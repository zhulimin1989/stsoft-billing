import { BadRequestException } from '@nestjs/common';

/**
 * 时段价格档（OFF_PEAK）的窗口工具。设计稿 me/time-based-pricing.md v13.4。
 *
 * 峰段窗口**仅随档配置**（model_pricing_tiers.band_schedule，必填），引擎无任何
 * 平台默认窗口常量；时区暂固定 Asia/Shanghai。窗口语义：band_schedule 存的是
 * **高峰窗口**（左闭右开 [start, end)），其余时间为空闲（OFF_PEAK）。
 */

export type ModelTimeBand = 'PEAK' | 'OFF_PEAK';

export type PeakWindow = {
  /** 1=周一 … 7=周日 */
  days: number[];
  /** "HH:mm"，含起点 */
  start: string;
  /** "HH:mm"，不含终点；必须 > start（不支持跨午夜单窗口，跨午夜拆两窗） */
  end: string;
};

export const OFF_PEAK_TIER_KEY = 'OFF_PEAK';
export const TIME_BAND_TIMEZONE = 'Asia/Shanghai';
const MAX_WINDOWS = 8;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 固定 en-US locale：zh 环境 weekday 输出「周一」，en-US 恒为英文缩写，避免解析歧义。
// hourCycle:'h23' 而非 hour12:false —— 后者在部分 Node/V8 版本映射到 h24，
// 午夜 00:30 会被格式化为 "24:30"，含 00:00 起点的窗口无法命中。
const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

let cachedFormatter: Intl.DateTimeFormat | null = null;

function getFormatter(): Intl.DateTimeFormat {
  if (!cachedFormatter) {
    cachedFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_BAND_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  return cachedFormatter;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** 取 at 在 Asia/Shanghai 的 (ISO weekday, 当日分钟数)。 */
function localWallClock(at: Date): { day: number; minutes: number } {
  const parts = getFormatter().formatToParts(at);
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  // h23 下 hour ∈ [0,23]；防御性兜底（h24 环境的 24:xx 归零点）
  if (hour === 24) hour = 0;
  const day = WEEKDAY_TO_ISO[weekday];
  if (!day) {
    // Intl 输出异常属基础设施问题，判 PEAK（fail-safe：不给折扣）
    return { day: 1, minutes: toMinutes('12:00') };
  }
  return { day, minutes: hour * 60 + minute };
}

/**
 * 判定 at 处于高峰还是空闲。windows 为**高峰窗口**（左闭右开），落在任一窗口 → PEAK。
 * 调用方必须先用 parseBandScheduleSafely/validateBandSchedule 得到合法 windows。
 */
export function resolveScheduleBand(at: Date, windows: PeakWindow[]): ModelTimeBand {
  const { day, minutes } = localWallClock(at);
  for (const window of windows) {
    if (!window.days.includes(day)) continue;
    if (minutes >= toMinutes(window.start) && minutes < toMinutes(window.end)) {
      return 'PEAK';
    }
  }
  return 'OFF_PEAK';
}

function normalizeWindows(raw: unknown): PeakWindow[] | string {
  if (!Array.isArray(raw)) return 'band_schedule 必须是数组';
  if (raw.length < 1 || raw.length > MAX_WINDOWS) {
    return `band_schedule 需要 1-${MAX_WINDOWS} 个高峰窗口`;
  }
  const windows: PeakWindow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `band_schedule[${i}] 必须是对象`;
    }
    const { days, start, end } = item as Record<string, unknown>;
    if (!Array.isArray(days) || days.length === 0) {
      return `band_schedule[${i}].days 必须是非空数组`;
    }
    const uniqueDays = [...new Set(days.map((d) => Number(d)))];
    if (uniqueDays.length !== days.length || uniqueDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return `band_schedule[${i}].days 只能是 1-7 且不重复`;
    }
    if (typeof start !== 'string' || !HHMM_RE.test(start)) {
      return `band_schedule[${i}].start 必须是 HH:mm`;
    }
    if (typeof end !== 'string' || !HHMM_RE.test(end)) {
      return `band_schedule[${i}].end 必须是 HH:mm`;
    }
    if (toMinutes(start) >= toMinutes(end)) {
      return `band_schedule[${i}] 需要 start < end（跨午夜请拆成两个窗口）`;
    }
    windows.push({ days: uniqueDays.sort((a, b) => a - b), start, end });
  }
  // 同日窗口不得重叠
  for (let day = 1; day <= 7; day += 1) {
    const ranges = windows
      .filter((w) => w.days.includes(day))
      .map((w) => [toMinutes(w.start), toMinutes(w.end)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i][0] < ranges[i - 1][1]) {
        return `band_schedule 周${day} 的高峰窗口存在重叠`;
      }
    }
  }
  return windows;
}

/**
 * 写侧校验：非法即抛（controller 转 400）。返回规范化后的窗口数组。
 */
export function validateBandSchedule(raw: unknown): PeakWindow[] {
  const result = normalizeWindows(raw);
  if (typeof result === 'string') {
    throw new BadRequestException(result);
  }
  return result;
}

/**
 * 读侧安全解析：缺失 / [] / days:[] / 非数组 / 非法 HH:mm / 历史脏结构 → null（不抛）。
 * 调用方对 null 的语义 = 不选时段档（按普通价计）+ warn。
 * `[]` 必须拦截 —— 空窗口若进入 resolveScheduleBand 会变成"全天 OFF_PEAK"。
 */
export function parseBandScheduleSafely(raw: unknown): PeakWindow[] | null {
  if (raw == null) return null;
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const result = normalizeWindows(value);
  return typeof result === 'string' ? null : result;
}

/** pricingUnit 允许 null（既有 token 默认语义）或 'token_1m'。 */
export function isTokenPricingUnit(pricingUnit: string | null | undefined): boolean {
  return pricingUnit == null || pricingUnit === 'token_1m';
}

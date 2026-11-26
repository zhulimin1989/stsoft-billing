import { BadRequestException } from '@nestjs/common';
import {
  PeakWindow,
  isTokenPricingUnit,
  parseBandScheduleSafely,
  resolveScheduleBand,
  validateBandSchedule,
} from './model-time-band';

// DeepSeek 口径：北京时间周一至五 09:00–12:00、14:00–18:00 为高峰（左闭右开）
const DEEPSEEK_WINDOWS: PeakWindow[] = [
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
];

/** 北京时间字符串 → Date（2026-08-24 是周一） */
function cst(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

describe('resolveScheduleBand', () => {
  it.each([
    ['周一 09:00:00 = 峰（左闭）', '2026-08-24T09:00:00', 'PEAK'],
    ['周一 11:59:59 = 峰', '2026-08-24T11:59:59', 'PEAK'],
    ['周一 12:00:00 = 谷（右开）', '2026-08-24T12:00:00', 'OFF_PEAK'],
    ['周一 13:59:59 = 谷（午休）', '2026-08-24T13:59:59', 'OFF_PEAK'],
    ['周一 14:00:00 = 峰', '2026-08-24T14:00:00', 'PEAK'],
    ['周一 17:59:59 = 峰', '2026-08-24T17:59:59', 'PEAK'],
    ['周一 18:00:00 = 谷', '2026-08-24T18:00:00', 'OFF_PEAK'],
    ['周一 08:59:59 = 谷（早间）', '2026-08-24T08:59:59', 'OFF_PEAK'],
    ['周六 10:00 全天谷', '2026-08-22T10:00:00', 'OFF_PEAK'],
    ['周日 15:00 全天谷', '2026-08-23T15:00:00', 'OFF_PEAK'],
  ])('%s', (_label, at, expected) => {
    expect(resolveScheduleBand(cst(at), DEEPSEEK_WINDOWS)).toBe(expected);
  });

  it('午夜 00:30 不因 h24 格式化误判（hourCycle:h23 防御，00:00 起点窗口可命中）', () => {
    const midnightWindows: PeakWindow[] = [{ days: [1], start: '00:00', end: '02:00' }];
    expect(resolveScheduleBand(cst('2026-08-24T00:30:00'), midnightWindows)).toBe('PEAK');
    expect(resolveScheduleBand(cst('2026-08-24T00:00:00'), midnightWindows)).toBe('PEAK');
    expect(resolveScheduleBand(cst('2026-08-24T02:00:00'), midnightWindows)).toBe('OFF_PEAK');
    expect(resolveScheduleBand(cst('2026-08-24T23:59:00'), midnightWindows)).toBe('OFF_PEAK');
  });

  it('时区正确性：UTC 时刻按北京墙钟判定（周一 01:30Z = 北京 09:30 峰）', () => {
    expect(resolveScheduleBand(new Date('2026-08-24T01:30:00Z'), DEEPSEEK_WINDOWS)).toBe('PEAK');
    // 周日 23:30Z = 北京周一 07:30 谷
    expect(resolveScheduleBand(new Date('2026-08-23T23:30:00Z'), DEEPSEEK_WINDOWS)).toBe('OFF_PEAK');
  });
});

describe('parseBandScheduleSafely（读侧 fail-safe：任何非法形态 → null，绝不抛）', () => {
  it.each([
    ['缺失 null', null],
    ['缺失 undefined', undefined],
    ['空数组（若放行会变全天 OFF_PEAK）', []],
    ['days 为空', [{ days: [], start: '09:00', end: '12:00' }]],
    ['非数组 JSON', { days: [1], start: '09:00', end: '12:00' }],
    ['非法 HH:mm', [{ days: [1], start: '9:00', end: '12:00' }]],
    ['start >= end', [{ days: [1], start: '12:00', end: '09:00' }]],
    ['day 越界', [{ days: [0, 8], start: '09:00', end: '12:00' }]],
    ['脏字符串', 'not-json'],
    ['同日重叠', [
      { days: [1], start: '09:00', end: '12:00' },
      { days: [1], start: '11:00', end: '13:00' },
    ]],
  ])('%s → null', (_label, raw) => {
    expect(parseBandScheduleSafely(raw)).toBeNull();
  });

  it('合法窗口（含 JSON 字符串形态）→ 规范化数组', () => {
    expect(parseBandScheduleSafely(DEEPSEEK_WINDOWS)).toEqual(DEEPSEEK_WINDOWS);
    expect(parseBandScheduleSafely(JSON.stringify(DEEPSEEK_WINDOWS))).toEqual(DEEPSEEK_WINDOWS);
  });
});

describe('validateBandSchedule（写侧：非法即抛 400）', () => {
  it.each([
    ['空数组', []],
    ['超过 8 个窗口', Array.from({ length: 9 }, (_, i) => ({ days: [((i % 7) + 1)], start: '09:00', end: '10:00' }))],
    ['days 重复', [{ days: [1, 1], start: '09:00', end: '12:00' }]],
    ['跨午夜单窗口（start>=end）', [{ days: [1], start: '22:00', end: '02:00' }]],
  ])('%s → BadRequestException', (_label, raw) => {
    expect(() => validateBandSchedule(raw)).toThrow(BadRequestException);
  });

  it('合法输入返回规范化窗口（days 排序去重）', () => {
    const result = validateBandSchedule([{ days: [5, 1, 3], start: '09:00', end: '12:00' }]);
    expect(result).toEqual([{ days: [1, 3, 5], start: '09:00', end: '12:00' }]);
  });
});

describe('isTokenPricingUnit', () => {
  it('null / token_1m 为 token 计价；image 等其余不是', () => {
    expect(isTokenPricingUnit(null)).toBe(true);
    expect(isTokenPricingUnit(undefined)).toBe(true);
    expect(isTokenPricingUnit('token_1m')).toBe(true);
    expect(isTokenPricingUnit('image')).toBe(false);
    expect(isTokenPricingUnit('video_second')).toBe(false);
  });
});

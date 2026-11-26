/**
 * AlertEventService — admin v2 事件流(/admin/v2/alerts)
 *
 * 命名注意:与 v0.3 既有 alerts 表(告警规则配置, name/metric/condition/threshold)
 * 完全独立。本服务操作的是 alert_events 表 / AlertEvent model。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-alerts-design.md (§6)
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AlertEvent,
  AlertEventCategory,
  AlertEventSeverity,
  AlertEventStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 列表分页上限,防 DoS。 */
const PAGE_SIZE_MAX = 200;
/** 去重窗口:5 分钟内同 (category, sourceType, sourceId) 已有 PENDING/READ 跳过。 */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * JSON.stringify 安全包装:RiskEngine/Payment 透传的 context 可能含循环引用
 * (如 axios error.request → response → request)。stringify 抛错会被外层 catch
 * 吞掉导致整条告警丢失,这里 fallback 到 '{}' 保住主链路。
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return '{}';
  }
}

export interface CreateAlertInput {
  category: AlertEventCategory;
  severity: AlertEventSeverity;
  title: string;
  message: string;
  sourceType?: string | null;
  sourceId?: string | null;
  userId?: string | null;
  /** 任意结构,内部 JSON.stringify 入库。 */
  context?: Record<string, unknown> | null;
}

/**
 * P2-A3 §8.2 系统健康告警入参。
 *
 * 这是后续 Sentry / Prometheus / health probe 集成的统一入口 ——
 * 调用方传指标名 + 当前值 + 阈值,内部组装出 SYSTEM category 的 AlertEvent。
 *
 * 本期(P2-A3)只在 health.controller 的 redis ping 失败处接一次,作为占位示例;
 * 后续阶段接入真实监控时,所有"系统不健康"事件都走这里。
 */
export interface CreateSystemAlertInput {
  /** 指标名,例如 'redis_unreachable' / 'pg_replication_lag_seconds'。 */
  metric: string;
  /** 当前观测值。redis 不可达这种"二值"指标用 0/1 表示。 */
  value: number;
  /** 触发阈值。redis 不可达用 1(任何 ≥1 视为告警)。 */
  threshold: number;
  /** 默认 CRITICAL。系统健康问题通常需要立即处理。 */
  severity?: AlertEventSeverity;
  /** 可选,自定义标题(默认按 metric 拼)。 */
  title?: string;
  /** 可选,自定义详情(默认按 metric/value/threshold 拼)。 */
  message?: string;
  /** 额外上下文,如 host/error.message,会与 {metric, value, threshold} 合并入库。 */
  context?: Record<string, unknown> | null;
}

export interface ListAlertsQuery {
  page: number;
  pageSize: number;
  category?: AlertEventCategory;
  severity?: AlertEventSeverity;
  status?: AlertEventStatus;
  fromDate?: Date;
  toDate?: Date;
  userId?: string;
  q?: string;
}

export interface ListAlertsResult {
  items: AlertEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AlertStats {
  unreadCount: number;
  criticalCount: number;
  todayCount: number;
}

@Injectable()
export class AlertEventService {
  private readonly logger = new Logger(AlertEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------- 内部 API ----------------------------

  /**
   * 事件源调用入口。**绝不抛异常** —— 失败仅 logger.warn,主链路继续。
   *
   * 去重:同一 (category, sourceType, sourceId) 在最近 5 分钟内已有
   * status ∈ {PENDING, READ} 的告警时,跳过创建,返回 null。
   *
   * 注意:findFirst+create 是 best-effort 软去重。并发两路同 key 会双双
   * 通过 findFirst 检查 → 同时 create。schema §6.1 不增 partial unique
   * index(PG partial unique 不支持 now()),实际依赖以下兜底:
   *   - P2002 unique violation(若上游加了硬唯一约束)→ 静默 swallow
   *   - 其它写入异常 → logger.warn,绝不抛
   * P2-A2 接 RiskEngine/Payment 后真实会发生(同笔订单瞬时双告警),
   * 5min 软窗口已能覆盖 99% 场景。
   */
  async createAlert(input: CreateAlertInput): Promise<AlertEvent | null> {
    try {
      const since = new Date(Date.now() - DEDUP_WINDOW_MS);
      const dup = await this.prisma.alertEvent.findFirst({
        where: {
          category: input.category,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          status: { in: ['PENDING', 'READ'] },
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (dup) {
        return null;
      }

      try {
        const created = await this.prisma.alertEvent.create({
          data: {
            category: input.category,
            severity: input.severity,
            title: input.title,
            message: input.message,
            sourceType: input.sourceType ?? null,
            sourceId: input.sourceId ?? null,
            userId: input.userId ?? null,
            context: safeStringify(input.context),
          },
        });
        return created;
      } catch (err) {
        // 并发竞态:两路同 (category, sourceType, sourceId) 都通过了
        // findFirst,后到的 create 撞 unique 约束 → 静默跳过。
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          this.logger.debug(
            `createAlert dedup race swallowed (category=${input.category}, sourceType=${input.sourceType ?? 'null'}, sourceId=${input.sourceId ?? 'null'})`,
          );
          return null;
        }
        throw err;
      }
    } catch (err) {
      // Alert 写入失败不能拖垮主链路(支付/风控/渠道)。
      this.logger.warn(
        `createAlert failed (category=${input.category}, sourceType=${input.sourceType ?? 'null'}, sourceId=${input.sourceId ?? 'null'}): ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * P2-A3 §8.2:系统健康告警入口。本期仅 health.controller 接入(redis ping fail
   * 时占位调一次);后续阶段接入 Sentry / Prometheus 真实监控时也走这里。
   *
   * 与 createAlert 一样**绝不抛异常** —— 健康检查不能因为 alert 写入失败而连锁挂掉。
   *
   * 去重:sourceId 设为 metric 本身,5 分钟内同 metric 不重复发(走 createAlert
   * 内部去重)。这意味着同一类故障(如 redis 持续不可达)只会刷一条 PENDING/READ
   * 告警,运营 ack 之后下个 5min 窗口才会再发。
   */
  async createSystemAlert(
    input: CreateSystemAlertInput,
  ): Promise<AlertEvent | null> {
    const severity = input.severity ?? 'CRITICAL';
    const title = input.title ?? `系统指标异常:${input.metric}`;
    const message =
      input.message ??
      `${input.metric} = ${input.value}, 阈值 = ${input.threshold}`;
    return this.createAlert({
      category: 'SYSTEM',
      severity,
      title,
      message,
      sourceType: 'system',
      sourceId: input.metric,
      context: {
        metric: input.metric,
        value: input.value,
        threshold: input.threshold,
        ...(input.context ?? {}),
      },
    });
  }

  // ---------------------------- 查询 / 统计 ----------------------------

  async list(query: ListAlertsQuery): Promise<ListAlertsResult> {
    const page = Math.max(1, Math.floor(query.page) || 1);
    const rawPageSize = Math.floor(query.pageSize) || 20;
    const pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, rawPageSize));

    const where: Prisma.AlertEventWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.severity) where.severity = query.severity;
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = query.userId;
    if (query.fromDate || query.toDate) {
      where.createdAt = {};
      if (query.fromDate) where.createdAt.gte = query.fromDate;
      if (query.toDate) where.createdAt.lte = query.toDate;
    }
    if (query.q && query.q.trim()) {
      const q = query.q.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { message: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.alertEvent.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<AlertEvent> {
    const row = await this.prisma.alertEvent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('告警事件不存在');
    return row;
  }

  async getStats(): Promise<AlertStats> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [unreadCount, criticalCount, todayCount] = await Promise.all([
      this.prisma.alertEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.alertEvent.count({
        where: { severity: 'CRITICAL', status: { not: 'HANDLED' } },
      }),
      this.prisma.alertEvent.count({
        where: { createdAt: { gte: startOfToday } },
      }),
    ]);

    return { unreadCount, criticalCount, todayCount };
  }

  // ---------------------------- 状态机 ----------------------------

  /**
   * 批量标记已读:仅对 status='PENDING' 的告警生效,
   * READ/HANDLED 不动(也不抛错,前端列表勾选可能混带已读项)。
   * 同时写入 readAt = now。
   */
  async markRead(
    ids: string[],
    _adminId: string,
  ): Promise<{ updated: number }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { updated: 0 };
    }
    const now = new Date();
    const result = await this.prisma.alertEvent.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'READ', readAt: now },
    });
    return { updated: result.count };
  }

  /**
   * 单条标记已处理。HANDLED 状态视为终态,重复调用抛 BadRequest(幂等抛错)。
   * PENDING 或 READ 状态都可以直接转 HANDLED;若仍是 PENDING 则同时补 readAt。
   */
  async handle(
    id: string,
    adminId: string,
    note: string | null | undefined,
  ): Promise<AlertEvent> {
    const existing = await this.getById(id);
    if (existing.status === 'HANDLED') {
      throw new BadRequestException('该告警已处理,不能重复处理');
    }
    const now = new Date();
    const data: Prisma.AlertEventUpdateInput = {
      status: 'HANDLED',
      handledAt: now,
      handledBy: adminId,
      handleNote: note ?? null,
    };
    if (!existing.readAt) {
      data.readAt = now;
    }
    return this.prisma.alertEvent.update({
      where: { id: existing.id },
      data,
    });
  }
}

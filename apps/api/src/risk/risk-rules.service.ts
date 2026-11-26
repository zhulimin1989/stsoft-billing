/**
 * RiskRule + RiskList CRUD with per-ruleType config validation.
 *
 * Per spec §8 of admin-v2-backend-p1. The risk engine (real-time + scheduled
 * scans) lives in RiskEngineService — this service is the admin-facing
 * surface (CRUD + list-entry management + config validation).
 *
 * Each `ruleType` has its own `config` JSON shape (see `validateConfig`):
 *   - BLACKLIST        { matchTypes: RiskListType[] }
 *   - USAGE_THRESHOLD  { metric, threshold, windowSec }
 *   - IP_LIMIT         { windowDays, maxAccountsPerIp }
 *   - REFUND_RATE      { scope, thresholdPct, windowDays }
 *   - FRAUD_PROVIDER   { provider, webhookUrl, apiKey }
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  RiskAction,
  RiskList,
  RiskListType,
  RiskRule,
  RiskRuleType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RISK_BLOCKED_CACHE_PREFIX } from './risk-engine.service';

const NAME_MAX = 128;
const REASON_MAX = 512;
const VALUE_MAX = 256;

const RULE_TYPES: ReadonlySet<RiskRuleType> = new Set([
  'BLACKLIST',
  'USAGE_THRESHOLD',
  'IP_LIMIT',
  'REFUND_RATE',
  'FRAUD_PROVIDER',
]);

const ACTIONS: ReadonlySet<RiskAction> = new Set([
  'BLOCK',
  'ALERT',
  'DISABLE_KEY',
  'FREEZE_USER',
]);

const LIST_TYPES: ReadonlySet<RiskListType> = new Set([
  'EMAIL',
  'DOMAIN',
  'IP',
  'CARD_HASH',
  'USER_ID',
]);

const USAGE_METRICS = new Set(['DAILY_TOKEN', 'DAILY_COST', 'MODEL_CALL_COUNT']);
const REFUND_SCOPES = new Set(['GLOBAL', 'PRODUCT', 'USER']);

export interface CreateRuleInput {
  name: string;
  ruleType: RiskRuleType;
  config: unknown; // raw JSON object — validated per ruleType
  action: RiskAction;
  isActive?: boolean;
}

export type UpdateRuleInput = Partial<CreateRuleInput>;

export interface ListRulesFilters {
  page: number;
  pageSize: number;
  search?: string;
  ruleType?: RiskRuleType;
  isActive?: boolean;
}

export type RiskRuleDto = Omit<RiskRule, 'config'> & { config: unknown };

export interface RuleListResult {
  items: RiskRuleDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateListEntryInput {
  listType: RiskListType;
  value: string;
  reason?: string;
  expiresAt?: string | Date | null;
  ruleId?: string | null;
  addedBy: string;
}

@Injectable()
export class RiskRulesService {
  private readonly logger = new Logger(RiskRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so existing unit tests that build the service without Redis
    // (RiskRulesService spec) keep working — the cache invalidation hook
    // is best-effort and the engine's TTL still bounds staleness.
    @Optional() private readonly redis?: RedisService,
  ) {}

  // ------------------------------ RiskRule CRUD ----------------------

  async list(filters: ListRulesFilters): Promise<RuleListResult> {
    const { page, pageSize, search, ruleType, isActive } = filters;
    const where: Prisma.RiskRuleWhereInput = { deletedAt: null };
    if (search) where.name = { contains: search, mode: 'insensitive' };
    if (ruleType) where.ruleType = ruleType;
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const [rows, total] = await Promise.all([
      this.prisma.riskRule.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.riskRule.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({ ...r, config: this.safeParse(r.config) })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<RiskRuleDto> {
    const row = await this.prisma.riskRule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('风控规则不存在');
    return { ...row, config: this.safeParse(row.config) };
  }

  async create(input: CreateRuleInput): Promise<RiskRuleDto> {
    this.assertCommon(input);
    const normalizedConfig = this.validateConfig(input.ruleType, input.config);
    const data: Prisma.RiskRuleCreateInput = {
      name: input.name.trim(),
      ruleType: input.ruleType,
      config: JSON.stringify(normalizedConfig),
      action: input.action,
      isActive: input.isActive ?? true,
    };
    const row = await this.prisma.riskRule.create({ data });
    this.warnIfBlacklistBlock(input.ruleType, input.action, row.id);
    return { ...row, config: normalizedConfig };
  }

  async update(
    id: string,
    input: UpdateRuleInput,
  ): Promise<RiskRuleDto> {
    const existing = await this.getById(id);

    const merged: CreateRuleInput = {
      name: input.name ?? existing.name,
      ruleType: input.ruleType ?? existing.ruleType,
      config: input.config ?? existing.config,
      action: input.action ?? existing.action,
      isActive: input.isActive ?? existing.isActive,
    };
    this.assertCommon(merged);
    const normalizedConfig = this.validateConfig(merged.ruleType, merged.config);

    const data: Prisma.RiskRuleUpdateInput = {};
    if (input.name !== undefined) data.name = merged.name.trim();
    if (input.ruleType !== undefined) data.ruleType = merged.ruleType;
    // Always re-write config when ruleType changes or config is updated, since
    // shape depends on ruleType.
    if (input.config !== undefined || input.ruleType !== undefined) {
      data.config = JSON.stringify(normalizedConfig);
    }
    if (input.action !== undefined) data.action = merged.action;
    if (input.isActive !== undefined) data.isActive = merged.isActive;

    const row = await this.prisma.riskRule.update({
      where: { id: existing.id },
      data,
    });
    this.warnIfBlacklistBlock(row.ruleType, row.action, row.id);
    return { ...row, config: this.safeParse(row.config) };
  }

  async softDelete(id: string): Promise<void> {
    const existing = await this.getById(id);
    await this.prisma.riskRule.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ------------------------------ RiskList CRUD ----------------------

  async listEntries(filters: {
    listType?: RiskListType;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    items: RiskList[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const where: Prisma.RiskListWhereInput = {};
    if (filters.listType) where.listType = filters.listType;
    if (filters.search) {
      where.value = { contains: filters.search, mode: 'insensitive' };
    }
    const [items, total] = await Promise.all([
      this.prisma.riskList.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.riskList.count({ where }),
    ]);
    return {
      items,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    };
  }

  async addEntry(input: CreateListEntryInput): Promise<RiskList> {
    if (!input.listType || !LIST_TYPES.has(input.listType)) {
      throw new BadRequestException('listType 非法');
    }
    if (
      typeof input.value !== 'string' ||
      !input.value.trim() ||
      input.value.length > VALUE_MAX
    ) {
      throw new BadRequestException(`value 必填且长度 ≤ ${VALUE_MAX}`);
    }
    if (input.reason && input.reason.length > REASON_MAX) {
      throw new BadRequestException(`reason 长度 ≤ ${REASON_MAX}`);
    }
    if (!input.addedBy) {
      throw new BadRequestException('addedBy 必填 (内部错误)');
    }
    const expiresAt = this.normalizeDate(input.expiresAt ?? null);

    // Light per-listType value sanity. Refuse blatantly malformed inputs.
    this.validateListValue(input.listType, input.value.trim());

    if (input.ruleId) {
      const ruleExists = await this.prisma.riskRule.findFirst({
        where: { id: input.ruleId, deletedAt: null },
        select: { id: true },
      });
      if (!ruleExists) throw new BadRequestException('ruleId 不存在');
    }

    try {
      return await this.prisma.riskList.create({
        data: {
          listType: input.listType,
          value: input.value.trim(),
          reason: input.reason ?? '',
          addedBy: input.addedBy,
          expiresAt,
          ruleId: input.ruleId ?? null,
        },
      });
    } catch (err) {
      // Unique constraint (listType, value)
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException('该名单值已存在');
      }
      throw err;
    }
  }

  async removeEntry(id: string): Promise<void> {
    const row = await this.prisma.riskList.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('名单条目不存在');
    await this.prisma.riskList.delete({ where: { id } });

    // Best-effort cache invalidation for USER_ID entries: the engine
    // caches `risk:blocked:{userId}` for 60s, so unbanning a user without
    // active invalidation leaves them locked out for up to a minute. For
    // USER_ID type the identifier IS the userId — DEL the key.
    //
    // IP / EMAIL / DOMAIN / CARD_HASH entries can match multiple users at
    // once and we don't track the reverse index, so we accept up to one
    // minute of TTL-bounded staleness for those (covered by spec §8.3 and
    // logged here so operators can see the gap).
    if (row.listType === 'USER_ID' && this.redis) {
      const key = `${RISK_BLOCKED_CACHE_PREFIX}${row.value}`;
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn(
          `risk:blocked cache DEL failed for userId=${row.value} after unban: ${
            (err as Error).message
          } — entry will expire on its own within 60s`,
        );
      }
    }
  }

  // ------------------------------ helpers ----------------------------

  private assertCommon(input: CreateRuleInput): void {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new BadRequestException('name 必填');
    }
    if (input.name.length > NAME_MAX) {
      throw new BadRequestException(`name 长度不得超过 ${NAME_MAX} 字符`);
    }
    if (!RULE_TYPES.has(input.ruleType)) {
      throw new BadRequestException('ruleType 非法');
    }
    if (!ACTIONS.has(input.action)) {
      throw new BadRequestException('action 非法');
    }
  }

  /**
   * Validate `config` JSON per ruleType, returning a normalized object that
   * we then JSON.stringify into the column. Throws BadRequestException for
   * malformed shapes.
   */
  validateConfig(ruleType: RiskRuleType, raw: unknown): Record<string, unknown> {
    const cfg = this.coerceObject(raw);
    switch (ruleType) {
      case 'BLACKLIST': {
        const matchTypes = cfg.matchTypes;
        if (!Array.isArray(matchTypes) || matchTypes.length === 0) {
          throw new BadRequestException(
            'BLACKLIST.config.matchTypes 必须是非空数组',
          );
        }
        const normalized: RiskListType[] = [];
        for (const t of matchTypes) {
          if (typeof t !== 'string' || !LIST_TYPES.has(t as RiskListType)) {
            throw new BadRequestException(
              `BLACKLIST.config.matchTypes 含非法类型: ${String(t)}`,
            );
          }
          normalized.push(t as RiskListType);
        }
        return { matchTypes: normalized };
      }
      case 'USAGE_THRESHOLD': {
        const metric = cfg.metric;
        const threshold = cfg.threshold;
        const windowSec = cfg.windowSec;
        if (typeof metric !== 'string' || !USAGE_METRICS.has(metric)) {
          throw new BadRequestException(
            `USAGE_THRESHOLD.metric 必须是 ${Array.from(USAGE_METRICS).join('|')}`,
          );
        }
        if (
          typeof threshold !== 'number' ||
          !Number.isFinite(threshold) ||
          threshold <= 0
        ) {
          throw new BadRequestException('USAGE_THRESHOLD.threshold 必须是正数');
        }
        if (
          typeof windowSec !== 'number' ||
          !Number.isInteger(windowSec) ||
          windowSec < 60 ||
          windowSec > 604800
        ) {
          throw new BadRequestException(
            'USAGE_THRESHOLD.windowSec 必须在 60-604800 秒之间',
          );
        }
        return { metric, threshold, windowSec };
      }
      case 'IP_LIMIT': {
        const windowDays = cfg.windowDays;
        const maxAccountsPerIp = cfg.maxAccountsPerIp;
        if (
          typeof windowDays !== 'number' ||
          !Number.isInteger(windowDays) ||
          windowDays < 1 ||
          windowDays > 90
        ) {
          throw new BadRequestException(
            'IP_LIMIT.windowDays 必须在 1-90 天之间',
          );
        }
        if (
          typeof maxAccountsPerIp !== 'number' ||
          !Number.isInteger(maxAccountsPerIp) ||
          maxAccountsPerIp < 2 ||
          maxAccountsPerIp > 1000
        ) {
          throw new BadRequestException(
            'IP_LIMIT.maxAccountsPerIp 必须在 2-1000 之间',
          );
        }
        return { windowDays, maxAccountsPerIp };
      }
      case 'REFUND_RATE': {
        const scope = cfg.scope;
        const thresholdPct = cfg.thresholdPct;
        const windowDays = cfg.windowDays;
        if (typeof scope !== 'string' || !REFUND_SCOPES.has(scope)) {
          throw new BadRequestException(
            `REFUND_RATE.scope 必须是 ${Array.from(REFUND_SCOPES).join('|')}`,
          );
        }
        if (scope === 'PRODUCT') {
          throw new BadRequestException(
            '暂不支持 PRODUCT 范围的退款率监控，请改用 USER 范围',
          );
        }
        if (
          typeof thresholdPct !== 'number' ||
          !Number.isFinite(thresholdPct) ||
          thresholdPct <= 0 ||
          thresholdPct > 100
        ) {
          throw new BadRequestException(
            'REFUND_RATE.thresholdPct 必须在 (0, 100] 之间',
          );
        }
        if (
          typeof windowDays !== 'number' ||
          !Number.isInteger(windowDays) ||
          windowDays < 1 ||
          windowDays > 365
        ) {
          throw new BadRequestException(
            'REFUND_RATE.windowDays 必须在 1-365 天之间',
          );
        }
        return { scope, thresholdPct, windowDays };
      }
      case 'FRAUD_PROVIDER': {
        const provider = cfg.provider;
        const webhookUrl = cfg.webhookUrl;
        const apiKey = cfg.apiKey;
        if (typeof provider !== 'string' || !provider.trim()) {
          throw new BadRequestException('FRAUD_PROVIDER.provider 必填');
        }
        if (
          webhookUrl !== undefined &&
          webhookUrl !== null &&
          typeof webhookUrl !== 'string'
        ) {
          throw new BadRequestException('FRAUD_PROVIDER.webhookUrl 类型非法');
        }
        if (
          apiKey !== undefined &&
          apiKey !== null &&
          typeof apiKey !== 'string'
        ) {
          throw new BadRequestException('FRAUD_PROVIDER.apiKey 类型非法');
        }
        return {
          provider: provider.trim(),
          webhookUrl: webhookUrl ?? null,
          apiKey: apiKey ?? null,
        };
      }
    }
  }

  private coerceObject(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }
    throw new BadRequestException('config 必须是 JSON 对象');
  }

  private validateListValue(listType: RiskListType, value: string): void {
    if (listType === 'EMAIL') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new BadRequestException('EMAIL 名单值格式不合法');
      }
    } else if (listType === 'DOMAIN') {
      if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) {
        throw new BadRequestException('DOMAIN 名单值格式不合法');
      }
    }
    // IP / CARD_HASH / USER_ID — opaque strings, no per-type validation.
  }

  private normalizeDate(raw: string | Date | null | undefined): Date | null {
    if (raw === null || raw === undefined) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('expiresAt 必须是合法时间');
    }
    return d;
  }

  private safeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn(`malformed config JSON, returning raw string`);
      return raw;
    }
  }

  /**
   * Surface a top-level WARN whenever a BLACKLIST + BLOCK rule is saved:
   * the engine's `isUserBlocked` hook is exposed but no caller has wired it
   * into request paths yet, so the rule is admin-audit-only until the
   * gateway integrates it. Keeps operators from believing they have a
   * real-time block in place when they don't.
   */
  private warnIfBlacklistBlock(
    ruleType: RiskRuleType,
    action: RiskAction,
    ruleId: string,
  ): void {
    if (ruleType === 'BLACKLIST' && action === 'BLOCK') {
      this.logger.warn(
        `BLACKLIST BLOCK rule created (id=${ruleId}) — real-time enforcement is not yet wired into request paths. Effect is admin-only audit until callers integrate isUserBlocked()`,
      );
    }
  }
}

import { Injectable } from '@nestjs/common';
import {
  TokenUsagePeriodSummaryV2Repository,
  type TokenUsagePeriodSummaryV2Granularity,
  type TokenUsagePeriodSummaryV2Row,
} from './token-usage-period-summary-v2.repository';
import { usdNumber, usdString } from './money';

/**
 * Token 用量周期汇总 V2 —— 业务层。
 *
 * 对外契约与 v1 `/billing/token-usage-period-summary` 保持一致（字段名 / 单位 / 排序），
 * 便于前端只切路径即可；v1 代码与行为完全不动。
 *
 * 口径：
 * - `granularity=month`：对齐企业账单 `/admin/v2/enterprise-accounts/:id/bills` 的现算口径
 *   - 请求数 → `requestCount`
 *   - Token 总量 → `tokenTotal`
 *   - 消耗金额 → `consumeCents`
 *   - 账户扣费 → `accountPayCents`（账户支付金额）
 *   - 代金券扣费 → `voucherDeductCents`（代金券抵扣金额）
 * - `granularity=day`：沿用现有日账单聚合逻辑。
 *
 * 范围：
 * - 企业账户（`billing_accounts.type = 'enterprise'`）按账单账户汇总 —— 与账单接口同源；
 * - 个人 / 团队账户按当前工作区（tenant）汇总 —— 与 v1 同源。
 *
 * 关于 `nodejs-polars`：
 * 评估结论是**不引入**。瓶颈在数据库 IO（570 万 token_usage、374 万 allocations，
 * 单次聚合需要先做行级可见性判定再按分摊表归并），不是 Node 侧算力。
 * - 走 `nodejs-polars` 只能先把明细行拉到进程内，网络与反序列化成本远高于 SQL 下推；
 * - 本接口只需要「分组求和 + 进分」这类关系代数，PostgreSQL 的 HashAggregate 已是更优解；
 * - 引入原生扩展会给 API 镜像的跨平台构建/部署增加无收益风险。
 * 因此聚合全部下推到 PostgreSQL，Node 侧只做日期边界与金额格式化（O(≤366) 行）。
 */

const ENTERPRISE_ACCOUNT_TYPE = 'enterprise';
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 366;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TokenUsagePeriodSummaryV2Subject {
  tenantId: string;
  billingAccountId: string;
  billingAccountType: string;
}

export interface TokenUsagePeriodSummaryV2Options {
  startDate?: string;
  endDate?: string;
  granularity: TokenUsagePeriodSummaryV2Granularity;
  apiKeyId?: string;
  productId?: string;
  model?: string;
}

export interface TokenUsagePeriodSummaryV2Item {
  period: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
  costAmount: string;
  paymentDeductionUsd: number;
  paymentDeductionAmount: string;
  voucherDeductionUsd: number;
  voucherDeductionAmount: string;
}

export interface TokenUsagePeriodSummaryV2Result {
  granularity: TokenUsagePeriodSummaryV2Granularity;
  items: TokenUsagePeriodSummaryV2Item[];
}

@Injectable()
export class TokenUsagePeriodSummaryV2Service {
  constructor(private readonly repository: TokenUsagePeriodSummaryV2Repository) {}

  async getPeriodSummary(
    subject: TokenUsagePeriodSummaryV2Subject,
    options: TokenUsagePeriodSummaryV2Options,
  ): Promise<TokenUsagePeriodSummaryV2Result> {
    const range = this.resolveRange(options.startDate, options.endDate);
    const rows = await this.repository.aggregate(
      {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        byBillingAccount: subject.billingAccountType === ENTERPRISE_ACCOUNT_TYPE,
      },
      {
        startInclusive: range.startInclusive,
        endExclusive: range.endExclusive,
        productId: this.optional(options.productId),
        model: this.optional(options.model),
        apiKeyId: this.optional(options.apiKeyId),
      },
      options.granularity,
    );

    return {
      granularity: options.granularity,
      items: rows.map((row) => this.toItem(row)),
    };
  }

  private toItem(row: TokenUsagePeriodSummaryV2Row): TokenUsagePeriodSummaryV2Item {
    return {
      period: row.period,
      calls: row.calls,
      totalTokens: row.totalTokens,
      costUsd: usdNumber(row.consumeUsd),
      costAmount: usdString(row.consumeUsd),
      paymentDeductionUsd: usdNumber(row.accountPayUsd),
      paymentDeductionAmount: usdString(row.accountPayUsd),
      voucherDeductionUsd: usdNumber(row.voucherUsd),
      voucherDeductionAmount: usdString(row.voucherUsd),
    };
  }

  private optional(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  /**
   * 统一按北京时间自然日解析边界：
   * `startInclusive` = 起始日 00:00:00+08 的 UTC 瞬时；
   * `endExclusive` = 结束日次日 00:00:00+08 的 UTC 瞬时（右开）。
   * 中国无夏令时，加一天即为次日零点。
   */
  private resolveRange(startDate?: string, endDate?: string): { startInclusive: Date; endExclusive: Date } {
    const today = this.beijingStartOfDay(new Date());
    const endInclusive = this.beijingStartOfDay(this.parseDate(endDate) ?? today);
    let startInclusive = this.beijingStartOfDay(
      this.parseDate(startDate) ?? new Date(endInclusive.getTime() - DEFAULT_RANGE_DAYS * DAY_MS),
    );

    if (startInclusive.getTime() > endInclusive.getTime()) {
      startInclusive = endInclusive;
    }

    const maxSpanMs = MAX_RANGE_DAYS * DAY_MS;
    const spanMs = endInclusive.getTime() + DAY_MS - startInclusive.getTime();
    if (spanMs > maxSpanMs) {
      startInclusive = new Date(endInclusive.getTime() + DAY_MS - maxSpanMs);
    }

    return {
      startInclusive,
      endExclusive: new Date(endInclusive.getTime() + DAY_MS),
    };
  }

  private parseDate(value?: string): Date | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    const parsed = DATE_ONLY_PATTERN.test(trimmed)
      ? new Date(`${trimmed}T00:00:00+08:00`)
      : new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private beijingStartOfDay(at: Date): Date {
    const shifted = new Date(at.getTime() + BEIJING_OFFSET_MS);
    return new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING_OFFSET_MS,
    );
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

const TOKEN_USAGE_SHANGHAI_DATE_SQL = Prisma.sql`
  (tu."created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
`;

export interface BillingSubjectFilter {
  tenantId?: string | null;
  billingAccountId?: string | null;
}

export interface TokenUsageFilters {
  userId: string;
  tenantId?: string | null;
  apiKeyUserId?: string;
  apiKeyId?: string;
  productId?: string;
  model?: string;
  createdAt?: { gte?: Date; lt?: Date };
}

export type TokenUsagePeriodGranularity = 'day' | 'month';

@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPlans() {
    return this.prisma.plan.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findActivePlans(productId?: string) {
    return this.prisma.plan.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ...(productId ? { productId } : {}),
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findPlanById(id: string) {
    return this.prisma.plan.findUnique({ where: { id } });
  }

  async aggregateBalance(userId: string, subject: BillingSubjectFilter = {}) {
    void userId;
    return this.prisma.accountWallet.findUnique({
      where: { billingAccountId: this.requireBillingAccountId(subject) },
    });
  }

  async aggregateUsedThisMonth(userId: string, since: Date, subject: BillingSubjectFilter = {}) {
    return this.prisma.balanceTransaction.aggregate({
      where: {
        ...this.balanceSubjectWhere(userId, subject),
        type: 'CONSUME',
        createdAt: { gte: since },
      },
      _sum: { amountUsd: true },
    });
  }

  async aggregateTotalGranted(userId: string, subject: BillingSubjectFilter = {}) {
    return this.prisma.balanceTransaction.aggregate({
      where: {
        ...this.balanceSubjectWhere(userId, subject),
        amountUsd: { gt: 0 },
      },
      _sum: { amountUsd: true },
    });
  }

  async aggregateBalanceGrantTotals(userId: string, subject: BillingSubjectFilter = {}) {
    void userId;
    const tenantId = this.requireTenantId(subject);
    const billingAccountId = this.requireBillingAccountId(subject);
    return this.prisma.balanceGrant.aggregate({
      where: {
        OR: [
          { billingAccountId },
          { tenantId, billingAccountId: null },
        ],
      },
      _sum: {
        paidAmountUsd: true,
        bonusAmountUsd: true,
      },
    });
  }

  async findTransactions(
    userId: string,
    skip: number,
    take: number,
    productId?: string,
    subject: BillingSubjectFilter = {},
  ) {
    return this.prisma.balanceTransaction.findMany({
      where: { ...this.balanceSubjectWhere(userId, subject), ...(productId ? { productId } : {}) },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async countTransactions(userId: string, productId?: string, subject: BillingSubjectFilter = {}) {
    return this.prisma.balanceTransaction.count({
      where: { ...this.balanceSubjectWhere(userId, subject), ...(productId ? { productId } : {}) },
    });
  }

  // ============================
  // 日账单汇总（Task 1）
  // ============================

  async dailyBalanceConsumption(
    userId: string,
    startDate: Date,
    endDate: Date,
    subject: BillingSubjectFilter = {},
    productId?: string,
  ): Promise<{ date: Date; totalUsd: Prisma.Decimal }[]> {
    const filters = [
      Prisma.sql`bt."tenant_id" = ${this.requireTenantId(subject)}`,
      Prisma.sql`bt."type" = 'CONSUME'`,
      Prisma.sql`bt."created_at" >= ${startDate}`,
      Prisma.sql`bt."created_at" < ${endDate}`,
    ];
    if (productId) filters.push(Prisma.sql`bt."product_id" = ${productId}`);
    return this.prisma.$queryRaw`
      SELECT DATE_TRUNC('day', bt."created_at") AS date,
             SUM(ABS(bt."amount_usd")) AS "totalUsd"
      FROM "balance_transactions" bt
      WHERE ${Prisma.join(filters, ' AND ')}
      GROUP BY DATE_TRUNC('day', bt."created_at")
      ORDER BY date ASC
    `;
  }

  async dailyCreditConsumption(
    userId: string,
    startDate: Date,
    endDate: Date,
    subject: BillingSubjectFilter = {},
    productId?: string,
  ): Promise<{ date: Date; totalCredits: number; totalTokens: number }[]> {
    const filters = [
      Prisma.sql`ct."tenant_id" = ${this.requireTenantId(subject)}`,
      Prisma.sql`ct."type" = 'CONSUME'`,
      Prisma.sql`ct."created_at" >= ${startDate}`,
      Prisma.sql`ct."created_at" < ${endDate}`,
    ];
    if (productId) filters.push(Prisma.sql`ct."product_id" = ${productId}`);
    return this.prisma.$queryRaw`
      SELECT DATE_TRUNC('day', ct."created_at") AS date,
             SUM(ABS(ct."credits_amount"))::int AS "totalCredits",
             COALESCE(SUM(ct."total_tokens"), 0)::int AS "totalTokens"
      FROM "credit_transactions" ct
      WHERE ${Prisma.join(filters, ' AND ')}
      GROUP BY DATE_TRUNC('day', ct."created_at")
      ORDER BY date ASC
    `;
  }

  /**
   * API-key/member-filtered daily billing must be derived from the ledgers that
   * actually funded each usage row. TokenUsage.costUsd is a price/cost fact, not
   * proof that the customer balance paid that amount.
   *
   * Allocation and credit rows are reduced to one row per TokenUsage before the
   * final joins. This is important because one balance consumption can have
   * several grant allocations; joining both ledgers directly would multiply
   * either side.
   */
  async dailyActualUsageFunding(
    filters: TokenUsageFilters,
  ): Promise<{
    date: Date;
    balanceConsumptionUsd: Prisma.Decimal;
    creditConsumption: number;
    totalTokens: number;
  }[]> {
    const where = this.tokenUsageSqlFilters(filters);
    const ledgerFilters = [
      Prisma.sql`scoped."tenantId" = ${this.requireTenantId(filters)}`,
    ];
    if (filters.productId) {
      ledgerFilters.push(Prisma.sql`scoped."productId" = ${filters.productId}`);
    }

    return this.prisma.$queryRaw<{
      date: Date;
      balanceConsumptionUsd: Prisma.Decimal;
      creditConsumption: number;
      totalTokens: number;
    }[]>(Prisma.sql`
      WITH scoped_usage AS (
        SELECT
          tu."id",
          tu."request_id" AS "requestId",
          tu."tenant_id" AS "tenantId",
          tu."product_id" AS "productId",
          tu."created_at" AS "createdAt",
          ak."user_id" AS "actorUserId",
          GREATEST(
            COALESCE(tu."total_tokens", 0),
            COALESCE(tu."prompt_tokens", 0) + COALESCE(tu."completion_tokens", 0)
          ) AS "totalTokens"
        FROM "token_usage" tu
        JOIN "api_keys" ak ON ak."id" = tu."api_key_id"
        WHERE ${Prisma.join(where, ' AND ')}
      ),
      allocation_totals AS (
        SELECT
          bca."token_usage_id" AS "tokenUsageId",
          SUM(bca."amount_usd") AS "balanceConsumptionUsd"
        FROM "balance_consumption_allocations" bca
        JOIN scoped_usage scoped ON scoped."id" = bca."token_usage_id"
        WHERE ${Prisma.join(ledgerFilters, ' AND ')}
          AND bca."tenant_id" = scoped."tenantId"
          AND bca."user_id" = scoped."actorUserId"
          AND (
            scoped."productId" IS NULL
            OR bca."product_id" = scoped."productId"
          )
        GROUP BY bca."token_usage_id"
      ),
      credit_totals AS (
        SELECT
          scoped."id" AS "tokenUsageId",
          SUM(ABS(ct."credits_amount"))::bigint AS "creditConsumption"
        FROM scoped_usage scoped
        JOIN "credit_transactions" ct
          ON scoped."requestId" IS NOT NULL
          AND ct."request_id" = scoped."requestId"
        WHERE ${Prisma.join(ledgerFilters, ' AND ')}
          AND ct."type" = 'CONSUME'
          AND ct."tenant_id" = scoped."tenantId"
          AND ct."user_id" = scoped."actorUserId"
          AND (
            scoped."productId" IS NULL
            OR ct."product_id" = scoped."productId"
          )
        GROUP BY scoped."id"
      )
      SELECT
        DATE_TRUNC('day', scoped."createdAt") AS "date",
        COALESCE(SUM(alloc."balanceConsumptionUsd"), 0) AS "balanceConsumptionUsd",
        COALESCE(SUM(credit."creditConsumption"), 0)::int AS "creditConsumption",
        COALESCE(SUM(scoped."totalTokens"), 0)::int AS "totalTokens"
      FROM scoped_usage scoped
      LEFT JOIN allocation_totals alloc ON alloc."tokenUsageId" = scoped."id"
      LEFT JOIN credit_totals credit ON credit."tokenUsageId" = scoped."id"
      GROUP BY DATE_TRUNC('day', scoped."createdAt")
      ORDER BY "date" ASC
    `);
  }

  async findTokenUsageItems(
    filters: TokenUsageFilters,
    page: number,
    pageSize: number,
  ) {
    return this.prisma.tokenUsage.findMany({
      where: this.tokenUsageWhere(filters),
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, (page - 1) * pageSize),
      take: pageSize,
      select: {
        id: true,
        apiKeyId: true,
        productId: true,
        model: true,
        pricingTierKey: true,
        promptTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        completionTokens: true,
        totalTokens: true,
        costUsd: true,
        createdAt: true,
        balanceTransaction: { select: { amountUsd: true } },
        consumptionAllocations: {
          select: {
            amountUsd: true,
            recognizedRevenueUsd: true,
            bonusConsumedUsd: true,
          },
        },
      },
    });
  }

  async countTokenUsageItems(filters: TokenUsageFilters): Promise<number> {
    return this.prisma.tokenUsage.count({
      where: this.tokenUsageWhere(filters),
    });
  }

  async aggregateTokenUsageSummary(
    filters: TokenUsageFilters,
    page: number,
    pageSize: number,
  ): Promise<{
    items: Array<{
      date: string;
      apiKeyId: string;
      apiKeyName: string;
      apiKeyPrefix: string;
      model: string;
      calls: number;
      totalTokens: number;
      promptTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      completionTokens: number;
      costUsd: Prisma.Decimal;
      paymentDeductionUsd: Prisma.Decimal;
      voucherDeductionUsd: Prisma.Decimal;
    }>;
    total: number;
  }> {
    const where = this.tokenUsageSqlFilters(filters);
    const skip = Math.max(0, (page - 1) * pageSize);

    const rows = await this.prisma.$queryRaw<
      Array<{
        date: string;
        apiKeyId: string;
        apiKeyName: string;
        apiKeyPrefix: string;
        model: string;
        calls: number | bigint;
        totalTokens: number | bigint;
        promptTokens: number | bigint;
        cachedInputTokens: number | bigint;
        cacheWriteInputTokens: number | bigint;
        completionTokens: number | bigint;
        costUsd: Prisma.Decimal;
        paymentDeductionUsd: Prisma.Decimal;
        voucherDeductionUsd: Prisma.Decimal;
        totalGroups: number | bigint;
      }>
    >(Prisma.sql`
      WITH scoped_usage AS MATERIALIZED (
        SELECT
          tu.id,
          tu.created_at,
          tu.api_key_id,
          tu.model,
          tu.total_tokens,
          tu.prompt_tokens,
          tu.cached_input_tokens,
          tu.cache_write_input_tokens,
          tu.completion_tokens,
          tu.cost_usd,
          ak.name AS "apiKeyName",
          ak.prefix AS "apiKeyPrefix"
        FROM token_usage tu
        JOIN api_keys ak ON ak.id = tu.api_key_id
        WHERE ${Prisma.join(where, ' AND ')}
      ),
      allocation_totals AS (
        SELECT
          bca.token_usage_id AS "tokenUsageId",
          SUM(bca.amount_usd) AS "allocationAmountUsd",
          SUM(bca.recognized_revenue_usd) AS "paymentDeductionUsd",
          SUM(bca.bonus_consumed_usd) AS "voucherDeductionUsd"
        FROM balance_consumption_allocations bca
        JOIN scoped_usage scoped ON scoped.id = bca.token_usage_id
        GROUP BY bca.token_usage_id
      ),
      grouped AS (
        SELECT
          ${TOKEN_USAGE_SHANGHAI_DATE_SQL}::text AS "date",
          tu.api_key_id AS "apiKeyId",
          tu."apiKeyName" AS "apiKeyName",
          tu."apiKeyPrefix" AS "apiKeyPrefix",
          tu.model AS "model",
          COUNT(*)::bigint AS "calls",
          SUM(
            GREATEST(
              COALESCE(tu.total_tokens, 0),
              COALESCE(tu.prompt_tokens, 0) + COALESCE(tu.completion_tokens, 0)
            )
          )::bigint AS "totalTokens",
          SUM(COALESCE(tu.prompt_tokens, 0))::bigint AS "promptTokens",
          SUM(COALESCE(tu.cached_input_tokens, 0))::bigint AS "cachedInputTokens",
          SUM(COALESCE(tu.cache_write_input_tokens, 0))::bigint AS "cacheWriteInputTokens",
          SUM(COALESCE(tu.completion_tokens, 0))::bigint AS "completionTokens",
          SUM(
            COALESCE(
              alloc."allocationAmountUsd",
              CASE WHEN tu.cost_usd > 0 THEN tu.cost_usd ELSE ABS(tu.cost_usd) END
            )
          ) AS "costUsd",
          SUM(
            COALESCE(
              alloc."paymentDeductionUsd",
              CASE WHEN tu.cost_usd > 0 THEN tu.cost_usd ELSE ABS(tu.cost_usd) END
            )
          ) AS "paymentDeductionUsd",
          SUM(COALESCE(alloc."voucherDeductionUsd", 0)) AS "voucherDeductionUsd"
        FROM scoped_usage tu
        LEFT JOIN allocation_totals alloc ON alloc."tokenUsageId" = tu.id
        GROUP BY
          ${TOKEN_USAGE_SHANGHAI_DATE_SQL},
          tu.api_key_id,
          tu."apiKeyName",
          tu."apiKeyPrefix",
          tu.model
      )
      SELECT *, COUNT(*) OVER()::bigint AS "totalGroups"
      FROM grouped
      ORDER BY "date" DESC, "apiKeyName" ASC, "model" ASC
      OFFSET ${skip}
      LIMIT ${pageSize}
    `);

    return {
      items: rows.map((row) => ({
        date: row.date,
        apiKeyId: row.apiKeyId,
        apiKeyName: row.apiKeyName,
        apiKeyPrefix: row.apiKeyPrefix,
        model: row.model,
        calls: Number(row.calls),
        totalTokens: Number(row.totalTokens),
        promptTokens: Number(row.promptTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        cacheWriteInputTokens: Number(row.cacheWriteInputTokens),
        completionTokens: Number(row.completionTokens),
        costUsd: row.costUsd,
        paymentDeductionUsd: row.paymentDeductionUsd,
        voucherDeductionUsd: row.voucherDeductionUsd,
      })),
      total: rows.length > 0 ? Number(rows[0].totalGroups) : 0,
    };
  }

  async aggregateTokenUsagePeriodSummary(
    filters: TokenUsageFilters,
    granularity: TokenUsagePeriodGranularity,
  ): Promise<Array<{
    period: string;
    calls: number;
    totalTokens: number;
    costUsd: Prisma.Decimal;
    paymentDeductionUsd: Prisma.Decimal;
    voucherDeductionUsd: Prisma.Decimal;
  }>> {
    const where = this.tokenUsageSqlFilters(filters);
    const periodSql = granularity === 'month'
      ? Prisma.sql`TO_CHAR(${TOKEN_USAGE_SHANGHAI_DATE_SQL}, 'YYYY-MM')`
      : Prisma.sql`${TOKEN_USAGE_SHANGHAI_DATE_SQL}::text`;

    const rows = await this.prisma.$queryRaw<Array<{
      period: string;
      calls: number | bigint;
      totalTokens: number | bigint;
      costUsd: Prisma.Decimal;
      paymentDeductionUsd: Prisma.Decimal;
      voucherDeductionUsd: Prisma.Decimal;
    }>>(Prisma.sql`
      WITH scoped_usage AS MATERIALIZED (
        SELECT
          tu.id,
          tu.created_at,
          tu.total_tokens,
          tu.prompt_tokens,
          tu.completion_tokens,
          tu.cost_usd
        FROM token_usage tu
        JOIN api_keys ak ON ak.id = tu.api_key_id
        WHERE ${Prisma.join(where, ' AND ')}
      ),
      allocation_totals AS (
        SELECT
          bca.token_usage_id AS "tokenUsageId",
          SUM(bca.amount_usd) AS "allocationAmountUsd",
          SUM(bca.recognized_revenue_usd) AS "paymentDeductionUsd",
          SUM(bca.bonus_consumed_usd) AS "voucherDeductionUsd"
        FROM balance_consumption_allocations bca
        JOIN scoped_usage scoped ON scoped.id = bca.token_usage_id
        GROUP BY bca.token_usage_id
      )
      SELECT
        ${periodSql} AS "period",
        COUNT(*)::bigint AS "calls",
        SUM(
          GREATEST(
            COALESCE(tu.total_tokens, 0),
            COALESCE(tu.prompt_tokens, 0) + COALESCE(tu.completion_tokens, 0)
          )
        )::bigint AS "totalTokens",
        SUM(
          COALESCE(
            alloc."allocationAmountUsd",
            CASE WHEN tu.cost_usd > 0 THEN tu.cost_usd ELSE ABS(tu.cost_usd) END
          )
        ) AS "costUsd",
        SUM(
          COALESCE(
            alloc."paymentDeductionUsd",
            CASE WHEN tu.cost_usd > 0 THEN tu.cost_usd ELSE ABS(tu.cost_usd) END
          )
        ) AS "paymentDeductionUsd",
        SUM(COALESCE(alloc."voucherDeductionUsd", 0)) AS "voucherDeductionUsd"
      FROM scoped_usage tu
      LEFT JOIN allocation_totals alloc ON alloc."tokenUsageId" = tu.id
      GROUP BY ${periodSql}
      ORDER BY "period" DESC
    `);

    return rows.map((row) => ({
      period: row.period,
      calls: Number(row.calls),
      totalTokens: Number(row.totalTokens),
      costUsd: row.costUsd,
      paymentDeductionUsd: row.paymentDeductionUsd,
      voucherDeductionUsd: row.voucherDeductionUsd,
    }));
  }

  // ============================
  // 月账单汇总（Task 2）
  // ============================

  async monthlyBalanceSummary(
    userId: string,
    yearStart: Date,
    yearEnd: Date,
    subject: BillingSubjectFilter = {},
    productId?: string,
  ): Promise<{ month: Date; consumeUsd: Prisma.Decimal; rechargeUsd: Prisma.Decimal }[]> {
    const filters = [
      Prisma.sql`bt."tenant_id" = ${this.requireTenantId(subject)}`,
      Prisma.sql`bt."created_at" >= ${yearStart}`,
      Prisma.sql`bt."created_at" < ${yearEnd}`,
    ];
    if (productId) filters.push(Prisma.sql`bt."product_id" = ${productId}`);
    return this.prisma.$queryRaw`
      SELECT DATE_TRUNC('month', bt."created_at") AS month,
             COALESCE(SUM(CASE WHEN bt."type" = 'CONSUME' THEN ABS(bt."amount_usd") ELSE 0 END), 0) AS "consumeUsd",
             COALESCE(SUM(CASE WHEN bt."type" = 'RECHARGE' THEN bt."amount_usd" ELSE 0 END), 0) AS "rechargeUsd"
      FROM "balance_transactions" bt
      WHERE ${Prisma.join(filters, ' AND ')}
      GROUP BY DATE_TRUNC('month', bt."created_at")
      ORDER BY month ASC
    `;
  }

  async monthlyCreditSummary(
    userId: string,
    yearStart: Date,
    yearEnd: Date,
    subject: BillingSubjectFilter = {},
    productId?: string,
  ): Promise<{ month: Date; consumeCredits: number; grantCredits: number; bonusCredits: number }[]> {
    const filters = [
      Prisma.sql`ct."tenant_id" = ${this.requireTenantId(subject)}`,
      Prisma.sql`ct."created_at" >= ${yearStart}`,
      Prisma.sql`ct."created_at" < ${yearEnd}`,
    ];
    if (productId) filters.push(Prisma.sql`ct."product_id" = ${productId}`);
    return this.prisma.$queryRaw`
      SELECT DATE_TRUNC('month', ct."created_at") AS month,
             COALESCE(SUM(CASE WHEN ct."type" = 'CONSUME' THEN ABS(ct."credits_amount") ELSE 0 END), 0)::int AS "consumeCredits",
             COALESCE(SUM(CASE WHEN ct."type" = 'QUOTA_GRANT' THEN ct."credits_amount" ELSE 0 END), 0)::int AS "grantCredits",
             COALESCE(SUM(CASE WHEN ct."type" = 'BONUS_PURCHASE' THEN ct."credits_amount" ELSE 0 END), 0)::int AS "bonusCredits"
      FROM "credit_transactions" ct
      WHERE ${Prisma.join(filters, ' AND ')}
      GROUP BY DATE_TRUNC('month', ct."created_at")
      ORDER BY month ASC
    `;
  }

  private balanceSubjectWhere(userId: string, subject: BillingSubjectFilter) {
    void userId;
    return {
      tenantId: this.requireTenantId(subject),
    };
  }

  private tokenUsageWhere(filters: TokenUsageFilters): Prisma.TokenUsageWhereInput {
    return {
      apiKey: {
        tenantId: this.requireTenantId(filters),
        ...(filters.apiKeyUserId ? { userId: filters.apiKeyUserId } : {}),
      },
      ...(filters.apiKeyId ? { apiKeyId: filters.apiKeyId } : {}),
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.model ? { model: filters.model } : {}),
      ...(filters.createdAt ? { createdAt: filters.createdAt } : {}),
    };
  }

  private tokenUsageSqlFilters(filters: TokenUsageFilters): Prisma.Sql[] {
    const tenantId = this.requireTenantId(filters);
    const sqlFilters = [
      Prisma.sql`ak.tenant_id = ${tenantId}`,
      Prisma.sql`tu.tenant_id = ${tenantId}`,
    ];
    if (filters.apiKeyUserId) sqlFilters.push(Prisma.sql`ak.user_id = ${filters.apiKeyUserId}`);
    if (filters.apiKeyId) sqlFilters.push(Prisma.sql`tu.api_key_id = ${filters.apiKeyId}`);
    if (filters.productId) sqlFilters.push(Prisma.sql`tu.product_id = ${filters.productId}`);
    if (filters.model) sqlFilters.push(Prisma.sql`tu.model = ${filters.model}`);
    if (filters.createdAt?.gte) sqlFilters.push(Prisma.sql`tu.created_at >= ${filters.createdAt.gte}`);
    if (filters.createdAt?.lt) sqlFilters.push(Prisma.sql`tu.created_at < ${filters.createdAt.lt}`);
    return sqlFilters;
  }

  private requireTenantId(subject: BillingSubjectFilter): string {
    const tenantId = subject.tenantId?.trim();
    if (!tenantId) throw new Error('tenantId is required for billing queries');
    return tenantId;
  }

  private requireBillingAccountId(subject: BillingSubjectFilter): string {
    const billingAccountId = subject.billingAccountId?.trim();
    if (!billingAccountId) throw new Error('billingAccountId is required for billing queries');
    return billingAccountId;
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CountedRow = { total_count: bigint | number | string | null };

type GatewayEventGapRow = CountedRow & {
  id: string;
  request_id: string;
  status: string;
  created_at: Date;
};

type TokenUsageLedgerGapRow = CountedRow & {
  id: string;
  request_id: string | null;
  api_key_id: string;
  tenant_id: string;
  product_id: string | null;
  customer_charge_policy: string;
  cost_usd: Prisma.Decimal | string | number;
  created_at: Date;
};

type WalletMismatchRow = CountedRow & {
  billing_account_id: string;
  wallet_balance_usd: Prisma.Decimal | string | number;
  ledger_balance_usd: Prisma.Decimal | string | number;
  diff_usd: Prisma.Decimal | string | number;
};

type ProviderCostSummaryRow = {
  total_count: bigint | number | string | null;
  priced_count: bigint | number | string | null;
  missing_count: bigint | number | string | null;
  customer_charge_usd: Prisma.Decimal | string | number | null;
  provider_cost_estimate_usd: Prisma.Decimal | string | number | null;
  estimated_gross_margin_usd: Prisma.Decimal | string | number | null;
};

type MissingProviderCostRow = CountedRow & {
  id: string;
  request_id: string | null;
  provider_code: string | null;
  model: string;
  customer_charge_usd: Prisma.Decimal | string | number;
  created_at: Date;
};

export interface AccountingReconciliationReport {
  generatedAt: string;
  sampleLimit: number;
  toleranceUsd: string;
  providerCostWindowHours: number;
  gatewayEventsWithoutTokenUsage: {
    count: number;
    samples: Array<{
      id: string;
      requestId: string;
      status: string;
      createdAt: string;
    }>;
  };
  paygTokenUsageWithoutBalanceLedger: {
    count: number;
    samples: Array<{
      id: string;
      requestId: string | null;
      apiKeyId: string;
      tenantId: string;
      productId: string | null;
      customerChargePolicy: string;
      costUsd: string;
      createdAt: string;
    }>;
  };
  creditTokenUsageWithoutCreditLedger: {
    count: number;
    samples: Array<{
      id: string;
      requestId: string | null;
      apiKeyId: string;
      tenantId: string;
      productId: string | null;
      customerChargePolicy: string;
      costUsd: string;
      createdAt: string;
    }>;
  };
  accountWalletLedgerMismatches: {
    count: number;
    samples: Array<{
      billingAccountId: string;
      walletBalanceUsd: string;
      ledgerBalanceUsd: string;
      diffUsd: string;
    }>;
  };
  providerCostEstimates: {
    totalRequests: number;
    pricedRequests: number;
    missingRequests: number;
    coverageRate: number;
    customerChargeUsd: string;
    providerCostEstimateUsd: string;
    estimatedGrossMarginUsd: string;
    missingSamples: Array<{
      id: string;
      requestId: string | null;
      providerCode: string | null;
      model: string;
      customerChargeUsd: string;
      createdAt: string;
    }>;
  };
}

@Injectable()
export class AccountingReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async buildReport(opts: {
    sampleLimit?: number;
    toleranceUsd?: string;
    providerCostWindowHours?: number;
  } = {}): Promise<AccountingReconciliationReport> {
    const sampleLimit = this.normalizeLimit(opts.sampleLimit);
    const toleranceUsd = this.normalizeTolerance(opts.toleranceUsd);
    const providerCostWindowHours = this.normalizeWindowHours(opts.providerCostWindowHours);

    const [
      gatewayEventsWithoutTokenUsage,
      paygTokenUsageWithoutBalanceLedger,
      creditTokenUsageWithoutCreditLedger,
      accountWalletLedgerMismatches,
      providerCostEstimates,
    ] = await Promise.all([
      this.gatewayEventsWithoutTokenUsage(sampleLimit),
      this.paygTokenUsageWithoutBalanceLedger(sampleLimit),
      this.creditTokenUsageWithoutCreditLedger(sampleLimit),
      this.accountWalletLedgerMismatches(sampleLimit, toleranceUsd),
      this.providerCostEstimates(sampleLimit, providerCostWindowHours),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      sampleLimit,
      toleranceUsd: toleranceUsd.toString(),
      providerCostWindowHours,
      gatewayEventsWithoutTokenUsage,
      paygTokenUsageWithoutBalanceLedger,
      creditTokenUsageWithoutCreditLedger,
      accountWalletLedgerMismatches,
      providerCostEstimates,
    };
  }

  private async providerCostEstimates(sampleLimit: number, windowHours: number) {
    const [summaryRows, missingRows] = await Promise.all([
      this.prisma.$queryRaw<ProviderCostSummaryRow[]>`
        SELECT
          COUNT(*) AS "total_count",
          COUNT(*) FILTER (WHERE "provider_cost_estimate_usd" IS NOT NULL) AS "priced_count",
          COUNT(*) FILTER (WHERE "provider_cost_estimate_usd" IS NULL) AS "missing_count",
          COALESCE(SUM("customer_charge_usd"), 0) AS "customer_charge_usd",
          COALESCE(SUM("provider_cost_estimate_usd"), 0) AS "provider_cost_estimate_usd",
          COALESCE(
            SUM("customer_charge_usd" - "provider_cost_estimate_usd")
              FILTER (WHERE "provider_cost_estimate_usd" IS NOT NULL),
            0
          ) AS "estimated_gross_margin_usd"
        FROM "token_usage"
        WHERE "created_at" >= NOW() - (${windowHours} * INTERVAL '1 hour')
      `,
      this.prisma.$queryRaw<MissingProviderCostRow[]>`
        SELECT
          "id",
          "request_id",
          "provider_code",
          "model",
          "customer_charge_usd",
          "created_at",
          COUNT(*) OVER() AS "total_count"
        FROM "token_usage"
        WHERE "created_at" >= NOW() - (${windowHours} * INTERVAL '1 hour')
          AND "provider_cost_estimate_usd" IS NULL
        ORDER BY "created_at" DESC
        LIMIT ${sampleLimit}
      `,
    ]);
    const summary = summaryRows[0];
    const totalRequests = this.numberValue(summary?.total_count ?? 0);
    const pricedRequests = this.numberValue(summary?.priced_count ?? 0);
    return {
      totalRequests,
      pricedRequests,
      missingRequests: this.numberValue(summary?.missing_count ?? 0),
      coverageRate: totalRequests > 0 ? pricedRequests / totalRequests : 1,
      customerChargeUsd: this.decimalString(summary?.customer_charge_usd ?? 0),
      providerCostEstimateUsd: this.decimalString(summary?.provider_cost_estimate_usd ?? 0),
      estimatedGrossMarginUsd: this.decimalString(summary?.estimated_gross_margin_usd ?? 0),
      missingSamples: missingRows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        providerCode: row.provider_code,
        model: row.model,
        customerChargeUsd: this.decimalString(row.customer_charge_usd),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  private async gatewayEventsWithoutTokenUsage(sampleLimit: number) {
    const rows = await this.prisma.$queryRaw<GatewayEventGapRow[]>`
      SELECT
        gbe."id",
        gbe."request_id",
        gbe."status",
        gbe."created_at",
        COUNT(*) OVER() AS "total_count"
      FROM "gateway_billing_events" gbe
      LEFT JOIN "token_usage" tu ON tu."gateway_billing_event_id" = gbe."id"
      WHERE gbe."status" = 'DEDUCTED'
        AND tu."id" IS NULL
      ORDER BY gbe."created_at" DESC
      LIMIT ${sampleLimit}
    `;
    return {
      count: this.countFromRows(rows),
      samples: rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  private async paygTokenUsageWithoutBalanceLedger(sampleLimit: number) {
    const rows = await this.prisma.$queryRaw<TokenUsageLedgerGapRow[]>`
      SELECT
        tu."id",
        tu."request_id",
        tu."api_key_id",
        tu."tenant_id",
        tu."product_id",
        tu."customer_charge_policy",
        tu."cost_usd",
        tu."created_at",
        COUNT(*) OVER() AS "total_count"
      FROM "token_usage" tu
      LEFT JOIN "balance_transactions" bt ON bt."token_usage_id" = tu."id"
      WHERE tu."customer_charge_policy" = 'payg_balance'
        AND tu."customer_charge_usd" > 0
        AND bt."id" IS NULL
      ORDER BY tu."created_at" DESC
      LIMIT ${sampleLimit}
    `;
    return this.mapTokenUsageLedgerGap(rows);
  }

  private async creditTokenUsageWithoutCreditLedger(sampleLimit: number) {
    const rows = await this.prisma.$queryRaw<TokenUsageLedgerGapRow[]>`
      SELECT
        tu."id",
        tu."request_id",
        tu."api_key_id",
        tu."tenant_id",
        tu."product_id",
        tu."customer_charge_policy",
        tu."cost_usd",
        tu."created_at",
        COUNT(*) OVER() AS "total_count"
      FROM "token_usage" tu
      LEFT JOIN "credit_transactions" ct
        ON ct."request_id" = tu."request_id"
       AND ct."type" = 'CONSUME'
      WHERE tu."customer_charge_policy" = 'subscription_credits'
        AND tu."request_id" IS NOT NULL
        AND ct."id" IS NULL
      ORDER BY tu."created_at" DESC
      LIMIT ${sampleLimit}
    `;
    return this.mapTokenUsageLedgerGap(rows);
  }

  private async accountWalletLedgerMismatches(
    sampleLimit: number,
    toleranceUsd: Prisma.Decimal,
  ) {
    const rows = await this.prisma.$queryRaw<WalletMismatchRow[]>`
      WITH ledger AS (
        SELECT
          "billing_account_id",
          COALESCE(SUM("amount_usd"), 0) AS "ledger_balance_usd"
        FROM "balance_transactions"
        WHERE "billing_account_id" IS NOT NULL
        GROUP BY "billing_account_id"
      ),
      mismatches AS (
        SELECT
          aw."billing_account_id",
          aw."balance_usd" AS "wallet_balance_usd",
          COALESCE(ledger."ledger_balance_usd", 0) AS "ledger_balance_usd",
          aw."balance_usd" - COALESCE(ledger."ledger_balance_usd", 0) AS "diff_usd"
        FROM "account_wallets" aw
        LEFT JOIN ledger ON ledger."billing_account_id" = aw."billing_account_id"
        WHERE ABS(aw."balance_usd" - COALESCE(ledger."ledger_balance_usd", 0)) > ${toleranceUsd}
      )
      SELECT
        *,
        COUNT(*) OVER() AS "total_count"
      FROM mismatches
      ORDER BY ABS("diff_usd") DESC
      LIMIT ${sampleLimit}
    `;
    return {
      count: this.countFromRows(rows),
      samples: rows.map((row) => ({
        billingAccountId: row.billing_account_id,
        walletBalanceUsd: this.decimalString(row.wallet_balance_usd),
        ledgerBalanceUsd: this.decimalString(row.ledger_balance_usd),
        diffUsd: this.decimalString(row.diff_usd),
      })),
    };
  }

  private mapTokenUsageLedgerGap(rows: TokenUsageLedgerGapRow[]) {
    return {
      count: this.countFromRows(rows),
      samples: rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        apiKeyId: row.api_key_id,
        tenantId: row.tenant_id,
        productId: row.product_id,
        customerChargePolicy: row.customer_charge_policy,
        costUsd: this.decimalString(row.cost_usd),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  private normalizeLimit(value: number | undefined): number {
    if (!Number.isFinite(value) || !value) return 20;
    return Math.min(100, Math.max(1, Math.floor(value)));
  }

  private normalizeTolerance(value: string | undefined): Prisma.Decimal {
    if (!value?.trim()) return new Prisma.Decimal('0.000001');
    let decimal: Prisma.Decimal;
    try {
      decimal = new Prisma.Decimal(value.trim());
    } catch {
      throw new BadRequestException('toleranceUsd 必须是数字');
    }
    return decimal.isNegative() ? decimal.abs() : decimal;
  }

  private normalizeWindowHours(value: number | undefined): number {
    if (!Number.isFinite(value) || !value) return 24;
    return Math.min(24 * 90, Math.max(1, Math.floor(value)));
  }

  private countFromRows(rows: CountedRow[]): number {
    return this.numberValue(rows[0]?.total_count ?? 0);
  }

  private numberValue(value: bigint | number | string | null): number {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    return 0;
  }

  private decimalString(value: Prisma.Decimal | string | number): string {
    return value instanceof Prisma.Decimal ? value.toString() : String(value);
  }
}

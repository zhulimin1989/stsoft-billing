import { Injectable } from '@nestjs/common';
import { InvoiceLineDescription, Prisma } from '@prisma/client';
import { usdToCents } from '../billing/money';
import { PrismaService } from '../prisma/prisma.service';
import {
  INVOICEABLE_MIN_AGE_MS,
  INVOICEABLE_ORDER_STATUSES,
  InvoiceSourceOrder,
  InvoiceSourceOrderLike,
  invoiceLineDescriptionForWholeOrder,
  invoiceProductNameForWholeOrder,
  invoiceSourceOrderSelect,
  invoiceableOrderBaseCents,
  isRechargeInvoiceSource,
} from './invoice-source.util';

type Tx = PrismaService | Prisma.TransactionClient;

export interface InvoiceSourceBase {
  baseCents: number;
  consumedPrincipalCents: number;
}

export interface InvoicePeriodSourceRow {
  period: string;
  orderId: string;
  orderType: string;
  currency: string;
  orderAmountCents: number;
  totalBaseCents: number;
  periodConsumedPrincipalCents: number;
  totalConsumedPrincipalCents: number;
  recordCount: number;
  productName: string | null;
  description: InvoiceLineDescription;
}

interface PeriodRowsInput {
  userId: string;
  tenantId: string;
  billingAccountId: string;
  start: Date;
  end: Date;
  paidBefore: Date;
}

interface InvoiceSourceStrategy {
  supports(order: InvoiceSourceOrderLike): boolean;
  computeBases(
    orders: InvoiceSourceOrderLike[],
    client: Tx,
  ): Promise<Map<string, InvoiceSourceBase>>;
  listPeriodRows(input: PeriodRowsInput, client: Tx): Promise<InvoicePeriodSourceRow[]>;
}

@Injectable()
export class InvoiceSourceService {
  private readonly strategies: InvoiceSourceStrategy[] = [
    new RechargeConsumptionInvoiceSourceStrategy(),
    new PaidOrderInvoiceSourceStrategy(),
  ];

  constructor(private readonly prisma: PrismaService) {}

  async listInvoiceableOrders(input: {
    userId: string;
    tenantId: string;
    paidBefore?: Date;
    client?: Tx;
  }): Promise<InvoiceSourceOrder[]> {
    const client = input.client ?? this.prisma;
    return client.order.findMany({
      where: {
        userId: input.userId,
        tenantId: input.tenantId,
        status: { in: INVOICEABLE_ORDER_STATUSES },
        refundedAt: null,
        amountCents: { gt: 0 },
        paidAt: { lte: input.paidBefore ?? invoiceablePaidBefore() },
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: invoiceSourceOrderSelect,
    });
  }

  async findOrdersByIds(input: {
    userId: string;
    tenantId: string;
    orderIds: string[];
    client?: Tx;
  }): Promise<InvoiceSourceOrder[]> {
    if (input.orderIds.length === 0) return [];
    const client = input.client ?? this.prisma;
    return client.order.findMany({
      where: {
        id: { in: input.orderIds },
        userId: input.userId,
        tenantId: input.tenantId,
      },
      select: invoiceSourceOrderSelect,
    });
  }

  async computeBaseForOrder(
    order: InvoiceSourceOrderLike,
    client: Tx = this.prisma,
  ): Promise<InvoiceSourceBase> {
    const bases = await this.computeBasesForOrders([order], client);
    return bases.get(order.id) ?? { baseCents: 0, consumedPrincipalCents: 0 };
  }

  async computeBasesForOrders(
    orders: InvoiceSourceOrderLike[],
    client: Tx = this.prisma,
  ): Promise<Map<string, InvoiceSourceBase>> {
    const result = new Map<string, InvoiceSourceBase>();
    const ordersByStrategy = new Map<InvoiceSourceStrategy, InvoiceSourceOrderLike[]>();
    for (const order of orders) {
      const strategy = this.resolveStrategy(order);
      if (!strategy) continue;
      const list = ordersByStrategy.get(strategy) ?? [];
      list.push(order);
      ordersByStrategy.set(strategy, list);
    }

    await Promise.all(
      [...ordersByStrategy.entries()].map(async ([strategy, matched]) => {
        const bases = await strategy.computeBases(matched, client);
        for (const [orderId, base] of bases.entries()) {
          result.set(orderId, base);
        }
      }),
    );
    return result;
  }

  private resolveStrategy(order: InvoiceSourceOrderLike): InvoiceSourceStrategy | null {
    return this.strategies.find((strategy) => strategy.supports(order)) ?? null;
  }

  async listDomesticPeriodRows(input: {
    userId: string;
    tenantId: string;
    billingAccountId: string;
    start: Date;
    end: Date;
    client?: Tx;
  }): Promise<InvoicePeriodSourceRow[]> {
    const client = input.client ?? this.prisma;
    const paidBefore = invoiceablePaidBefore();
    const rows = (
      await Promise.all(
        this.strategies.map((strategy) =>
          strategy.listPeriodRows({ ...input, paidBefore }, client),
        ),
      )
    ).flat();
    return rows.sort((a, b) => b.period.localeCompare(a.period));
  }
}

class RechargeConsumptionInvoiceSourceStrategy implements InvoiceSourceStrategy {
  supports(order: InvoiceSourceOrderLike): boolean {
    return isRechargeInvoiceSource(order);
  }

  async computeBases(
    orders: InvoiceSourceOrderLike[],
    client: Tx,
  ): Promise<Map<string, InvoiceSourceBase>> {
    const orderIds = orders.map((order) => order.id);
    const consumedMap = await this.loadConsumedPrincipalCentsByOrder(orderIds, client);
    return new Map(
      orders.map((order) => {
        const consumedPrincipalCents = consumedMap.get(order.id) ?? 0;
        return [
          order.id,
          {
            consumedPrincipalCents,
            // Overseas order-level recharge invoices are based on the paid recharge amount
            // after the 24h cool-off period. Domestic monthly invoices still use listPeriodRows.
            baseCents: Math.max(0, order.amountCents),
          },
        ];
      }),
    );
  }

  async listPeriodRows(
    input: PeriodRowsInput,
    client: Tx,
  ): Promise<InvoicePeriodSourceRow[]> {
    // Personal and team workspaces can share one account-wide wallet. The
    // allocation tenant remains usage attribution; billingAccountId is the
    // active financial boundary for recharge consumption and invoicing.
    const rows = await client.$queryRaw<Array<{
      period: string;
      order_id: string;
      currency: string;
      order_amount_cents: number;
      period_usd: Prisma.Decimal | null;
      total_usd: Prisma.Decimal | null;
      record_count: bigint | number;
      product_name: string | null;
    }>>`
      WITH invoice_principal_facts AS NOT MATERIALIZED (
        -- Preserve the existing direct grant-allocation source. Settlement facts
        -- are a separate, canonical grant reduction and must not be rewritten as
        -- synthetic BALANCE_GRANT allocations.
        SELECT
          a.created_at AS consumed_at,
          a.billing_account_id,
          g.order_id,
          a.recognized_revenue_usd::numeric AS paid_usd
        FROM balance_consumption_allocations a
        JOIN balance_grants g
          ON g.id = a.balance_grant_id
         AND g.billing_account_id = a.billing_account_id
        JOIN balance_transactions consume_tx
          ON consume_tx.id = a.balance_transaction_id
         AND consume_tx.billing_account_id = a.billing_account_id
         AND consume_tx.type::text = 'CONSUME'
        WHERE a.billing_account_id = ${input.billingAccountId}
          AND a.source = 'BALANCE_GRANT'
          AND g.order_id IS NOT NULL

        UNION ALL

        -- A paid recharge can immediately settle earlier personal overdraft.
        -- enterprise_credit_settlements is the immutable bridge from that debt
        -- consumption to the grant/order whose usable principal was compressed.
        -- Keep the debt consumption time as the invoice service period;
        -- settlement.occurred_at remains the separate finance recognition time.
        SELECT
          debt.created_at AS consumed_at,
          settlement.billing_account_id,
          g.order_id,
          settlement.paid_usd::numeric AS paid_usd
        FROM enterprise_credit_settlements settlement
        JOIN balance_consumption_allocations debt
          ON debt.id = settlement.allocation_id
         AND debt.billing_account_id = settlement.billing_account_id
         AND debt.source = settlement.debt_source
        JOIN balance_transactions debt_tx
          ON debt_tx.id = debt.balance_transaction_id
         AND debt_tx.billing_account_id = debt.billing_account_id
         AND debt_tx.type::text = 'CONSUME'
        JOIN balance_grants g
          ON g.id = settlement.balance_grant_id
         AND g.billing_account_id = settlement.billing_account_id
        JOIN balance_transactions repayment_tx
          ON repayment_tx.id = settlement.repayment_transaction_id
         AND repayment_tx.billing_account_id = settlement.billing_account_id
         AND repayment_tx.type::text IN ('RECHARGE', 'ADJUST')
         AND repayment_tx.order_id = g.order_id
         AND repayment_tx.created_at = settlement.occurred_at
        WHERE settlement.billing_account_id = ${input.billingAccountId}
          AND settlement.debt_source = 'NEGATIVE_BALANCE'
          AND debt.source = 'NEGATIVE_BALANCE'
          AND debt.balance_grant_id IS NULL
          AND (
            (
              settlement.trigger = 'FUNDING'
              AND settlement.repair_run_id IS NULL
              AND settlement.repayment_transaction_id IS NOT NULL
            )
            OR (
              settlement.trigger = 'REPAIR'
              AND settlement.repair_run_id IS NOT NULL
              AND settlement.repayment_transaction_id IS NOT NULL
            )
          )
          AND settlement.paid_usd > 0
          AND g.order_id IS NOT NULL
      ),
      period_allocations AS (
        SELECT
          TO_CHAR((fact.consumed_at + INTERVAL '8 hours'), 'YYYY-MM') AS period,
          fact.order_id,
          COUNT(*) AS record_count,
          COALESCE(SUM(fact.paid_usd), 0)::numeric AS period_usd
        FROM invoice_principal_facts fact
        JOIN orders o
          ON o.id = fact.order_id
         AND o.billing_account_id = fact.billing_account_id
        WHERE fact.consumed_at >= ${input.start}
          AND fact.consumed_at < ${input.end}
          AND o.order_type::text = 'RECHARGE'
          AND LOWER(o.currency) = 'cny'
          AND o.status::text IN (${Prisma.join(INVOICEABLE_ORDER_STATUSES)})
          AND o.paid_at IS NOT NULL
          AND o.paid_at <= ${input.paidBefore}
          AND o.refunded_at IS NULL
        GROUP BY period, fact.order_id
      ),
      total_allocations AS (
        SELECT
          fact.order_id,
          COALESCE(SUM(fact.paid_usd), 0)::numeric AS total_usd
        FROM invoice_principal_facts fact
        WHERE fact.order_id IN (SELECT order_id FROM period_allocations)
        GROUP BY fact.order_id
      )
      SELECT
        pa.period,
        pa.order_id,
        o.currency,
        o.amount_cents AS order_amount_cents,
        pa.period_usd,
        ta.total_usd,
        pa.record_count,
        COALESCE(p.name, 'API 按量用量') AS product_name
      FROM period_allocations pa
      JOIN total_allocations ta ON ta.order_id = pa.order_id
      JOIN orders o ON o.id = pa.order_id
      LEFT JOIN products p ON p.id = o.product_id
      ORDER BY pa.period DESC, o.paid_at DESC NULLS LAST, o.created_at DESC
    `;

    return rows.map((row) => ({
      period: row.period,
      orderId: row.order_id,
      orderType: 'RECHARGE',
      currency: normalizeCurrency(row.currency),
      orderAmountCents: Number(row.order_amount_cents),
      totalBaseCents: Math.min(Number(row.order_amount_cents), usdToCents(row.total_usd ?? 0)),
      periodConsumedPrincipalCents: usdToCents(row.period_usd ?? 0),
      totalConsumedPrincipalCents: usdToCents(row.total_usd ?? 0),
      recordCount: Number(row.record_count),
      productName: row.product_name,
      description: 'RAYTONE_API',
    }));
  }

  private async loadConsumedPrincipalCentsByOrder(
    orderIds: string[],
    client: Tx,
  ): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await client.$queryRaw<Array<{ order_id: string; usd: Prisma.Decimal | null }>>`
      WITH selected_orders AS (
        SELECT id, billing_account_id
        FROM orders
        WHERE id IN (${Prisma.join(orderIds)})
      ),
      invoice_principal_facts AS (
        SELECT
          selected.id AS order_id,
          a.recognized_revenue_usd::numeric AS paid_usd
        FROM selected_orders selected
        JOIN balance_grants g
          ON g.order_id = selected.id
         AND g.billing_account_id = selected.billing_account_id
        JOIN balance_consumption_allocations a
          ON a.balance_grant_id = g.id
         AND a.billing_account_id = g.billing_account_id
        JOIN balance_transactions consume_tx
          ON consume_tx.id = a.balance_transaction_id
         AND consume_tx.billing_account_id = a.billing_account_id
         AND consume_tx.type::text = 'CONSUME'
        WHERE a.source = 'BALANCE_GRANT'

        UNION ALL

        SELECT
          selected.id AS order_id,
          settlement.paid_usd::numeric AS paid_usd
        FROM selected_orders selected
        JOIN balance_grants g
          ON g.order_id = selected.id
         AND g.billing_account_id = selected.billing_account_id
        JOIN enterprise_credit_settlements settlement
          ON settlement.balance_grant_id = g.id
         AND settlement.billing_account_id = g.billing_account_id
        JOIN balance_consumption_allocations debt
          ON debt.id = settlement.allocation_id
         AND debt.billing_account_id = settlement.billing_account_id
         AND debt.source = settlement.debt_source
        JOIN balance_transactions debt_tx
          ON debt_tx.id = debt.balance_transaction_id
         AND debt_tx.billing_account_id = debt.billing_account_id
         AND debt_tx.type::text = 'CONSUME'
        JOIN balance_transactions repayment_tx
          ON repayment_tx.id = settlement.repayment_transaction_id
         AND repayment_tx.billing_account_id = settlement.billing_account_id
         AND repayment_tx.type::text IN ('RECHARGE', 'ADJUST')
         AND repayment_tx.order_id = g.order_id
         AND repayment_tx.created_at = settlement.occurred_at
        WHERE settlement.debt_source = 'NEGATIVE_BALANCE'
          AND debt.source = 'NEGATIVE_BALANCE'
          AND debt.balance_grant_id IS NULL
          AND (
            (
              settlement.trigger = 'FUNDING'
              AND settlement.repair_run_id IS NULL
              AND settlement.repayment_transaction_id IS NOT NULL
            )
            OR (
              settlement.trigger = 'REPAIR'
              AND settlement.repair_run_id IS NOT NULL
              AND settlement.repayment_transaction_id IS NOT NULL
            )
          )
          AND settlement.paid_usd > 0
      )
      SELECT
        order_id,
        COALESCE(SUM(paid_usd), 0)::numeric AS usd
      FROM invoice_principal_facts
      GROUP BY order_id
    `;
    return new Map(rows.map((row) => [row.order_id, usdToCents(row.usd ?? 0)]));
  }
}

class PaidOrderInvoiceSourceStrategy implements InvoiceSourceStrategy {
  supports(order: InvoiceSourceOrderLike): boolean {
    return !isRechargeInvoiceSource(order);
  }

  async computeBases(
    orders: InvoiceSourceOrderLike[],
  ): Promise<Map<string, InvoiceSourceBase>> {
    return new Map(
      orders.map((order) => {
        const baseCents = invoiceableOrderBaseCents(order);
        return [order.id, { baseCents, consumedPrincipalCents: baseCents }];
      }),
    );
  }

  async listPeriodRows(
    input: PeriodRowsInput,
    client: Tx,
  ): Promise<InvoicePeriodSourceRow[]> {
    const orders = await client.order.findMany({
      where: {
        userId: input.userId,
        tenantId: input.tenantId,
        billingAccountId: input.billingAccountId,
        orderType: { not: 'RECHARGE' },
        status: { in: INVOICEABLE_ORDER_STATUSES },
        refundedAt: null,
        amountCents: { gt: 0 },
        currency: { equals: 'cny', mode: 'insensitive' },
        paidAt: { gte: input.start, lt: input.end, lte: input.paidBefore },
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: invoiceSourceOrderSelect,
    });

    return orders
      .filter((order) => order.paidAt)
      .map((order) => {
        const baseCents = Math.max(0, order.amountCents);
        return {
          period: toShanghaiPeriod(order.paidAt as Date),
          orderId: order.id,
          orderType: order.orderType,
          currency: normalizeCurrency(order.currency),
          orderAmountCents: order.amountCents,
          totalBaseCents: baseCents,
          periodConsumedPrincipalCents: baseCents,
          totalConsumedPrincipalCents: baseCents,
          recordCount: 1,
          productName: invoiceProductNameForWholeOrder(order),
          description: invoiceLineDescriptionForWholeOrder(order),
        };
      });
  }
}

function invoiceablePaidBefore(): Date {
  return new Date(Date.now() - INVOICEABLE_MIN_AGE_MS);
}

function normalizeCurrency(value: string): string {
  return value.trim().toLowerCase();
}

function toShanghaiPeriod(value: Date): string {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

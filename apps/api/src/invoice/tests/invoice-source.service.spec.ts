import { InvoiceSourceService } from '../invoice-source.service';

describe('InvoiceSourceService — 国内账期来源', () => {
  it('国内月账期的非充值付费订单只查询 CNY 订单', async () => {
    const orderFindMany = jest.fn(async () => []);
    const prisma = {
      $queryRaw: jest.fn(async () => []),
      order: {
        findMany: orderFindMany,
      },
    };
    const service = new InvoiceSourceService(prisma as never);

    await service.listDomesticPeriodRows({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-user-1',
      start: new Date('2026-05-01T00:00:00.000Z'),
      end: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billingAccountId: 'ba-user-1',
          orderType: { not: 'RECHARGE' },
          currency: { equals: 'cny', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('国内月账期的混合 Bundle 按整单金额入账，避免漏开非 TokenPlan 子项', async () => {
    const paidAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const orderFindMany = jest.fn(async () => [{
      id: 'bundle-order',
      orderType: 'BUNDLE',
      amountCents: 20_000,
      bonusCents: 0,
      currency: 'cny',
      status: 'PAID',
      refundedAt: null,
      paidAt,
      createdAt: paidAt,
      productId: null,
      product: null,
      plan: null,
      boosterPack: null,
      bundleSku: { name: '团队组合包' },
      items: [
        {
          name: 'TokenPlan Pro',
          amountCents: 12_000,
          currency: 'cny',
          productId: 'prod-token-plan',
          planId: 'plan-token-plan',
          boosterPackId: null,
          product: { name: 'TokenPlan', billingMode: 'CODING_PLAN' },
          plan: null,
          boosterPack: null,
        },
        {
          name: 'API Credits',
          amountCents: 8_000,
          currency: 'cny',
          productId: 'prod-api',
          planId: null,
          boosterPackId: 'booster-api',
          product: { name: 'Raytone API', billingMode: 'PAY_AS_YOU_GO' },
          plan: null,
          boosterPack: null,
        },
      ],
    }]);
    const prisma = {
      $queryRaw: jest.fn(async () => []),
      order: {
        findMany: orderFindMany,
      },
    };
    const service = new InvoiceSourceService(prisma as never);

    const rows = await service.listDomesticPeriodRows({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-user-1',
      start: new Date('2026-05-01T00:00:00.000Z'),
      end: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: 'bundle-order',
      orderType: 'BUNDLE',
      orderAmountCents: 20_000,
      totalBaseCents: 20_000,
      periodConsumedPrincipalCents: 20_000,
      totalConsumedPrincipalCents: 20_000,
      productName: '团队组合包',
      description: 'RAYTONE_API',
    });
  });

  it('充值消费按账务账户跨工作区聚合，并要求 allocation、grant 与 order 同账户', async () => {
    const queryRaw = jest.fn(async () => [{
      period: '2026-06',
      order_id: 'recharge-order',
      currency: 'cny',
      order_amount_cents: 500,
      period_usd: '5',
      total_usd: '5',
      record_count: BigInt(1_053),
      product_name: 'API 按量用量',
    }]);
    const prisma = {
      $queryRaw: queryRaw,
      order: { findMany: jest.fn(async () => []) },
    };
    const service = new InvoiceSourceService(prisma as never);

    const rows = await service.listDomesticPeriodRows({
      userId: 'owner-user',
      tenantId: 'personal-tenant',
      billingAccountId: 'ba-personal-owner',
      start: new Date('2026-05-31T16:00:00.000Z'),
      end: new Date('2026-06-30T16:00:00.000Z'),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        period: '2026-06',
        orderId: 'recharge-order',
        orderAmountCents: 500,
        totalBaseCents: 500,
        periodConsumedPrincipalCents: 500,
        totalConsumedPrincipalCents: 500,
        recordCount: 1_053,
      }),
    ]);
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = Array.from(strings).join('?');
    expect(sql).toContain('WHERE a.billing_account_id = ?');
    expect(sql).toContain('g.billing_account_id = a.billing_account_id');
    expect(sql).toContain('o.billing_account_id = fact.billing_account_id');
    expect(sql).toContain('enterprise_credit_settlements settlement');
    expect(sql).toContain('settlement.paid_usd::numeric AS paid_usd');
    expect(sql).toContain('a.recognized_revenue_usd::numeric AS paid_usd');
    expect(sql).toContain("a.source = 'BALANCE_GRANT'");
    expect(sql).toContain("settlement.debt_source = 'NEGATIVE_BALANCE'");
    expect(sql).toContain("consume_tx.type::text = 'CONSUME'");
    expect(sql).toContain("debt_tx.type::text = 'CONSUME'");
    expect(sql).toContain("repayment_tx.type::text IN ('RECHARGE', 'ADJUST')");
    expect(sql).toContain('repayment_tx.order_id = g.order_id');
    expect(sql).toContain('repayment_tx.created_at = settlement.occurred_at');
    expect(sql).toContain("settlement.trigger = 'FUNDING'");
    expect(sql).toContain("settlement.trigger = 'REPAIR'");
    expect(sql).toContain('settlement.repair_run_id IS NULL');
    expect(sql).toContain('settlement.repair_run_id IS NOT NULL');
    expect(sql).toContain('debt.created_at AS consumed_at');
    expect(sql).not.toContain('settlement.amount_usd::numeric AS paid_usd');
    expect(sql).not.toContain('settled_usd');
    expect(sql).not.toContain('a.user_id');
    expect(sql).not.toContain('a.tenant_id');
    expect(values.filter((value) => value === 'ba-personal-owner')).toHaveLength(2);
  });

  it('充值订单已消费本金同时汇总直接 allocation 与可证明的现金结清', async () => {
    const queryRaw = jest.fn(async () => [{
      order_id: 'recharge-order',
      usd: '1.34',
    }]);
    const prisma = {
      $queryRaw: queryRaw,
      order: { findMany: jest.fn(async () => []) },
    };
    const service = new InvoiceSourceService(prisma as never);

    await expect(service.computeBaseForOrder({
      id: 'recharge-order',
      orderType: 'RECHARGE',
      amountCents: 500,
      status: 'PAID',
      refundedAt: null,
      paidAt: new Date('2026-06-01T00:00:00.000Z'),
    })).resolves.toEqual({
      baseCents: 500,
      consumedPrincipalCents: 134,
    });

    const [strings] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = Array.from(strings).join('?');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('enterprise_credit_settlements settlement');
    expect(sql).toContain('settlement.paid_usd::numeric AS paid_usd');
    expect(sql).toContain('a.recognized_revenue_usd::numeric AS paid_usd');
    expect(sql).toContain("a.source = 'BALANCE_GRANT'");
    expect(sql).toContain("settlement.debt_source = 'NEGATIVE_BALANCE'");
    expect(sql).toContain("consume_tx.type::text = 'CONSUME'");
    expect(sql).toContain("debt_tx.type::text = 'CONSUME'");
    expect(sql).toContain("repayment_tx.type::text IN ('RECHARGE', 'ADJUST')");
    expect(sql).toContain('repayment_tx.order_id = g.order_id');
    expect(sql).toContain('repayment_tx.created_at = settlement.occurred_at');
    expect(sql).toContain("settlement.trigger = 'FUNDING'");
    expect(sql).toContain("settlement.trigger = 'REPAIR'");
    expect(sql).not.toContain('settled_usd');
  });
});

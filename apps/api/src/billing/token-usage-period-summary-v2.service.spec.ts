import { Prisma } from '@prisma/client';
import { TokenUsagePeriodSummaryV2Service } from './token-usage-period-summary-v2.service';
import type {
  TokenUsagePeriodSummaryV2Filters,
  TokenUsagePeriodSummaryV2Granularity,
  TokenUsagePeriodSummaryV2Scope,
} from './token-usage-period-summary-v2.repository';

function buildService() {
  const aggregate = jest.fn().mockImplementation(async (
    _scope: TokenUsagePeriodSummaryV2Scope,
    _filters: TokenUsagePeriodSummaryV2Filters,
    _granularity: TokenUsagePeriodSummaryV2Granularity,
  ) => [{
    period: '2026-10',
    calls: 7,
    totalTokens: 1234,
    consumeUsd: new Prisma.Decimal('87.932463091'),
    accountPayUsd: new Prisma.Decimal('80.5'),
    voucherUsd: new Prisma.Decimal('7.432463091'),
  }]);
  const repository = { aggregate };
  const service = new TokenUsagePeriodSummaryV2Service(repository as never);
  return { service, aggregate };
}

describe('TokenUsagePeriodSummaryV2Service', () => {
  it('scopes enterprise accounts by billing account (month bill source of truth)', async () => {
    const { service, aggregate } = buildService();

    await service.getPeriodSummary(
      { tenantId: 'tenant-1', billingAccountId: 'account-1', billingAccountType: 'enterprise' },
      { startDate: '2026-06-01', endDate: '2026-11-30', granularity: 'month' },
    );

    const [scope, filters, granularity] = aggregate.mock.calls[0]!;
    expect(scope).toEqual({ tenantId: 'tenant-1', billingAccountId: 'account-1', byBillingAccount: true });
    expect(granularity).toBe('month');
    expect(filters.startInclusive.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(filters.endExclusive.toISOString()).toBe('2026-11-30T16:00:00.000Z');
  });

  it('scopes personal accounts by workspace to keep v1 semantics', async () => {
    const { service, aggregate } = buildService();

    await service.getPeriodSummary(
      { tenantId: 'tenant-1', billingAccountId: 'account-1', billingAccountType: 'personal' },
      { startDate: '2026-11-04', endDate: '2026-11-11', granularity: 'day' },
    );

    const [scope, filters, granularity] = aggregate.mock.calls[0]!;
    expect(scope.byBillingAccount).toBe(false);
    expect(granularity).toBe('day');
    expect(filters.startInclusive.toISOString()).toBe('2026-11-03T16:00:00.000Z');
    expect(filters.endExclusive.toISOString()).toBe('2026-11-11T16:00:00.000Z');
  });

  it('maps billing channel amounts onto the v1 response contract', async () => {
    const { service } = buildService();

    const result = await service.getPeriodSummary(
      { tenantId: 'tenant-1', billingAccountId: 'account-1', billingAccountType: 'enterprise' },
      { startDate: '2026-10-01', endDate: '2026-10-31', granularity: 'month' },
    );

    expect(result).toEqual({
      granularity: 'month',
      items: [{
        period: '2026-10',
        calls: 7,
        totalTokens: 1234,
        costUsd: 87.932463091,
        costAmount: '87.932463091000',
        paymentDeductionUsd: 80.5,
        paymentDeductionAmount: '80.500000000000',
        voucherDeductionUsd: 7.432463091,
        voucherDeductionAmount: '7.432463091000',
      }],
    });
  });

  it('drops blank optional filters and trims real ones', async () => {
    const { service, aggregate } = buildService();

    await service.getPeriodSummary(
      { tenantId: 'tenant-1', billingAccountId: 'account-1', billingAccountType: 'enterprise' },
      {
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        granularity: 'month',
        productId: ' product-1 ',
        model: '   ',
        apiKeyId: '',
      },
    );

    const [, filters] = aggregate.mock.calls[0]!;
    expect(filters.productId).toBe('product-1');
    expect(filters.model).toBeUndefined();
    expect(filters.apiKeyId).toBeUndefined();
  });

  it('caps overly wide ranges instead of scanning years of usage', async () => {
    const { service, aggregate } = buildService();

    await service.getPeriodSummary(
      { tenantId: 'tenant-1', billingAccountId: 'account-1', billingAccountType: 'enterprise' },
      { startDate: '2020-01-01', endDate: '2026-11-30', granularity: 'month' },
    );

    const [, filters] = aggregate.mock.calls[0]!;
    const spanMs = filters.endExclusive.getTime() - filters.startInclusive.getTime();
    expect(spanMs).toBe(366 * 24 * 60 * 60 * 1000);
  });
});

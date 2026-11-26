import { Prisma } from '@prisma/client';
import { AccountingReconciliationService } from './accounting-reconciliation.service';

describe('AccountingReconciliationService', () => {
  it('builds an accounting reconciliation report from bounded samples', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{
          id: 'gw-event-1',
          request_id: 'req-1',
          status: 'DEDUCTED',
          created_at: new Date('2026-06-10T00:00:00.000Z'),
          total_count: BigInt(2),
        }])
        .mockResolvedValueOnce([{
          id: 'usage-payg-1',
          request_id: 'req-2',
          api_key_id: 'key-1',
          tenant_id: 'tenant-1',
          product_id: 'prod-1',
          customer_charge_policy: 'payg_balance',
          cost_usd: new Prisma.Decimal('0.1'),
          created_at: new Date('2026-06-10T00:01:00.000Z'),
          total_count: BigInt(1),
        }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          billing_account_id: 'ba-1',
          wallet_balance_usd: new Prisma.Decimal('10'),
          ledger_balance_usd: new Prisma.Decimal('9.5'),
          diff_usd: new Prisma.Decimal('0.5'),
          total_count: BigInt(1),
        }])
        .mockResolvedValueOnce([{
          total_count: BigInt(4),
          priced_count: BigInt(3),
          missing_count: BigInt(1),
          customer_charge_usd: new Prisma.Decimal('1.25'),
          provider_cost_estimate_usd: new Prisma.Decimal('0.75'),
          estimated_gross_margin_usd: new Prisma.Decimal('0.5'),
        }])
        .mockResolvedValueOnce([{
          id: 'usage-missing-cost-1',
          request_id: 'req-3',
          provider_code: 'provider-a',
          model: 'model-a',
          customer_charge_usd: new Prisma.Decimal('0.2'),
          created_at: new Date('2026-06-10T00:02:00.000Z'),
          total_count: BigInt(1),
        }]),
    };
    const service = new AccountingReconciliationService(prisma as never);

    const report = await service.buildReport({ sampleLimit: 5, toleranceUsd: '0.01' });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
    expect(prisma.$queryRaw.mock.calls[1][0].join(' ')).toContain(
      'tu."customer_charge_usd" > 0',
    );
    expect(report.sampleLimit).toBe(5);
    expect(report.toleranceUsd).toBe('0.01');
    expect(report.providerCostWindowHours).toBe(24);
    expect(report.gatewayEventsWithoutTokenUsage.count).toBe(2);
    expect(report.gatewayEventsWithoutTokenUsage.samples[0]).toMatchObject({
      requestId: 'req-1',
      status: 'DEDUCTED',
    });
    expect(report.paygTokenUsageWithoutBalanceLedger.count).toBe(1);
    expect(report.paygTokenUsageWithoutBalanceLedger.samples[0]).toMatchObject({
      id: 'usage-payg-1',
      costUsd: '0.1',
    });
    expect(report.creditTokenUsageWithoutCreditLedger.count).toBe(0);
    expect(report.accountWalletLedgerMismatches.samples[0]).toEqual({
      billingAccountId: 'ba-1',
      walletBalanceUsd: '10',
      ledgerBalanceUsd: '9.5',
      diffUsd: '0.5',
    });
    expect(report.providerCostEstimates).toMatchObject({
      totalRequests: 4,
      pricedRequests: 3,
      missingRequests: 1,
      coverageRate: 0.75,
      customerChargeUsd: '1.25',
      providerCostEstimateUsd: '0.75',
      estimatedGrossMarginUsd: '0.5',
      missingSamples: [
        expect.objectContaining({
          requestId: 'req-3',
          providerCode: 'provider-a',
        }),
      ],
    });
  });
});

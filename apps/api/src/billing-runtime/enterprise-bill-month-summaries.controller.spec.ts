import { EnterpriseBillMonthSummariesController } from './enterprise-bill-month-summaries.controller';

describe('EnterpriseBillMonthSummariesController', () => {
  it('closes historical months and forwards optional billingAccountId', async () => {
    const bills = {
      closeHistoricalClosedMonths: jest.fn(async () => ({
        skipped: false,
        yearMonth: '2026-08',
        yearMonths: ['2026-07', '2026-08'],
        processed: 6,
        hasMore: false,
        billingAccountId: 'ba-1',
      })),
    };
    const controller = new EnterpriseBillMonthSummariesController(bills as never, {
      refreshFundingSnapshots: jest.fn(),
    } as never);

    const result = await controller.close({ billingAccountId: 'ba-1' });

    expect(bills.closeHistoricalClosedMonths).toHaveBeenCalledWith(expect.any(Date), {
      billingAccountId: 'ba-1',
    });
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: {
        skipped: false,
        yearMonth: '2026-08',
        yearMonths: ['2026-07', '2026-08'],
        processed: 6,
        hasMore: false,
        billingAccountId: 'ba-1',
      },
    });
  });

  it('refreshes current-month summaries and funding snapshots without request parameters', async () => {
    const accounts = {
      refreshFundingSnapshots: jest.fn(async () => 2),
    };
    const bills = {
      refreshCurrentMonthSummaries: jest.fn(async (_now: Date, refreshFunding?: () => Promise<number>) => ({
        skipped: false,
        yearMonth: '2026-09',
        processed: 2,
        fundingProcessed: refreshFunding ? await refreshFunding() : 0,
        hasMore: false,
      })),
    };
    const controller = new EnterpriseBillMonthSummariesController(bills as never, accounts as never);

    const result = await controller.refresh();

    expect(bills.refreshCurrentMonthSummaries).toHaveBeenCalledWith(expect.any(Date), expect.any(Function));
    expect(accounts.refreshFundingSnapshots).toHaveBeenCalled();
    expect(result.data).toEqual({
      skipped: false,
      yearMonth: '2026-09',
      processed: 2,
      fundingProcessed: 2,
      hasMore: false,
    });
  });
});

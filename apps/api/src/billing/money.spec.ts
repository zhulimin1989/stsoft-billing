import { Prisma } from '@prisma/client';
import { accountAvailableFromWalletAndRemainingUsd, sumUsdToCents, usdToCents } from './money';

describe('accountAvailableFromWalletAndRemainingUsd', () => {
  it('正余额计入可用：max(0, 520.3326) + 剩余信用 100 = 620.3326', () => {
    const available = accountAvailableFromWalletAndRemainingUsd(
      new Prisma.Decimal('520.3326'),
      new Prisma.Decimal(100),
    );
    expect(usdToCents(available)).toBe(62033);
  });

  it('负余额不冲减剩余信用：max(0, -30) + 70 = 70', () => {
    const available = accountAvailableFromWalletAndRemainingUsd(-30, 70);
    expect(usdToCents(available)).toBe(7000);
  });

  it('非 ACTIVE 时剩余信用按 0：max(0, 5) + 0 = 5', () => {
    const available = accountAvailableFromWalletAndRemainingUsd(5, 0);
    expect(usdToCents(available)).toBe(500);
  });
});

describe('sumUsdToCents', () => {
  it('rounds once after summing USD (3×0.005 → 2, not 3)', () => {
    const parts = ['0.005', '0.005', '0.005'];
    expect(parts.map((value) => usdToCents(value)).reduce((total, cents) => total + cents, 0)).toBe(3);
    expect(sumUsdToCents(parts)).toBe(2);
  });

  it('keeps 头文 9月 29.76890614 as 2977 cents', () => {
    expect(usdToCents('29.76890614')).toBe(2977);
    expect(sumUsdToCents(['29.76890614'])).toBe(2977);
  });
});

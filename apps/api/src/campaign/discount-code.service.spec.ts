import { DiscountCodeService } from './discount-code.service';
import { DiscountCodeRepository } from './discount-code.repository';
import { StripeCouponSyncService } from './stripe-coupon-sync.service';
import { BadRequestException } from '@nestjs/common';

function makeRepo(): jest.Mocked<DiscountCodeRepository> {
  return {
    create: jest.fn(),
    update: jest.fn(),
    findById: jest.fn(),
    findByCode: jest.fn(),
    findAll: jest.fn(),
    countUserRedemptions: jest.fn().mockResolvedValue(0),
    countReservedOrders: jest.fn().mockResolvedValue(0),
    countCompletedOrders: jest.fn().mockResolvedValue(0),
    sumSaved: jest.fn().mockResolvedValue(0),
  } as any;
}

function makeStripe(): jest.Mocked<StripeCouponSyncService> {
  return {
    createAmountOffCoupon: jest.fn(),
    createDiscountCodeCoupon: jest.fn().mockResolvedValue('cpn_code'),
    archiveCoupon: jest.fn().mockResolvedValue(undefined),
    archiveCouponsMap: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('DiscountCodeService.applyDiscount', () => {
  const svc = new DiscountCodeService(makeRepo(), makeStripe());

  it('percent_off', () => {
    expect(svc.applyDiscount(10000, 'percent_off', 20)).toBe(8000);
    expect(svc.applyDiscount(9999, 'percent_off', 50)).toBe(5000);
  });

  it('amount_off', () => {
    expect(svc.applyDiscount(10000, 'amount_off', 3000)).toBe(7000);
    expect(svc.applyDiscount(1000, 'amount_off', 5000)).toBe(0);
  });
});

describe('DiscountCodeService.validateAndGet', () => {
  function baseRecord(over: Partial<any> = {}) {
    return {
      id: 'dc1',
      code: 'SAVE20',
      name: 'Save 20',
      description: '',
      discountType: 'percent_off',
      discountValue: 20,
      currency: null,
      duration: 'once',
      durationMonths: null,
      planIdsJson: '[]',
      firstTimeOnly: false,
      scope: 'all',
      maxUses: 0,
      maxUsesPerUser: 1,
      currentUses: 0,
      startAt: null,
      endAt: null,
      stripeCouponId: 'cpn_x',
      isActive: true,
      ...over,
    };
  }

  it('happy path', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(baseRecord() as any);
    const svc = new DiscountCodeService(repo, makeStripe());
    const hit = await svc.validateAndGet({
      code: 'save20',
      userId: 'u1',
      planId: 'plan-1',
      currency: 'usd',
      isNewUser: false,
      userHasPlanHistory: false,
      originalAmountCents: 1900,
    });
    expect(hit.amountAfterCents).toBe(1520);
    expect(hit.amountSavedCents).toBe(380);
    expect(hit.code.stripeCouponId).toBe('cpn_x');
  });

  it('码不存在', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(null as any);
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'NOPE',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('码已过期', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(
      baseRecord({ endAt: new Date(Date.now() - 86400 * 1000) }) as any,
    );
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/过期/);
  });

  it('per-user 限次', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(baseRecord({ maxUsesPerUser: 1 }) as any);
    repo.countUserRedemptions.mockResolvedValue(1);
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/次数/);
  });

  it('per-user 限次包含待支付订单占用', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(baseRecord({ maxUsesPerUser: 1 }) as any);
    repo.countReservedOrders.mockImplementation(async (_discountCodeId, userId?: string) =>
      userId ? 1 : 0,
    );
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/次数/);
  });

  it('global 限次包含待支付订单占用', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(baseRecord({ maxUses: 1, maxUsesPerUser: 0 }) as any);
    repo.countReservedOrders.mockResolvedValue(1);
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/使用完/);
  });

  it('planIds 限制', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(
      baseRecord({ planIdsJson: JSON.stringify(['other-plan']) }) as any,
    );
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'usd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/不适用/);
  });

  it('amount_off 币种不匹配', async () => {
    const repo = makeRepo();
    repo.findByCode.mockResolvedValue(
      baseRecord({ discountType: 'amount_off', discountValue: 500, currency: 'usd' }) as any,
    );
    const svc = new DiscountCodeService(repo, makeStripe());
    await expect(
      svc.validateAndGet({
        code: 'SAVE20',
        userId: 'u1',
        planId: 'plan-1',
        currency: 'sgd',
        isNewUser: true,
        userHasPlanHistory: false,
        originalAmountCents: 1000,
      }),
    ).rejects.toThrow(/USD/);
  });
});

describe('DiscountCodeService.create', () => {
  it('格式不合法抛 BadRequest', async () => {
    const svc = new DiscountCodeService(makeRepo(), makeStripe());
    await expect(
      svc.create({
        code: 'ab',
        name: 'X',
        discountType: 'percent_off',
        discountValue: 20,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('percent_off 范围外', async () => {
    const svc = new DiscountCodeService(makeRepo(), makeStripe());
    await expect(
      svc.create({
        code: 'HELLO',
        name: 'X',
        discountType: 'percent_off',
        discountValue: 0,
      }),
    ).rejects.toThrow(/1~99/);
  });

  it('amount_off 需要 currency', async () => {
    const svc = new DiscountCodeService(makeRepo(), makeStripe());
    await expect(
      svc.create({
        code: 'HELLO',
        name: 'X',
        discountType: 'amount_off',
        discountValue: 500,
      }),
    ).rejects.toThrow(/currency/);
  });
});

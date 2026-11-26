import { BillingController } from './billing.controller';

describe('BillingController', () => {
  function buildController() {
    const billingService = {
      resolveSubjectForUser: jest.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
      getBalanceReportForUser: jest.fn(),
      getCreditsSummary: jest.fn(),
      isSelfOperatedCodingPlanProduct: jest.fn().mockResolvedValue(false),
      resolveSelfOpEntitlementId: jest.fn().mockResolvedValue({ selfOp: false, entitlementId: null }),
      getCurrentSubscriptionBySlug: jest.fn().mockResolvedValue({ status: 'none' }),
      assertCodingPlanEntitlementAccess: jest.fn(),
      getTokenUsagePeriodSummary: jest.fn().mockResolvedValue({ granularity: 'month', items: [] }),
    };
    const creditService = { getSummary: jest.fn().mockResolvedValue({ balanceCents: 0 }) };
    const subscriptionResolver = { resolve: jest.fn().mockResolvedValue({ subscriptionId: 'sub-tenant' }) };
    const controller = new BillingController(
      billingService as never,
      creditService as never,
      {} as never,
      {} as never,
      subscriptionResolver as never,
      { get: jest.fn() } as never,
      { getDeploymentConfig: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { controller, billingService, creditService, subscriptionResolver };
  }

  it('converts Decimal USD balances to cents without floating point drift', async () => {
    const { controller, billingService } = buildController();
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 101,
      balanceUsd: 1.005,
      accountBalanceCents: 101,
      accountBalanceUsd: 1.005,
      accountAvailableBalanceCents: 101,
      accountAvailableBalanceUsd: 1.005,
      creditLimitCents: 0,
      creditLimitUsd: 0,
      creditUsedCents: 0,
      creditUsedUsd: 0,
      creditRemainingCents: 0,
      creditRemainingUsd: 0,
    });

    const response = await controller.getBalance('user-1');

    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith('user-1', undefined);
    expect(response.data.balanceCents).toBe(101);
    expect(response.data.balanceUsd).toBe(1.005);
    expect(response.data.balanceAmount).toBe('1.005000000000');
    expect(response.data.currency).toBe('usd');
  });

  it('allows workspace members to read credits summary for the usage page', async () => {
    const { controller, billingService } = buildController();
    const summary = { balanceCents: 1000 };
    billingService.getCreditsSummary.mockResolvedValue(summary);

    const response = await controller.getCreditsSummary('user-1', 'tenant-1');

    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(response.data).toMatchObject({ ...summary, currency: 'usd', currencyCode: 'USD', currencySymbol: '$' });
  });

  // me/self-op-subscription-workspace-independent.md：自营订阅显示绕开当前工作区成员/账务角色 gate。
  it('getCurrentSubscription bypasses billing-subject gate for self-op products', async () => {
    const { controller, billingService } = buildController();
    billingService.isSelfOperatedCodingPlanProduct.mockResolvedValue(true);

    await controller.getCurrentSubscription('user-1', 'prod-cp', undefined, 'tenant-x');

    expect(billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(billingService.getCurrentSubscriptionBySlug).toHaveBeenCalledWith(
      'user-1', 'prod-cp', expect.any(String), {},
    );
  });

  it('getCurrentSubscription keeps the workspace gate for non-self-op products', async () => {
    const { controller, billingService } = buildController();
    billingService.isSelfOperatedCodingPlanProduct.mockResolvedValue(false);

    await controller.getCurrentSubscription('user-1', 'prod-sub', undefined, 'tenant-1');

    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith('user-1', 'tenant-1', {
      requireBillingRole: true,
    });
  });

  it('getCredits resolves self-op subscriptionId by userId and skips the workspace gate', async () => {
    const { controller, billingService, creditService } = buildController();
    billingService.resolveSelfOpEntitlementId.mockResolvedValue({ selfOp: true, entitlementId: 'ent-selfop' });

    await controller.getCredits('user-1', 'prod-cp', undefined, 'tenant-x');

    // 传 CHAT_PRODUCT_SLUG 兜底，与 current-subscription 一致。
    expect(billingService.resolveSelfOpEntitlementId).toHaveBeenCalledWith('user-1', 'prod-cp', expect.any(String));
    expect(billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(creditService.getSummary).toHaveBeenCalledWith('ent-selfop', 'user-1');
  });

  // codex High：credits 缺省 productId 时也须靠默认 slug 命中自营产品，否则切工作区仍 403。
  it('getCredits still detects self-op via default slug when productId is omitted', async () => {
    const { controller, billingService, creditService } = buildController();
    billingService.resolveSelfOpEntitlementId.mockResolvedValue({ selfOp: true, entitlementId: 'ent-default' });

    await controller.getCredits('user-1', undefined, undefined, 'tenant-x');

    expect(billingService.resolveSelfOpEntitlementId).toHaveBeenCalledWith('user-1', undefined, expect.any(String));
    expect(billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(creditService.getSummary).toHaveBeenCalledWith('ent-default', 'user-1');
  });

  it('getCredits returns empty summary (subscriptionId="") for self-op without an active entitlement', async () => {
    const { controller, billingService, creditService } = buildController();
    billingService.resolveSelfOpEntitlementId.mockResolvedValue({ selfOp: true, entitlementId: null });

    await controller.getCredits('user-1', 'prod-cp', undefined, 'tenant-x');

    expect(creditService.getSummary).toHaveBeenCalledWith('', 'user-1');
  });

  it('getCredits keeps the workspace-scoped resolution for non-self-op products', async () => {
    const { controller, billingService, subscriptionResolver, creditService } = buildController();
    billingService.resolveSelfOpEntitlementId.mockResolvedValue({ selfOp: false, entitlementId: null });

    await controller.getCredits('user-1', 'prod-sub', undefined, 'tenant-1');

    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith('user-1', 'tenant-1', {
      requireBillingRole: true,
    });
    expect(subscriptionResolver.resolve).toHaveBeenCalledWith('user-1', 'prod-sub', { tenantId: 'tenant-1' });
    expect(creditService.getSummary).toHaveBeenCalledWith('sub-tenant', 'user-1');
  });

  it('uses deployment config currency from runtime system config', async () => {
    const billingService = {
      resolveSubjectForUser: jest.fn().mockResolvedValue({}),
      getBalanceReportForUser: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        balanceCents: 200,
        balanceUsd: 2,
        accountBalanceCents: 200,
        accountBalanceUsd: 2,
        accountAvailableBalanceCents: 200,
        accountAvailableBalanceUsd: 2,
        creditLimitCents: 0,
        creditLimitUsd: 0,
        creditUsedCents: 0,
        creditUsedUsd: 0,
        creditRemainingCents: 0,
        creditRemainingUsd: 0,
      }),
      getCreditsSummary: jest.fn(),
    };
    const controller = new BillingController(
      billingService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn() } as never,
      { getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny' }) } as never,
    );

    const response = await controller.getBalance('user-1');

    expect(response.data.currency).toBe('cny');
    expect(response.data.currencyCode).toBe('CNY');
    expect(response.data.currencySymbol).toBe('¥');
  });

  it('forwards validated period-summary granularity to the billing service', async () => {
    const { controller, billingService } = buildController();

    const response = await controller.getTokenUsagePeriodSummary(
      'user-1',
      'tenant-1',
      '2026-05-01',
      '2026-10-31',
      undefined,
      'product-1',
      undefined,
      'month',
    );

    expect(billingService.getTokenUsagePeriodSummary).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ granularity: 'month', productId: 'product-1' }),
      { tenantId: 'tenant-1' },
    );
    expect(response.data).toEqual({ granularity: 'month', items: [] });
  });

  it('rejects an unsupported period-summary granularity', async () => {
    const { controller } = buildController();

    await expect(controller.getTokenUsagePeriodSummary(
      'user-1',
      'tenant-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'week',
    )).rejects.toThrow('granularity must be day or month');
  });
});

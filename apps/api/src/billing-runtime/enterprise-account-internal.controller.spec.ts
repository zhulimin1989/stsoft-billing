import { EnterpriseAccountInternalController } from './enterprise-account-internal.controller';

describe('EnterpriseAccountInternalController.recharge', () => {
  function buildController() {
    const enterpriseAccounts = {
      resolveFundingAnchor: jest.fn().mockResolvedValue({
        billingAccountId: 'ba-ent-1',
        ownerUserId: 'user-1',
        tenantId: 'tenant-1',
      }),
      syncEnterpriseAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
      transferEnterpriseOwner: jest.fn().mockResolvedValue({
        id: 'ba-ent-1',
        tenantId: 'tenant-1',
        previousOwnerUserId: 'user-1',
        ownerUserId: 'user-2',
        transferred: true,
        idempotent: false,
      }),
    };
    const billingService = {
      adminRecharge: jest.fn().mockResolvedValue({ id: 'tx-1' }),
      applyClassifiedBalanceAdjustment: jest.fn().mockResolvedValue({
        direction: 'DEBIT',
        amountCents: -500,
      }),
    };
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-payg-1',
          billingMode: 'PAY_AS_YOU_GO',
          isActive: true,
        }),
      },
    };
    const controller = new EnterpriseAccountInternalController(
      enterpriseAccounts as never,
      billingService as never,
      prisma as never,
    );
    const req = { internalCaller: 'admin-api' };
    return { controller, enterpriseAccounts, billingService, prisma, req };
  }

  it('uses the enterprise funding anchor and fans out account key balances', async () => {
    const { controller, enterpriseAccounts, billingService, prisma, req } = buildController();

    const result = await controller.recharge(req as never, 'ba-ent-1', {
      amountCents: 1000,
      productId: 'prod-payg-1',
      description: '线下转账入账',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({ code: 0, message: '充值成功', data: { id: 'tx-1' } });
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'prod-payg-1', deletedAt: null },
      select: { id: true, billingMode: true, isActive: true },
    });
    expect(enterpriseAccounts.resolveFundingAnchor).toHaveBeenCalledWith('ba-ent-1');
    expect(billingService.adminRecharge).toHaveBeenCalledWith(
      'user-1',
      1000,
      '线下转账入账',
      'prod-payg-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-ent-1',
        idempotencyKey: 'key-1',
      },
    );
    expect(enterpriseAccounts.syncEnterpriseAccountKeyBalances).toHaveBeenCalledWith('ba-ent-1');
  });

  it('rejects non-positive recharge amounts', async () => {
    const { controller, req } = buildController();

    await expect(controller.recharge(req as never, 'ba-ent-1', {
      amountCents: 0,
      productId: 'prod-payg-1',
      description: 'invalid',
      idempotencyKey: 'key-1',
    })).rejects.toThrow('充值金额必须大于 0');
  });

  it('rejects recharge without product id', async () => {
    const { controller, req } = buildController();

    await expect(controller.recharge(req as never, 'ba-ent-1', {
      amountCents: 1000,
      description: 'invalid',
      idempotencyKey: 'key-1',
    })).rejects.toThrow('productId 不能为空');
  });

  it('rejects recharge with non-payg product', async () => {
    const { controller, prisma, req } = buildController();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-sub-1',
      billingMode: 'SUBSCRIPTION',
      isActive: true,
    });

    await expect(controller.recharge(req as never, 'ba-ent-1', {
      amountCents: 1000,
      productId: 'prod-sub-1',
      description: 'invalid',
      idempotencyKey: 'key-1',
    })).rejects.toThrow('充值产品必须是启用中的按量产品');
  });

  it('anchors classified balance adjustment to the enterprise billing account', async () => {
    const { controller, enterpriseAccounts, billingService, req } = buildController();

    const result = await controller.applyBalanceAdjustment(req as never, 'ba-ent-1', {
      amountCents: -500,
      reasonCode: 'BILLING_CORRECTION',
      description: 'duplicate usage correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
    });

    expect(result.data).toEqual({ direction: 'DEBIT', amountCents: -500 });
    expect(billingService.applyClassifiedBalanceAdjustment).toHaveBeenCalledWith('user-1', {
      amountCents: -500,
      reasonCode: 'BILLING_CORRECTION',
      description: 'duplicate usage correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-ent-1',
    });
    expect(enterpriseAccounts.syncEnterpriseAccountKeyBalances).toHaveBeenCalledWith('ba-ent-1');
  });

  it('forwards the complete owner-transfer snapshot to the transactional service', async () => {
    const { controller, enterpriseAccounts } = buildController();
    const body = {
      tenantId: 'tenant-1',
      previousOwnerUserId: 'user-1',
      newOwner: {
        id: 'user-2',
        email: 'next@example.com',
        phone: '13800000002',
        nickname: 'Next owner',
        isActive: true,
        sourceUpdatedAt: '2026-08-06T08:00:00.000Z',
      },
    };

    await expect(controller.transferOwner('ba-ent-1', body)).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: {
        id: 'ba-ent-1',
        tenantId: 'tenant-1',
        previousOwnerUserId: 'user-1',
        ownerUserId: 'user-2',
        transferred: true,
        idempotent: false,
      },
    });
    expect(enterpriseAccounts.transferEnterpriseOwner)
      .toHaveBeenCalledWith('ba-ent-1', body);
  });
  it('anchors classified balance adjustment to the enterprise billing account', async () => {
    const { controller, enterpriseAccounts, billingService, req } = buildController();

    const result = await controller.applyBalanceAdjustment(req as never, 'ba-ent-1', {
      amountCents: -500,
      reasonCode: 'BILLING_CORRECTION',
      description: 'duplicate usage correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
    });

    expect(result.data).toEqual({ direction: 'DEBIT', amountCents: -500 });
    expect(billingService.applyClassifiedBalanceAdjustment).toHaveBeenCalledWith('user-1', {
      amountCents: -500,
      reasonCode: 'BILLING_CORRECTION',
      description: 'duplicate usage correction',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-ent-1',
    });
    expect(enterpriseAccounts.syncEnterpriseAccountKeyBalances).toHaveBeenCalledWith('ba-ent-1');
  });
});

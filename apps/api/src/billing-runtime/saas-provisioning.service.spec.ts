import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { decrypt, encrypt } from '../common/utils/crypto';
import { SaasProvisioningService } from './saas-provisioning.service';

const ENCRYPTION_KEY = '11'.repeat(32);

type KeyRow = {
  id: string;
  prefix: string;
  keyHash: string;
  isActive: boolean;
  mirrorStatus: string;
  activatedAt: Date | null;
  provisionSecretEncrypted: string | null;
  provisionSecretExpiresAt: Date | null;
  rotationPredecessorId: string | null;
  deletedAt: Date | null;
  managedBy: string | null;
  [key: string]: unknown;
};

describe('SaasProvisioningService', () => {
  function buildService(initialKeys: KeyRow[] = []) {
    const keys = initialKeys.map((key) => ({ ...key }));
    const receipts: any[] = [];
    const apiKey = {
      findMany: jest.fn().mockImplementation(async () => (
        keys
          .filter((key) => key.deletedAt === null)
          .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      )),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => (
        keys.find((key) => key.id === where.id) ?? null
      )),
      create: jest.fn().mockImplementation(async ({ data }: { data: Partial<KeyRow> }) => {
        const row = Object.assign({
          activatedAt: null,
          provisionSecretEncrypted: null,
          provisionSecretExpiresAt: null,
          rotationPredecessorId: null,
          deletedAt: null,
          managedBy: null,
          allowedModels: null,
          budgetUsd: null,
        }, data) as KeyRow;
        keys.push(row);
        return row;
      }),
      update: jest.fn().mockImplementation(async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<KeyRow>;
      }) => {
        const row = keys.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`missing key ${where.id}`);
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn().mockImplementation(async ({
        where,
        data,
      }: {
        where: { id?: string };
        data: Partial<KeyRow>;
      }) => {
        const rows = keys.filter((candidate) => !where.id || candidate.id === where.id);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
    };
    const prisma: any = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-1',
          slug: 'coding',
          billingMode: 'SUBSCRIPTION',
          codingPlanFulfillmentMode: null,
          isActive: true,
          deletedAt: null,
        }),
      },
      productExternalUserBinding: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'user-binding-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      productExternalTenantBinding: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'tenant-binding-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tenant: {
        create: jest.fn().mockImplementation(async ({ data }: { data: { id: string } }) => ({
          id: data.id,
        })),
        update: jest.fn().mockResolvedValue({}),
      },
      tenantMember: {
        findUnique: jest.fn().mockResolvedValue({ role: 'owner', status: 'active' }),
        create: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      tenantProductEntitlement: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      subscriptionPeriod: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      codingPlanEntitlement: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      productModelAvailability: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => (
          (where.modelName?.in ?? []).map((modelName: string) => ({ modelName }))
        )),
      },
      modelAccess: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => (
          (where.modelName?.in ?? []).map((modelName: string) => ({ modelName }))
        )),
      },
      saasProvisionReceipt: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id) return receipts.find((row) => row.id === where.id) ?? null;
          const scope = where.productId_idempotencyKey;
          return receipts.find(
            (row) => row.productId === scope.productId
              && row.idempotencyKey === scope.idempotencyKey,
          ) ?? null;
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const row = {
            id: `receipt-${receipts.length + 1}`,
            result: null,
            completedAt: null,
            lastError: null,
            ...data,
          };
          receipts.push(row);
          return row;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const row = receipts.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error(`missing receipt ${where.id}`);
          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const rows = receipts.filter((row) => (
            (!where.id || row.id === where.id)
            && (!where.status || row.status === where.status)
            && (!where.leaseId || row.leaseId === where.leaseId)
          ));
          rows.forEach((row) => Object.assign(row, data));
          return { count: rows.length };
        }),
      },
      plan: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      apiKey,
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn().mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
      ),
    };
    const billingService = {
      resolveSubjectForUser: jest.fn().mockResolvedValue({ billingAccountId: 'ba-1' }),
      isSelfOperatedCodingPlanProduct: jest.fn().mockResolvedValue(false),
    };
    const creditService = {
      grantQuota: jest.fn().mockResolvedValue(undefined),
    };
    const publisherSync = {
      syncApiKeyActivationRequired: jest.fn().mockResolvedValue(undefined),
      revokeApiKeyRequired: jest.fn().mockResolvedValue(undefined),
    };
    const userMirror = {
      mirrorUser: jest.fn().mockResolvedValue({
        id: 'internal-user',
        skippedStale: false,
        sourceUpdatedAt: null,
      }),
    };
    const config = {
      get: jest.fn().mockImplementation((key: string) => (
        key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined
      )),
    };
    const subscriptionLifecycle = {
      activateIfAbsent: jest.fn().mockResolvedValue({
        contractId: 'contract-1',
        periodId: 'subscription-1',
        entitlementId: 'entitlement-1',
        planId: 'plan-free',
        provisionReceiptId: null,
        created: false,
      }),
      activateCodingPlanIfAbsent: jest.fn(),
      withCurrentActivePeriod: jest.fn().mockImplementation(
        async (_tenantId: string, _productId: string, callback: (period: any) => unknown) => callback({
          periodId: 'subscription-1',
          contractId: 'contract-1',
          userId: 'internal-user',
          tenantId: 'tenant-1',
          productId: 'prod-1',
          planId: 'plan-free',
          provisionReceiptId: null,
          expiresAt: null,
        }),
      ),
      withCurrentActiveCodingPlanEntitlement: jest.fn(),
    };
    const catalog = {
      getModels: jest.fn().mockResolvedValue({
        models: [
          { id: 'gpt-4' },
          { id: 'gpt-5' },
          { id: 'gpt-6' },
          { id: 'gpt-product-a' },
        ],
      }),
    };
    const service = new SaasProvisioningService(
      prisma,
      billingService as never,
      creditService as never,
      publisherSync as never,
      userMirror as never,
      config as unknown as ConfigService,
      subscriptionLifecycle as never,
      catalog as never,
    );
    return {
      service,
      prisma,
      billingService,
      publisherSync,
      userMirror,
      creditService,
      subscriptionLifecycle,
      catalog,
      config,
      keys,
      receipts,
    };
  }

  const provisionPaths = [
    'subscription',
    'user-only-coding-plan',
    'direct',
  ] as const;

  function buildProvisionPath(path: (typeof provisionPaths)[number]) {
    const dependencies = buildService();
    const {
      prisma,
      subscriptionLifecycle,
    } = dependencies;
    const request = {
      idempotencyKey: `await-${path}-1`,
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: path !== 'direct',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1', type: 'personal' },
    };

    if (path === 'subscription') {
      prisma.plan.findFirst.mockResolvedValue({
        id: 'plan-free',
        name: 'Free',
        monthlyCredits: 100,
        validityDays: 30,
      });
    } else if (path === 'user-only-coding-plan') {
      prisma.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        slug: 'coding',
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: 'platform_model_package',
        isActive: true,
        deletedAt: null,
      });
      prisma.plan.findFirst.mockResolvedValue({
        id: 'plan-free',
        name: 'Free',
        monthlyCredits: 100,
        validityDays: 30,
      });
      subscriptionLifecycle.activateCodingPlanIfAbsent.mockImplementation(
        async (input: {
          userId: string;
          tenantId: string;
          productId: string;
          planId: string;
          expiresAt: Date | null;
        }) => ({
          id: 'coding-entitlement-1',
          userId: input.userId,
          tenantId: input.tenantId,
          productId: input.productId,
          planId: input.planId,
          provisionReceiptId: null,
          status: 'ACTIVE',
          expiresAt: input.expiresAt,
          created: false,
        }),
      );
      subscriptionLifecycle.withCurrentActiveCodingPlanEntitlement.mockImplementation(
        async (
          tenantId: string,
          productId: string,
          callback: (entitlement: {
            id: string;
            userId: string;
            tenantId: string;
            productId: string;
            planId: string;
            provisionReceiptId: string | null;
            status: string;
            expiresAt: Date | null;
            created: boolean;
          }) => unknown,
        ) => callback({
          id: 'coding-entitlement-1',
          userId: 'internal-user',
          tenantId,
          productId,
          planId: 'plan-free',
          provisionReceiptId: null,
          status: 'ACTIVE',
          expiresAt: null,
          created: false,
        }),
      );
    } else {
      prisma.product.findFirst.mockResolvedValue({
        id: 'prod-1',
        slug: 'coding',
        billingMode: 'PAY_AS_YOU_GO',
        codingPlanFulfillmentMode: null,
        isActive: true,
        deletedAt: null,
      });
    }

    return { ...dependencies, request };
  }

  function tenantLeaseReleaseCount(
    prisma: ReturnType<typeof buildService>['prisma'],
  ): number {
    return prisma.productExternalTenantBinding.updateMany.mock.calls.filter(
      ([input]: [{ data: Record<string, unknown> }]) => (
        input.data.provisioningLeaseId === null
      ),
    ).length;
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('creates product-scoped bindings and never uses external ids as global primary keys', async () => {
    const { service, prisma, userMirror } = buildService();

    const result = await service.provision({
      idempotencyKey: 'provision-create-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1', email: 'alice@example.com' },
      tenant: { id: 'external-tenant-1', name: 'Alice' },
    });

    expect(result.userId).not.toBe('external-user-1');
    expect(result.tenantId).not.toBe('external-tenant-1');
    expect(userMirror.mirrorUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.userId,
        email: 'alice@example.com',
      }),
      prisma,
    );
    expect(prisma.productExternalUserBinding.create).toHaveBeenCalledWith({
      data: {
        productId: 'prod-1',
        externalUserId: 'external-user-1',
        userId: result.userId,
        snapshotWritable: true,
        email: 'alice@example.com',
        phone: null,
        nickname: null,
        sourceUpdatedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.productExternalTenantBinding.create).toHaveBeenCalledWith({
      data: {
        productId: 'prod-1',
        bindingKey: 'external:external-tenant-1',
        externalTenantId: 'external-tenant-1',
        tenantId: result.tenantId,
        snapshotWritable: true,
      },
      select: { id: true },
    });
    expect(prisma.tenant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        id: result.tenantId,
        ownerUserId: result.userId,
      }),
    }));
    expect(prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenantProductEntitlement.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_productId: {
          tenantId: result.tenantId,
          productId: 'prod-1',
        },
      },
      create: expect.objectContaining({
        planId: null,
      }),
      update: {
        status: 'active',
        source: 'saas_provision',
        expiresAt: null,
      },
    });
    expect(prisma.productExternalTenantBinding.update).not.toHaveBeenCalled();
  });

  it('fails closed on new identity writes in production until the V2 gate is enabled', async () => {
    const { service, prisma, userMirror, config } = buildService();
    config.get.mockImplementation((key: string) => {
      if (key === 'ENCRYPTION_KEY') return ENCRYPTION_KEY;
      if (key === 'NODE_ENV') return 'production';
      return undefined;
    });

    await expect(service.provision({
      idempotencyKey: 'identity-gate-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'new-external-user' },
      tenant: { id: 'new-external-tenant' },
    })).rejects.toThrow('PARTNER_IDENTITY_V2_WRITE_ENABLED');
    expect(userMirror.mirrorUser).not.toHaveBeenCalled();
    expect(prisma.productExternalUserBinding.create).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it('rejects Partner attempts to change global user activation state before any write', async () => {
    const { service, prisma } = buildService();

    await expect(service.provision({
      idempotencyKey: 'provision-active-1',
      productId: 'prod-1',
      user: { id: 'external-user-1', isActive: false },
    })).rejects.toThrow('Partner provision 不允许修改 user.isActive');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('serializes the whole provision workflow with a durable tenant-binding lease', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.productExternalTenantBinding.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.provision({
      idempotencyKey: 'provision-lease-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).rejects.toThrow('正在执行 provision');

    expect(billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(prisma.tenantProductEntitlement.upsert).not.toHaveBeenCalled();
  });

  it.each(provisionPaths)(
    'keeps the tenant lease until the %s provision path settles',
    async (path) => {
      const { service, prisma, request } = buildProvisionPath(path);
      const enteredFinish = deferred();
      const allowFinish = deferred();
      prisma.tenantProductEntitlement.upsert.mockImplementation(async () => {
        enteredFinish.resolve();
        await allowFinish.promise;
        return {};
      });

      const provision = service.provision(request);
      await enteredFinish.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const releasesBeforeFinishSettled = tenantLeaseReleaseCount(prisma);

      allowFinish.resolve();
      await expect(provision).resolves.toEqual(expect.objectContaining({
        productId: 'prod-1',
      }));

      const completionCall = prisma.saasProvisionReceipt.updateMany.mock.calls.findIndex(
        ([input]: [{ data: Record<string, unknown> }]) => input.data.status === 'SUCCEEDED',
      );
      const releaseCall = prisma.productExternalTenantBinding.updateMany.mock.calls.findIndex(
        ([input]: [{ data: Record<string, unknown> }]) => (
          input.data.provisioningLeaseId === null
        ),
      );
      expect(releasesBeforeFinishSettled).toBe(0);
      expect(completionCall).toBeGreaterThanOrEqual(0);
      expect(releaseCall).toBeGreaterThanOrEqual(0);
      expect(prisma.saasProvisionReceipt.updateMany.mock.invocationCallOrder[completionCall])
        .toBeLessThan(
          prisma.productExternalTenantBinding.updateMany.mock.invocationCallOrder[releaseCall],
        );
      expect(tenantLeaseReleaseCount(prisma)).toBe(1);
    },
  );

  it.each(provisionPaths)(
    'persists an asynchronous %s provision failure before releasing the tenant lease',
    async (path) => {
      const { service, prisma, receipts, request } = buildProvisionPath(path);
      prisma.tenantProductEntitlement.upsert.mockRejectedValueOnce(
        new Error(`finish failed: ${path}`),
      );

      await expect(service.provision(request)).rejects.toThrow(`finish failed: ${path}`);

      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toEqual(expect.objectContaining({
        status: 'FAILED',
        leaseId: null,
        leaseExpiresAt: null,
        lastError: `finish failed: ${path}`,
      }));
      expect(tenantLeaseReleaseCount(prisma)).toBe(1);
    },
  );

  it('defers provision-owned quota until the final active subscription is locked', async () => {
    const { service, prisma, creditService, subscriptionLifecycle } = buildService();
    prisma.subscriptionPeriod.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'subscription-1',
        planId: 'plan-free',
        status: 'ACTIVE',
        expiresAt: null,
        plan: {
          id: 'plan-free',
          monthlyCredits: 100,
        },
      });
    prisma.plan.findFirst.mockResolvedValue({
      id: 'plan-free',
      name: 'Free',
      monthlyCredits: 100,
      validityDays: 30,
    });
    subscriptionLifecycle.activateIfAbsent.mockResolvedValue({
      contractId: 'contract-1',
      periodId: 'subscription-1',
      entitlementId: 'entitlement-1',
      planId: 'plan-free',
      provisionReceiptId: 'receipt-1',
      created: true,
    });
    await expect((service as any).ensureDefaultPlan(
      'user-1',
      'tenant-1',
      'prod-1',
      'receipt-1',
      'ba-1',
    )).resolves.toEqual({
      id: 'subscription-1',
      planId: 'plan-free',
      provisionReceiptId: 'receipt-1',
      created: true,
    });
    await expect((service as any).ensureDefaultPlan(
      'user-1',
      'tenant-1',
      'prod-1',
      'receipt-1',
      'ba-1',
    )).resolves.toEqual({
      id: 'subscription-1',
      planId: 'plan-free',
      provisionReceiptId: 'receipt-1',
      created: false,
    });

    expect(creditService.grantQuota).not.toHaveBeenCalled();
    expect(subscriptionLifecycle.activateIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('adds a second product-bound user as an active member of an existing team tenant', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      id: 'user-binding-1',
      userId: 'internal-user-1',
      user: { isActive: true, deletedAt: null },
    }]);
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      id: 'tenant-binding-1',
      tenantId: 'internal-tenant-1',
      tenant: {
        ownerUserId: 'another-user',
        name: 'Shared team',
        type: 'team',
        status: 'active',
        deletedAt: null,
      },
    }]);

    await expect(service.provision({
      idempotencyKey: 'provision-owner-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).resolves.toEqual(expect.objectContaining({
      userId: 'internal-user-1',
      tenantId: 'internal-tenant-1',
    }));

    expect(prisma.tenantMember.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_userId: {
          tenantId: 'internal-tenant-1',
          userId: 'internal-user-1',
        },
      },
      create: {
        tenantId: 'internal-tenant-1',
        userId: 'internal-user-1',
        role: 'member',
        status: 'active',
      },
      update: {
        role: 'member',
        status: 'active',
      },
    });
    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'internal-user-1',
      'internal-tenant-1',
    );
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it('never adds a non-owner user to an explicitly addressed personal tenant', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      id: 'user-binding-1',
      userId: 'internal-user-1',
      user: { isActive: true, deletedAt: null },
    }]);
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      id: 'tenant-binding-1',
      tenantId: 'personal-tenant-1',
      tenant: {
        ownerUserId: 'another-user',
        name: 'Another personal tenant',
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
    }]);

    await expect(service.provision({
      idempotencyKey: 'personal-owner-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-personal-1', type: 'personal' },
    })).rejects.toThrow('产品租户绑定的 owner 不匹配');
    expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
    expect(billingService.resolveSubjectForUser).not.toHaveBeenCalled();
  });

  it('does not let a product mutate a backfilled shared global user snapshot', async () => {
    const { service, prisma, userMirror } = buildService();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      id: 'legacy-user-binding',
      userId: 'legacy-global-user',
      snapshotWritable: false,
      user: {
        isActive: true,
        deletedAt: null,
        email: 'owner@example.com',
        phone: null,
        nickname: 'Owner',
      },
    }]);

    await expect(service.provision({
      idempotencyKey: 'provision-legacy-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: {
        id: 'legacy-global-user',
        email: 'attacker@example.com',
      },
      tenant: { id: 'legacy-tenant' },
    })).rejects.toThrow('历史共享用户绑定不允许');

    expect(userMirror.mirrorUser).not.toHaveBeenCalled();
    expect(prisma.productExternalTenantBinding.findMany).not.toHaveBeenCalled();
  });

  it('does not resolve an unbound global user id', async () => {
    const { service, prisma } = buildService();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([]);

    await expect(service.resolveProductUser('prod-1', 'global-user-1'))
      .rejects.toThrow('产品未绑定该用户');
  });

  it('resolves an external product subject with its product-scoped contact email', async () => {
    const { service, prisma } = buildService();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      userId: 'internal-user-1',
      email: 'product-user@example.com',
      phone: null,
      nickname: null,
      user: { isActive: true, deletedAt: null },
    }]);
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      tenantId: 'internal-tenant-1',
      tenant: {
        ownerUserId: 'internal-user-1',
        status: 'active',
        deletedAt: null,
      },
    }]);

    await expect(service.resolveProductSubject(
      'prod-1',
      'external-user-1',
      'external-tenant-1',
    )).resolves.toEqual({
      userId: 'internal-user-1',
      tenantId: 'internal-tenant-1',
      email: 'product-user@example.com',
    });
  });

  it('recovers the same encrypted key after Publisher failure instead of creating another key', async () => {
    const { service, publisherSync, prisma, keys } = buildService();
    publisherSync.syncApiKeyActivationRequired.mockRejectedValueOnce(
      new Error('publisher unavailable'),
    );

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {},
    )).rejects.toThrow('publisher unavailable');

    expect(keys).toHaveLength(1);
    const persisted = keys[0];
    const recoverablePlainKey = decrypt(
      persisted.provisionSecretEncrypted!,
      ENCRYPTION_KEY,
    );

    const retry = await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {},
    );

    expect(retry).toEqual(expect.objectContaining({
      id: persisted.id,
      plainKey: recoverablePlainKey,
      created: false,
    }));
    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeyActivationRequired).toHaveBeenLastCalledWith(persisted.id);
  });

  it('retries a failed provision with the same receipt and partially created key', async () => {
    const {
      service,
      prisma,
      publisherSync,
      keys,
      receipts,
    } = buildService();
    const request = {
      idempotencyKey: 'publisher-recovery-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1', type: 'personal' },
    };
    publisherSync.syncApiKeyActivationRequired.mockRejectedValueOnce(
      new Error('publisher unavailable'),
    );

    await expect(service.provision(request)).rejects.toThrow('publisher unavailable');

    expect(keys).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(expect.objectContaining({
      status: 'FAILED',
      lastError: 'publisher unavailable',
    }));
    const userId = prisma.productExternalUserBinding.create.mock.calls[0][0].data.userId;
    const tenantId = prisma.tenant.create.mock.calls[0][0].data.id;
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      id: 'user-binding-1',
      userId,
      snapshotWritable: true,
      email: null,
      phone: null,
      nickname: null,
      sourceUpdatedAt: null,
      user: {
        isActive: true,
        deletedAt: null,
        email: null,
        phone: null,
        nickname: null,
        sourceUpdatedAt: null,
      },
    }]);
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      id: 'tenant-binding-1',
      tenantId,
      snapshotWritable: true,
      tenant: {
        ownerUserId: userId,
        name: `SaaS Tenant ${tenantId.slice(0, 8)}`,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
    }]);

    const retry = await service.provision(request);

    expect(retry.apiKey.id).toBe(keys[0].id);
    expect(retry.apiKey.plainKey).toBe(decrypt(
      keys[0].provisionSecretEncrypted!,
      ENCRYPTION_KEY,
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('SUCCEEDED');
    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeyActivationRequired).toHaveBeenCalledTimes(2);
  });

  it('rejects arbitrary key names so a product token cannot mint an unbounded key set', async () => {
    const { service, prisma } = buildService();

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      { name: 'another-key' },
    )).rejects.toThrow('key.name 仅支持固定值 saas:coding:virtual');

    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('cleans expired recovery ciphertexts in the periodic cleanup path', async () => {
    const { service, prisma } = buildService();
    const now = new Date('2026-07-23T00:00:00.000Z');

    await expect((service as any).cleanupExpiredProvisionSecrets(now)).resolves.toBe(0);

    expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: {
        managedBy: 'saas_provision',
        provisionSecretEncrypted: { not: null },
        OR: [
          { provisionSecretExpiresAt: null },
          { provisionSecretExpiresAt: { lte: now } },
        ],
      },
      data: {
        provisionSecretEncrypted: null,
        provisionSecretExpiresAt: null,
      },
    });
  });

  it('clears an expired recovery secret when the managed key is next accessed', async () => {
    const expiredKey: KeyRow = {
      id: 'key-expired-secret',
      prefix: 'rk-expired',
      keyHash: 'hash-expired',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: encrypt('rk-expired-secret-value', ENCRYPTION_KEY),
      provisionSecretExpiresAt: new Date(Date.now() - 1),
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      createdAt: new Date(),
    };
    const { service, keys } = buildService([expiredKey]);

    const result = await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {},
    );

    expect(result.plainKey).toBeNull();
    expect(keys[0]).toMatchObject({
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
    });
  });

  it('fails closed instead of taking over an unmanaged same-name key', async () => {
    const unmanaged: KeyRow = {
      id: 'key-unmanaged',
      prefix: 'rk-unmanaged',
      keyHash: 'hash-unmanaged',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: null,
      createdAt: new Date(),
    };
    const { service, prisma, publisherSync } = buildService([unmanaged]);

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {},
    )).rejects.toThrow('同名 API Key 不属于 SaaS provision');

    expect(prisma.apiKey.create).not.toHaveBeenCalled();
    expect(publisherSync.syncApiKeyActivationRequired).not.toHaveBeenCalled();
  });

  it('fails closed when legacy data already has multiple managed active keys', async () => {
    const duplicateKeys = ['key-1', 'key-2'].map((id): KeyRow => ({
      id,
      prefix: `rk-${id}`,
      keyHash: `hash-${id}`,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      createdAt: new Date(),
    }));
    const { service, publisherSync } = buildService(duplicateKeys);

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {},
    )).rejects.toThrow('存在多个 active 记录');

    expect(publisherSync.syncApiKeyActivationRequired).not.toHaveBeenCalled();
  });

  it('keeps the predecessor row until Publisher acknowledges revocation', async () => {
    const oldKey: KeyRow = {
      id: 'key-old',
      prefix: 'rk-old',
      keyHash: 'hash-old',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date('2026-07-01T00:00:00.000Z'),
      provisionSecretEncrypted: encrypt('rk-old-secret', ENCRYPTION_KEY),
      provisionSecretExpiresAt: new Date(Date.now() + 60_000),
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const { service, prisma, publisherSync, keys } = buildService([oldKey]);
    publisherSync.syncApiKeyActivationRequired.mockImplementation(async () => {
      expect(keys.find((key) => key.id === 'key-old')).toMatchObject({
        isActive: true,
        deletedAt: null,
      });
      expect(keys.find((key) => key.id !== 'key-old')).toMatchObject({
        isActive: false,
        mirrorStatus: 'PROVISIONING',
      });
    });
    publisherSync.revokeApiKeyRequired.mockImplementation(async () => {
      expect(keys.find((key) => key.id === 'key-old')).toMatchObject({
        isActive: true,
        deletedAt: null,
      });
      expect(keys.find((key) => key.id !== 'key-old')).toMatchObject({
        isActive: false,
        mirrorStatus: 'PROVISIONING',
      });
    });

    const result = await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      { rotate: true },
    );

    expect(result).toEqual(expect.objectContaining({
      created: true,
      rotated: true,
      plainKey: expect.stringMatching(/^rk-/),
    }));
    expect(publisherSync.syncApiKeyActivationRequired.mock.invocationCallOrder[0])
      .toBeLessThan(publisherSync.revokeApiKeyRequired.mock.invocationCallOrder[0]);
    expect(publisherSync.revokeApiKeyRequired.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.apiKey.updateMany.mock.invocationCallOrder[0]);
    expect(publisherSync.revokeApiKeyRequired).toHaveBeenCalledWith({
      id: 'key-old',
      keyHash: 'hash-old',
    });
    expect(keys.find((key) => key.id === 'key-old')).toMatchObject({
      isActive: false,
      mirrorStatus: 'REVOKED',
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      deletedAt: expect.any(Date),
    });
  });

  it('keeps both local key states unchanged when Publisher activation fails', async () => {
    const oldKey: KeyRow = {
      id: 'key-old',
      prefix: 'rk-old',
      keyHash: 'hash-old',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: null,
      budgetUsd: null,
      createdAt: new Date(),
    };
    const { service, publisherSync, keys } = buildService([oldKey]);
    publisherSync.syncApiKeyActivationRequired.mockRejectedValueOnce(
      new Error('activation unavailable'),
    );

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      { rotate: true },
    )).rejects.toThrow('activation unavailable');

    expect(keys.find((key) => key.id === 'key-old')).toMatchObject({
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
    });
    expect(keys.find((key) => key.id !== 'key-old')).toMatchObject({
      isActive: false,
      mirrorStatus: 'PROVISIONING',
      deletedAt: null,
    });
    expect(publisherSync.revokeApiKeyRequired).not.toHaveBeenCalled();
  });

  it('keeps the predecessor active when Publisher revocation fails', async () => {
    const oldKey: KeyRow = {
      id: 'key-old',
      prefix: 'rk-old',
      keyHash: 'hash-old',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: null,
      budgetUsd: null,
      createdAt: new Date(),
    };
    const { service, publisherSync, keys } = buildService([oldKey]);
    publisherSync.revokeApiKeyRequired.mockRejectedValueOnce(
      new Error('revoke unavailable'),
    );

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      { rotate: true },
    )).rejects.toThrow('revoke unavailable');

    expect(keys.find((key) => key.id === 'key-old')).toMatchObject({
      isActive: true,
      deletedAt: null,
    });
    expect(keys.find((key) => key.id !== 'key-old')).toMatchObject({
      isActive: false,
      mirrorStatus: 'PROVISIONING',
      deletedAt: null,
    });
  });

  it('replays a completed rotation from a durable receipt without another rotation or plaintext persistence', async () => {
    const oldKey: KeyRow = {
      id: 'key-old',
      prefix: 'rk-old',
      keyHash: 'hash-old',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: null,
      budgetUsd: null,
      createdAt: new Date(),
    };
    const {
      service,
      prisma,
      publisherSync,
      receipts,
    } = buildService([oldKey]);
    const request = {
      idempotencyKey: 'rotate-receipt-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
      key: { rotate: true },
    };

    const first = await service.provision(request);
    const replay = await service.provision(request);

    expect(replay).toEqual(first);
    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeyActivationRequired).toHaveBeenCalledTimes(1);
    expect(publisherSync.revokeApiKeyRequired).toHaveBeenCalledTimes(1);
    expect(receipts[0].status).toBe('SUCCEEDED');
    expect(receipts[0].result.apiKey.plainKey).toBeNull();
    expect(JSON.stringify(receipts[0].result)).not.toContain(first.apiKey.plainKey);
  });

  it('never discloses one provision receipt secret through a different idempotency receipt', async () => {
    const { service, receipts } = buildService();
    const firstReceipt = {
      id: 'receipt-secret-owner',
      productId: 'prod-1',
      idempotencyKey: 'secret-owner-1',
      requestFingerprint: 'fingerprint-owner',
      status: 'PENDING',
      leaseId: 'lease-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      result: null,
    };
    receipts.push(firstReceipt);

    const firstKey = await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      undefined,
      {
        id: firstReceipt.id,
        leaseId: firstReceipt.leaseId,
        replayResult: null,
      },
    );
    expect(firstKey.plainKey).toMatch(/^rk-/);
    await (service as any).completeProvisionReceipt(
      {
        id: firstReceipt.id,
        leaseId: firstReceipt.leaseId,
        replayResult: null,
      },
      {
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        productSlug: 'coding',
        apiKey: firstKey,
        subscription: null,
      },
    );

    const secondReceipt = {
      id: 'receipt-different-request',
      productId: 'prod-1',
      idempotencyKey: 'different-request-1',
      requestFingerprint: 'fingerprint-different',
      status: 'PENDING',
      leaseId: 'lease-different',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      result: null,
    };
    receipts.push(secondReceipt);
    const secondKey = await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      undefined,
      {
        id: secondReceipt.id,
        leaseId: secondReceipt.leaseId,
        replayResult: null,
      },
    );
    expect(secondKey).toMatchObject({
      id: firstKey.id,
      prefix: firstKey.prefix,
      plainKey: null,
      created: false,
    });
    await (service as any).completeProvisionReceipt(
      {
        id: secondReceipt.id,
        leaseId: secondReceipt.leaseId,
        replayResult: null,
      },
      {
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        productSlug: 'coding',
        apiKey: secondKey,
        subscription: null,
      },
    );

    const exactReplay = await (service as any).hydrateProvisionReceiptResult(
      firstReceipt.result,
    );
    const differentReplay = await (service as any).hydrateProvisionReceiptResult(
      secondReceipt.result,
    );
    expect(exactReplay.apiKey.plainKey).toBe(firstKey.plainKey);
    expect(differentReplay.apiKey.plainKey).toBeNull();
    expect(JSON.stringify(secondReceipt.result)).not.toContain(firstKey.plainKey);
  });

  it('rejects reuse of a provision idempotency key with a different normalized request', async () => {
    const { service, prisma } = buildService();
    const request = {
      idempotencyKey: 'same-receipt-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1', name: 'Original' },
    };
    await service.provision(request);

    await expect(service.provision({
      ...request,
      tenant: { ...request.tenant, name: 'Changed' },
    })).rejects.toThrow('idempotencyKey 已用于不同');

    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
  });

  it('requires a valid top-level provision idempotency key', async () => {
    const { service, prisma } = buildService();

    await expect(service.provision({
      productId: 'prod-1',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).rejects.toThrow('idempotencyKey 是必填字段');
    await expect(service.provision({
      idempotencyKey: 'bad key!',
      productId: 'prod-1',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).rejects.toThrow('idempotencyKey 长度必须');

    expect(prisma.saasProvisionReceipt.create).not.toHaveBeenCalled();
  });

  it('returns the successful result even when tenant lease release fails and logs the TTL recovery', async () => {
    const { service, prisma } = buildService();
    const log = jest.spyOn((service as any).logger, 'error').mockImplementation();
    prisma.productExternalTenantBinding.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (data.provisioningLeaseId === null) {
          throw new Error('lease store unavailable');
        }
        return { count: 1 };
      },
    );

    await expect(service.provision({
      idempotencyKey: 'release-success-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).resolves.toEqual(expect.objectContaining({
      productId: 'prod-1',
    }));

    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to release'));
  });

  it('preserves the primary workflow error when tenant lease release also fails', async () => {
    const { service, prisma, billingService } = buildService();
    const log = jest.spyOn((service as any).logger, 'error').mockImplementation();
    billingService.resolveSubjectForUser.mockRejectedValueOnce(
      new Error('billing unavailable'),
    );
    prisma.productExternalTenantBinding.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (data.provisioningLeaseId === null) {
          throw new Error('lease store unavailable');
        }
        return { count: 1 };
      },
    );

    await expect(service.provision({
      idempotencyKey: 'release-primary-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).rejects.toThrow('billing unavailable');

    expect(log).toHaveBeenCalledWith(expect.stringContaining('primary=billing unavailable'));
  });

  it('resolves a self-operated user-only provision to its stable personal tenant for later scopes', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
      isActive: true,
      deletedAt: null,
    });
    billingService.isSelfOperatedCodingPlanProduct.mockResolvedValue(true);

    const provisioned = await service.provision({
      idempotencyKey: 'user-only-scope-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
    });
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      userId: provisioned.userId,
      email: null,
      phone: null,
      nickname: null,
      user: { isActive: true, deletedAt: null },
    }]);
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      tenantId: provisioned.tenantId,
      tenant: {
        ownerUserId: provisioned.userId,
        status: 'active',
        deletedAt: null,
      },
    }]);

    await expect(service.resolveProductSubject(
      'prod-1',
      'external-user-1',
    )).resolves.toEqual({
      userId: provisioned.userId,
      tenantId: provisioned.tenantId,
      email: null,
    });
  });

  it('rejects a team tenant shape when self-operated user-only scope omits tenant.id', async () => {
    const { service, prisma } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
      isActive: true,
      deletedAt: null,
    });

    await expect(service.provision({
      idempotencyKey: 'user-only-team-shape-1',
      productId: 'prod-1',
      productSlug: 'coding',
      user: { id: 'external-user-1' },
      tenant: { name: 'Team without id', type: 'team' },
    })).rejects.toThrow('tenant.type 只能是 personal');
    expect(prisma.saasProvisionReceipt.create).not.toHaveBeenCalled();
    expect(prisma.tenant.create).not.toHaveBeenCalled();
  });

  it('validates an explicit self-operated team but resolves all runtime reads to the personal tenant', async () => {
    const { service, prisma, billingService } = buildService();
    billingService.isSelfOperatedCodingPlanProduct.mockResolvedValue(true);
    prisma.productExternalUserBinding.findMany.mockResolvedValue([{
      userId: 'user-1',
      email: 'user@example.com',
      phone: null,
      nickname: null,
      user: { isActive: true, deletedAt: null },
    }]);
    prisma.productExternalTenantBinding.findMany.mockImplementation(
      async ({ where }: any) => (
        where.externalTenantId
          ? [{
              tenantId: 'team-tenant-1',
              tenant: {
                ownerUserId: 'team-owner',
                status: 'active',
                deletedAt: null,
              },
            }]
          : [{
              tenantId: 'personal-tenant-1',
              tenant: {
                ownerUserId: 'user-1',
                status: 'active',
                deletedAt: null,
              },
            }]
      ),
    );
    prisma.tenantMember.findUnique.mockImplementation(async ({ where }: any) => (
      where.tenantId_userId.tenantId === 'team-tenant-1'
        ? { role: 'member', status: 'active' }
        : { role: 'owner', status: 'active' }
    ));

    await expect(service.resolveProductSubject(
      'prod-1',
      'external-user-1',
      'external-team-1',
    )).resolves.toEqual({
      userId: 'user-1',
      tenantId: 'personal-tenant-1',
      email: 'user@example.com',
    });
  });

  it('keeps team subject bindings isolated by product', async () => {
    const { service, prisma, billingService } = buildService();
    billingService.isSelfOperatedCodingPlanProduct.mockResolvedValue(false);
    prisma.productExternalUserBinding.findMany.mockImplementation(
      async ({ where }: any) => (
        where.productId === 'prod-a'
          ? [{
              userId: 'user-a',
              email: null,
              phone: null,
              nickname: null,
              user: { isActive: true, deletedAt: null },
            }]
          : []
      ),
    );
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      tenantId: 'team-a',
      tenant: {
        ownerUserId: 'owner-a',
        status: 'active',
        deletedAt: null,
      },
    }]);
    prisma.tenantMember.findUnique.mockResolvedValue({
      role: 'member',
      status: 'active',
    });

    await expect(service.resolveProductSubject(
      'prod-a',
      'external-user',
      'external-team',
    )).resolves.toEqual({
      userId: 'user-a',
      tenantId: 'team-a',
      email: null,
    });
    await expect(service.resolveProductSubject(
      'prod-b',
      'external-user',
      'external-team',
    )).rejects.toThrow('产品未绑定该用户');
  });

  it('does not treat another binding internal UUID as an external user alias', async () => {
    const { service, prisma } = buildService();
    prisma.productExternalUserBinding.findMany.mockImplementation(
      async ({ where }: any) => (
        where.externalUserId === 'external-user-1'
          ? [{
              userId: 'internal-uuid-1',
              email: null,
              phone: null,
              nickname: null,
              user: { isActive: true, deletedAt: null },
            }]
          : []
      ),
    );

    await expect(service.resolveProductUser(
      'prod-1',
      'internal-uuid-1',
    )).rejects.toThrow('产品未绑定该用户');
    expect(prisma.productExternalUserBinding.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          productId: 'prod-1',
          externalUserId: 'internal-uuid-1',
        },
      }),
    );
  });

  it('declaratively updates a writable tenant name but rejects legacy snapshot changes', async () => {
    const { service, prisma } = buildService();
    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      id: 'tenant-binding-1',
      tenantId: 'tenant-1',
      snapshotWritable: true,
      tenant: {
        ownerUserId: 'user-1',
        name: 'Old name',
        type: 'team',
        status: 'active',
        deletedAt: null,
      },
    }]);

    await expect((service as any).ensureBoundTenant(
      prisma,
      'prod-1',
      'user-binding-1',
      'user-1',
      { id: 'external-tenant-1', name: 'New name', type: 'team' },
    )).resolves.toEqual({ id: 'tenant-1', bindingId: 'tenant-binding-1' });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: {
        name: 'New name',
        mirroredAt: expect.any(Date),
      },
    });

    prisma.productExternalTenantBinding.findMany.mockResolvedValue([{
      id: 'legacy-binding',
      tenantId: 'tenant-legacy',
      snapshotWritable: false,
      tenant: {
        ownerUserId: 'user-1',
        name: 'Legacy',
        type: 'team',
        status: 'active',
        deletedAt: null,
      },
    }]);
    await expect((service as any).ensureBoundTenant(
      prisma,
      'prod-1',
      'user-binding-1',
      'user-1',
      { id: 'legacy-external', name: 'Changed', type: 'team' },
    )).rejects.toThrow('历史共享租户绑定不允许');
  });

  it('rejects unversioned or same-version changes to a versioned product user snapshot', async () => {
    const { service, prisma, userMirror } = buildService();
    const binding = {
      id: 'user-binding-1',
      userId: 'user-1',
      snapshotWritable: true,
      email: 'old@example.com',
      phone: null,
      nickname: 'Old',
      sourceUpdatedAt: new Date('2026-07-20T00:00:00.000Z'),
      user: {
        isActive: true,
        deletedAt: null,
        email: 'old@example.com',
        phone: null,
        nickname: 'Old',
        sourceUpdatedAt: new Date('2026-07-20T00:00:00.000Z'),
      },
    };
    prisma.productExternalUserBinding.findMany.mockResolvedValue([binding]);

    await expect((service as any).ensureBoundUser(
      prisma,
      'prod-1',
      'external-user-1',
      { id: 'external-user-1', email: 'new@example.com' },
    )).rejects.toThrow('必须提供晚于当前快照');
    await expect((service as any).ensureBoundUser(
      prisma,
      'prod-1',
      'external-user-1',
      {
        id: 'external-user-1',
        email: 'new@example.com',
        sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
      },
    )).rejects.toThrow('必须提供晚于当前快照');
    expect(userMirror.mirrorUser).not.toHaveBeenCalled();
  });

  it('keeps the product-scoped contact snapshot even when global User projection cannot own the email', async () => {
    const { service, prisma } = buildService();

    await (service as any).ensureBoundUser(
      prisma,
      'prod-2',
      'external-user-2',
      {
        id: 'external-user-2',
        email: 'shared@example.com',
        phone: '13800000000',
        nickname: 'Shared',
        sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
      },
    );

    expect(prisma.productExternalUserBinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-2',
        externalUserId: 'external-user-2',
        email: 'shared@example.com',
        phone: '13800000000',
        nickname: 'Shared',
        sourceUpdatedAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
      select: { id: true },
    });
  });

  it('treats allowedModels as a canonical set and requires rotation for real config changes', async () => {
    const active: KeyRow = {
      id: 'key-active',
      prefix: 'rk-active',
      keyHash: 'hash-active',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: '["gpt-4","gpt-5"]',
      budgetUsd: new Prisma.Decimal(1),
      createdAt: new Date(),
    };
    const { service, prisma } = buildService([active]);

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {
        allowedModels: ['gpt-5', ' gpt-4 ', 'gpt-5'],
        budgetCents: 100,
      },
    )).resolves.toEqual(expect.objectContaining({ id: 'key-active' }));
    expect(prisma.apiKey.create).not.toHaveBeenCalled();

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      { budgetCents: 200 },
    )).rejects.toThrow('配置变化需要显式设置 rotate=true');
  });

  it('applies declared key config on an explicit rotation', async () => {
    const active: KeyRow = {
      id: 'key-active',
      prefix: 'rk-active',
      keyHash: 'hash-active',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      activatedAt: new Date(),
      provisionSecretEncrypted: null,
      provisionSecretExpiresAt: null,
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: '["gpt-4"]',
      budgetUsd: new Prisma.Decimal(1),
      createdAt: new Date(),
    };
    const { service, prisma } = buildService([active]);

    await (service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      {
        rotate: true,
        allowedModels: ['gpt-6', 'gpt-5', 'gpt-6'],
        budgetCents: 250,
      },
    );

    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        allowedModels: '["gpt-5","gpt-6"]',
        budgetUsd: new Prisma.Decimal(2.5),
        isActive: false,
        mirrorStatus: 'PROVISIONING',
      }),
    });
  });

  it('skips subscription creation by default for PAY_AS_YOU_GO and rejects ensureFreePlan=true', async () => {
    const { service, prisma, subscriptionLifecycle } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'payg',
      billingMode: 'PAY_AS_YOU_GO',
      codingPlanFulfillmentMode: null,
      isActive: true,
      deletedAt: null,
    });

    await expect(service.provision({
      idempotencyKey: 'payg-default-1',
      productId: 'prod-1',
      productSlug: 'payg',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    })).resolves.toEqual(expect.objectContaining({ subscription: null }));
    expect(subscriptionLifecycle.activateIfAbsent).not.toHaveBeenCalled();
    expect(prisma.plan.findFirst).not.toHaveBeenCalled();

    await expect(service.provision({
      idempotencyKey: 'payg-explicit-1',
      productId: 'prod-1',
      productSlug: 'payg',
      ensureFreePlan: true,
      user: { id: 'external-user-2' },
      tenant: { id: 'external-tenant-2' },
    })).rejects.toThrow('PAY_AS_YOU_GO 产品不支持');
  });

  it('never grants provision quota to an independently active paid subscription', async () => {
    const { service, prisma, creditService, subscriptionLifecycle } = buildService();
    prisma.plan.findFirst.mockResolvedValue({
      id: 'plan-free',
      name: 'Free',
      monthlyCredits: 100,
      validityDays: 30,
    });
    subscriptionLifecycle.activateIfAbsent.mockResolvedValue({
      contractId: 'contract-paid',
      periodId: 'subscription-paid',
      entitlementId: 'entitlement-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
      created: false,
    });

    await expect((service as any).ensureDefaultPlan(
      'user-1',
      'tenant-1',
      'prod-1',
      'receipt-1',
      'ba-1',
    )).resolves.toEqual({
      id: 'subscription-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
      created: false,
    });
    expect(creditService.grantQuota).not.toHaveBeenCalled();
  });

  it('converges to a paid replacement before quota issuance and receipt completion', async () => {
    const {
      service,
      prisma,
      creditService,
      subscriptionLifecycle,
    } = buildService();
    prisma.plan.findFirst.mockResolvedValue({
      id: 'plan-free',
      name: 'Free',
      monthlyCredits: 100,
      validityDays: 30,
    });
    subscriptionLifecycle.activateIfAbsent.mockResolvedValue({
      contractId: 'contract-free',
      periodId: 'subscription-free',
      entitlementId: 'entitlement-free',
      planId: 'plan-free',
      provisionReceiptId: 'receipt-1',
      created: true,
    });
    subscriptionLifecycle.withCurrentActivePeriod.mockImplementation(
      async (_tenantId: string, _productId: string, callback: (period: any) => unknown) => callback({
        periodId: 'subscription-paid',
        contractId: 'contract-paid',
        userId: 'paid-owner',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        planId: 'plan-paid',
        provisionReceiptId: null,
        expiresAt: null,
      }),
    );

    const result = await service.provision({
      idempotencyKey: 'paid-race-1',
      productId: 'prod-1',
      productSlug: 'coding',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    });

    expect(result.subscription).toEqual({
      id: 'subscription-paid',
      planId: 'plan-paid',
      created: false,
    });
    expect(creditService.grantQuota).not.toHaveBeenCalled();
    expect(prisma.tenantProductEntitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ planId: 'plan-paid' }),
        update: expect.objectContaining({ planId: 'plan-paid' }),
      }),
    );
  });

  it('creates self-operated Coding Plan entitlement and binds the key to the personal runtime tenant', async () => {
    const {
      service,
      prisma,
      billingService,
      subscriptionLifecycle,
    } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
      isActive: true,
      deletedAt: null,
    });
    prisma.plan.findFirst.mockResolvedValue({
      id: 'plan-free',
      name: 'Free',
      monthlyCredits: 100,
      validityDays: 30,
    });
    const createdTenantIds: string[] = [];
    prisma.tenant.create.mockImplementation(async ({ data }: any) => {
      createdTenantIds.push(data.id);
      return { id: data.id };
    });
    subscriptionLifecycle.activateCodingPlanIfAbsent.mockImplementation(
      async (input: any) => ({
        id: 'coding-entitlement-1',
        userId: input.userId,
        tenantId: input.tenantId,
        productId: input.productId,
        planId: input.planId,
        provisionReceiptId: input.provisionReceiptId,
        status: 'ACTIVE',
        expiresAt: input.expiresAt,
        created: true,
      }),
    );
    subscriptionLifecycle.withCurrentActiveCodingPlanEntitlement.mockImplementation(
      async (tenantId: string, productId: string, callback: (entitlement: any) => unknown) => callback({
        id: 'coding-entitlement-1',
        userId: 'internal-user',
        tenantId,
        productId,
        planId: 'plan-free',
        provisionReceiptId: 'receipt-1',
        status: 'ACTIVE',
        expiresAt: null,
        created: false,
      }),
    );

    const result = await service.provision({
      idempotencyKey: 'coding-entitlement-1',
      productId: 'prod-1',
      productSlug: 'coding',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-team-1', name: 'External team', type: 'team' },
    });

    expect(createdTenantIds).toHaveLength(2);
    expect(result.tenantId).toBe(createdTenantIds[0]);
    const personalTenantId = createdTenantIds[1];
    expect(subscriptionLifecycle.activateCodingPlanIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: personalTenantId,
        productId: 'prod-1',
        planId: 'plan-free',
        provisionReceiptId: 'receipt-1',
      }),
    );
    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: personalTenantId,
        productId: 'prod-1',
        codingPlanEntitlementId: 'coding-entitlement-1',
      }),
    });
    expect(billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      expect.any(String),
      personalTenantId,
    );
  });

  it('does not auto-provision provider-resale and binds only an existing active entitlement', async () => {
    const { service, prisma, subscriptionLifecycle } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding-resale',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
      isActive: true,
      deletedAt: null,
    });
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'resale-entitlement-1',
      planId: 'resale-plan-1',
      provisionReceiptId: null,
    });

    await expect(service.provision({
      idempotencyKey: 'resale-default-1',
      productId: 'prod-1',
      productSlug: 'coding-resale',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-team-1', type: 'team' },
    })).resolves.toEqual(expect.objectContaining({
      subscription: {
        id: 'resale-entitlement-1',
        planId: 'resale-plan-1',
        created: false,
      },
    }));
    expect(subscriptionLifecycle.activateCodingPlanIfAbsent).not.toHaveBeenCalled();
    expect(prisma.plan.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        codingPlanEntitlementId: 'resale-entitlement-1',
      }),
    });

    await expect(service.provision({
      idempotencyKey: 'resale-explicit-1',
      productId: 'prod-1',
      productSlug: 'coding-resale',
      ensureFreePlan: true,
      user: { id: 'external-user-2' },
      tenant: { id: 'external-team-2', type: 'team' },
    })).rejects.toThrow('provider_resale Coding Plan 不允许');
  });

  it('rejects provider-resale key provisioning when no active entitlement exists', async () => {
    const { service, prisma } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding-resale',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
      isActive: true,
      deletedAt: null,
    });

    await expect(service.provision({
      idempotencyKey: 'resale-missing-1',
      productId: 'prod-1',
      productSlug: 'coding-resale',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-team-1', type: 'team' },
    })).rejects.toThrow('需要既有 active entitlement');
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('fails closed for a CODING_PLAN product with an unknown fulfillment mode', async () => {
    const { service, prisma } = buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-1',
      slug: 'coding-unknown',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: null,
      isActive: true,
      deletedAt: null,
    });

    await expect(service.provision({
      idempotencyKey: 'coding-mode-unknown-1',
      productId: 'prod-1',
      productSlug: 'coding-unknown',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-team-1' },
    })).rejects.toThrow('fulfillment mode 未配置');
    expect(prisma.saasProvisionReceipt.create).not.toHaveBeenCalled();
  });

  it('rejects a configured paid plan when any active PlanPrice period is positive', async () => {
    const { service, prisma } = buildService();
    prisma.product.findFirst.mockResolvedValue({ defaultPlanId: 'plan-paid' });
    prisma.plan.findFirst.mockResolvedValue(null);

    await expect((service as any).findDefaultPlan('prod-1'))
      .rejects.toThrow('不是免费套餐');
    expect(prisma.plan.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'plan-paid',
        monthlyPrice: 0,
        quarterlyPrice: 0,
        yearlyPrice: 0,
        deletedAt: null,
        prices: {
          none: {
            isActive: true,
            OR: [
              { monthlyPrice: { gt: 0 } },
              { quarterlyPrice: { gt: 0 } },
              { yearlyPrice: { gt: 0 } },
            ],
          },
        },
      }),
    }));
  });

  it('rejects an empty explicit allowedModels list before any provision write', async () => {
    const { service, prisma } = buildService();

    await expect(service.provision({
      idempotencyKey: 'empty-models-1',
      productId: 'prod-1',
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
      key: { allowedModels: [' ', ''] },
    })).rejects.toThrow('至少需要一个非空模型');
    expect(prisma.saasProvisionReceipt.create).not.toHaveBeenCalled();
  });

  it('rejects requested models that are not visible in the bound product and plan', async () => {
    const { service, prisma, catalog } = buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'subscription-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
    });
    catalog.getModels.mockResolvedValue({
      models: [{ id: 'gpt-product-a' }],
    });
    prisma.modelAccess.findMany.mockResolvedValue([
      { modelName: 'gpt-product-a' },
      { modelName: 'gpt-other-product' },
    ]);

    await expect(service.provision({
      idempotencyKey: 'cross-product-model-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
      key: { allowedModels: ['gpt-other-product'] },
    })).rejects.toThrow('当前产品或套餐未授权模型');
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('accepts a catalog-visible subscription model without requiring ProductModelAvailability', async () => {
    const { service, prisma, catalog } = buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'subscription-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
    });
    catalog.getModels.mockResolvedValue({
      models: [{ id: 'gpt-plan-only' }],
    });
    prisma.modelAccess.findMany.mockResolvedValue([
      { modelName: 'gpt-plan-only' },
    ]);

    await expect(service.provision({
      idempotencyKey: 'plan-model-without-availability-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
      key: { allowedModels: ['gpt-plan-only'] },
    })).resolves.toEqual(expect.objectContaining({
      apiKey: expect.objectContaining({ id: expect.any(String) }),
    }));
    expect(prisma.productModelAvailability.findMany).not.toHaveBeenCalled();
    expect(catalog.getModels).toHaveBeenCalledWith(expect.objectContaining({
      id: 'prod-1',
    }));
  });

  it('does not adopt a pending key created by another idempotency receipt', async () => {
    const pending: KeyRow = {
      id: 'key-pending-other',
      prefix: 'rk-pending',
      keyHash: 'f'.repeat(64),
      isActive: false,
      mirrorStatus: 'PROVISIONING',
      activatedAt: null,
      provisionSecretEncrypted: encrypt('rk-pending-secret', ENCRYPTION_KEY),
      provisionSecretExpiresAt: new Date(Date.now() + 60_000),
      rotationPredecessorId: null,
      deletedAt: null,
      managedBy: 'saas_provision',
      allowedModels: null,
      budgetUsd: null,
    };
    const { service, receipts } = buildService([pending]);
    receipts.push({
      id: 'receipt-new',
      status: 'PENDING',
      leaseId: 'lease-new',
      result: null,
    });

    await expect((service as any).ensureVirtualApiKey(
      'user-1',
      'tenant-1',
      'prod-1',
      'coding',
      undefined,
      {
        id: 'receipt-new',
        leaseId: 'lease-new',
        replayResult: null,
      },
    )).rejects.toThrow('属于其他幂等请求');
  });

  it('fingerprints equivalent allowedModels sets identically across receipt replays', async () => {
    const { service, prisma } = buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'subscription-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
    });
    const base = {
      idempotencyKey: 'model-set-replay-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    };

    const first = await service.provision({
      ...base,
      key: { allowedModels: ['gpt-5', 'gpt-4', 'gpt-5'] },
    });
    const replay = await service.provision({
      ...base,
      key: { allowedModels: [' gpt-4 ', 'gpt-5'] },
    });

    expect(replay).toEqual(first);
    expect(prisma.apiKey.create).toHaveBeenCalledTimes(1);
  });

  it('replays the same key id with plainKey null after the recovery window expires', async () => {
    const { service, keys } = buildService();
    const request = {
      idempotencyKey: 'expired-replay-1',
      productId: 'prod-1',
      productSlug: 'coding',
      ensureFreePlan: false,
      user: { id: 'external-user-1' },
      tenant: { id: 'external-tenant-1' },
    };
    const first = await service.provision(request);
    const key = keys.find((row) => row.id === first.apiKey.id)!;
    key.provisionSecretExpiresAt = new Date(Date.now() - 1);

    const replay = await service.provision(request);

    expect(replay.apiKey).toEqual(expect.objectContaining({
      id: first.apiKey.id,
      prefix: first.apiKey.prefix,
      plainKey: null,
    }));
    expect(key.provisionSecretEncrypted).toBeNull();
    expect(key.provisionSecretExpiresAt).toBeNull();
  });
});

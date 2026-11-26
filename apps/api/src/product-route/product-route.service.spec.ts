import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductBillingMode } from '@prisma/client';
import { ProductRouteService } from './product-route.service';

const DEDICATED_PRODUCT_CHANNEL_METADATA = {
  provider_isolation: {
    visibility: 'dedicated_only',
    credential_source: 'dedicated_upstream',
    allowed_route_kinds: ['dedicated_route'],
  },
};

function makeProduct() {
  return {
    id: 'prod-1',
    name: 'PAYG',
    slug: 'payg',
    billingMode: ProductBillingMode.PAY_AS_YOU_GO,
  };
}

function makeChannel(overrides = {}) {
  return {
    id: 'ch-1',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    sdkType: 'openai_completions',
    providerProfile: 'openai_compatible',
    models: JSON.stringify(['gpt-4.1', 'o3']),
    providerAccountIdentity: {
      ref: 'pa_openai_main',
      providerCode: 'openai',
      status: 'active',
    },
    ...overrides,
  };
}

function makeProductChannel(overrides = {}) {
  return {
    id: 'pc-1',
    productId: 'prod-1',
    channelId: 'ch-1',
    status: 'active',
    isDefault: false,
    priority: 5,
    weight: 1,
    maxRpm: null,
    maxTpm: null,
    metadata: null,
    channel: makeChannel(),
    ...overrides,
  };
}

function makeGroup(overrides = {}) {
  return {
    id: 'grp-1',
    productId: 'prod-1',
    code: 'default',
    members: [],
    ...overrides,
  };
}

function makePrisma() {
  const prisma: any = {
    product: {
      findFirst: jest.fn().mockResolvedValue(makeProduct()),
    },
    channel: {
      findFirst: jest.fn().mockResolvedValue(makeChannel()),
    },
    productChannel: {
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'pc-1' }),
      update: jest.fn(),
    },
    productChannelGroup: {
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(makeGroup()),
      create: jest.fn().mockResolvedValue({ id: 'grp-1' }),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    productChannelGroupMember: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'member-1' }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    routeAssignment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'ra-1' }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
    },
    userSegment: {
      findFirst: jest.fn().mockResolvedValue({ id: 'seg-1' }),
    },
    productRuntimePolicy: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'policy-1' }),
      update: jest.fn().mockResolvedValue({ id: 'policy-1' }),
    },
  };
  prisma.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(prisma));
  return prisma;
}

function makeService() {
  const prisma = makePrisma();
  const publisherSync = {
    syncRuntimeIntentAfterProductPolicyChangeDetailed: jest.fn().mockResolvedValue({
      accepted: true,
      status: 'ACCEPTED',
      idempotencyKey: 'route-sync-1',
      response: { batch_id: 'batch-1', status: 'accepted' },
    }),
    syncRuntimeIntentAfterProductPolicyChangeRequired: jest.fn().mockResolvedValue(undefined),
    buildProductRouteGraph: jest.fn().mockResolvedValue({ schema_version: 1 }),
  };
  const service = new ProductRouteService(prisma, publisherSync as any);
  return { service, prisma, publisherSync };
}

describe('ProductRouteService', () => {
  it('rejects ProductChannel allowedModels outside the physical channel model list', async () => {
    const { service, publisherSync } = makeService();

    await expect(service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      allowedModels: ['gpt-5'],
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed).not.toHaveBeenCalled();
  });

  it('rejects binding a non-dedicated Channel without an account identity', async () => {
    const { service, prisma } = makeService();
    prisma.channel.findFirst.mockResolvedValueOnce(makeChannel({
      providerAccountIdentity: null,
    }));

    await expect(service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      allowedModels: ['gpt-4.1'],
    })).rejects.toThrow('请先为 Channel 绑定有效的供应商账户身份');

    expect(prisma.productChannel.create).not.toHaveBeenCalled();
  });

  it('allows a strict dedicated-upstream ProductChannel without a Channel identity', async () => {
    const { service, prisma } = makeService();
    prisma.channel.findFirst.mockResolvedValueOnce(makeChannel({
      providerAccountIdentity: null,
    }));

    await expect(service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    })).resolves.toBeDefined();

    expect(prisma.productChannel.create).toHaveBeenCalledTimes(1);
  });

  it('rejects partial dedicated isolation before creating a ProductChannel', async () => {
    const { service, prisma } = makeService();

    await expect(service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      metadata: {
        provider_isolation: { visibility: 'dedicated_only' },
      },
    })).rejects.toThrow('credential_source must be dedicated_upstream');

    expect(prisma.productChannel.findFirst).not.toHaveBeenCalled();
    expect(prisma.productChannel.create).not.toHaveBeenCalled();
  });

  it('creates ProductChannel and bumps product runtime policy before publisher sync', async () => {
    const { service, prisma, publisherSync } = makeService();

    await service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      allowedModels: ['gpt-4.1'],
      priority: 10,
      weight: 80,
    });

    expect(prisma.productChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        channelId: 'ch-1',
        allowedModels: ['gpt-4.1'],
        priority: 10,
        weight: 80,
      }),
    });
    expect(prisma.productRuntimePolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        credentialSource: 'keypool',
        runtimeBillingMode: 'payg_balance',
      }),
    });
    expect(publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed).toHaveBeenCalledWith('prod-1');
  });

  it('rejects group members whose product channel is not in the product', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(null);

    await expect(service.addGroupMember('prod-1', 'grp-1', {
      productChannelId: 'pc-other',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.productChannelGroupMember.create).not.toHaveBeenCalled();
  });

  it('rejects a dedicated-only ProductChannel before adding it to a group', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.addGroupMember('prod-1', 'grp-1', {
      productChannelId: 'pc-1',
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.productChannelGroupMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.productChannelGroupMember.create).not.toHaveBeenCalled();
  });

  it('rejects route assignment targets outside the product', async () => {
    const { service, prisma } = makeService();
    prisma.productChannelGroup.findFirst.mockResolvedValueOnce(null);

    await expect(service.createAssignment('prod-1', {
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'GROUP',
      targetId: 'grp-other',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.routeAssignment.create).not.toHaveBeenCalled();
  });

  it('increments existing runtime policy revision after assignment changes', async () => {
    const { service, prisma, publisherSync } = makeService();
    prisma.productRuntimePolicy.findUnique.mockResolvedValueOnce({ id: 'policy-1' });
    prisma.productChannelGroup.findFirst.mockResolvedValueOnce(makeGroup());

    await service.createAssignment('prod-1', {
      subjectType: 'USER_SEGMENT',
      subjectId: 'seg-1',
      targetType: 'GROUP',
      targetId: 'grp-1',
      mode: 'PREFER',
      priority: 500,
    });

    expect(prisma.productRuntimePolicy.update).toHaveBeenCalledWith({
      where: { productId: 'prod-1' },
      data: { revision: { increment: 1 } },
    });
    expect(publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed).toHaveBeenCalledWith('prod-1');
  });

  it('rejects a direct assignment to a dedicated-only ProductChannel before writing', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.createAssignment('prod-1', {
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'PRODUCT_CHANNEL',
      targetId: 'pc-1',
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.routeAssignment.create).not.toHaveBeenCalled();
  });

  it('revalidates an unchanged direct assignment target before updating', async () => {
    const { service, prisma } = makeService();
    prisma.routeAssignment.findFirst.mockResolvedValueOnce({
      id: 'ra-1',
      productId: 'prod-1',
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'PRODUCT_CHANNEL',
      targetId: 'pc-1',
      mode: 'ONLY',
      priority: 100,
      startsAt: null,
      endsAt: null,
      isActive: true,
    });
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.updateAssignment('prod-1', 'ra-1', {
      priority: 200,
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.routeAssignment.update).not.toHaveBeenCalled();
  });

  it('allows explicitly deactivating a legacy assignment with a dedicated-only target', async () => {
    const { service, prisma } = makeService();
    prisma.routeAssignment.findFirst.mockResolvedValueOnce({
      id: 'ra-1',
      productId: 'prod-1',
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'PRODUCT_CHANNEL',
      targetId: 'pc-1',
      mode: 'ONLY',
      priority: 100,
      startsAt: null,
      endsAt: null,
      isActive: true,
    });
    prisma.routeAssignment.update.mockResolvedValueOnce({ id: 'ra-1', isActive: false });

    await expect(service.updateAssignment('prod-1', 'ra-1', {
      targetType: 'PRODUCT_CHANNEL',
      targetId: 'pc-1',
      isActive: false,
    })).resolves.toBeDefined();

    expect(prisma.productChannel.findFirst).not.toHaveBeenCalled();
    expect(prisma.routeAssignment.update).toHaveBeenCalledWith({
      where: { id: 'ra-1' },
      data: {
        targetType: 'PRODUCT_CHANNEL',
        targetId: 'pc-1',
        isActive: false,
      },
    });
  });

  it('still validates a changed target when the assignment is being deactivated', async () => {
    const { service, prisma } = makeService();
    prisma.routeAssignment.findFirst.mockResolvedValueOnce({
      id: 'ra-1',
      productId: 'prod-1',
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'GROUP',
      targetId: 'grp-1',
      mode: 'ONLY',
      priority: 100,
      startsAt: null,
      endsAt: null,
      isActive: true,
    });
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.updateAssignment('prod-1', 'ra-1', {
      targetType: 'PRODUCT_CHANNEL',
      targetId: 'pc-1',
      isActive: false,
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.routeAssignment.update).not.toHaveBeenCalled();
  });

  it('rejects an assignment to a legacy group containing a dedicated-only ProductChannel', async () => {
    const { service, prisma } = makeService();
    prisma.productChannelGroup.findFirst.mockResolvedValueOnce(makeGroup({
      members: [{
        productChannel: makeProductChannel({
          metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
        }),
      }],
    }));

    await expect(service.createAssignment('prod-1', {
      subjectType: 'USER',
      subjectId: 'user-1',
      targetType: 'GROUP',
      targetId: 'grp-1',
    })).rejects.toThrow('路由分组包含 dedicated-only ProductChannel pc-1');

    expect(prisma.routeAssignment.create).not.toHaveBeenCalled();
  });

  it('creates a default delivery setting for all users and syncs publisher once', async () => {
    const { service, prisma, publisherSync } = makeService();
    prisma.productChannelGroup.findFirst.mockResolvedValueOnce(null);
    prisma.productChannelGroup.create.mockResolvedValueOnce({ id: 'grp-new', productId: 'prod-1', code: 'payg' });
    prisma.productChannel.create.mockResolvedValueOnce({ id: 'pc-1', productId: 'prod-1', channelId: 'ch-1' });

    const result = await service.createDeliverySetting('prod-1', {
      group: { name: 'PAYG 默认投放组' },
      channels: [{ channelId: 'ch-1' }],
      audience: { scope: 'ALL' },
    });

    expect(prisma.productChannelGroup.updateMany).toHaveBeenCalledWith({
      where: { productId: 'prod-1', deletedAt: null, isDefault: true },
      data: { isDefault: false },
    });
    expect(prisma.productChannelGroup.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        name: 'PAYG 默认投放组',
        isDefault: true,
        strategy: 'weighted_failover',
        status: 'active',
      }),
    });
    expect(prisma.routeAssignment.create).not.toHaveBeenCalled();
    expect(publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed).toHaveBeenCalledTimes(1);
    expect(result.publisherSync).toEqual({
      ok: true,
      status: 'ACCEPTED',
      idempotencyKey: 'route-sync-1',
    });
  });

  it('rejects a delivery setting before writing when a Channel has no account identity', async () => {
    const { service, prisma } = makeService();
    prisma.channel.findFirst.mockResolvedValueOnce(makeChannel({
      providerAccountIdentity: null,
    }));

    await expect(service.createDeliverySetting('prod-1', {
      channels: [{ channelId: 'ch-1' }],
      audience: { scope: 'ALL' },
    })).rejects.toThrow('请先为 Channel 绑定有效的供应商账户身份');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productChannel.create).not.toHaveBeenCalled();
  });

  it('rejects dedicated-only metadata before a delivery-setting transaction starts', async () => {
    const { service, prisma } = makeService();
    prisma.channel.findFirst.mockResolvedValueOnce(makeChannel({
      providerAccountIdentity: null,
    }));

    await expect(service.createDeliverySetting('prod-1', {
      channels: [{
        channelId: 'ch-1',
        metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
      }],
      audience: { scope: 'ALL' },
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productChannelGroup.create).not.toHaveBeenCalled();
    expect(prisma.productChannel.create).not.toHaveBeenCalled();
  });

  it('rejects tenant-owned dedicated isolation before a delivery-setting transaction starts', async () => {
    const { service, prisma } = makeService();

    await expect(service.createDeliverySetting('prod-1', {
      channels: [{
        channelId: 'ch-1',
        metadata: {
          provider_isolation: {
            ...DEDICATED_PRODUCT_CHANNEL_METADATA.provider_isolation,
            owner_scope: { tenant_id: 'tenant-1' },
          },
        },
      }],
      audience: { scope: 'ALL' },
    })).rejects.toThrow(
      'owner_scope must not include tenant_id or entitlement_id',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productChannelGroup.create).not.toHaveBeenCalled();
  });

  it('rejects an existing dedicated-only ProductChannel before a delivery-setting transaction starts', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.createDeliverySetting('prod-1', {
      channels: [{ channelId: 'ch-1' }],
      audience: { scope: 'ALL' },
    })).rejects.toThrow('dedicated-only ProductChannel');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productChannelGroup.create).not.toHaveBeenCalled();
  });

  it('loads Channel account-identity evidence when updating an ordinary ProductChannel', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel());
    prisma.productChannel.update.mockResolvedValueOnce(makeProductChannel({ priority: 10 }));

    await expect(service.updateProductChannel('prod-1', 'pc-1', {
      priority: 10,
    })).resolves.toBeDefined();

    expect(prisma.productChannel.findFirst).toHaveBeenCalledWith({
      where: { id: 'pc-1', productId: 'prod-1', deletedAt: null },
      include: {
        channel: {
          select: expect.objectContaining({
            providerAccountIdentity: {
              select: {
                ref: true,
                providerCode: true,
                status: true,
              },
            },
          }),
        },
      },
    });
    expect(prisma.productChannel.update).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid isolation enums before updating a ProductChannel', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel());

    await expect(service.updateProductChannel('prod-1', 'pc-1', {
      metadata: {
        provider_isolation: { credential_source: 'embedded_key' },
      },
    })).rejects.toThrow('credential_source is invalid');

    expect(prisma.productChannelGroupMember.count).not.toHaveBeenCalled();
    expect(prisma.routeAssignment.count).not.toHaveBeenCalled();
    expect(prisma.productChannel.update).not.toHaveBeenCalled();
  });

  it.each([
    { groupMemberCount: 1, directAssignmentCount: 0, reference: '分组成员' },
    { groupMemberCount: 0, directAssignmentCount: 1, reference: '直连路由' },
  ])(
    'rejects changing a referenced ProductChannel to dedicated-only via a $reference reference',
    async ({ groupMemberCount, directAssignmentCount }) => {
      const { service, prisma } = makeService();
      prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel());
      prisma.productChannelGroupMember.count.mockResolvedValueOnce(groupMemberCount);
      prisma.routeAssignment.count.mockResolvedValueOnce(directAssignmentCount);

      await expect(service.updateProductChannel('prod-1', 'pc-1', {
        metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
      })).rejects.toThrow('请先移除');

      expect(prisma.productChannel.update).not.toHaveBeenCalled();
    },
  );

  it('allows updating a standalone dedicated-only ProductChannel', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findFirst.mockResolvedValueOnce(makeProductChannel({
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
      channel: makeChannel({ providerAccountIdentity: null }),
    }));
    prisma.productChannel.update.mockResolvedValueOnce(makeProductChannel({
      displayName: 'Dedicated upstream',
      metadata: DEDICATED_PRODUCT_CHANNEL_METADATA,
    }));

    await expect(service.updateProductChannel('prod-1', 'pc-1', {
      displayName: 'Dedicated upstream',
    })).resolves.toBeDefined();

    expect(prisma.productChannelGroupMember.count).toHaveBeenCalled();
    expect(prisma.routeAssignment.count).toHaveBeenCalled();
    expect(prisma.productChannel.update).toHaveBeenCalledTimes(1);
  });

  it('returns a visible publisher sync failure when route changes are saved but not accepted', async () => {
    const { service, publisherSync } = makeService();
    publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed.mockResolvedValueOnce({
      accepted: false,
      status: 'FAILED',
      idempotencyKey: 'route-sync-failed',
      error: 'Publisher request failed: 502',
    });

    const result = await service.createProductChannel('prod-1', {
      channelId: 'ch-1',
      allowedModels: ['gpt-4.1'],
    });

    expect(result.publisherSync).toEqual({
      ok: false,
      status: 'FAILED',
      idempotencyKey: 'route-sync-failed',
      error: 'Publisher request failed: 502',
    });
  });

  it('lists only product channels whose physical channel is not deleted', async () => {
    const { service, prisma } = makeService();
    prisma.productChannel.findMany.mockResolvedValueOnce([]);

    await service.listProductChannels('prod-1');

    expect(prisma.productChannel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { productId: 'prod-1', deletedAt: null, channel: { deletedAt: null } },
    }));
  });

  it('lists group members only when their product and physical channels are not deleted', async () => {
    const { service, prisma } = makeService();
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);

    await service.listGroups('prod-1');

    expect(prisma.productChannelGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        members: expect.objectContaining({
          where: {
            productChannel: {
              deletedAt: null,
              channel: { deletedAt: null },
            },
          },
        }),
      }),
    }));
  });

  it('creates a delivery setting for a user segment as a route assignment', async () => {
    const { service, prisma } = makeService();
    prisma.productChannelGroup.findFirst.mockResolvedValueOnce(null);
    prisma.productChannelGroup.create.mockResolvedValueOnce({ id: 'grp-seg', productId: 'prod-1', code: 'seg-group' });
    prisma.productChannel.create.mockResolvedValueOnce({ id: 'pc-1', productId: 'prod-1', channelId: 'ch-1' });

    await service.createDeliverySetting('prod-1', {
      group: { code: 'seg-group', name: '分群投放组' },
      channels: [{ channelId: 'ch-1', groupMember: { role: 'primary', priority: 8, weight: 3 } }],
      audience: { scope: 'USER_SEGMENT', subjectId: 'seg-1', mode: 'ONLY', priority: 120 },
    });

    expect(prisma.productChannelGroup.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        code: 'seg-group',
        isDefault: false,
      }),
    });
    expect(prisma.productChannelGroupMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: 'grp-seg',
        productChannelId: 'pc-1',
        role: 'primary',
        priority: 8,
        weight: 3,
      }),
    });
    expect(prisma.routeAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        subjectType: 'USER_SEGMENT',
        subjectId: 'seg-1',
        targetType: 'GROUP',
        targetId: 'grp-seg',
        mode: 'ONLY',
        priority: 120,
      }),
    });
  });
});

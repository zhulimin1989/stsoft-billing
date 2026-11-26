import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ProductBillingMode } from '@prisma/client';
import { normalizeStringArrayInput, parseStringArrayJson } from '../common/utils/json-array.util';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import type { PublisherSyncDispatchResult } from '../publisher/publisher-sync-job.service';
import { normalizeClientCompatibilityValue } from '../publisher/publisher-runtime-registry';
import {
  isStrictDedicatedProviderIsolation,
  providerEndpointIsolationFromMetadata,
  type ProviderEndpointIsolation,
} from '../publisher/provider-isolation.policy';
import {
  PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  validateProviderAccountIdentityForProvider,
} from '../provider-account-identity/provider-account-identity.policy';
import {
  AddProductChannelGroupMemberInput,
  CreateDeliverySettingInput,
  CreateProductChannelGroupInput,
  CreateProductChannelInput,
  CreateRouteAssignmentInput,
  PRODUCT_CHANNEL_GROUP_MEMBER_ROLES,
  PRODUCT_CHANNEL_GROUP_STATUSES,
  PRODUCT_CHANNEL_GROUP_STRATEGIES,
  PRODUCT_CHANNEL_STATUSES,
  ROUTE_ASSIGNMENT_MODES,
  ROUTE_ASSIGNMENT_SUBJECT_TYPES,
  ROUTE_ASSIGNMENT_TARGET_TYPES,
  RouteAssignmentFilters,
  UpdateProductChannelGroupInput,
  UpdateProductChannelGroupMemberInput,
  UpdateProductChannelInput,
  UpdateRouteAssignmentInput,
} from './product-route.dto';

type ProductForRoute = {
  id: string;
  name: string;
  slug: string;
  billingMode: ProductBillingMode;
};

const CHANNEL_FOR_ROUTE_SELECT = {
  id: true,
  provider: true,
  baseUrl: true,
  sdkType: true,
  providerProfile: true,
  models: true,
  providerAccountIdentity: {
    select: PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  },
} as const satisfies Prisma.ChannelSelect;

const PRODUCT_CHANNEL_WITH_CHANNEL_INCLUDE = {
  channel: {
    select: CHANNEL_FOR_ROUTE_SELECT,
  },
} as const satisfies Prisma.ProductChannelInclude;

type ChannelForRoute = Prisma.ChannelGetPayload<{
  select: typeof CHANNEL_FOR_ROUTE_SELECT;
}>;

type ProductChannelForRoute = Prisma.ProductChannelGetPayload<Record<string, never>>;

type ProductChannelWithChannelForRoute = Prisma.ProductChannelGetPayload<{
  include: typeof PRODUCT_CHANNEL_WITH_CHANNEL_INCLUDE;
}>;

type ProductRoutePublisherSync =
  | {
      ok: true;
      status: 'ACCEPTED';
      idempotencyKey: string;
      warnings?: unknown[];
    }
  | {
      ok: false;
      status: 'PENDING' | 'FAILED' | 'DISABLED';
      idempotencyKey?: string;
      error: string;
    };

@Injectable()
export class ProductRouteService {
  private readonly logger = new Logger(ProductRouteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherSync: PublisherSyncService,
  ) {}

  async createDeliverySetting(productId: string, input: CreateDeliverySettingInput = {}) {
    const product = await this.requireProduct(productId);
    const channelInputs = Array.isArray(input.channels) ? input.channels : [];
    if (channelInputs.length === 0) throw new BadRequestException('至少选择一个供应商渠道');

    const seenChannelIds = new Set<string>();
    const normalizedChannels = await Promise.all(channelInputs.map(async (channelInput, index) => {
      const channelId = this.requiredString(channelInput.channelId, `channels[${index}].channelId`);
      if (seenChannelIds.has(channelId)) throw new BadRequestException('供应商渠道不能重复选择');
      seenChannelIds.add(channelId);
      const channel = await this.requireChannel(channelId);
      const existing = await this.prisma.productChannel.findFirst({
        where: { productId, channelId, deletedAt: null },
      });
      const effectiveMetadata = Object.prototype.hasOwnProperty.call(channelInput, 'metadata')
        ? channelInput.metadata
        : existing?.metadata;
      const isolation = this.assertProductChannelEligibleForOrdinaryRoute(
        effectiveMetadata,
        `channels[${index}]`,
      );
      this.assertChannelReadyForProductRoute(
        channel,
        isolation,
        `channels[${index}]`,
      );
      return { channelInput, channelId, channel, existing, index };
    }));

    const audience = input.audience ?? {};
    const scope = this.deliveryAudienceScope(audience.scope);
    let assignmentData: Prisma.RouteAssignmentUncheckedCreateInput | null = null;
    if (scope !== 'ALL') {
      const subjectId = this.requiredString(audience.subjectId, 'audience.subjectId');
      await this.validateSubject(scope, subjectId);
      const startsAt = this.optionalDate(audience.startsAt, 'audience.startsAt');
      const endsAt = this.optionalDate(audience.endsAt, 'audience.endsAt');
      this.assertDateRange(startsAt, endsAt);
      assignmentData = {
        productId,
        subjectType: scope,
        subjectId,
        modelPattern: this.optionalString(audience.modelPattern),
        clientCompatibility: this.optionalClientCompatibility(audience.clientCompatibility),
        targetType: 'GROUP',
        targetId: '',
        mode: this.enumValue(audience.mode, ROUTE_ASSIGNMENT_MODES, 'ONLY', 'audience.mode'),
        priority: this.positiveInt(audience.priority, 100, 'audience.priority'),
        startsAt,
        endsAt,
        isActive: audience.isActive !== undefined ? Boolean(audience.isActive) : true,
        reason: this.optionalString(audience.reason),
        metadata: this.optionalJson(audience.metadata),
      };
    }

    const groupInput = input.group ?? {};
    const explicitGroupCode = typeof groupInput.code === 'string' && groupInput.code.trim();
    const groupCode = explicitGroupCode
      ? this.requiredCode(groupInput.code, 'group.code')
      : await this.nextDeliveryGroupCode(productId, groupInput.name || product.name || product.slug);
    if (explicitGroupCode) await this.assertGroupCodeUnique(productId, groupCode);

    const groupIsDefault = scope === 'ALL' || Boolean(groupInput.isDefault);
    const saved = await this.prisma.$transaction(async (tx) => {
      if (groupIsDefault) {
        await tx.productChannelGroup.updateMany({
          where: { productId, deletedAt: null, isDefault: true },
          data: { isDefault: false },
        });
      }
      const group = await tx.productChannelGroup.create({
        data: {
          productId,
          code: groupCode,
          name: this.optionalString(groupInput.name) || `${product.name || product.slug} 投放组`,
          description: this.optionalString(groupInput.description),
          strategy: this.enumValue(groupInput.strategy, PRODUCT_CHANNEL_GROUP_STRATEGIES, 'weighted_failover', 'group.strategy'),
          isDefault: groupIsDefault,
          status: this.enumValue(groupInput.status, PRODUCT_CHANNEL_GROUP_STATUSES, 'active', 'group.status'),
          metadata: this.optionalJson(groupInput.metadata),
        },
      });

      const productChannels = [];
      const members = [];
      for (const { channelInput, channelId, channel, existing, index } of normalizedChannels) {
        const createData: Prisma.ProductChannelUncheckedCreateInput = {
          productId,
          channelId,
          displayName: this.optionalString(channelInput.displayName),
          status: this.enumValue(channelInput.status, PRODUCT_CHANNEL_STATUSES, 'active', `channels[${index}].status`),
          isDefault: Boolean(channelInput.isDefault),
          allowedModels: this.normalizeModelArray(channelInput.allowedModels, channel, `channels[${index}].allowedModels`),
          deniedModels: this.normalizeModelArray(channelInput.deniedModels, channel, `channels[${index}].deniedModels`, false),
          priority: this.positiveInt(channelInput.priority, 5, `channels[${index}].priority`),
          weight: this.positiveInt(channelInput.weight, 1, `channels[${index}].weight`),
          maxRpm: this.optionalPositiveInt(channelInput.maxRpm, `channels[${index}].maxRpm`),
          maxTpm: this.optionalPositiveInt(channelInput.maxTpm, `channels[${index}].maxTpm`),
          metadata: this.optionalJson(channelInput.metadata),
        };
        const updateData: Prisma.ProductChannelUncheckedUpdateInput = {
          status: createData.status,
          isDefault: createData.isDefault,
          priority: createData.priority,
          weight: createData.weight,
        };
        if ('displayName' in channelInput) updateData.displayName = createData.displayName;
        if ('allowedModels' in channelInput) updateData.allowedModels = createData.allowedModels;
        if ('deniedModels' in channelInput) updateData.deniedModels = createData.deniedModels;
        if ('maxRpm' in channelInput) updateData.maxRpm = createData.maxRpm;
        if ('maxTpm' in channelInput) updateData.maxTpm = createData.maxTpm;
        if ('metadata' in channelInput) updateData.metadata = createData.metadata;

        const productChannel = existing
          ? await tx.productChannel.update({ where: { id: existing.id }, data: updateData })
          : await tx.productChannel.create({ data: createData });
        productChannels.push(productChannel);

        const memberInput = channelInput.groupMember ?? {};
        const existingMember = await tx.productChannelGroupMember.findUnique({
          where: {
            groupId_productChannelId: {
              groupId: group.id,
              productChannelId: productChannel.id,
            },
          },
        });
        const memberData: Prisma.ProductChannelGroupMemberUncheckedCreateInput = {
          groupId: group.id,
          productChannelId: productChannel.id,
          priority: this.positiveInt(memberInput.priority, index === 0 ? 5 : (index + 1) * 10, `channels[${index}].groupMember.priority`),
          weight: this.positiveInt(memberInput.weight, 1, `channels[${index}].groupMember.weight`),
          role: this.enumValue(
            memberInput.role,
            PRODUCT_CHANNEL_GROUP_MEMBER_ROLES,
            index === 0 ? 'primary' : 'fallback',
            `channels[${index}].groupMember.role`,
          ),
          maxRpm: this.optionalPositiveInt(memberInput.maxRpm, `channels[${index}].groupMember.maxRpm`),
          maxTpm: this.optionalPositiveInt(memberInput.maxTpm, `channels[${index}].groupMember.maxTpm`),
        };
        const member = existingMember
          ? await tx.productChannelGroupMember.update({ where: { id: existingMember.id }, data: memberData })
          : await tx.productChannelGroupMember.create({ data: memberData });
        members.push(member);
      }

      const assignment = assignmentData
        ? await tx.routeAssignment.create({
            data: {
              ...assignmentData,
              targetId: group.id,
            },
          })
        : null;

      return { group, productChannels, members, assignment };
    });

    await this.ensureRuntimePolicy(product, true);

    const publisherSync = await this.syncRouteToPublisher(productId);

    let routeGraph: unknown = null;
    let routeGraphError: string | null = null;
    try {
      routeGraph = await this.publisherSync.buildProductRouteGraph(productId);
    } catch (err) {
      routeGraphError = (err as Error).message;
    }

    return {
      productId,
      ...saved,
      publisherSync,
      routeGraph,
      routeGraphError,
    };
  }

  async listProductChannels(productId: string) {
    await this.requireProduct(productId);
    return this.prisma.productChannel.findMany({
      where: { productId, deletedAt: null, channel: { deletedAt: null } },
      orderBy: [{ priority: 'asc' }, { weight: 'desc' }, { createdAt: 'asc' }],
      include: {
        channel: {
          select: {
            id: true,
            name: true,
            provider: true,
            baseUrl: true,
            sdkType: true,
            providerProfile: true,
            clientCompatibility: true,
            models: true,
            status: true,
            isActive: true,
            priority: true,
            weight: true,
          },
        },
        groupMembers: {
          include: { group: true },
          orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
        },
      },
    });
  }

  async createProductChannel(productId: string, input: CreateProductChannelInput) {
    await this.requireProduct(productId);
    const channelId = this.requiredString(input.channelId, 'channelId');
    const channel = await this.requireChannel(channelId);
    const isolation = this.productChannelIsolation(input.metadata, 'ProductChannel metadata');
    this.assertChannelReadyForProductRoute(channel, isolation, 'ProductChannel');
    await this.assertProductChannelUnique(productId, channelId);

    const allowedModels = this.normalizeModelArray(input.allowedModels, channel, 'allowedModels');
    const deniedModels = this.normalizeModelArray(input.deniedModels, channel, 'deniedModels', false);
    const created = await this.prisma.productChannel.create({
      data: {
        productId,
        channelId,
        displayName: this.optionalString(input.displayName),
        status: this.enumValue(input.status, PRODUCT_CHANNEL_STATUSES, 'active', 'status'),
        isDefault: Boolean(input.isDefault),
        allowedModels,
        deniedModels,
        priority: this.positiveInt(input.priority, 5, 'priority'),
        weight: this.positiveInt(input.weight, 1, 'weight'),
        maxRpm: this.optionalPositiveInt(input.maxRpm, 'maxRpm'),
        maxTpm: this.optionalPositiveInt(input.maxTpm, 'maxTpm'),
        metadata: this.optionalJson(input.metadata),
      },
    });

    return this.withPublisherSync(created, await this.afterRouteMutation(productId));
  }

  async updateProductChannel(productId: string, productChannelId: string, input: UpdateProductChannelInput) {
    const existing = await this.requireProductChannel(productId, productChannelId, { includeChannel: true });
    const channel = existing.channel;
    const effectiveMetadata = Object.prototype.hasOwnProperty.call(input, 'metadata')
      ? input.metadata
      : existing.metadata;
    const isolation = this.productChannelIsolation(
      effectiveMetadata,
      'ProductChannel metadata',
    );
    if (isStrictDedicatedProviderIsolation(isolation)) {
      await this.assertDedicatedProductChannelIsStandalone(productId, productChannelId);
    }
    this.assertChannelReadyForProductRoute(channel, isolation, 'ProductChannel');
    const data: Prisma.ProductChannelUpdateInput = {};

    if ('displayName' in input) data.displayName = this.optionalString(input.displayName);
    if ('status' in input) data.status = this.enumValue(input.status, PRODUCT_CHANNEL_STATUSES, existing.status, 'status');
    if ('isDefault' in input) data.isDefault = Boolean(input.isDefault);
    if ('allowedModels' in input) data.allowedModels = this.normalizeModelArray(input.allowedModels, channel, 'allowedModels');
    if ('deniedModels' in input) data.deniedModels = this.normalizeModelArray(input.deniedModels, channel, 'deniedModels', false);
    if ('priority' in input) data.priority = this.positiveInt(input.priority, existing.priority, 'priority');
    if ('weight' in input) data.weight = this.positiveInt(input.weight, existing.weight, 'weight');
    if ('maxRpm' in input) data.maxRpm = this.optionalPositiveInt(input.maxRpm, 'maxRpm');
    if ('maxTpm' in input) data.maxTpm = this.optionalPositiveInt(input.maxTpm, 'maxTpm');
    if ('metadata' in input) data.metadata = this.optionalJson(input.metadata);

    const updated = await this.prisma.productChannel.update({
      where: { id: productChannelId },
      data,
    });
    return this.withPublisherSync(updated, await this.afterRouteMutation(productId));
  }

  async deleteProductChannel(productId: string, productChannelId: string) {
    await this.requireProductChannel(productId, productChannelId);
    const deleted = await this.prisma.productChannel.update({
      where: { id: productChannelId },
      data: {
        status: 'disabled',
        deletedAt: new Date(),
      },
    });
    return this.withPublisherSync(deleted, await this.afterRouteMutation(productId));
  }

  async listGroups(productId: string) {
    await this.requireProduct(productId);
    return this.prisma.productChannelGroup.findMany({
      where: { productId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
      include: {
        members: {
          where: {
            productChannel: {
              deletedAt: null,
              channel: { deletedAt: null },
            },
          },
          orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
          include: {
            productChannel: {
              include: {
                channel: {
                  select: {
                    id: true,
                    name: true,
                    provider: true,
                    baseUrl: true,
                    sdkType: true,
                    providerProfile: true,
                    models: true,
                    status: true,
                    isActive: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async createGroup(productId: string, input: CreateProductChannelGroupInput) {
    await this.requireProduct(productId);
    const code = this.requiredCode(input.code, 'code');
    await this.assertGroupCodeUnique(productId, code);

    const createData: Prisma.ProductChannelGroupUncheckedCreateInput = {
      productId,
      code,
      name: this.requiredString(input.name, 'name'),
      description: this.optionalString(input.description),
      strategy: this.enumValue(input.strategy, PRODUCT_CHANNEL_GROUP_STRATEGIES, 'weighted_failover', 'strategy'),
      isDefault: Boolean(input.isDefault),
      status: this.enumValue(input.status, PRODUCT_CHANNEL_GROUP_STATUSES, 'active', 'status'),
      metadata: this.optionalJson(input.metadata),
    };
    const created = createData.isDefault
      ? await this.prisma.$transaction(async (tx) => {
          await tx.productChannelGroup.updateMany({
            where: { productId, deletedAt: null, isDefault: true },
            data: { isDefault: false },
          });
          return tx.productChannelGroup.create({ data: createData });
        })
      : await this.prisma.productChannelGroup.create({ data: createData });

    return this.withPublisherSync(created, await this.afterRouteMutation(productId));
  }

  async updateGroup(productId: string, groupId: string, input: UpdateProductChannelGroupInput) {
    const existing = await this.requireGroup(productId, groupId);
    const data: Prisma.ProductChannelGroupUpdateInput = {};

    if ('code' in input) {
      const code = this.requiredCode(input.code, 'code');
      if (code !== existing.code) await this.assertGroupCodeUnique(productId, code);
      data.code = code;
    }
    if ('name' in input) data.name = this.requiredString(input.name, 'name');
    if ('description' in input) data.description = this.optionalString(input.description);
    if ('strategy' in input) data.strategy = this.enumValue(input.strategy, PRODUCT_CHANNEL_GROUP_STRATEGIES, existing.strategy, 'strategy');
    if ('status' in input) data.status = this.enumValue(input.status, PRODUCT_CHANNEL_GROUP_STATUSES, existing.status, 'status');
    if ('metadata' in input) data.metadata = this.optionalJson(input.metadata);

    const wantsDefault = 'isDefault' in input ? Boolean(input.isDefault) : undefined;
    const updated = wantsDefault
      ? await this.prisma.$transaction(async (tx) => {
          await tx.productChannelGroup.updateMany({
            where: { productId, deletedAt: null, isDefault: true, id: { not: groupId } },
            data: { isDefault: false },
          });
          return tx.productChannelGroup.update({
            where: { id: groupId },
            data: { ...data, isDefault: true },
          });
        })
      : await this.prisma.productChannelGroup.update({
          where: { id: groupId },
          data: {
            ...data,
            ...('isDefault' in input ? { isDefault: false } : {}),
          },
        });

    return this.withPublisherSync(updated, await this.afterRouteMutation(productId));
  }

  async deleteGroup(productId: string, groupId: string) {
    await this.requireGroup(productId, groupId);
    const deleted = await this.prisma.productChannelGroup.update({
      where: { id: groupId },
      data: {
        status: 'disabled',
        isDefault: false,
        deletedAt: new Date(),
      },
    });
    return this.withPublisherSync(deleted, await this.afterRouteMutation(productId));
  }

  async addGroupMember(productId: string, groupId: string, input: AddProductChannelGroupMemberInput) {
    await this.requireGroup(productId, groupId);
    const productChannelId = this.requiredString(input.productChannelId, 'productChannelId');
    const productChannel = await this.requireProductChannel(productId, productChannelId);
    this.assertProductChannelEligibleForOrdinaryRoute(
      productChannel.metadata,
      'ProductChannel',
    );
    await this.assertGroupMemberUnique(groupId, productChannelId);

    const created = await this.prisma.productChannelGroupMember.create({
      data: {
        groupId,
        productChannelId,
        priority: this.positiveInt(input.priority, 5, 'priority'),
        weight: this.positiveInt(input.weight, 1, 'weight'),
        role: this.enumValue(input.role, PRODUCT_CHANNEL_GROUP_MEMBER_ROLES, 'primary', 'role'),
        maxRpm: this.optionalPositiveInt(input.maxRpm, 'maxRpm'),
        maxTpm: this.optionalPositiveInt(input.maxTpm, 'maxTpm'),
      },
    });
    return this.withPublisherSync(created, await this.afterRouteMutation(productId));
  }

  async updateGroupMember(
    productId: string,
    groupId: string,
    memberId: string,
    input: UpdateProductChannelGroupMemberInput,
  ) {
    const existing = await this.requireGroupMember(productId, groupId, memberId);
    const data: Prisma.ProductChannelGroupMemberUpdateInput = {};
    if ('priority' in input) data.priority = this.positiveInt(input.priority, existing.priority, 'priority');
    if ('weight' in input) data.weight = this.positiveInt(input.weight, existing.weight, 'weight');
    if ('role' in input) data.role = this.enumValue(input.role, PRODUCT_CHANNEL_GROUP_MEMBER_ROLES, existing.role, 'role');
    if ('maxRpm' in input) data.maxRpm = this.optionalPositiveInt(input.maxRpm, 'maxRpm');
    if ('maxTpm' in input) data.maxTpm = this.optionalPositiveInt(input.maxTpm, 'maxTpm');

    const updated = await this.prisma.productChannelGroupMember.update({
      where: { id: memberId },
      data,
    });
    return this.withPublisherSync(updated, await this.afterRouteMutation(productId));
  }

  async removeGroupMember(productId: string, groupId: string, memberId: string) {
    await this.requireGroupMember(productId, groupId, memberId);
    const deleted = await this.prisma.productChannelGroupMember.delete({ where: { id: memberId } });
    return this.withPublisherSync(deleted, await this.afterRouteMutation(productId));
  }

  async listAssignments(productId: string, filters: RouteAssignmentFilters = {}) {
    await this.requireProduct(productId);
    const where: Prisma.RouteAssignmentWhereInput = { productId };
    if (filters.subjectType) where.subjectType = filters.subjectType;
    if (filters.subjectId) where.subjectId = filters.subjectId;
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    return this.prisma.routeAssignment.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async createAssignment(productId: string, input: CreateRouteAssignmentInput) {
    await this.requireProduct(productId);
    const subjectType = this.enumValue(
      input.subjectType,
      ROUTE_ASSIGNMENT_SUBJECT_TYPES,
      undefined,
      'subjectType',
    );
    const subjectId = this.requiredString(input.subjectId, 'subjectId');
    const targetType = this.enumValue(
      input.targetType,
      ROUTE_ASSIGNMENT_TARGET_TYPES,
      undefined,
      'targetType',
    );
    const targetId = this.requiredString(input.targetId, 'targetId');
    await this.validateSubject(subjectType, subjectId);
    await this.validateTarget(productId, targetType, targetId);
    const startsAt = this.optionalDate(input.startsAt, 'startsAt');
    const endsAt = this.optionalDate(input.endsAt, 'endsAt');
    this.assertDateRange(startsAt, endsAt);

    const created = await this.prisma.routeAssignment.create({
      data: {
        productId,
        subjectType,
        subjectId,
        modelPattern: this.optionalString(input.modelPattern),
        clientCompatibility: this.optionalClientCompatibility(input.clientCompatibility),
        targetType,
        targetId,
        mode: this.enumValue(input.mode, ROUTE_ASSIGNMENT_MODES, 'ONLY', 'mode'),
        priority: this.positiveInt(input.priority, 100, 'priority'),
        startsAt,
        endsAt,
        isActive: input.isActive !== undefined ? Boolean(input.isActive) : true,
        reason: this.optionalString(input.reason),
        metadata: this.optionalJson(input.metadata),
      },
    });
    return this.withPublisherSync(created, await this.afterRouteMutation(productId));
  }

  async updateAssignment(productId: string, assignmentId: string, input: UpdateRouteAssignmentInput) {
    const existing = await this.requireAssignment(productId, assignmentId);
    const data: Prisma.RouteAssignmentUpdateInput = {};

    const subjectType = 'subjectType' in input
      ? this.enumValue(input.subjectType, ROUTE_ASSIGNMENT_SUBJECT_TYPES, undefined, 'subjectType')
      : existing.subjectType;
    const subjectId = 'subjectId' in input
      ? this.requiredString(input.subjectId, 'subjectId')
      : existing.subjectId;
    const targetType = 'targetType' in input
      ? this.enumValue(input.targetType, ROUTE_ASSIGNMENT_TARGET_TYPES, undefined, 'targetType')
      : existing.targetType;
    const targetId = 'targetId' in input
      ? this.requiredString(input.targetId, 'targetId')
      : existing.targetId;
    const targetFieldsProvided = 'targetType' in input || 'targetId' in input;
    const targetChanged = targetType !== existing.targetType || targetId !== existing.targetId;
    const effectiveIsActive = 'isActive' in input
      ? Boolean(input.isActive)
      : existing.isActive;

    if ('subjectType' in input || 'subjectId' in input) {
      await this.validateSubject(subjectType, subjectId);
      data.subjectType = subjectType;
      data.subjectId = subjectId;
    }
    if (effectiveIsActive || targetChanged) {
      await this.validateTarget(productId, targetType, targetId);
    }
    if (targetFieldsProvided) {
      data.targetType = targetType;
      data.targetId = targetId;
    }
    if ('modelPattern' in input) data.modelPattern = this.optionalString(input.modelPattern);
    if ('clientCompatibility' in input) data.clientCompatibility = this.optionalClientCompatibility(input.clientCompatibility);
    if ('mode' in input) data.mode = this.enumValue(input.mode, ROUTE_ASSIGNMENT_MODES, existing.mode, 'mode');
    if ('priority' in input) data.priority = this.positiveInt(input.priority, existing.priority, 'priority');
    if ('isActive' in input) data.isActive = Boolean(input.isActive);
    if ('reason' in input) data.reason = this.optionalString(input.reason);
    if ('metadata' in input) data.metadata = this.optionalJson(input.metadata);

    const startsAt = 'startsAt' in input ? this.optionalDate(input.startsAt, 'startsAt') : existing.startsAt;
    const endsAt = 'endsAt' in input ? this.optionalDate(input.endsAt, 'endsAt') : existing.endsAt;
    this.assertDateRange(startsAt, endsAt);
    if ('startsAt' in input) data.startsAt = startsAt;
    if ('endsAt' in input) data.endsAt = endsAt;

    const updated = await this.prisma.routeAssignment.update({
      where: { id: assignmentId },
      data,
    });
    return this.withPublisherSync(updated, await this.afterRouteMutation(productId));
  }

  async deleteAssignment(productId: string, assignmentId: string) {
    await this.requireAssignment(productId, assignmentId);
    const deleted = await this.prisma.routeAssignment.delete({ where: { id: assignmentId } });
    return this.withPublisherSync(deleted, await this.afterRouteMutation(productId));
  }

  async compileRouteGraph(productId: string) {
    await this.requireProduct(productId);
    return this.publisherSync.buildProductRouteGraph(productId);
  }

  async rebuildRouteGraph(productId: string) {
    const product = await this.requireProduct(productId);
    await this.ensureRuntimePolicy(product, false);
    await this.publisherSync.syncRuntimeIntentAfterProductPolicyChangeRequired(productId);
    return this.publisherSync.buildProductRouteGraph(productId);
  }

  private async afterRouteMutation(productId: string): Promise<ProductRoutePublisherSync> {
    const product = await this.requireProduct(productId);
    await this.ensureRuntimePolicy(product, true);
    return this.syncRouteToPublisher(productId);
  }

  private async syncRouteToPublisher(productId: string): Promise<ProductRoutePublisherSync> {
    try {
      return this.publisherSyncResult(
        await this.publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed(productId),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`product route saved but publisher sync state could not be recorded product=${productId}: ${message}`);
      return { ok: false, status: 'FAILED', error: message };
    }
  }

  private publisherSyncResult(result: PublisherSyncDispatchResult): ProductRoutePublisherSync {
    if (result.accepted) {
      return {
        ok: true,
        status: 'ACCEPTED',
        idempotencyKey: result.idempotencyKey,
        ...(result.response?.warnings?.length ? { warnings: result.response.warnings } : {}),
      };
    }
    return {
      ok: false,
      status: result.status === 'ACCEPTED' ? 'FAILED' : result.status,
      idempotencyKey: result.idempotencyKey,
      error: result.error ?? 'Publisher 同步未被接收',
    };
  }

  private withPublisherSync<T extends object>(
    row: T,
    publisherSync: ProductRoutePublisherSync,
  ): T & { publisherSync: ProductRoutePublisherSync } {
    return {
      ...row,
      publisherSync,
    };
  }

  private async ensureRuntimePolicy(product: ProductForRoute, bumpRevision: boolean): Promise<void> {
    const existing = await this.prisma.productRuntimePolicy.findUnique({
      where: { productId: product.id },
      select: { id: true },
    });
    if (existing) {
      if (bumpRevision) {
        await this.prisma.productRuntimePolicy.update({
          where: { productId: product.id },
          data: { revision: { increment: 1 } },
        });
      }
      return;
    }

    try {
      await this.prisma.productRuntimePolicy.create({
        data: {
          productId: product.id,
          ...this.defaultRuntimePolicyFor(product.billingMode),
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        if (bumpRevision) {
          await this.prisma.productRuntimePolicy.update({
            where: { productId: product.id },
            data: { revision: { increment: 1 } },
          });
        }
        return;
      }
      throw err;
    }
  }

  private defaultRuntimePolicyFor(
    billingMode: ProductBillingMode,
  ): Omit<Prisma.ProductRuntimePolicyUncheckedCreateInput, 'id' | 'productId' | 'revision' | 'createdAt' | 'updatedAt'> {
    if (billingMode === ProductBillingMode.PAY_AS_YOU_GO) {
      return {
        credentialSource: 'keypool',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'product_allowlist',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'payg_balance',
        routeStrategy: null,
        status: 'active',
      };
    }
    if (billingMode === ProductBillingMode.CODING_PLAN) {
      return {
        credentialSource: 'keypool',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'plan_configured',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'token_plan_quota',
        routeStrategy: null,
        status: 'active',
      };
    }
    return {
      credentialSource: 'keypool',
      allowedProviderIds: [],
      allowedChannelIds: [],
      modelScopeMode: 'plan_configured',
      allowedModels: [],
      fallbackPolicy: 'within_product',
      runtimeBillingMode: 'subscription_credits',
      routeStrategy: null,
      status: 'active',
    };
  }

  private async requireProduct(productId: string): Promise<ProductForRoute> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, slug: true, billingMode: true },
    });
    if (!product) throw new NotFoundException('产品不存在');
    return product;
  }

  private async requireChannel(channelId: string): Promise<ChannelForRoute> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
      select: CHANNEL_FOR_ROUTE_SELECT,
    });
    if (!channel) throw new BadRequestException('渠道不存在或已删除');
    return channel;
  }

  private assertChannelReadyForProductRoute(
    channel: ChannelForRoute,
    isolation: ProviderEndpointIsolation | undefined,
    source: string,
  ): void {
    if (isStrictDedicatedProviderIsolation(isolation)) return;
    try {
      validateProviderAccountIdentityForProvider(
        channel.providerAccountIdentity,
        channel.provider,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(
        `${source}: ${detail}，请先为 Channel 绑定有效的供应商账户身份`,
      );
    }
  }

  private assertProductChannelEligibleForOrdinaryRoute(
    metadata: unknown,
    source: string,
  ): ProviderEndpointIsolation | undefined {
    const isolation = this.productChannelIsolation(metadata, `${source}.metadata`);
    if (!isStrictDedicatedProviderIsolation(isolation)) return isolation;
    throw new BadRequestException(
      `${source}: dedicated-only ProductChannel 仅可用于 dedicated_route，不能加入普通产品路由`,
    );
  }

  private productChannelIsolation(
    metadata: unknown,
    source: string,
  ): ProviderEndpointIsolation | undefined {
    try {
      return providerEndpointIsolationFromMetadata(metadata, source);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private async assertDedicatedProductChannelIsStandalone(
    productId: string,
    productChannelId: string,
  ): Promise<void> {
    const [groupMemberCount, directAssignmentCount] = await Promise.all([
      this.prisma.productChannelGroupMember.count({
        where: {
          productChannelId,
          group: { productId, deletedAt: null },
        },
      }),
      this.prisma.routeAssignment.count({
        where: {
          productId,
          targetType: 'PRODUCT_CHANNEL',
          targetId: productChannelId,
        },
      }),
    ]);
    if (groupMemberCount === 0 && directAssignmentCount === 0) return;
    throw new BadRequestException(
      'dedicated-only ProductChannel 不能被普通产品路由引用；'
      + `请先移除 ${groupMemberCount} 个分组成员引用和 ${directAssignmentCount} 条直连路由引用`,
    );
  }

  private async requireProductChannel(
    productId: string,
    productChannelId: string,
    options: { includeChannel: true },
  ): Promise<ProductChannelWithChannelForRoute>;
  private async requireProductChannel(
    productId: string,
    productChannelId: string,
    options?: { includeChannel?: false },
  ): Promise<ProductChannelForRoute>;
  private async requireProductChannel(
    productId: string,
    productChannelId: string,
    options: { includeChannel?: boolean } = {},
  ): Promise<ProductChannelWithChannelForRoute | ProductChannelForRoute> {
    const productChannel = options.includeChannel
      ? await this.prisma.productChannel.findFirst({
          where: { id: productChannelId, productId, deletedAt: null },
          include: PRODUCT_CHANNEL_WITH_CHANNEL_INCLUDE,
        })
      : await this.prisma.productChannel.findFirst({
          where: { id: productChannelId, productId, deletedAt: null },
        });
    if (!productChannel) throw new NotFoundException('产品渠道不存在');
    return productChannel;
  }

  private async requireGroup(productId: string, groupId: string) {
    const group = await this.prisma.productChannelGroup.findFirst({
      where: { id: groupId, productId, deletedAt: null },
    });
    if (!group) throw new NotFoundException('渠道分组不存在');
    return group;
  }

  private async requireGroupMember(productId: string, groupId: string, memberId: string) {
    const member = await this.prisma.productChannelGroupMember.findFirst({
      where: {
        id: memberId,
        groupId,
        group: { productId, deletedAt: null },
        productChannel: { productId, deletedAt: null },
      },
    });
    if (!member) throw new NotFoundException('分组成员不存在');
    return member;
  }

  private async requireAssignment(productId: string, assignmentId: string) {
    const assignment = await this.prisma.routeAssignment.findFirst({
      where: { id: assignmentId, productId },
    });
    if (!assignment) throw new NotFoundException('路由覆盖规则不存在');
    return assignment;
  }

  private async assertProductChannelUnique(productId: string, channelId: string): Promise<void> {
    const existing = await this.prisma.productChannel.findFirst({
      where: { productId, channelId, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('该产品已绑定此渠道');
  }

  private async assertGroupCodeUnique(productId: string, code: string): Promise<void> {
    const existing = await this.prisma.productChannelGroup.findFirst({
      where: { productId, code, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('该产品下已存在同 code 的渠道分组');
  }

  private async assertGroupMemberUnique(groupId: string, productChannelId: string): Promise<void> {
    const existing = await this.prisma.productChannelGroupMember.findFirst({
      where: { groupId, productChannelId },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('该产品渠道已在此分组中');
  }

  private async validateSubject(subjectType: string, subjectId: string): Promise<void> {
    if (subjectType === 'USER') {
      const user = await this.prisma.user.findFirst({
        where: { id: subjectId, deletedAt: null },
        select: { id: true },
      });
      if (!user) throw new BadRequestException('用户不存在或已删除');
      return;
    }
    if (subjectType === 'USER_SEGMENT') {
      const segment = await this.prisma.userSegment.findFirst({
        where: { id: subjectId, deletedAt: null },
        select: { id: true },
      });
      if (!segment) throw new BadRequestException('用户组不存在或已删除');
      return;
    }
    throw new BadRequestException('subjectType 暂不支持');
  }

  private async validateTarget(productId: string, targetType: string, targetId: string): Promise<void> {
    if (targetType === 'GROUP') {
      const group = await this.prisma.productChannelGroup.findFirst({
        where: { id: targetId, productId, deletedAt: null },
        select: {
          id: true,
          members: {
            where: { productChannel: { deletedAt: null } },
            select: {
              productChannel: {
                select: { id: true, metadata: true },
              },
            },
          },
        },
      });
      if (!group) throw new NotFoundException('渠道分组不存在');
      const dedicatedMember = group.members.find((member) => (
        isStrictDedicatedProviderIsolation(this.productChannelIsolation(
          member.productChannel.metadata,
          `ProductChannel ${member.productChannel.id} metadata`,
        ))
      ));
      if (dedicatedMember) {
        throw new BadRequestException(
          `路由分组包含 dedicated-only ProductChannel ${dedicatedMember.productChannel.id}，`
          + '不能用于普通产品路由',
        );
      }
      return;
    }
    if (targetType === 'PRODUCT_CHANNEL') {
      const productChannel = await this.requireProductChannel(productId, targetId);
      this.assertProductChannelEligibleForOrdinaryRoute(
        productChannel.metadata,
        'RouteAssignment target',
      );
      return;
    }
    throw new BadRequestException('targetType 暂不支持');
  }

  private normalizeModelArray(
    raw: unknown,
    channel: ChannelForRoute,
    fieldName: string,
    requireSubset = true,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (raw === undefined || raw === null) return Prisma.JsonNull;
    const values = normalizeStringArrayInput(raw);
    if (!requireSubset || values.length === 0) return values;
    const channelModels = parseStringArrayJson(channel.models);
    if (channelModels.includes('*')) return values;
    const allowed = new Set(channelModels);
    const invalid = values.filter((model) => !allowed.has(model));
    if (invalid.length > 0) {
      throw new BadRequestException(`${fieldName} 包含渠道未开通模型: ${invalid.join(', ')}`);
    }
    return values;
  }

  private requiredString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${fieldName} 为必填`);
    }
    return value.trim();
  }

  private requiredCode(value: unknown, fieldName: string): string {
    const code = this.requiredString(value, fieldName);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(code)) {
      throw new BadRequestException(`${fieldName} 只能包含字母、数字、下划线和中划线，且最长 64 位`);
    }
    return code;
  }

  private deliveryAudienceScope(value: unknown): 'ALL' | 'USER' | 'USER_SEGMENT' {
    if (value === undefined || value === null || value === '') return 'ALL';
    if (value === 'ALL' || value === 'USER' || value === 'USER_SEGMENT') return value;
    throw new BadRequestException('audience.scope 必须是 ALL / USER / USER_SEGMENT');
  }

  private async nextDeliveryGroupCode(productId: string, seed: unknown): Promise<string> {
    const base = this.deliveryCodeSeed(seed);
    for (let i = 0; i < 20; i += 1) {
      const suffix = i === 0 ? '' : `-${i + 1}`;
      const candidate = `${base}${suffix}`.slice(0, 64);
      const existing = await this.prisma.productChannelGroup.findFirst({
        where: { productId, code: candidate, deletedAt: null },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    return `${base.slice(0, 52)}-${Date.now().toString(36)}`.slice(0, 64);
  }

  private deliveryCodeSeed(seed: unknown): string {
    const raw = typeof seed === 'string' ? seed : 'delivery';
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 48);
    if (/^[a-z0-9]/.test(normalized)) return normalized;
    return 'delivery';
  }

  private optionalString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private optionalClientCompatibility(value: unknown): string | null {
    const trimmed = this.optionalString(value);
    if (!trimmed) return null;
    try {
      return normalizeClientCompatibilityValue(trimmed);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private enumValue<T extends readonly string[]>(
    value: unknown,
    allowed: T,
    fallback: string | undefined,
    fieldName: string,
  ): T[number] {
    if (value === undefined || value === null || value === '') {
      if (fallback !== undefined && allowed.includes(fallback)) return fallback as T[number];
      throw new BadRequestException(`${fieldName} 为必填`);
    }
    if (typeof value === 'string' && allowed.includes(value)) return value as T[number];
    throw new BadRequestException(`${fieldName} 不合法`);
  }

  private positiveInt(value: unknown, fallback: number, fieldName: string): number {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException(`${fieldName} 必须是正整数`);
    }
    return n;
  }

  private optionalPositiveInt(value: unknown, fieldName: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    return this.positiveInt(value, 1, fieldName);
  }

  private optionalDate(value: unknown, fieldName: string): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${fieldName} 日期不合法`);
    return date;
  }

  private assertDateRange(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && startsAt >= endsAt) {
      throw new BadRequestException('startsAt 必须早于 endsAt');
    }
  }

  private optionalJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    return value as Prisma.InputJsonValue;
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}

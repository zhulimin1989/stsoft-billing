export const PRODUCT_CHANNEL_STATUSES = ['active', 'disabled', 'testing'] as const;
export const PRODUCT_CHANNEL_GROUP_STATUSES = ['active', 'disabled'] as const;
export const PRODUCT_CHANNEL_GROUP_STRATEGIES = [
  'weighted_failover',
  'priority_failover',
  'round_robin',
  'cost_first',
  'latency_first',
] as const;
export const PRODUCT_CHANNEL_GROUP_MEMBER_ROLES = ['primary', 'fallback', 'shadow'] as const;
export const ROUTE_ASSIGNMENT_SUBJECT_TYPES = ['USER', 'USER_SEGMENT'] as const;
export const ROUTE_ASSIGNMENT_TARGET_TYPES = ['GROUP', 'PRODUCT_CHANNEL'] as const;
export const ROUTE_ASSIGNMENT_MODES = ['ONLY', 'PREFER'] as const;

export type ProductChannelStatus = typeof PRODUCT_CHANNEL_STATUSES[number];
export type ProductChannelGroupStatus = typeof PRODUCT_CHANNEL_GROUP_STATUSES[number];
export type ProductChannelGroupStrategy = typeof PRODUCT_CHANNEL_GROUP_STRATEGIES[number];
export type ProductChannelGroupMemberRole = typeof PRODUCT_CHANNEL_GROUP_MEMBER_ROLES[number];
export type RouteAssignmentSubjectType = typeof ROUTE_ASSIGNMENT_SUBJECT_TYPES[number];
export type RouteAssignmentTargetType = typeof ROUTE_ASSIGNMENT_TARGET_TYPES[number];
export type RouteAssignmentMode = typeof ROUTE_ASSIGNMENT_MODES[number];

export type CreateProductChannelInput = {
  channelId?: string;
  displayName?: string | null;
  status?: string;
  isDefault?: boolean;
  allowedModels?: unknown;
  deniedModels?: unknown;
  priority?: unknown;
  weight?: unknown;
  maxRpm?: unknown;
  maxTpm?: unknown;
  metadata?: unknown;
};

export type UpdateProductChannelInput = Omit<CreateProductChannelInput, 'channelId'>;

export type CreateProductChannelGroupInput = {
  code?: string;
  name?: string;
  description?: string | null;
  strategy?: string;
  isDefault?: boolean;
  status?: string;
  metadata?: unknown;
};

export type UpdateProductChannelGroupInput = Partial<CreateProductChannelGroupInput>;

export type AddProductChannelGroupMemberInput = {
  productChannelId?: string;
  priority?: unknown;
  weight?: unknown;
  role?: string;
  maxRpm?: unknown;
  maxTpm?: unknown;
};

export type UpdateProductChannelGroupMemberInput = Omit<Partial<AddProductChannelGroupMemberInput>, 'productChannelId'>;

export type DeliverySettingAudienceScope = 'ALL' | RouteAssignmentSubjectType;

export type CreateDeliverySettingChannelInput = CreateProductChannelInput & {
  groupMember?: UpdateProductChannelGroupMemberInput;
};

export type CreateDeliverySettingInput = {
  group?: CreateProductChannelGroupInput;
  channels?: CreateDeliverySettingChannelInput[];
  audience?: Partial<CreateRouteAssignmentInput> & {
    scope?: DeliverySettingAudienceScope;
  };
};

export type CreateRouteAssignmentInput = {
  subjectType?: string;
  subjectId?: string;
  modelPattern?: string | null;
  clientCompatibility?: string | null;
  targetType?: string;
  targetId?: string;
  mode?: string;
  priority?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  isActive?: boolean;
  reason?: string | null;
  metadata?: unknown;
};

export type UpdateRouteAssignmentInput = Partial<CreateRouteAssignmentInput>;

export type RouteAssignmentFilters = {
  subjectType?: string;
  subjectId?: string;
  targetType?: string;
  isActive?: boolean;
};

import { z } from 'zod';

// 分页参数 schema
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

// 注册 schema
export const registerSchema = z
  .object({
    email: z.string().email('邮箱格式不正确').optional(),
    phone: z
      .string()
      .regex(/^1[3-9]\d{9}$/, '手机号格式不正确')
      .optional(),
    password: z.string().min(8, '密码至少8位').max(64, '密码最多64位'),
    nickname: z.string().max(30, '昵称最多30字').optional(),
    // P2-D 邀请裂变(均可选,归因失败注册仍成功)
    referralCode: z.string().max(32, '邀请码最多32字').optional(),
    deviceId: z.string().max(128, 'deviceId 最多128字').optional(),
  })
  .refine((data) => data.email || data.phone, {
    message: '手机号和邮箱至少填一个',
  });

export type RegisterInput = z.infer<typeof registerSchema>;

// 登录 schema
export const loginSchema = z
  .object({
    email: z.string().email('邮箱格式不正确').optional(),
    phone: z.string().optional(),
    password: z.string().min(1, '请输入密码'),
  })
  .refine((data) => data.email || data.phone, {
    message: '手机号和邮箱至少填一个',
  });

export type LoginInput = z.infer<typeof loginSchema>;

// 更新个人信息 schema
export const updateProfileSchema = z.object({
  nickname: z.string().max(30, '昵称最多30字').optional(),
  avatar: z.string().url('头像必须是合法 URL').optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// 修改密码 schema
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入旧密码'),
  newPassword: z.string().min(8, '新密码至少8位').max(64, '新密码最多64位'),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ============================
// API Key schema
// ============================

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'Key 名称不能为空').max(50, 'Key 名称最多50字'),
  productId: z.string().uuid('产品 ID 格式不正确').optional(),
  codingPlanEntitlementId: z.string().uuid('CodingPlan 权益 ID 格式不正确').optional(),
  allowedModels: z.array(z.string()).optional(),
  budgetCents: z.number().int().min(1, '限额必须大于 0').max(100_000_000, '限额过大').nullable().optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// ============================
// Chat Studio schema
// ============================

export const createConversationSchema = z.object({
  model: z.string().optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  title: z.string().max(100, '标题最多100字').optional(),
  model: z.string().optional(),
});

export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const sendMessageSchema = z.object({
  content: z.string().min(1, '消息不能为空').max(32000, '消息过长'),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

// ============================
// 订单 schema
// ============================

const planIdSchema = z.string()
  .trim()
  .min(1, '套餐 ID 不能为空')
  .max(128, '套餐 ID 过长')
  .regex(/^[A-Za-z0-9_-]+$/, '套餐 ID 格式不正确');

export const createOrderSchema = z.object({
  orderType: z.enum(['SUBSCRIPTION', 'BOOSTER_PACK', 'RECHARGE', 'BUNDLE']).default('SUBSCRIPTION'),
  planId: planIdSchema.optional(),
  bundleSkuId: z.string().uuid('组合套餐 ID 格式不正确').optional(),
  boosterPackId: z.string().uuid('加油包 ID 格式不正确').optional(),
  amountCents: z.number().int().min(1).optional(),
  // PR0-4: RECHARGE 时携带，用于匹配 RechargeTier 计算赠送金额
  productId: z.string().uuid('产品 ID 格式不正确').optional(),
  // PR0-4: 用户显式选择的 tier（可选，用于强校验）
  tierId: z.string().uuid('面额 ID 格式不正确').optional(),
  idempotencyKey: z.string().max(128).optional(),
  channel: z.enum(['WECHAT', 'ALIPAY', 'STRIPE', 'BALANCE']),
  promoCode: z.string().optional(),
  // 多币种 / 计费周期 / 支付方式（Stripe 场景细分）
  billingPeriod: z.enum(['monthly', 'quarterly', 'yearly']).optional().default('monthly'),
  // ISO 4217 三字母代码，小写存储。前端传什么大小写都接受。
  currency: z
    .string()
    .length(3, '币种代码必须为 3 位')
    .transform((s) => s.toLowerCase())
    .optional(),
  // paymentMethod：历史字段，保留向后兼容。
  // 2026-04 后：Stripe Checkout 页面让用户自选支付方式（card / alipay / link / ...），
  // 后端不再根据该字段分流到 createSubscription vs createCheckoutSession —— 由 orderType 决定。
  // 前端新逻辑一律不传。
  paymentMethod: z.enum(['card', 'alipay']).optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
}).refine(
  (data) => {
    if (data.orderType === 'RECHARGE' && !data.amountCents) return false;
    if (data.orderType === 'SUBSCRIPTION' && !data.planId) return false;
    if (data.orderType === 'BUNDLE' && !data.bundleSkuId) return false;
    if (data.orderType === 'BOOSTER_PACK' && !data.boosterPackId) return false;
    return true;
  },
  { message: 'RECHARGE 需要 amountCents，SUBSCRIPTION 需要 planId，BUNDLE 需要 bundleSkuId，BOOSTER_PACK 需要 boosterPackId' },
).refine(
  (data) => data.orderType !== 'RECHARGE' || Boolean(data.productId && data.tierId) || !data.amountCents || data.amountCents % 100 === 0,
  { message: '自定义充值金额必须为整数', path: ['amountCents'] },
);

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const paymentMethodsQuerySchema = z.object({
  orderType: z.enum(['SUBSCRIPTION', 'BOOSTER_PACK', 'RECHARGE', 'BUNDLE']).default('SUBSCRIPTION'),
  productId: z.string().uuid('产品 ID 格式不正确').optional(),
  currency: z.string().length(3, '币种代码必须为 3 位').transform((s) => s.toLowerCase()).optional(),
});

export type PaymentMethodsQueryInput = z.infer<typeof paymentMethodsQuerySchema>;

// ============================
// 成员管理 schema
// ============================

export const inviteMemberSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  role: z.enum(['admin', 'member']),
  displayName: z.string().max(30, '昵称最多30字').optional(),
});

export type InviteMemberSchemaInput = z.infer<typeof inviteMemberSchema>;

// ============================
// 用量查询 schema
// ============================

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
});

export type UsageQueryInput = z.infer<typeof usageQuerySchema>;

// ============================
// Admin — Channel schemas
// ============================

export const createChannelSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.string().optional(),
  /** Per-model 配置 JSON，shape 见 api/src/channel/model-configs.ts。后端做严格校验 */
  modelConfigs: z.string().nullable().optional(),
  sdkType: z.string().optional(),
  providerProfile: z.string().nullable().optional(),
  clientCompatibility: z.string().nullable().optional(),
  tokenCountStrategy: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(100).optional(),
  weight: z.number().int().min(1).max(100).optional(),
  maxRpm: z.number().int().optional(),
  maxTpm: z.number().int().optional(),
  remark: z.string().optional(),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = createChannelSchema.partial().omit({ name: true, provider: true, baseUrl: true, apiKey: true }).extend({
  name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

// ============================
// Admin — Product schemas
// ============================

export const productBillingModeSchema = z.enum(['SUBSCRIPTION', 'PAY_AS_YOU_GO', 'CODING_PLAN']);
export type ProductBillingModeInput = z.infer<typeof productBillingModeSchema>;

export const PAYMENT_CALLBACK_ORIGIN_MAX_COUNT = 50;
export const PAYMENT_CALLBACK_ORIGIN_MAX_LENGTH = 512;

const PAYMENT_CALLBACK_HTTP_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function canonicalizePaymentCallbackOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('支付回跳 Origin 必须是字符串');
  }
  const candidate = value.trim();
  if (!candidate) {
    throw new Error('支付回跳 Origin 不能为空');
  }
  if (/[\u0000-\u0020\u007f]/.test(candidate)) {
    throw new Error('支付回跳 Origin 不能包含空白或控制字符');
  }
  if (candidate.length > PAYMENT_CALLBACK_ORIGIN_MAX_LENGTH) {
    throw new Error(`支付回跳 Origin 不能超过 ${PAYMENT_CALLBACK_ORIGIN_MAX_LENGTH} 个字符`);
  }
  if (candidate.includes('*')) {
    throw new Error('支付回跳 Origin 不支持通配符');
  }
  if (!/^https?:\/\//i.test(candidate)) {
    throw new Error('支付回跳 Origin 必须以 http:// 或 https:// 开头');
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('支付回跳地址必须是合法的 HTTP/HTTPS Origin');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('支付回跳地址仅支持 HTTP/HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('支付回跳 Origin 不能包含用户名或密码');
  }
  if (parsed.hostname.includes('*')) {
    throw new Error('支付回跳 Origin 不支持通配符');
  }

  const schemeSeparator = candidate.indexOf('://');
  const authorityAndSuffix = candidate.slice(schemeSeparator + 3);
  if (authorityAndSuffix.includes('@')) {
    throw new Error('支付回跳 Origin 不能包含用户名或密码');
  }
  const suffixIndex = authorityAndSuffix.search(/[/?#\\]/);
  if (suffixIndex >= 0 && authorityAndSuffix.slice(suffixIndex) !== '/') {
    throw new Error('支付回跳地址只能配置 Origin，不能包含路径、查询参数或锚点');
  }
  if (parsed.protocol === 'http:' && !PAYMENT_CALLBACK_HTTP_LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('HTTP 仅允许 localhost、127.0.0.1 或 [::1]');
  }

  return parsed.origin;
}

export const paymentCallbackOriginSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    canonicalizePaymentCallbackOrigin(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : '支付回跳 Origin 不合法',
    });
  }
});

export const allowedPaymentCallbackOriginsSchema = z
  .array(paymentCallbackOriginSchema)
  .max(PAYMENT_CALLBACK_ORIGIN_MAX_COUNT)
  .nullable();
export type AllowedPaymentCallbackOriginsInput = z.infer<typeof allowedPaymentCallbackOriginsSchema>;

export const createProductSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  allowedPaymentCallbackOrigins: allowedPaymentCallbackOriginsSchema.optional(),
  defaultPlanId: z.string().nullable().optional(),
  billingMode: productBillingModeSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  allowedPaymentCallbackOrigins: allowedPaymentCallbackOriginsSchema.optional(),
  defaultPlanId: z.string().nullable().optional(),
  billingMode: productBillingModeSchema.optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// ============================
// Admin — BoosterPack schemas
// ============================

export const createBoosterPackSchema = z.object({
  productId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  creditsAmount: z.number().int().min(1),
  priceCents: z.number().int().min(0),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateBoosterPackInput = z.infer<typeof createBoosterPackSchema>;

export const updateBoosterPackSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  creditsAmount: z.number().int().min(1).optional(),
  priceCents: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateBoosterPackInput = z.infer<typeof updateBoosterPackSchema>;

// ============================
// Admin — Bundle SKU schemas
// ============================

export const bundleSkuItemSchema = z.object({
  productId: z.string().min(1),
  planId: z.string().min(1).nullable().optional(),
  boosterPackId: z.string().min(1).nullable().optional(),
  billingType: z.enum(['SUBSCRIPTION', 'ONE_TIME']),
  name: z.string().optional(),
  unitAmountCents: z.number().int().min(1),
  originalUnitAmountCents: z.number().int().min(0).nullable().optional(),
  quantity: z.number().int().min(1).optional(),
  recurringInterval: z.enum(['month', 'year']).nullable().optional(),
  validityDays: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().optional(),
}).superRefine((item, ctx) => {
  if (item.billingType === 'SUBSCRIPTION') {
    if (!item.planId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '订阅项必须绑定套餐', path: ['planId'] });
    }
    if (item.boosterPackId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '订阅项不能绑定加油包', path: ['boosterPackId'] });
    }
    if (item.recurringInterval !== 'month' && item.recurringInterval !== 'year') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '订阅项必须配置续费周期', path: ['recurringInterval'] });
    }
  }
  if (item.billingType === 'ONE_TIME') {
    const targets = [item.planId, item.boosterPackId].filter(Boolean);
    if (targets.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '一次性项必须且只能绑定一个套餐或加油包' });
    }
  }
});

const bundleSkuBaseSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  currency: z.string().length(3).optional(),
  billingPeriod: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  amountCents: z.number().int().min(1).optional(),
  originalAmountCents: z.number().int().min(0).nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  maxUsesPerUser: z.number().int().min(0).optional(),
  maxUsesTotal: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  items: z.array(bundleSkuItemSchema).min(2),
});

export const createBundleSkuSchema = bundleSkuBaseSchema.superRefine((bundle, ctx) => {
  const hasSubscription = bundle.items.some((item) => item.billingType === 'SUBSCRIPTION');
  const hasOneTime = bundle.items.some((item) => item.billingType === 'ONE_TIME');
  if (!hasSubscription || !hasOneTime) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '组合套餐必须同时包含可续费项和一次性权益项', path: ['items'] });
  }
  if (bundle.startAt && bundle.endAt && new Date(bundle.startAt) >= new Date(bundle.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '开始时间必须早于结束时间', path: ['endAt'] });
  }
});

export type CreateBundleSkuInput = z.infer<typeof createBundleSkuSchema>;

export const updateBundleSkuSchema = bundleSkuBaseSchema.partial().extend({
  items: z.array(bundleSkuItemSchema).min(2).optional(),
}).superRefine((bundle, ctx) => {
  if (bundle.items) {
    const hasSubscription = bundle.items.some((item) => item.billingType === 'SUBSCRIPTION');
    const hasOneTime = bundle.items.some((item) => item.billingType === 'ONE_TIME');
    if (!hasSubscription || !hasOneTime) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '组合套餐必须同时包含可续费项和一次性权益项', path: ['items'] });
    }
  }
  if (bundle.startAt && bundle.endAt && new Date(bundle.startAt) >= new Date(bundle.endAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '开始时间必须早于结束时间', path: ['endAt'] });
  }
});

export type UpdateBundleSkuInput = z.infer<typeof updateBundleSkuSchema>;

// ============================
// Admin — Plan schemas
// ============================

export const createPlanSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  planType: z.string().optional(),
  monthlyPrice: z.number().int().min(0).optional(),
  quarterlyPrice: z.number().int().min(0).optional(),
  yearlyPrice: z.number().int().min(0).optional(),
  billingPeriod: z.string().optional(),
  monthlyCredits: z.number().int().min(0).optional(),
  creditsRollover: z.boolean().optional(),
  rolloverMaxMonths: z.number().int().min(0).optional(),
  rateLimitRpm: z.number().int().min(0).optional(),
  rateLimitTpm: z.number().int().min(0).optional(),
  maxContextWindow: z.number().int().min(0).optional(),
  overageEnabled: z.boolean().optional(),
  usageMultiplier: z.number().optional(),
  memberLimit: z.number().int().min(0).optional(),
  minimumSeats: z.number().int().min(0).optional(),
  dataTraining: z.string().optional(),
  supportTier: z.string().optional(),
  ssoEnabled: z.boolean().optional(),
  priorityAccess: z.boolean().optional(),
  badge: z.string().nullable().optional(),
  trialDays: z.number().int().min(0).optional(),
  features: z.unknown().optional(),
  isActive: z.boolean().optional(),
  isLegacy: z.boolean().optional(),
  salesLimit: z.number().int().min(0).optional(),
  sortOrder: z.number().int().optional(),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

// Update plan is PATCH-style: any subset of create fields. Backend
// (billing.admin.service.updatePlan) applies only provided keys.
// Without .partial(), `name` stays required and client calls like
// `planApi.update(id, { isActive: false })` would be type-rejected even
// though the server would accept them.
export const updatePlanSchema = createPlanSchema.omit({ id: true }).partial();
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

// ============================
// Admin — Alert schemas
// ============================

export const createAlertSchema = z.object({
  name: z.string().min(1),
  metric: z.string().optional(),
  condition: z.string().min(1),
  threshold: z.number().optional(),
  windowMinutes: z.number().int().min(1).optional(),
});

export type CreateAlertInput = z.infer<typeof createAlertSchema>;

export const updateAlertSchema = createAlertSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;

// ============================
// Admin — Announcement schemas
// ============================

export const createAnnouncementSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  targetAudience: z.string().optional(),
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const updateAnnouncementSchema = createAnnouncementSchema.partial();
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

// ============================
// Admin — FeatureFlag schemas
// ============================

export const upsertFeatureFlagSchema = z.object({
  key: z.string().min(1),
  value: z.boolean(),
  description: z.string().optional(),
  scope: z.string().optional(),
  scopeValue: z.string().nullable().optional(),
});

export type UpsertFeatureFlagInput = z.infer<typeof upsertFeatureFlagSchema>;

// ============================
// Admin — SystemPrompt schemas
// ============================

export const upsertSystemPromptSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  key: z.string().optional(),
  content: z.string().min(1),
  description: z.string().optional(),
});

export type UpsertSystemPromptInput = z.infer<typeof upsertSystemPromptSchema>;

// ============================
// Admin — ModelAccess schemas
// ============================

export const modelAccessItemSchema = z.object({
  tierId: z.string().optional(),
  planId: z.string().optional(),
  modelName: z.string().optional(),
  model: z.string().optional(),
  isActive: z.boolean().optional(),
  isAllowed: z.boolean().optional(),
  dailyLimit: z.number().int().optional(),
  creditMultiplier: z.number().optional(),
});

export type ModelAccessItemInput = z.infer<typeof modelAccessItemSchema>;

export const modelRoutePolicyItemSchema = z.object({
  planId: z.string(),
  routeKey: z.string().min(1),
  primaryModel: z.string().nullable().optional(),
  fallbackModels: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

export type ModelRoutePolicyItemInput = z.infer<typeof modelRoutePolicyItemSchema>;

// ============================
// Admin — Role schemas
// ============================

export const createAdminRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.string().optional(),
  key: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

export type CreateAdminRoleInput = z.infer<typeof createAdminRoleSchema>;

export const updateAdminRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  permissions: z.string().optional(),
  key: z.string().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateAdminRoleInput = z.infer<typeof updateAdminRoleSchema>;

// ============================
// Admin — Member schemas
// ============================

export const inviteAdminMemberSchema = z.object({
  email: z.string().email(),
  roleId: z.string().min(1),
  name: z.string().optional(),
  phone: z.string().optional(),
  department: z.string().optional(),
});

export type InviteAdminMemberInput = z.infer<typeof inviteAdminMemberSchema>;

export const updateAdminMemberSchema = z.object({
  presetRole: z.string().optional(),
  permissions: z.record(z.boolean()).optional(),
  isActive: z.boolean().optional(),
  roleId: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  department: z.string().optional(),
});

export type UpdateAdminMemberInput = z.infer<typeof updateAdminMemberSchema>;

// ============================
// Admin — User Update schema
// ============================

export const updateUserSchema = z.object({
  email: z.string().email().optional(),
  nickname: z.string().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

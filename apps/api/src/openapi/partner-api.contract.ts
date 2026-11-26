import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z, ZodTypeAny } from 'zod';
import {
  buildPartnerApiEndpoints,
  PARTNER_API_BASE_PATH,
  PARTNER_API_ENDPOINT_KEYS,
  type PartnerApiEndpointKey,
} from '../common/openapi/partner-api-endpoints';

extendZodWithOpenApi(z);

const nonEmptyId = (description: string, example: string) =>
  z.string()
    .regex(
      /^[^\u0000-\u001F\u007F]*$/,
      'Identifier must not contain ASCII control characters',
    )
    .trim()
    .min(1)
    .max(128)
    .openapi({ description, example });

const nullableString = z.string().nullable();
const isoDateTime = z.string().datetime({ offset: true });
const partnerBillingModeSchema = z.enum([
  'SUBSCRIPTION',
  'PAY_AS_YOU_GO',
  'CODING_PLAN',
]);
const partnerIdempotencyKey = (description: string, example: string) =>
  z.string()
    .trim()
    .min(8, 'idempotencyKey 长度不能少于 8 个字符')
    .max(128, 'idempotencyKey 长度不能超过 128 个字符')
    .regex(
      /^[A-Za-z0-9._:-]+$/,
      'idempotencyKey 只能包含字母、数字、点、下划线、冒号和连字符',
    )
    .openapi({ description, example });
const currencyCode = () =>
  z.string()
    .regex(/^[A-Za-z]{3}$/, '币种代码必须是 3 位英文字母')
    .transform((value) => value.toLowerCase())
    .openapi({
      description: 'Three-letter ISO 4217 currency code.',
      example: 'usd',
    });
const httpUrl = (description: string, example: string) =>
  z.string()
    .regex(/^https?:\/\//i, 'URL 只支持 http 或 https 协议')
    .url()
    .openapi({ description, example });

export const partnerUserScopeSchema = z.object({
  userId: nonEmptyId('External SaaS user identifier mirrored into Billing.', 'user-123'),
  tenantId: nonEmptyId(
    'External SaaS tenant identifier. It may be omitted only for a self-operated CODING_PLAN product whose subject is explicitly per-user.',
    'tenant-123',
  ).optional(),
}).strict();

export const partnerCreditQuerySchema = partnerUserScopeSchema.extend({
  entitlementId: nonEmptyId(
    'Optional CodingPlan entitlement. It must belong to the token-derived product and subject.',
    'entitlement-123',
  ).optional(),
}).strict();

export const partnerOrderTypeSchema = z.enum([
  'SUBSCRIPTION',
  'BOOSTER_PACK',
  'RECHARGE',
  'BUNDLE',
]);

export const partnerPurchasableOrderTypeSchema = z.enum([
  'SUBSCRIPTION',
  'BOOSTER_PACK',
  'RECHARGE',
]);

export const partnerOrderStatusSchema = z.enum([
  'PENDING',
  'PAID',
  'FULFILLING',
  'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'REFUNDING',
  'REFUNDED',
  'REFUND_FAILED',
  'REFUND_COMPENSATION_FAILED',
]);

export const partnerCreateOrderSchema = partnerUserScopeSchema.extend({
  tenantId: z.string({ required_error: 'tenantId 不能为空' })
    .regex(
      /^[^\u0000-\u001F\u007F]*$/,
      'tenantId 不能包含 ASCII 控制字符',
    )
    .trim()
    .min(1, 'tenantId 不能为空')
    .max(128)
    .openapi({
      description:
        'External tenant that owns and pays for the order. Required for every product so user-api can verify tenant membership.',
      example: 'tenant-123',
    }),
  orderType: partnerPurchasableOrderTypeSchema.default('SUBSCRIPTION').openapi({
    description:
      'Purchase type. Exactly one matching target field is required; target fields for other order types are rejected.',
    example: 'SUBSCRIPTION',
  }),
  planId: z.string()
    .trim()
    .min(1, '套餐 ID 不能为空')
    .max(128, '套餐 ID 过长')
    .regex(/^[A-Za-z0-9_-]+$/, '套餐 ID 格式不正确')
    .openapi({
      description: 'Required and only allowed when orderType is SUBSCRIPTION.',
      example: 'plan-pro',
    })
    .optional(),
  boosterPackId: z.string().uuid('加油包 ID 格式不正确').openapi({
    description: 'Required and only allowed when orderType is BOOSTER_PACK.',
    example: '6ff92714-a7e3-4554-b0d0-a9eae3e9a39e',
  }).optional(),
  amountCents: z.number()
    .int()
    .min(1)
    .max(2_147_483_600)
    .openapi({
      description:
        'Required and only allowed for RECHARGE. Amount in the smallest currency unit; capped below the signed 32-bit database boundary.',
      example: 5000,
    })
    .optional(),
  idempotencyKey: partnerIdempotencyKey(
    'Required caller-generated idempotency key. Reuse it for every retry of the same logical order.',
    'saas-order-10001',
  ),
  channel: z.enum(['WECHAT', 'ALIPAY', 'STRIPE']).openapi({
    description: 'Payment channel. Availability depends on order type and deployment configuration.',
    example: 'STRIPE',
  }),
  billingPeriod: z.enum(['monthly', 'quarterly', 'yearly']).optional().openapi({
    description: 'Optional only for SUBSCRIPTION; omission means monthly.',
    example: 'monthly',
  }),
  currency: currencyCode().optional(),
  successUrl: httpUrl(
    'Browser redirect after successful payment. Allowed for STRIPE and ALIPAY only; its origin must be allowlisted for the product.',
    'https://app.saas.example/billing/success',
  ).optional(),
  cancelUrl: httpUrl(
    'Browser redirect after cancelled payment. Allowed for STRIPE only; its origin must be allowlisted for the product.',
    'https://app.saas.example/billing/cancel',
  ).optional(),
}).strict().superRefine((data, context) => {
  const expectedTarget = {
    SUBSCRIPTION: 'planId',
    BOOSTER_PACK: 'boosterPackId',
    RECHARGE: 'amountCents',
  }[data.orderType] as 'planId' | 'boosterPackId' | 'amountCents';
  const targetFields = [
    'planId',
    'boosterPackId',
    'amountCents',
  ] as const;
  for (const field of targetFields) {
    if (field === expectedTarget && data[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${data.orderType} 需要 ${field}`,
      });
    }
    if (field !== expectedTarget && data[field] !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} 不适用于 ${data.orderType}`,
      });
    }
  }
  if (data.orderType !== 'SUBSCRIPTION' && data.billingPeriod !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['billingPeriod'],
      message: `billingPeriod 不适用于 ${data.orderType}`,
    });
  }
  if (
    data.channel === 'WECHAT'
    && (data.successUrl !== undefined || data.cancelUrl !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [data.successUrl !== undefined ? 'successUrl' : 'cancelUrl'],
      message: 'WECHAT 不接受浏览器回跳 URL',
    });
  }
  if (data.channel === 'ALIPAY' && data.cancelUrl !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cancelUrl'],
      message: 'ALIPAY 不接受 cancelUrl',
    });
  }
}).refine(
  (data) => data.orderType !== 'RECHARGE' || !data.amountCents || data.amountCents % 100 === 0,
  { message: '充值金额必须是 100 cents 的整数倍', path: ['amountCents'] },
);

const partnerPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).openapi({
    description: 'One-based page number.',
    example: 1,
  }),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).openapi({
    description: 'Number of records per page, at most 100.',
    example: 20,
  }),
}).strict();

export const partnerOrdersQuerySchema = partnerPaginationSchema.merge(partnerUserScopeSchema).extend({
  status: partnerOrderStatusSchema.openapi({
    description: 'Order status filter.',
    example: 'PENDING',
  }).optional(),
  orderType: partnerOrderTypeSchema.openapi({
    description: 'Order type filter.',
    example: 'SUBSCRIPTION',
  }).optional(),
}).strict();

export const partnerTransactionsQuerySchema =
  partnerPaginationSchema.merge(partnerUserScopeSchema).strict();

export const partnerCreditTransactionsQuerySchema =
  partnerPaginationSchema.merge(partnerCreditQuerySchema).strict();

export const partnerDailySummaryQuerySchema = partnerUserScopeSchema.extend({
  startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate 必须是 YYYY-MM-DD').openapi({
    description: 'Inclusive UTC calendar date in YYYY-MM-DD form.',
    example: '2026-07-01',
  }),
  endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate 必须是 YYYY-MM-DD').openapi({
    description: 'Inclusive UTC calendar date in YYYY-MM-DD form.',
    example: '2026-07-31',
  }),
  apiKeyId: nonEmptyId('Optional API key filter.', 'key-123').optional(),
}).strict();

export const partnerMonthlySummaryQuerySchema = partnerUserScopeSchema.extend({
  year: z.string().trim().regex(/^(20[2-9]\d|2100)$/, 'year 必须是合法的年份（2020-2100）').openapi({
    description: 'UTC calendar year from 2020 through 2100.',
    example: '2026',
  }),
}).strict();

export const partnerPaymentMethodsQuerySchema = z.object({
  orderType: partnerPurchasableOrderTypeSchema.default('SUBSCRIPTION').openapi({
    description: 'Order type whose configured methods should be returned.',
    example: 'SUBSCRIPTION',
  }),
  currency: currencyCode().optional(),
}).strict();

const partnerProvisionUserSchema = z.object({
  id: nonEmptyId('External SaaS user identifier.', 'user-123'),
  email: z.string().email().max(320).nullable().optional().openapi({
    description: 'Latest email snapshot.',
    example: 'alice@example.com',
  }),
  phone: z.string().trim().min(1).max(64).nullable().optional().openapi({
    description: 'Latest phone snapshot.',
    example: '+8613800000000',
  }),
  nickname: z.string().trim().min(1).max(128).nullable().optional().openapi({
    description: 'Latest display-name snapshot.',
    example: 'Alice',
  }),
  sourceUpdatedAt: isoDateTime.nullable().optional().openapi({
    description: 'Version timestamp of the external user snapshot. It must not be more than five minutes in the future.',
    example: '2026-07-23T08:00:00.000Z',
  }),
}).strict();

const partnerProvisionTenantSchema = z.object({
  id: nonEmptyId(
    'External SaaS tenant identifier. Required except for self-operated CODING_PLAN user-only products.',
    'tenant-123',
  ).nullable().optional(),
  name: z.string().trim().min(1).max(200).nullable().optional().openapi({
    description: 'Latest tenant display name.',
    example: 'Alice Team',
  }),
  type: z.enum(['personal', 'team']).nullable().optional().openapi({
    description: 'Tenant type. Only personal and team are accepted.',
    example: 'personal',
  }),
}).strict();

const partnerProvisionKeySchema = z.object({
  name: z.string().trim().min(1).max(128).nullable().optional().openapi({
    description:
      'Virtual API key name. If supplied, it must equal the fixed product-scoped name '
      + 'saas:{token-derived-productSlug}:virtual.',
    example: 'saas:example-product:virtual',
  }),
  allowedModels: z.array(z.string().trim().min(1).max(256))
    .min(1, 'allowedModels 非空时至少需要一个模型')
    .max(200)
    .nullable()
    .optional()
    .openapi({
      description:
        'Optional model allowlist for the virtual API key. A non-null list must contain at least one model; an empty list is rejected rather than treated as unrestricted.',
      example: ['gpt-4.1'],
    }),
  budgetCents: z.number().int().positive().max(100_000_000).nullable().optional().openapi({
    description: 'Optional key budget in cents.',
    example: 100000,
  }),
  rotate: z.boolean().nullable().optional().openapi({
    description:
      'Rotate an existing Partner-managed key. Key policy changes require true. '
      + 'An exact replay with the same idempotency key returns the original durable result and never rotates again.',
    example: false,
  }),
}).strict();

export const partnerProvisionRequestSchema = z.object({
  idempotencyKey: partnerIdempotencyKey(
    'Required caller-generated idempotency key, scoped to the token-derived product. '
      + 'Retry the same normalized request with the same key; reusing it for a different request returns HTTP 409.',
    'provision:tenant-10001',
  ),
  user: partnerProvisionUserSchema,
  tenant: partnerProvisionTenantSchema.nullable().optional(),
  key: partnerProvisionKeySchema.nullable().optional(),
  ensureFreePlan: z.boolean().nullable().optional().openapi({
    description:
      'For SUBSCRIPTION and self-operated CODING_PLAN (platform_model_package), omission/null/true ensures the default/free entitlement and false skips it. '
      + 'For PAY_AS_YOU_GO and provider_resale CODING_PLAN, omission/null/false skips automatic entitlement creation (provider_resale requires an existing active entitlement) and true is rejected with HTTP 400. '
      + 'Unknown or unconfigured CODING_PLAN fulfillment modes fail closed.',
    example: true,
  }),
}).strict();

export type PartnerUserScope = z.output<typeof partnerUserScopeSchema>;
export type PartnerCreditQuery = z.output<typeof partnerCreditQuerySchema>;
export type PartnerCreateOrderRequest = z.output<typeof partnerCreateOrderSchema>;
export type PartnerProvisionRequest = z.output<typeof partnerProvisionRequestSchema>;

const registry = new OpenAPIRegistry();

const errorResponseSchema = registry.register(
  'PartnerErrorResponse',
  z.object({
    code: z.union([z.string(), z.number()]).openapi({
      description: 'Stable machine-readable error code.',
      example: 'VALIDATION_ERROR',
    }),
    message: z.string().openapi({
      description: 'Human-readable error message.',
      example: '请求参数错误',
    }),
    data: z.null(),
    statusCode: z.number().int().optional().openapi({
      description: 'HTTP status code included by transport-level errors such as rate limiting.',
      example: 429,
    }),
    retryAfter: z.number().int().positive().optional().openapi({
      description: 'Retry delay in seconds when the request is rate limited.',
      example: 60,
    }),
  }).strict(),
);

const productSchema = registry.register(
  'PartnerProduct',
  z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    icon: nullableString.optional(),
    billingMode: partnerBillingModeSchema.optional(),
    codingPlanFulfillmentMode: nullableString.optional(),
    fulfillmentMode: nullableString.optional(),
    defaultPlanId: nullableString.optional(),
    isActive: z.boolean(),
    sortOrder: z.number().int().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  }).strict(),
);

const planSchema = registry.register(
  'PartnerPlan',
  z.object({
    id: z.string(),
    productId: nullableString,
    currency: currencyCode(),
    name: z.string(),
    description: z.string(),
    planType: z.string(),
    monthlyPrice: z.number().int(),
    quarterlyPrice: z.number().int(),
    yearlyPrice: z.number().int(),
    billingPeriod: z.string(),
    monthlyCredits: z.number().int(),
    creditsRollover: z.boolean(),
    rolloverMaxMonths: z.number().int(),
    rateLimitRpm: z.number().int(),
    rateLimitTpm: z.number().int(),
    maxContextWindow: z.number().int(),
    quotaRules: z.array(z.object({
      metric: z.enum(['REQUESTS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'TOTAL_TOKENS', 'CREDITS']),
      windowType: z.enum(['ROLLING', 'FIXED_PERIOD', 'CUMULATIVE']),
      durationSec: z.number().int(),
      durationLabel: z.string(),
      limitValue: z.number().int(),
      enforced: z.boolean(),
    }).strict()).optional(),
    overageEnabled: z.boolean(),
    usageMultiplier: z.number(),
    memberLimit: z.number().int(),
    minimumSeats: z.number().int(),
    dataTraining: z.string(),
    supportTier: z.string(),
    ssoEnabled: z.boolean(),
    priorityAccess: z.boolean(),
    badge: nullableString,
    trialDays: z.number().int(),
    validityDays: z.number().int(),
    features: z.array(z.string()),
    isActive: z.boolean(),
    isLegacy: z.boolean(),
    soldOut: z.boolean(),
    sortOrder: z.number().int(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  }).strict(),
);

const boosterPackSchema = registry.register(
  'PartnerBoosterPack',
  z.object({
    id: z.string(),
    productId: nullableString,
    name: z.string(),
    description: z.string(),
    creditsAmount: z.number().int(),
    priceCents: z.number().int(),
    expiryDays: z.number().int().nullable().optional(),
    isActive: z.boolean(),
    sortOrder: z.number().int(),
  }).strict(),
);

const modelSchema = registry.register(
  'PartnerModel',
  z.object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    modelType: nullableString.optional(),
  }).strict(),
);

const modelAccessSchema = registry.register(
  'PartnerModelAccess',
  z.object({
    planId: z.string(),
    modelName: z.string(),
    isActive: z.boolean(),
    creditMultiplier: z.number().nonnegative().openapi({
      description:
        'Authoritative plan/model credit multiplier. 0 means no credit charge, 1 is the base rate, and values above or below 1 scale credit consumption.',
      example: 1.5,
    }),
  }).strict(),
);

const modelRoutePolicySchema = registry.register(
  'PartnerModelRoutePolicy',
  z.object({
    planId: z.string(),
    routeKey: z.string(),
    primaryModel: z.string(),
    fallbackModels: z.array(z.string()),
    isActive: z.boolean(),
  }).strict(),
);

const channelSchema = registry.register(
  'PartnerChannel',
  z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    runtime: z.string(),
    models: z.record(z.string(), z.record(z.string(), z.unknown())),
    sdkType: nullableString.optional(),
    isDefault: z.boolean(),
  }).strict(),
);

const currentSubscriptionSchema = registry.register(
  'PartnerCurrentSubscription',
  z.object({
    productId: nullableString,
    billingMode: nullableString,
    fulfillmentMode: nullableString.optional(),
    planId: nullableString,
    planName: z.string(),
    billingPeriod: nullableString,
    codingPlanEntitlementId: nullableString.optional(),
    monthlyPrice: z.number().int(),
    monthlyCredits: z.number().int(),
    rateLimitRpm: z.number().int(),
    rateLimitTpm: z.number().int(),
    maxContextWindow: z.number().int(),
    quotaRules: z.array(z.object({
      metric: z.enum(['REQUESTS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'TOTAL_TOKENS', 'CREDITS']),
      windowType: z.enum(['ROLLING', 'FIXED_PERIOD', 'CUMULATIVE']),
      durationSec: z.number().int(),
      durationLabel: z.string(),
      limitValue: z.number().int(),
      enforced: z.boolean(),
    }).strict()).optional(),
    usageWindows: z.object({
      month: z.object({
        usedCredits: z.number().int(),
        budgetCredits: z.number().int(),
        resetInSec: z.number().int().nullable(),
      }).strict().optional(),
      week: z.object({
        usedCredits: z.number().int(),
        budgetCredits: z.number().int(),
        resetInSec: z.number().int().nullable(),
      }).strict().optional(),
      fiveHour: z.object({
        usedCredits: z.number().int(),
        budgetCredits: z.number().int(),
        resetInSec: z.number().int().nullable(),
      }).strict().optional(),
    }).strict().optional(),
    features: z.array(z.string()),
    status: z.string(),
    expiresAt: isoDateTime.nullable(),
  }).strict(),
);

const creditsSchema = registry.register(
  'PartnerCredits',
  z.object({
    quotaCredits: z.number().int(),
    bonusCredits: z.number().int(),
    grantCredits: z.number().int(),
    totalCredits: z.number().int(),
    usedThisMonth: z.number().int(),
    usedThisCycle: z.number().int(),
    billingCycleStart: isoDateTime.nullable(),
  }).strict(),
);

const creditTransactionSchema = registry.register(
  'PartnerCreditTransaction',
  z.object({
    id: z.string(),
    userId: nullableString,
    tenantId: nullableString.optional(),
    productId: nullableString.optional(),
    subscriptionId: nullableString.optional(),
    type: z.enum([
      'QUOTA_GRANT',
      'QUOTA_RESET',
      'BONUS_PURCHASE',
      'CONSUME',
      'REFUND',
      'GRANT',
      'EXPIRE',
    ]),
    creditsAmount: z.number().int(),
    source: z.string(),
    quotaAfter: z.number().int(),
    bonusAfter: z.number().int(),
    balanceAfter: z.number().int(),
    inputTokens: z.number().int().optional(),
    cachedInputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    totalTokens: z.number().int().optional(),
    requestId: z.string().optional(),
    createdAt: isoDateTime,
  }).strict(),
);

const balanceTransactionSchema = registry.register(
  'PartnerBalanceTransaction',
  z.object({
    id: z.string(),
    userId: nullableString,
    tenantId: nullableString.optional(),
    productId: nullableString.optional(),
    type: z.enum(['RECHARGE', 'CONSUME', 'ADJUST', 'REFUND']),
    amountCents: z.number().int(),
    balanceAfterCents: z.number().int(),
    amountUsd: z.number().optional(),
    balanceAfterUsd: z.number().optional(),
    tokenUsageId: z.string().optional(),
    description: z.string(),
    createdAt: isoDateTime,
  }).strict(),
);

const orderSchema = registry.register(
  'PartnerOrder',
  z.object({
    id: z.string(),
    userId: z.string(),
    tenantId: nullableString.optional(),
    orderType: partnerOrderTypeSchema,
    bundleSkuId: nullableString.optional(),
    productId: nullableString.optional(),
    planId: nullableString,
    boosterPackId: nullableString,
    amountCents: z.number().int(),
    rechargeTierId: nullableString.optional(),
    bonusCents: z.number().int().optional(),
    totalGrantedCents: z.number().int().optional(),
    billingPeriod: z.enum(['monthly', 'quarterly', 'yearly']).nullable().optional(),
    prorationCreditCents: z.number().int().nullable().optional(),
    status: partnerOrderStatusSchema,
    channel: z.enum(['WECHAT', 'ALIPAY', 'STRIPE', 'BALANCE']).nullable(),
    tradeNo: nullableString,
    paidAt: isoDateTime.nullable(),
    refundedAt: isoDateTime.nullable().optional(),
    refundReason: nullableString.optional(),
    createdAt: isoDateTime,
  }).strict(),
);

const pagination = <T extends ZodTypeAny>(item: T) => z.object({
  items: z.array(item),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().min(0),
}).strict();

const currentProductDataSchema = registry.register(
  'PartnerCurrentProduct',
  z.object({
    productId: z.string(),
    productSlug: z.string(),
    name: z.string(),
    billingMode: partnerBillingModeSchema,
    isActive: z.boolean(),
    defaultPlanId: nullableString,
    hasWebhookUrl: z.boolean(),
    endpoints: registry.register(
      'PartnerApiEndpoints',
      z.object(
        Object.fromEntries(
          PARTNER_API_ENDPOINT_KEYS.map((key) => [key, z.string()] as const),
        ) as Record<PartnerApiEndpointKey, z.ZodString>,
      ).strict(),
    ),
  }).strict(),
);

const productsDataSchema = z.array(productSchema);
const plansDataSchema = z.array(planSchema);
const boosterPacksDataSchema = z.array(boosterPackSchema);
const modelsDataSchema = z.object({ models: z.array(modelSchema) }).strict();
const modelAccessDataSchema = z.object({ items: z.array(modelAccessSchema) }).strict();
const modelRoutePoliciesDataSchema = z.object({ items: z.array(modelRoutePolicySchema) }).strict();
const channelsDataSchema = z.object({ items: z.array(channelSchema) }).strict();
const catalogDataSchema = registry.register(
  'PartnerCatalog',
  z.object({
    products: productsDataSchema,
    plans: plansDataSchema,
    boosterPacks: boosterPacksDataSchema,
    models: modelsDataSchema,
    modelAccess: modelAccessDataSchema,
    modelRoutePolicies: modelRoutePoliciesDataSchema,
    channels: channelsDataSchema,
  }).strict(),
);

const creditsSummaryDataSchema = registry.register(
  'PartnerCreditsSummary',
  z.object({
    productId: z.string(),
    productSlug: z.string(),
    userId: z.string(),
    tenantId: nullableString,
    subscription: currentSubscriptionSchema,
    credits: creditsSchema,
    quotaCredits: z.number().int(),
    bonusCredits: z.number().int(),
    grantCredits: z.number().int(),
    totalCredits: z.number().int(),
    usedThisMonth: z.number().int(),
    usedThisCycle: z.number().int(),
    billingCycleStart: isoDateTime.nullable(),
  }).strict(),
);

const dailySummarySchema = registry.register(
  'PartnerDailySummaryItem',
  z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({
      description: 'UTC calendar-date bucket.',
      example: '2026-07-23',
    }),
    balanceConsumptionCents: z.number().int(),
    creditConsumption: z.number().int(),
    tokenCount: z.number().int(),
  }).strict(),
);

const monthlySummarySchema = registry.register(
  'PartnerMonthlySummaryItem',
  z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).openapi({
      description: 'UTC calendar-month bucket.',
      example: '2026-07',
    }),
    balanceConsumeCents: z.number().int(),
    balanceRechargeCents: z.number().int(),
    creditConsume: z.number().int(),
    creditGrant: z.number().int(),
    creditBonus: z.number().int(),
  }).strict(),
);

const paymentMethodsSchema = registry.register(
  'PartnerPaymentMethods',
  z.object({
    methods: z.array(z.object({
      channel: z.enum(['WECHAT', 'ALIPAY', 'STRIPE']),
      label: z.string(),
      currency: z.string().length(3),
      mode: z.enum(['qr', 'redirect']),
    }).strict()),
  }).strict(),
);

const provisionResultSchema = registry.register(
  'PartnerProvisionResult',
  z.object({
    userId: z.string(),
    tenantId: z.string().nullable().openapi({
      description:
        'External tenant id supplied by the caller, or null for a self-operated CODING_PLAN user-only request.',
    }),
    productId: z.string(),
    productSlug: z.string(),
    apiKey: z.object({
      id: z.string(),
      prefix: z.string(),
      plainKey: z.string().nullable().openapi({
        description:
          'Recoverable key secret. It can be returned on exact idempotent replays only during the 15-minute encrypted recovery window; afterward it is null.',
      }),
      created: z.boolean().openapi({
        description: 'Whether the original durable provision operation created this key.',
      }),
      rotated: z.boolean().openapi({
        description: 'Whether the original durable provision operation rotated a predecessor.',
      }),
    }).strict(),
    subscription: z.object({
      id: z.string(),
      planId: z.string(),
      created: z.boolean().openapi({
        description: 'Whether the original durable provision operation created this subscription.',
      }),
    }).strict().nullable(),
  }).strict(),
);

const createOrderResultSchema = registry.register(
  'PartnerCreateOrderResult',
  z.object({
    order: orderSchema,
    payUrl: z.string().url().nullable(),
  }).strict(),
);

const orderStatusResultSchema = registry.register(
  'PartnerOrderStatus',
  z.object({
    status: partnerOrderStatusSchema,
    paidAt: isoDateTime.nullable(),
    cancelReason: nullableString,
  }).strict(),
);

const productExample = {
  id: 'prod-123',
  slug: 'example-product',
  name: 'Example Product',
  description: 'Example external SaaS product',
  icon: null,
  billingMode: 'SUBSCRIPTION',
  defaultPlanId: 'plan-pro',
  isActive: true,
  sortOrder: 10,
};

const planExample = {
  id: 'plan-pro',
  productId: 'prod-123',
  currency: 'usd',
  name: 'Pro',
  description: 'Professional plan',
  planType: 'individual',
  monthlyPrice: 1999,
  quarterlyPrice: 1799,
  yearlyPrice: 1599,
  billingPeriod: 'monthly',
  monthlyCredits: 100000,
  creditsRollover: false,
  rolloverMaxMonths: 0,
  rateLimitRpm: 60,
  rateLimitTpm: 100000,
  maxContextWindow: 200000,
  overageEnabled: false,
  usageMultiplier: 1,
  memberLimit: 1,
  minimumSeats: 1,
  dataTraining: 'never',
  supportTier: 'priority',
  ssoEnabled: false,
  priorityAccess: true,
  badge: 'Popular',
  trialDays: 0,
  validityDays: 30,
  features: ['priority'],
  isActive: true,
  isLegacy: false,
  soldOut: false,
  sortOrder: 10,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

const orderExample = {
  id: 'order-123',
  userId: 'user-123',
  tenantId: 'tenant-123',
  orderType: 'SUBSCRIPTION',
  bundleSkuId: null,
  productId: 'prod-123',
  planId: 'plan-pro',
  boosterPackId: null,
  amountCents: 1999,
  rechargeTierId: null,
  bonusCents: 0,
  totalGrantedCents: 1999,
  billingPeriod: 'monthly',
  prorationCreditCents: null,
  status: 'PENDING',
  channel: 'ALIPAY',
  tradeNo: null,
  paidAt: null,
  refundedAt: null,
  refundReason: null,
  createdAt: '2026-07-23T08:00:00.000Z',
};

const currentSubscriptionExample = {
  productId: 'prod-123',
  billingMode: 'SUBSCRIPTION',
  fulfillmentMode: null,
  planId: 'plan-pro',
  planName: 'Pro',
  billingPeriod: 'monthly',
  monthlyPrice: 1999,
  monthlyCredits: 100000,
  rateLimitRpm: 60,
  rateLimitTpm: 100000,
  maxContextWindow: 200000,
  features: ['priority'],
  status: 'active',
  expiresAt: null,
};

const creditsExample = {
  quotaCredits: 80000,
  bonusCredits: 10000,
  grantCredits: 5000,
  totalCredits: 95000,
  usedThisMonth: 15000,
  usedThisCycle: 15000,
  billingCycleStart: '2026-07-01T00:00:00.000Z',
};

const envelope = (data: unknown, message = 'ok') => ({ code: 0, message, data });

// These are installed by the standalone OpenAPI transport for every response,
// including errors.  Keep them in the generated contract so consumers do not
// accidentally assume catalog or billing reads are safe for shared caching.
const partnerTransportHeaders = {
  'Cache-Control': {
    description: 'Always private, no-store. Partner responses must not be stored by browser or shared caches.',
    schema: { type: 'string' as const, enum: ['private, no-store'] },
    example: 'private, no-store',
  },
  Vary: {
    description: 'Includes Authorization, x-product-token, and x-billing-product-token to isolate credential-derived product state.',
    schema: { type: 'string' as const },
    example: 'Authorization, x-product-token, x-billing-product-token',
  },
};

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503;

const errorDefinitions: Record<ErrorStatus, {
  component: string;
  description: string;
  example: {
    code: string | number;
    message: string;
    data: null;
    statusCode?: number;
    retryAfter?: number;
  };
}> = {
  400: {
    component: 'PartnerBadRequest',
    description: 'Request validation failed.',
    example: { code: 'VALIDATION_ERROR', message: '请求参数错误', data: null },
  },
  401: {
    component: 'PartnerUnauthorized',
    description: 'Product integration token is missing, invalid, inactive, or revoked.',
    example: { code: 'AUTH_UNAUTHORIZED', message: 'Missing or invalid product integration token', data: null },
  },
  403: {
    component: 'PartnerForbidden',
    description: 'The authenticated subject is not permitted to perform this operation.',
    example: { code: 'AUTH_FORBIDDEN', message: '无权限执行此操作', data: null },
  },
  404: {
    component: 'PartnerNotFound',
    description: 'The requested resource does not exist in the token-derived product scope.',
    example: { code: 'NOT_FOUND', message: '资源不存在', data: null },
  },
  409: {
    component: 'PartnerConflict',
    description: 'The request conflicts with current state or an earlier idempotent request.',
    example: { code: 'CONFLICT', message: '请求与当前资源状态冲突', data: null },
  },
  413: {
    component: 'PartnerPayloadTooLarge',
    description: 'Request body exceeds the Partner API body-size limit.',
    example: { code: 'VALIDATION_ERROR', message: '请求体过大', data: null },
  },
  415: {
    component: 'PartnerUnsupportedMediaType',
    description: 'Request Content-Type is not supported by the Partner API.',
    example: { code: 'VALIDATION_ERROR', message: '不支持的 Content-Type', data: null },
  },
  429: {
    component: 'PartnerRateLimited',
    description: 'Rate limit exceeded. Honor the Retry-After response header.',
    example: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: '请求过于频繁',
      data: null,
      statusCode: 429,
      retryAfter: 60,
    },
  },
  500: {
    component: 'PartnerInternalError',
    description: 'Unexpected server error.',
    example: { code: 'INTERNAL_ERROR', message: '服务器内部错误', data: null },
  },
  502: {
    component: 'PartnerUpstreamError',
    description: 'An upstream provider returned an invalid or failed response.',
    example: { code: 'UPSTREAM_ERROR', message: '上游服务响应异常', data: null },
  },
  503: {
    component: 'PartnerServiceUnavailable',
    description: 'A required downstream service or the shared rate-limit backend is unavailable.',
    example: { code: 'SERVICE_UNAVAILABLE', message: '依赖服务或限流后端暂时不可用', data: null },
  },
};

const errorResponseRefs = Object.fromEntries(
  (Object.entries(errorDefinitions) as Array<[`${ErrorStatus}`, typeof errorDefinitions[ErrorStatus]]>)
    .map(([status, definition]) => {
      const parsedExample = errorResponseSchema.safeParse(definition.example);
      if (!parsedExample.success) {
        throw new Error(
          `Invalid Partner ${status} error example: ${parsedExample.error.message}`,
        );
      }
      const ref = registry.registerComponent('responses', definition.component, {
        description: definition.description,
        headers: {
          ...partnerTransportHeaders,
          ...(status === '429'
            ? {
                'Retry-After': {
                  description: 'Seconds until the client may retry.',
                  schema: { type: 'integer', minimum: 1 },
                  example: 60,
                },
              }
            : {}),
        },
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PartnerErrorResponse' },
            examples: {
              error: { value: definition.example },
            },
          },
        },
      });
      return [Number(status), ref] as const;
    }),
) as Record<ErrorStatus, { name: string; ref: { $ref: string } }>;

const commonErrors = [400, 401, 413, 415, 429, 500, 503] satisfies ErrorStatus[];
const protectedResourceErrors = [400, 401, 403, 404, 409, 413, 415, 429, 500, 503] satisfies ErrorStatus[];
const writeErrors = [400, 401, 403, 404, 409, 413, 415, 429, 500, 502, 503] satisfies ErrorStatus[];

interface PartnerRequestContract {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: {
    schema: ZodTypeAny;
    required: boolean;
    description: string;
    example: unknown;
  };
}

interface PartnerOperationContract {
  operationId: string;
  method: 'get' | 'post';
  path: `${typeof PARTNER_API_BASE_PATH}/${string}` | typeof PARTNER_API_BASE_PATH;
  tag: 'Product' | 'Catalog' | 'Billing' | 'Payment' | 'Provisioning';
  summary: string;
  description: string;
  request?: PartnerRequestContract;
  success: {
    status: 200 | 201;
    description: string;
    dataSchema: ZodTypeAny;
    example: unknown;
  };
  errors: readonly ErrorStatus[];
}

export const partnerOrderIdParamsSchema = z.object({
  id: nonEmptyId('Order identifier.', 'order-123'),
}).strict();

export const PARTNER_API_OPERATIONS = {
  getCurrentProduct: {
    operationId: 'partnerGetCurrentProduct',
    method: 'get',
    path: '/partner/v1/product/current',
    tag: 'Product',
    summary: 'Get the token-derived product',
    description: 'Returns the active product represented by the integration token and its Partner API endpoint map.',
    success: {
      status: 200,
      description: 'Current product metadata.',
      dataSchema: currentProductDataSchema,
      example: envelope({
        productId: 'prod-123',
        productSlug: 'example-product',
        name: 'Example Product',
        billingMode: 'SUBSCRIPTION',
        isActive: true,
        defaultPlanId: 'plan-pro',
        hasWebhookUrl: true,
        endpoints: buildPartnerApiEndpoints(),
      }),
    },
    errors: [...commonErrors, 404],
  },
  getCatalog: {
    operationId: 'partnerGetCatalog',
    method: 'get',
    path: '/partner/v1/catalog',
    tag: 'Catalog',
    summary: 'Get the complete product catalog',
    description: 'Returns the product-scoped aggregate catalog represented by the integration token.',
    success: {
      status: 200,
      description: 'Product catalog aggregate.',
      dataSchema: catalogDataSchema,
      example: envelope({
        products: [productExample],
        plans: [planExample],
        boosterPacks: [],
        models: { models: [] },
        modelAccess: { items: [] },
        modelRoutePolicies: { items: [] },
        channels: { items: [] },
      }),
    },
    errors: [...commonErrors, 404],
  },
  getProducts: {
    operationId: 'partnerListProducts',
    method: 'get',
    path: '/partner/v1/catalog/products',
    tag: 'Catalog',
    summary: 'List visible products',
    description: 'Returns the product represented by the integration token.',
    success: {
      status: 200,
      description: 'Visible products.',
      dataSchema: productsDataSchema,
      example: envelope([productExample]),
    },
    errors: [...commonErrors, 404],
  },
  getPlans: {
    operationId: 'partnerListPlans',
    method: 'get',
    path: '/partner/v1/catalog/plans',
    tag: 'Catalog',
    summary: 'List product plans',
    description:
      'Returns active plans belonging to the token-derived product, priced from active PlanPrice rows for the platform currency with the same legacy fallback used by checkout.',
    success: {
      status: 200,
      description: 'Active product plans.',
      dataSchema: plansDataSchema,
      example: envelope([planExample]),
    },
    errors: [...commonErrors, 404],
  },
  getBoosterPacks: {
    operationId: 'partnerListBoosterPacks',
    method: 'get',
    path: '/partner/v1/catalog/booster-packs',
    tag: 'Catalog',
    summary: 'List product booster packs',
    description: 'Returns active booster packs belonging to the token-derived product.',
    success: {
      status: 200,
      description: 'Active booster packs.',
      dataSchema: boosterPacksDataSchema,
      example: envelope([{
        id: 'booster-123',
        productId: 'prod-123',
        name: '10K Credits',
        description: 'One-time credit add-on',
        creditsAmount: 10000,
        priceCents: 999,
        isActive: true,
        sortOrder: 10,
      }]),
    },
    errors: [...commonErrors, 404],
  },
  getModels: {
    operationId: 'partnerListModels',
    method: 'get',
    path: '/partner/v1/catalog/models',
    tag: 'Catalog',
    summary: 'List product-visible models',
    description: 'Returns models visible through the token-derived product catalog.',
    success: {
      status: 200,
      description: 'Visible model catalog.',
      dataSchema: modelsDataSchema,
      example: envelope({
        models: [{ id: 'gpt-4.1', displayName: 'gpt-4.1', provider: 'openai', modelType: 'chat' }],
      }),
    },
    errors: [...commonErrors, 404],
  },
  getModelAccess: {
    operationId: 'partnerListModelAccess',
    method: 'get',
    path: '/partner/v1/catalog/model-access',
    tag: 'Catalog',
    summary: 'List plan model access',
    description: 'Returns model access rules for plans in the token-derived product.',
    success: {
      status: 200,
      description: 'Plan model access rules.',
      dataSchema: modelAccessDataSchema,
      example: envelope({
        items: [{
          planId: 'plan-pro',
          modelName: 'gpt-4.1',
          isActive: true,
          creditMultiplier: 1.5,
        }],
      }),
    },
    errors: [...commonErrors, 404],
  },
  getModelRoutePolicies: {
    operationId: 'partnerListModelRoutePolicies',
    method: 'get',
    path: '/partner/v1/catalog/model-route-policies',
    tag: 'Catalog',
    summary: 'List model route policies',
    description: 'Returns active model routing policies for plans in the token-derived product.',
    success: {
      status: 200,
      description: 'Product model route policies.',
      dataSchema: modelRoutePoliciesDataSchema,
      example: envelope({
        items: [{
          planId: 'plan-pro',
          routeKey: 'default',
          primaryModel: 'gpt-4.1',
          fallbackModels: ['gpt-4.1-mini'],
          isActive: true,
        }],
      }),
    },
    errors: [...commonErrors, 404],
  },
  getChannels: {
    operationId: 'partnerListChannels',
    method: 'get',
    path: '/partner/v1/catalog/channels',
    tag: 'Catalog',
    summary: 'List product-visible runtime channels',
    description: 'Returns the sanitized runtime channel view available to the token-derived product.',
    success: {
      status: 200,
      description: 'Sanitized product channel catalog.',
      dataSchema: channelsDataSchema,
      example: envelope({
        items: [{
          id: 'channel-123',
          name: 'Primary OpenAI',
          provider: 'openai',
          runtime: 'gateway',
          models: { 'gpt-4.1': { context_window: 200000 } },
          sdkType: 'openai',
          isDefault: true,
        }],
      }),
    },
    errors: [...commonErrors, 404],
  },
  getBillingCurrentSubscription: {
    operationId: 'partnerGetCurrentSubscription',
    method: 'get',
    path: '/partner/v1/billing/current-subscription',
    tag: 'Billing',
    summary: 'Get current subscription',
    description: 'Returns the subject subscription for the token-derived product.',
    request: { query: partnerUserScopeSchema },
    success: {
      status: 200,
      description: 'Current subscription.',
      dataSchema: currentSubscriptionSchema,
      example: envelope(currentSubscriptionExample),
    },
    errors: protectedResourceErrors,
  },
  getBillingCredits: {
    operationId: 'partnerGetCredits',
    method: 'get',
    path: '/partner/v1/billing/credits',
    tag: 'Billing',
    summary: 'Get credit balances',
    description: 'Returns current product credit pools for the resolved billing subject.',
    request: { query: partnerCreditQuerySchema },
    success: {
      status: 200,
      description: 'Credit balances.',
      dataSchema: creditsSchema,
      example: envelope(creditsExample),
    },
    errors: protectedResourceErrors,
  },
  getBillingCreditsSummary: {
    operationId: 'partnerGetCreditsSummary',
    method: 'get',
    path: '/partner/v1/billing/credits-summary',
    tag: 'Billing',
    summary: 'Get subscription and credit summary',
    description: 'Returns subscription and credit data together. Credit fields are also mirrored at data top level for compatibility.',
    request: { query: partnerUserScopeSchema },
    success: {
      status: 200,
      description: 'Subscription and credit summary.',
      dataSchema: creditsSummaryDataSchema,
      example: envelope({
        productId: 'prod-123',
        productSlug: 'example-product',
        userId: 'user-123',
        tenantId: 'tenant-123',
        subscription: currentSubscriptionExample,
        credits: creditsExample,
        ...creditsExample,
      }),
    },
    errors: protectedResourceErrors,
  },
  getBillingCreditTransactions: {
    operationId: 'partnerListCreditTransactions',
    method: 'get',
    path: '/partner/v1/billing/credit-transactions',
    tag: 'Billing',
    summary: 'List credit transactions',
    description:
      'Returns paginated credit ledger entries in the token-derived product scope. '
      + 'For a team subject, the ledger covers the team rather than filtering to the query user. '
      + 'Response userId is the actual actor mapped through the current product namespace, or null when no safe external mapping exists.',
    request: { query: partnerCreditTransactionsQuerySchema },
    success: {
      status: 200,
      description: 'Paginated credit transactions.',
      dataSchema: pagination(creditTransactionSchema),
      example: envelope({
        items: [{
          id: 'credit-tx-123',
          userId: 'user-123',
          tenantId: 'tenant-123',
          productId: 'prod-123',
          subscriptionId: 'subscription-123',
          type: 'CONSUME',
          creditsAmount: -150,
          source: 'chat:gpt-4.1',
          quotaAfter: 80000,
          bonusAfter: 10000,
          balanceAfter: 90000,
          totalTokens: 1200,
          requestId: 'request-123',
          createdAt: '2026-07-23T08:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    },
    errors: protectedResourceErrors,
  },
  getBillingTransactions: {
    operationId: 'partnerListBalanceTransactions',
    method: 'get',
    path: '/partner/v1/billing/transactions',
    tag: 'Billing',
    summary: 'List balance transactions',
    description:
      'Returns paginated money/balance ledger entries in the token-derived product scope. '
      + 'For a team subject, the ledger covers the team rather than filtering to the query user. '
      + 'Response userId is the actual actor mapped through the current product namespace, or null when no safe external mapping exists.',
    request: { query: partnerTransactionsQuerySchema },
    success: {
      status: 200,
      description: 'Paginated balance transactions.',
      dataSchema: pagination(balanceTransactionSchema),
      example: envelope({
        items: [{
          id: 'balance-tx-123',
          userId: 'user-123',
          tenantId: 'tenant-123',
          productId: 'prod-123',
          type: 'RECHARGE',
          amountCents: 5000,
          balanceAfterCents: 10000,
          amountUsd: 50,
          balanceAfterUsd: 100,
          description: 'Stripe recharge',
          createdAt: '2026-07-23T08:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    },
    errors: protectedResourceErrors,
  },
  getBillingDailySummary: {
    operationId: 'partnerGetDailyBillingSummary',
    method: 'get',
    path: '/partner/v1/billing/daily-summary',
    tag: 'Billing',
    summary: 'Get daily billing summary',
    description:
      'Returns daily balance, credit, and token consumption using UTC calendar-day boundaries. '
      + 'The range is inclusive: startDate begins at 00:00:00Z and endDate ends immediately before the next 00:00:00Z.',
    request: { query: partnerDailySummaryQuerySchema },
    success: {
      status: 200,
      description: 'Daily billing summary.',
      dataSchema: z.array(dailySummarySchema),
      example: envelope([{
        date: '2026-07-23',
        balanceConsumptionCents: 25,
        creditConsumption: 150,
        tokenCount: 1200,
      }]),
    },
    errors: protectedResourceErrors,
  },
  getBillingMonthlySummary: {
    operationId: 'partnerGetMonthlyBillingSummary',
    method: 'get',
    path: '/partner/v1/billing/monthly-summary',
    tag: 'Billing',
    summary: 'Get monthly billing summary',
    description:
      'Returns monthly balance and credit totals for one UTC calendar year; month buckets change at 00:00:00Z on the first day of each month.',
    request: { query: partnerMonthlySummaryQuerySchema },
    success: {
      status: 200,
      description: 'Monthly billing summary.',
      dataSchema: z.array(monthlySummarySchema),
      example: envelope([{
        month: '2026-07',
        balanceConsumeCents: 2500,
        balanceRechargeCents: 5000,
        creditConsume: 15000,
        creditGrant: 100000,
        creditBonus: 10000,
      }]),
    },
    errors: protectedResourceErrors,
  },
  createPaymentOrder: {
    operationId: 'partnerCreatePaymentOrder',
    method: 'post',
    path: '/partner/v1/payment/create',
    tag: 'Payment',
    summary: 'Create a payment order',
    description:
      'Creates a product-scoped order and returns the provider payment URL when applicable. '
      + 'tenantId is required for every product because purchase eligibility is verified against external tenant membership.',
    request: {
      body: {
        schema: partnerCreateOrderSchema,
        required: true,
        description:
          'Order creation input. Product identity is always derived from the integration token. '
          + 'tenantId is always required for user-api purchase-eligibility verification.',
        example: {
          userId: 'user-123',
          tenantId: 'tenant-123',
          orderType: 'SUBSCRIPTION',
          planId: 'plan-pro',
          channel: 'ALIPAY',
          billingPeriod: 'monthly',
          currency: 'usd',
          idempotencyKey: 'saas-order-10001',
          successUrl: 'https://app.saas.example/billing/success',
        },
      },
    },
    success: {
      status: 201,
      description: 'Order created.',
      dataSchema: createOrderResultSchema,
      example: envelope({
        order: orderExample,
        payUrl: 'https://openapi.alipay.com/gateway.do?example=1',
      }, '订单创建成功'),
    },
    errors: writeErrors,
  },
  getPaymentOrders: {
    operationId: 'partnerListPaymentOrders',
    method: 'get',
    path: '/partner/v1/payment/orders',
    tag: 'Payment',
    summary: 'List payment orders',
    description: 'Returns paginated orders for the resolved subject and token-derived product.',
    request: { query: partnerOrdersQuerySchema },
    success: {
      status: 200,
      description: 'Paginated payment orders.',
      dataSchema: pagination(orderSchema),
      example: envelope({
        items: [orderExample],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    },
    errors: protectedResourceErrors,
  },
  getPaymentOrderStatus: {
    operationId: 'partnerGetPaymentOrderStatus',
    method: 'get',
    path: '/partner/v1/payment/orders/{id}/status',
    tag: 'Payment',
    summary: 'Get payment order status',
    description: 'Returns a compact order status view suitable for payment polling.',
    request: { params: partnerOrderIdParamsSchema, query: partnerUserScopeSchema },
    success: {
      status: 200,
      description: 'Current order status.',
      dataSchema: orderStatusResultSchema,
      example: envelope({ status: 'PENDING', paidAt: null, cancelReason: null }),
    },
    errors: protectedResourceErrors,
  },
  getPaymentOrder: {
    operationId: 'partnerGetPaymentOrder',
    method: 'get',
    path: '/partner/v1/payment/orders/{id}',
    tag: 'Payment',
    summary: 'Get a payment order',
    description: 'Returns full order details in the resolved subject and product scope.',
    request: { params: partnerOrderIdParamsSchema, query: partnerUserScopeSchema },
    success: {
      status: 200,
      description: 'Payment order details.',
      dataSchema: orderSchema,
      example: envelope({ ...orderExample, status: 'COMPLETED', paidAt: '2026-07-23T08:05:00.000Z' }),
    },
    errors: protectedResourceErrors,
  },
  getPaymentMethods: {
    operationId: 'partnerListPaymentMethods',
    method: 'get',
    path: '/partner/v1/payment/methods',
    tag: 'Payment',
    summary: 'List available payment methods',
    description: 'Returns configured methods for the token-derived product, order type, and platform currency.',
    request: { query: partnerPaymentMethodsQuerySchema },
    success: {
      status: 200,
      description: 'Available payment methods.',
      dataSchema: paymentMethodsSchema,
      example: envelope({
        methods: [{ channel: 'STRIPE', label: '银行卡', currency: 'usd', mode: 'redirect' }],
      }),
    },
    errors: commonErrors,
  },
  provision: {
    operationId: 'partnerProvisionTenant',
    method: 'post',
    path: '/partner/v1/tenants/provision',
    tag: 'Provisioning',
    summary: 'Provision a product tenant',
    description:
      'Mirrors the external subject, establishes product entitlement state, and creates or reuses a virtual API key. '
      + 'The idempotency key is scoped to the token-derived product; exact replays return the durable receipt, '
      + 'while a different normalized request with the same key returns HTTP 409. tenant.id is required except '
      + 'for a self-operated CODING_PLAN product whose subject is explicitly per-user. PAY_AS_YOU_GO and '
      + 'provider_resale CODING_PLAN never create a free entitlement through this operation; unknown Coding '
      + 'fulfillment modes fail closed.',
    request: {
      body: {
        schema: partnerProvisionRequestSchema,
        required: true,
        description: 'Provisioning snapshot. Product identity is derived exclusively from the integration token.',
        example: {
          idempotencyKey: 'provision:tenant-10001',
          user: {
            id: 'user-123',
            email: 'alice@example.com',
            nickname: 'Alice',
            sourceUpdatedAt: '2026-07-23T08:00:00.000Z',
          },
          tenant: {
            id: 'tenant-123',
            name: 'Alice Team',
            type: 'personal',
          },
          ensureFreePlan: true,
          key: {
            allowedModels: ['gpt-4.1'],
            budgetCents: 100000,
            rotate: false,
          },
        },
      },
    },
    success: {
      status: 201,
      description:
        'Tenant provisioned. A newly generated secret is recoverable on exact replays for at most 15 minutes.',
      dataSchema: provisionResultSchema,
      example: envelope({
        userId: 'user-123',
        tenantId: 'tenant-123',
        productId: 'prod-123',
        productSlug: 'example-product',
        apiKey: {
          id: 'key-123',
          prefix: 'rk-12345678',
          plainKey: 'rk-full-key-returned-once',
          created: true,
          rotated: false,
        },
        subscription: {
          id: 'subscription-123',
          planId: 'plan-pro',
          created: true,
        },
      }),
    },
    errors: writeErrors,
  },
} satisfies Record<string, PartnerOperationContract>;

export type PartnerOperationKey = keyof typeof PARTNER_API_OPERATIONS;
export const PARTNER_API_OPERATION_COUNT = Object.keys(PARTNER_API_OPERATIONS).length;
const partnerSuccessResponseSchemas =
  new Map<PartnerOperationKey, ZodTypeAny>();

function responseSchemaName(operationKey: string): string {
  return `Partner${operationKey[0].toUpperCase()}${operationKey.slice(1)}Response`;
}

for (const [operationKey, operation] of Object.entries(PARTNER_API_OPERATIONS) as Array<
  [string, PartnerOperationContract]
>) {
  const successSchema = registry.register(
    responseSchemaName(operationKey),
    z.object({
      code: z.number().int().openapi({ example: 0 }),
      message: z.string().openapi({ example: 'ok' }),
      data: operation.success.dataSchema,
    }).strict(),
  );
  partnerSuccessResponseSchemas.set(
    operationKey as PartnerOperationKey,
    successSchema,
  );
  const successExample = successSchema.safeParse(operation.success.example);
  if (!successExample.success) {
    throw new Error(
      `Invalid Partner success example for ${operationKey}: ${successExample.error.message}`,
    );
  }
  if (operation.request?.body) {
    const requestExample = operation.request.body.schema.safeParse(
      operation.request.body.example,
    );
    if (!requestExample.success) {
      throw new Error(
        `Invalid Partner request example for ${operationKey}: ${requestExample.error.message}`,
      );
    }
  }
  const responses: RouteConfig['responses'] = {
    [operation.success.status]: {
      description: operation.success.description,
      headers: partnerTransportHeaders,
      content: {
        'application/json': {
          schema: successSchema,
          examples: {
            success: { value: operation.success.example },
          },
        },
      },
    },
  };
  for (const status of operation.errors) {
    responses[status] = errorResponseRefs[status].ref;
  }

  registry.registerPath({
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.description,
    tags: [operation.tag],
    security: [
      { partnerBearer: [] },
      { productToken: [] },
      { billingProductToken: [] },
    ],
    request: operation.request
      ? {
          ...(operation.request.params ? { params: operation.request.params as never } : {}),
          ...(operation.request.query ? { query: operation.request.query as never } : {}),
          ...(operation.request.body
            ? {
                body: {
                  required: operation.request.body.required,
                  description: operation.request.body.description,
                  content: {
                    'application/json': {
                      schema: operation.request.body.schema,
                      examples: {
                        request: { value: operation.request.body.example },
                      },
                    },
                  },
                },
              }
            : {}),
        }
      : undefined,
    responses,
  });
}

export function assertPartnerSuccessResponse(
  operationKey: PartnerOperationKey,
  response: unknown,
): void {
  const schema = partnerSuccessResponseSchemas.get(operationKey);
  if (!schema) {
    throw new Error(`Missing Partner success schema for ${operationKey}`);
  }
  const serialized = JSON.stringify(response);
  if (serialized === undefined) {
    throw new Error(
      `Partner response contract violation at ${operationKey}: response is not JSON serializable`,
    );
  }
  const parsed = schema.safeParse(JSON.parse(serialized));
  if (parsed.success) return;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`)
    .join(', ');
  throw new Error(
    `Partner response contract violation at ${operationKey}: ${issues}`,
  );
}

registry.registerComponent('securitySchemes', 'partnerBearer', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'ProductIntegrationToken',
  description: 'Recommended: Authorization: Bearer <product_integration_token>.',
});
registry.registerComponent('securitySchemes', 'productToken', {
  type: 'apiKey',
  in: 'header',
  name: 'x-product-token',
  description: 'Compatibility header carrying the product integration token.',
});
registry.registerComponent('securitySchemes', 'billingProductToken', {
  type: 'apiKey',
  in: 'header',
  name: 'x-billing-product-token',
  description: 'Legacy compatibility header carrying the product integration token.',
});

export function buildPartnerOpenApiDocument(publicBaseUrl?: string | null): OpenAPIObject {
  const normalizedBaseUrl = publicBaseUrl?.trim().replace(/\/+$/, '');
  const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Codesphere Partner OpenAPI',
      description:
        'External, product-token-scoped API for catalog discovery, billing reads, payments, and SaaS provisioning.',
      version: '1.0.0',
      contact: {
        name: 'Codesphere Platform Engineering',
      },
    },
    servers: [{
      url: normalizedBaseUrl || '/',
      description: normalizedBaseUrl ? 'Configured Partner API endpoint' : 'Current Partner API origin',
    }],
    tags: [
      { name: 'Product', description: 'Token-derived product identity.' },
      { name: 'Catalog', description: 'Product-scoped catalog discovery.' },
      { name: 'Billing', description: 'Subject and product-scoped billing reads.' },
      { name: 'Payment', description: 'Product-scoped payment order lifecycle.' },
      { name: 'Provisioning', description: 'External SaaS subject provisioning.' },
    ],
  }) as unknown as OpenAPIObject;
  applyCreateOrderSemanticConstraints(document);
  return document;
}

type OpenApiDocument = ReturnType<typeof buildPartnerOpenApiDocument>;

function applyCreateOrderSemanticConstraints(document: OpenAPIObject): void {
  const requestBody = document.paths['/partner/v1/payment/create']
    ?.post?.requestBody;
  if (!requestBody || '$ref' in requestBody) {
    throw new Error('Missing concrete Partner create-order request body');
  }
  const json = requestBody.content?.['application/json'];
  if (!json?.schema) {
    throw new Error('Missing Partner create-order JSON schema');
  }

  const generatedFlatSchema = json.schema;
  const forbid = (...fields: string[]) => ({
    not: {
      anyOf: fields.map((field) => ({ required: [field] })),
    },
  });

  // Zod refinements are executable runtime rules, but OpenAPI 3.0 generators
  // cannot infer them. Preserve the generated scalar/object constraints and
  // add the same cross-field rules explicitly so generated SDKs see the exact
  // contract instead of an over-permissive flat object.
  json.schema = {
    allOf: [
      generatedFlatSchema,
      {
        description:
          'Exactly one purchase target is allowed and it must match orderType.',
        oneOf: [
          {
            title: 'Subscription order',
            properties: {
              orderType: { type: 'string', enum: ['SUBSCRIPTION'] },
            },
            required: ['planId'],
            ...forbid('boosterPackId', 'amountCents'),
          },
          {
            title: 'Booster-pack order',
            properties: {
              orderType: { type: 'string', enum: ['BOOSTER_PACK'] },
            },
            required: ['orderType', 'boosterPackId'],
            ...forbid('planId', 'amountCents', 'billingPeriod'),
          },
          {
            title: 'Recharge order',
            properties: {
              orderType: { type: 'string', enum: ['RECHARGE'] },
              amountCents: { type: 'integer', multipleOf: 100 },
            },
            required: ['orderType', 'amountCents'],
            ...forbid('planId', 'boosterPackId', 'billingPeriod'),
          },
        ],
      },
      {
        description:
          'Browser callback fields are restricted by payment channel.',
        oneOf: [
          {
            title: 'WeChat payment',
            properties: {
              channel: { type: 'string', enum: ['WECHAT'] },
            },
            required: ['channel'],
            ...forbid('successUrl', 'cancelUrl'),
          },
          {
            title: 'Alipay payment',
            properties: {
              channel: { type: 'string', enum: ['ALIPAY'] },
            },
            required: ['channel'],
            ...forbid('cancelUrl'),
          },
          {
            title: 'Stripe payment',
            properties: {
              channel: { type: 'string', enum: ['STRIPE'] },
            },
            required: ['channel'],
          },
        ],
      },
    ],
  };
}

function resolveResponse(
  document: OpenApiDocument,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const ref = response.$ref;
  if (typeof ref !== 'string') return response;
  const name = ref.split('/').pop();
  const resolved = name ? document.components?.responses?.[name] : undefined;
  if (!resolved || '$ref' in resolved) {
    throw new Error(`Unresolvable OpenAPI response reference: ${ref}`);
  }
  return resolved as unknown as Record<string, unknown>;
}

function hasJsonSchemaAndExample(response: Record<string, unknown>): boolean {
  const content = response.content as Record<string, { schema?: unknown; example?: unknown; examples?: unknown }> | undefined;
  const json = content?.['application/json'];
  return Boolean(json?.schema && (json.example !== undefined || json.examples));
}

function hasPartnerTransportHeaders(response: Record<string, unknown>): boolean {
  const headers = response.headers as Record<string, unknown> | undefined;
  return Boolean(headers?.['Cache-Control'] && headers.Vary);
}

const partnerDictionarySchemaPaths = new Set([
  'PartnerChannel.models',
]);

function assertClosedPartnerObjectSchemas(document: OpenApiDocument): void {
  const openObjects: string[] = [];
  const visit = (
    value: unknown,
    path: string,
    insideDictionary = false,
  ): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const schema = value as Record<string, unknown>;
    if (typeof schema.$ref === 'string') return;

    const dictionary = insideDictionary || partnerDictionarySchemaPaths.has(path);
    if (schema.type === 'object') {
      if (!dictionary && schema.additionalProperties !== false) {
        openObjects.push(path);
      }
      if (dictionary && schema.additionalProperties === undefined) {
        openObjects.push(`${path} (dictionary is not explicit)`);
      }
      const properties = schema.properties as Record<string, unknown> | undefined;
      for (const [name, property] of Object.entries(properties ?? {})) {
        visit(property, `${path}.${name}`, dictionary);
      }
      if (
        schema.additionalProperties
        && typeof schema.additionalProperties === 'object'
      ) {
        visit(schema.additionalProperties, `${path}.*`, dictionary);
      }
    }

    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const alternatives = schema[keyword];
      if (Array.isArray(alternatives)) {
        alternatives.forEach((alternative, index) => {
          visit(alternative, `${path}.${keyword}[${index}]`, dictionary);
        });
      }
    }
    if (schema.items) visit(schema.items, `${path}[]`, dictionary);
  };

  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    visit(schema, name);
  }
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ['get', 'post'] as const) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const requestBody = operation.requestBody;
      if (requestBody && !('$ref' in requestBody)) {
        visit(
          requestBody.content?.['application/json']?.schema,
          `${method.toUpperCase()} ${path} request`,
        );
      }
    }
  }
  if (openObjects.length > 0) {
    throw new Error(
      `Public object schemas must set additionalProperties=false: ${openObjects.join(', ')}`,
    );
  }
}

export function assertPartnerOpenApiDocument(document: OpenApiDocument): void {
  const seenOperationIds = new Set<string>();
  let operationCount = 0;

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ['get', 'post'] as const) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      operationCount += 1;
      if (!operation.operationId || seenOperationIds.has(operation.operationId)) {
        throw new Error(`Missing or duplicate operationId at ${method.toUpperCase()} ${path}`);
      }
      seenOperationIds.add(operation.operationId);
      if (!operation.summary || !operation.description) {
        throw new Error(`Missing summary/description at ${method.toUpperCase()} ${path}`);
      }
      if (!operation.security || operation.security.length !== 3) {
        throw new Error(`Incomplete authentication alternatives at ${method.toUpperCase()} ${path}`);
      }

      const successCode = method === 'post' ? '201' : '200';
      const success = operation.responses[successCode];
      if (
        !success
        || '$ref' in success
        || !hasJsonSchemaAndExample(success as unknown as Record<string, unknown>)
        || !hasPartnerTransportHeaders(success as unknown as Record<string, unknown>)
      ) {
        throw new Error(`Incomplete success response at ${method.toUpperCase()} ${path}`);
      }
      const errorEntries = Object.entries(operation.responses)
        .filter(([status]) => Number(status) >= 400);
      if (errorEntries.length === 0) {
        throw new Error(`Missing error responses at ${method.toUpperCase()} ${path}`);
      }
      for (const [status, response] of errorEntries) {
        const resolved = resolveResponse(
          document,
          response as unknown as Record<string, unknown>,
        );
        if (!hasJsonSchemaAndExample(resolved) || !hasPartnerTransportHeaders(resolved)) {
          throw new Error(`Incomplete ${status} response at ${method.toUpperCase()} ${path}`);
        }
      }
      if (!operation.responses[503]) {
        throw new Error(
          `Missing fail-closed rate-limit backend response at ${method.toUpperCase()} ${path}`,
        );
      }
      for (const transportStatus of [413, 415] as const) {
        if (!operation.responses[transportStatus]) {
          throw new Error(
            `Missing Fastify transport response ${transportStatus} at ${method.toUpperCase()} ${path}`,
          );
        }
      }
      if (method === 'post' && !operation.requestBody) {
        throw new Error(`Missing request body at ${method.toUpperCase()} ${path}`);
      }
      if (method === 'post' && operation.requestBody) {
        if ('$ref' in operation.requestBody) {
          throw new Error(`Unresolved request body at ${method.toUpperCase()} ${path}`);
        }
        const requestContent = operation.requestBody.content?.['application/json'];
        if (
          !requestContent?.schema
          || (requestContent.example === undefined && !requestContent.examples)
        ) {
          throw new Error(`Incomplete request body at ${method.toUpperCase()} ${path}`);
        }
      }
    }
  }

  if (operationCount !== PARTNER_API_OPERATION_COUNT) {
    throw new Error(
      `Expected ${PARTNER_API_OPERATION_COUNT} Partner operations, found ${operationCount}`,
    );
  }
  for (const scheme of ['partnerBearer', 'productToken', 'billingProductToken']) {
    if (!document.components?.securitySchemes?.[scheme]) {
      throw new Error(`Missing security scheme: ${scheme}`);
    }
  }
  assertClosedPartnerObjectSchemas(document);
}

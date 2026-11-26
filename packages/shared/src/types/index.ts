// ============================
// 枚举
// ============================

export * from './deployment-config';

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FULFILLING = 'FULFILLING',
  PARTIALLY_FULFILLED_REQUIRES_COMPENSATION = 'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
  REFUNDING = 'REFUNDING',
  REFUNDED = 'REFUNDED',
  REFUND_FAILED = 'REFUND_FAILED',
  REFUND_COMPENSATION_FAILED = 'REFUND_COMPENSATION_FAILED',
}

export enum PaymentChannel {
  WECHAT = 'WECHAT',
  ALIPAY = 'ALIPAY',
  STRIPE = 'STRIPE',
  BALANCE = 'BALANCE',
}

export enum TransactionType {
  RECHARGE = 'RECHARGE',
  CONSUME = 'CONSUME',
  ADJUST = 'ADJUST',
  REFUND = 'REFUND',
}

export enum OrderType {
  SUBSCRIPTION = 'SUBSCRIPTION',
  BOOSTER_PACK = 'BOOSTER_PACK',
  RECHARGE = 'RECHARGE',
  BUNDLE = 'BUNDLE',
}

export enum BundleItemBillingType {
  SUBSCRIPTION = 'SUBSCRIPTION',
  ONE_TIME = 'ONE_TIME',
}

export enum OrderItemStatus {
  PENDING = 'PENDING',
  FULFILLED = 'FULFILLED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export type BillingPeriod = 'monthly' | 'quarterly' | 'yearly';

export enum CreditTxType {
  QUOTA_GRANT = 'QUOTA_GRANT',
  QUOTA_RESET = 'QUOTA_RESET',
  BONUS_PURCHASE = 'BONUS_PURCHASE',
  CONSUME = 'CONSUME',
  REFUND = 'REFUND',
  GRANT = 'GRANT',
  EXPIRE = 'EXPIRE',
}

// ============================
// 实体类型
// ============================

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  webhookUrl?: string | null;
  allowedPaymentCallbackOrigins?: string[] | null;
  defaultPlanId?: string | null;
  billingMode?: 'SUBSCRIPTION' | 'PAY_AS_YOU_GO' | 'CODING_PLAN';
  integrationTokenPrefix?: string | null;
  integrationTokenRotatedAt?: string | null;
  webhookSecretPrefix?: string | null;
  webhookSecretRotatedAt?: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type PaymentCallbackMode = 'GLOBAL_FALLBACK' | 'DENY_ALL' | 'PRODUCT_ALLOWLIST';

export interface ProductPaymentCallbacks {
  mode: PaymentCallbackMode;
  configuredOrigins: string[] | null;
  effectiveOrigins: string[];
}

export interface BoosterPack {
  id: string;
  productId: string | null;
  name: string;
  description: string;
  creditsAmount: number;
  priceCents: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface BundleSkuItem {
  id: string;
  bundleSkuId: string;
  productId: string;
  planId: string | null;
  boosterPackId: string | null;
  billingType: BundleItemBillingType;
  name: string;
  unitAmountCents: number;
  originalUnitAmountCents: number | null;
  quantity: number;
  recurringInterval: 'month' | 'year' | null;
  validityDays: number | null;
  sortOrder: number;
  product?: Pick<Product, 'id' | 'name' | 'slug'> | null;
  plan?: Pick<Plan, 'id' | 'name' | 'monthlyCredits' | 'validityDays'> | null;
  boosterPack?: Pick<BoosterPack, 'id' | 'name' | 'creditsAmount'> | null;
}

export interface BundleSku {
  id: string;
  code: string;
  name: string;
  description: string;
  currency: string;
  billingPeriod: BillingPeriod;
  amountCents: number;
  originalAmountCents: number | null;
  startAt: string | null;
  endAt: string | null;
  maxUsesPerUser: number;
  maxUsesTotal: number;
  isActive: boolean;
  sortOrder: number;
  usedCount?: number;
  revenueCents?: number;
  createdAt: string;
  updatedAt: string;
  items: BundleSkuItem[];
}

export interface CreditTransaction {
  id: string;
  userId: string;
  tenantId?: string | null;
  productId?: string | null;
  subscriptionId?: string | null;
  type: CreditTxType;
  creditsAmount: number;
  source: string;
  quotaAfter: number;
  bonusAfter: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requestId?: string;
  createdAt: string;
}

export interface CreditsSummaryV2 {
  quotaCredits: number;       // 套餐月度积分余量
  bonusCredits: number;       // 加油包积分余量
  grantCredits?: number;      // 用户级奖励积分余量
  totalCredits: number;       // 合计
  usedThisMonth: number;      // 本月消耗
  usedThisCycle?: number;     // 当前订阅周期消耗
  billingCycleStart?: string | null;
}

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  nickname: string;
  avatar: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 套餐配额模板规则视图（自营 CodingPlan 专用，解析自 PlanQuotaTemplate.rules 并合并去重）。
 * enforced=true 表示按当前 publisher 口径会真实下发网关执行；用户端只渲染 enforced 规则。
 */
export interface PlanQuotaRuleView {
  metric: 'REQUESTS' | 'INPUT_TOKENS' | 'OUTPUT_TOKENS' | 'TOTAL_TOKENS' | 'CREDITS';
  windowType: 'ROLLING' | 'FIXED_PERIOD' | 'CUMULATIVE';
  durationSec: number;
  durationLabel: string;
  limitValue: number;
  enforced: boolean;
}

export interface Plan {
  id: string;
  productId: string | null;
  name: string;
  description: string;

  // 类型与计费
  planType: string;          // individual / team / enterprise
  monthlyPrice: number;      // USD cents
  quarterlyPrice: number;    // USD cents, quarterly monthly-equivalent price
  yearlyPrice: number;       // USD cents, yearly monthly-equivalent price
  billingPeriod: string;     // monthly / yearly / quarterly

  // 用量配额
  monthlyCredits: number;
  creditsRollover: boolean;
  rolloverMaxMonths: number;

  // 速率限制（自营 CodingPlan 已弃用三散字段：保存归 0，展示走 quotaRules；
  // 转售/通用套餐继续使用，字段保留兼容老客户端）
  rateLimitRpm: number;
  rateLimitTpm: number;
  maxContextWindow: number;

  // 配额模板规则（仅自营 CodingPlan 套餐返回；其余套餐不附带）
  quotaRules?: PlanQuotaRuleView[];

  // 超额策略
  overageEnabled: boolean;
  usageMultiplier: number;

  // 模型访问（已迁移至 model_access 表，此字段废弃）
  availableModels?: string[];

  // 团队
  memberLimit: number;
  minimumSeats: number;

  // 安全与合规
  dataTraining: string;      // opt_in / opt_out / never
  supportTier: string;       // community / standard / priority / dedicated
  ssoEnabled: boolean;
  priorityAccess: boolean;

  // 展示
  badge: string | null;
  trialDays: number;
  validityDays: number;
  features: string[];
  isActive: boolean;
  isLegacy: boolean;
  salesLimit?: number;
  reservedSalesCount?: number;
  remainingSales?: number | null;
  soldOut?: boolean;
  sortOrder: number;

  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  userId: string;
  tenantId?: string | null;
  orderType: OrderType;
  bundleSkuId?: string | null;
  productId?: string | null;
  planId: string | null;
  boosterPackId: string | null;
  amountCents: number;
  rechargeTierId?: string | null;
  bonusCents?: number;
  totalGrantedCents?: number;
  billingPeriod?: BillingPeriod | null;
  prorationCreditCents?: number | null;
  status: OrderStatus;
  channel: PaymentChannel | null;
  tradeNo: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  userId: string;
  tenantId?: string | null;
  productId?: string | null;
  codingPlanEntitlementId?: string | null;
  productName?: string | null;
  name: string;
  prefix: string;
  isActive: boolean;
  allowedModels: string[] | null;
  budgetCents: number | null;
  usageCents: number;
  budgetUsd?: number | null;
  usageUsd?: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BalanceTransaction {
  id: string;
  userId: string;
  tenantId?: string | null;
  productId?: string | null;
  productName?: string | null;
  type: TransactionType;
  amountCents: number;
  balanceAfterCents: number;
  amountUsd?: number;
  balanceAfterUsd?: number;
  tokenUsageId?: string;
  description: string;
  createdAt: string;
}

export type CreditDetailStatus = 'ACTIVE' | 'USED_UP' | 'EXPIRED';

export interface CreditDetailItem {
  id: string;
  grantId: string;
  orderId: string | null;
  productId: string | null;
  source: string;
  amountCents: number;
  remainingCents: number;
  status: CreditDetailStatus;
  validFrom: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface VoucherDetailItem {
  id: string;
  grantId: string;
  orderId: string | null;
  productId: string | null;
  source: string;
  amountCents: number;
  remainingCents: number;
  status: CreditDetailStatus;
  validFrom: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreditDetailsResult {
  credits: PaginatedResult<CreditDetailItem>;
  vouchers: PaginatedResult<VoucherDetailItem>;
}

// ============================
// Chat Studio
// ============================

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ChatMessage[];
}

// ============================
// 支付响应类型
// ============================

export interface CreateOrderResponse {
  order: Order;
  payUrl: string | null;
}

export type PaymentMethodChannel = 'WECHAT' | 'ALIPAY' | 'STRIPE';

export interface AvailablePaymentMethod {
  channel: PaymentMethodChannel;
  label: string;
  currency: string;
  mode: 'qr' | 'redirect';
}

export interface PaymentMethodsResponse {
  methods: AvailablePaymentMethod[];
}

// ============================
// 成员管理
// ============================

export enum MemberRole {
  OWNER = 'owner',
  MEMBER = 'member',
}

export enum MemberStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  email: string;
  nickname: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: string;
  lastActiveAt: string | null;
}

export interface InviteMemberInput {
  email: string;
  role: MemberRole;
  displayName?: string;
}

// ============================
// 用量统计（扩展）
// ============================

export interface UsageOverview {
  totalTokens: number;
  totalCostCents: number;
  totalCostUsd?: number;
  totalRequests: number;
  monthlyCredits: number;
  memberCount: number;
  memberLimit: number;
  dailyUsage: { date: string; tokens: number; cost: number }[];
  modelUsage: { model: string; tokens: number }[];
}

// ============================
// 订阅信息
// ============================

export interface SubscriptionInfo {
  currentPlan: {
    id: string;
    name: string;
    monthlyPrice: number;
    status: string;
    billingCycleStart: string | null;
  } | null;
  plans: PlanDetail[];
}

export interface PlanDetail {
  id: string;
  name: string;
  description: string;
  monthlyPrice: number;
  quarterlyPrice: number;
  yearlyPrice: number;
  monthlyCredits: number;
  memberLimit: number;
  features: string[];
  isActive: boolean;
}

// ============================
// 额度汇总
// ============================

export interface CreditsSummary {
  subject: {
    tenantId: string;
    billingAccountId: string;
    accountType: string;
    accountName: string;
    canRecharge: boolean;
  };
  balanceCents: number;
  usedThisMonthCents: number;
  totalGrantedCents: number;
  balanceUsd?: number;
  balanceAmount?: string;
  accountBalanceCents?: number;
  accountBalanceUsd?: number;
  accountBalanceAmount?: string;
  accountAvailableBalanceCents?: number;
  accountAvailableBalanceUsd?: number;
  accountAvailableBalanceAmount?: string;
  billingAccountType?: string;
  creditLimitCents?: number;
  creditLimitUsd?: number;
  creditLimitAmount?: string;
  creditUsedCents?: number;
  creditUsedUsd?: number;
  creditUsedAmount?: string;
  creditRemainingCents?: number;
  creditRemainingUsd?: number;
  creditRemainingAmount?: string;
  creditStatus?: string | null;
  creditTermsDays?: number | null;
  creditEffectiveAt?: string | null;
  creditExpiresAt?: string | null;
  /** Workspace budget cap; null means unlimited. */
  allowanceCents?: number | null;
  allowanceUsd?: number | null;
  allowanceUsedCents?: number;
  allowanceUsedUsd?: number;
  allowanceRemainingCents?: number | null;
  allowanceRemainingUsd?: number | null;
  /** Frozen, still-unsettled enterprise receivable that remains inside approved credit terms. */
  approvedReceivableOutstandingCents?: number;
  approvedReceivableOutstandingUsd?: number;
  approvedReceivableOutstandingAmount?: string;
  /** Frozen, still-unsettled enterprise overage that never received credit terms. */
  unapprovedDebtOutstandingCents?: number;
  unapprovedDebtOutstandingUsd?: number;
  unapprovedDebtOutstandingAmount?: string;
  /** False means legacy open allocations exist whose funding class cannot be proven. */
  enterpriseFundingClassificationComplete?: boolean;
  /** Requests whose usage evidence is not yet authoritative. Excluded from settled usage. */
  pendingUsageCount?: number;
  /** Funds reserved while usage evidence is pending. This is not a settled charge. */
  pendingHoldCents?: number;
  pendingHoldUsd?: number;
  pendingHoldAmount?: string;
  /** Unreserved financial exposure awaiting evidence review. This is not a settled charge. */
  pendingExposureCents?: number;
  pendingExposureUsd?: number;
  pendingExposureAmount?: string;
  /** Authoritative usage recorded as an account receivable instead of a customer deduction. */
  openDebtCents?: number;
  openDebtUsd?: number;
  openDebtAmount?: string;
  /** Public account-level admission state. */
  accessStatus?: string | null;
  /** Public-safe outcome only; internal evidence and finance reasons never leave Billing Admin. */
  creditPolicy?: {
    status?: string | null;
    action?: string | null;
    reason?: string | null;
  } | null;
  usedThisMonthUsd?: number;
  usedThisMonthAmount?: string;
  totalGrantedUsd?: number;
  totalGrantedAmount?: string;
  totalRechargeCents?: number;
  totalRechargeUsd?: number;
  totalRechargeAmount?: string;
  totalBonusGrantedCents?: number;
  totalBonusGrantedUsd?: number;
  totalBonusGrantedAmount?: string;
  currency?: string;
  currencyCode?: string;
  currencySymbol?: string;
}

// ============================
// 管理端权限
// ============================

export type AdminPageKey =
  | 'dashboard'
  | 'funnel'
  | 'users'
  | 'enterprise_accounts'
  | 'user_segments'
  | 'tickets'
  | 'risk_users'
  | 'risk_rules'
  | 'products'
  | 'subscription_plans'
  | 'subscription_booster_packs'
  | 'subscription_accounts'
  | 'payg_pricing'
  | 'usage_pricing_policies'
  | 'recharge_tiers'
  | 'credit_policy'
  | 'payg_accounts'
  | 'coding_self_managed_plans'
  | 'coding_quota_templates'
  | 'coding_third_party_plans'
  | 'coding_resale_config'
  | 'coding_resale_report'
  | 'bundles'
  | 'campaigns'
  | 'discount_codes'
  | 'grant_rules'
  | 'referrals'
  | 'announcements'
  | 'models'
  | 'provider_cost_policies'
  | 'channels'
  | 'delivery_settings'
  | 'publisher_sync_jobs'
  | 'finance_overview'
  | 'orders'
  | 'invoices'
  | 'finance_reports'
  | 'finance_reconciliation'
  | 'finance_export_jobs'
  | 'monitoring'
  | 'gateway_billing_events'
  | 'historical_platform_losses'
  | 'alerts'
  | 'agent_observability'
  | 'roles'
  | 'members'
  | 'audit_logs'
  | 'feature_flags'
  | 'system_prompts'
  | 'payment_config'
  | 'system_config'
  | 'api_keys'
  | 'usage'
  | 'revenue'
  | 'sessions'
  | 'model_access';

export type AdminPagePermissionAtom = `admin.page.${AdminPageKey}.${string}`;

export type AdminPermissionAtom =
  | 'admin.dashboard'
  | 'admin.users.view'
  | 'admin.users.manage'
  | 'admin.enterprise_accounts.review'
  | 'admin.orders.view'
  | 'admin.orders.manage'
  | 'admin.transactions.view'
  | 'admin.revenue.view'
  | 'admin.plans.view'
  | 'admin.plans.manage'
  | 'admin.channels.view'
  | 'admin.channels.manage'
  | 'admin.promo.manage'
  | 'admin.monitoring.view'
  | 'admin.announcements.manage'
  | 'admin.audit.view'
  | 'admin.audit.manage'
  | 'admin.system.manage'
  | 'admin.members.manage'
  | 'admin.tickets.view'
  | 'admin.tickets.manage'
  | AdminPagePermissionAtom
  | 'admin.data.revenue.view'
  | 'admin.data.finance_reports.view'
  | 'admin.data.finance_reports.export'
  | 'admin.data.coding_plan.view'
  | 'admin.data.coding_plan.manage'
  | 'admin.data.delivery_routes.manage'
  | 'admin.data.channels.manage'
  | 'admin.data.model_access.manage'
  | 'admin.catalog.products.view'
  | 'admin.catalog.user_segments.view'
  | 'admin.catalog.plans.view'
  | 'admin.catalog.booster_packs.view'
  | 'admin.catalog.channels.view'
  | 'admin.catalog.models.view';

export type AdminPresetRole = 'super_admin' | 'admin' | 'operator' | 'finance' | 'viewer';

// ============================
// 管理端权限解析
// ============================

export const ADMIN_PRESET_ROLE_PERMISSIONS: Record<AdminPresetRole, AdminPermissionAtom[]> = {
  super_admin: [
    'admin.dashboard', 'admin.users.view', 'admin.users.manage',
    'admin.enterprise_accounts.review',
    'admin.orders.view', 'admin.orders.manage', 'admin.transactions.view', 'admin.revenue.view',
    'admin.plans.view', 'admin.plans.manage', 'admin.channels.view',
    'admin.channels.manage', 'admin.promo.manage', 'admin.monitoring.view',
    'admin.announcements.manage', 'admin.audit.view', 'admin.audit.manage',
    'admin.system.manage', 'admin.members.manage',
    'admin.tickets.view', 'admin.tickets.manage',
    'admin.page.gateway_billing_events.retry',
    'admin.page.gateway_billing_events.review',
    'admin.page.gateway_billing_events.settle',
    'admin.page.gateway_billing_events.absorb',
    'admin.page.historical_platform_losses.view',
    'admin.page.historical_platform_losses.export',
    'admin.page.historical_platform_losses.prepare',
    'admin.page.historical_platform_losses.approve_post',
  ],
  admin: [
    'admin.dashboard', 'admin.users.view', 'admin.users.manage',
    'admin.enterprise_accounts.review',
    'admin.orders.view', 'admin.orders.manage', 'admin.transactions.view', 'admin.revenue.view',
    'admin.plans.view', 'admin.plans.manage', 'admin.channels.view',
    'admin.channels.manage', 'admin.promo.manage', 'admin.monitoring.view',
    'admin.announcements.manage', 'admin.audit.view', 'admin.audit.manage',
    'admin.system.manage',
    'admin.tickets.view', 'admin.tickets.manage',
    'admin.page.gateway_billing_events.retry',
  ],
  operator: [
    'admin.dashboard', 'admin.users.view', 'admin.users.manage',
    'admin.enterprise_accounts.review',
    'admin.orders.view', 'admin.orders.manage', 'admin.channels.view', 'admin.channels.manage',
    'admin.promo.manage', 'admin.monitoring.view', 'admin.announcements.manage',
    'admin.audit.view',
    'admin.tickets.view', 'admin.tickets.manage',
    'admin.page.gateway_billing_events.retry',
  ],
  finance: [
    'admin.dashboard', 'admin.users.view', 'admin.orders.view',
    'admin.transactions.view', 'admin.revenue.view', 'admin.plans.view',
    'admin.tickets.view',
    'admin.page.gateway_billing_events.review',
    'admin.page.gateway_billing_events.settle',
    'admin.page.gateway_billing_events.absorb',
    'admin.page.historical_platform_losses.view',
    'admin.page.historical_platform_losses.export',
    'admin.page.historical_platform_losses.prepare',
    'admin.page.historical_platform_losses.approve_post',
  ],
  viewer: [
    'admin.dashboard', 'admin.users.view', 'admin.orders.view',
    'admin.transactions.view', 'admin.revenue.view', 'admin.monitoring.view',
    'admin.audit.view',
    'admin.tickets.view',
  ],
};

export const ADMIN_PERMISSION_IMPLICATIONS: Partial<
  Record<AdminPermissionAtom, AdminPermissionAtom[]>
> = {
  'admin.dashboard': ['admin.page.dashboard.view'],
  'admin.users.view': [
    'admin.page.users.view',
    'admin.page.enterprise_accounts.view',
    'admin.page.user_segments.view',
    'admin.page.payg_accounts.view',
    'admin.page.api_keys.view',
    'admin.catalog.user_segments.view',
  ],
  'admin.users.manage': [
    'admin.users.view',
    'admin.page.users.manage',
    'admin.page.enterprise_accounts.manage',
    'admin.page.user_segments.manage',
    'admin.page.payg_accounts.manage',
    'admin.page.api_keys.manage',
  ],
  'admin.enterprise_accounts.review': ['admin.page.enterprise_accounts.review'],
  'admin.tickets.view': ['admin.page.tickets.view'],
  'admin.tickets.manage': ['admin.tickets.view', 'admin.page.tickets.manage'],
  'admin.orders.view': [
    'admin.page.orders.view',
    'admin.page.invoices.view',
    'admin.page.coding_resale_report.view',
  ],
  'admin.orders.manage': [
    'admin.orders.view',
    'admin.page.orders.manage',
    'admin.page.invoices.manage',
    'admin.page.coding_resale_report.manage',
  ],
  'admin.transactions.view': [
    'admin.page.usage.view',
    'admin.page.gateway_billing_events.view',
  ],
  'admin.revenue.view': [
    'admin.page.revenue.view',
    'admin.page.finance_overview.view',
    'admin.page.finance_reports.view',
    'admin.page.finance_reports.export',
    'admin.page.finance_reconciliation.view',
    'admin.page.finance_reconciliation.manage',
    'admin.page.finance_reconciliation.export',
    'admin.page.finance_export_jobs.view',
    'admin.page.finance_export_jobs.download',
    'admin.data.revenue.view',
    'admin.data.finance_reports.view',
    'admin.data.finance_reports.export',
  ],
  'admin.plans.view': [
    'admin.page.products.view',
    'admin.page.subscription_plans.view',
    'admin.page.subscription_booster_packs.view',
    'admin.page.subscription_accounts.view',
    'admin.page.coding_self_managed_plans.view',
    'admin.page.coding_quota_templates.view',
    'admin.page.coding_third_party_plans.view',
    'admin.page.coding_resale_config.view',
    'admin.page.model_access.view',
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
    'admin.catalog.models.view',
  ],
  'admin.plans.manage': [
    'admin.plans.view',
    'admin.page.products.manage',
    'admin.page.subscription_plans.manage',
    'admin.page.subscription_booster_packs.manage',
    'admin.page.subscription_accounts.manage',
    'admin.page.payg_pricing.manage',
    'admin.page.usage_pricing_policies.manage',
    'admin.page.recharge_tiers.manage',
    'admin.page.credit_policy.manage',
    'admin.page.coding_self_managed_plans.manage',
    'admin.page.coding_quota_templates.manage',
    'admin.page.coding_third_party_plans.manage',
    'admin.page.bundles.manage',
    'admin.page.campaigns.manage',
    'admin.page.discount_codes.manage',
    'admin.page.grant_rules.manage',
    'admin.page.referrals.manage',
    'admin.page.models.manage',
    'admin.page.provider_cost_policies.manage',
    'admin.page.model_access.manage',
  ],
  'admin.promo.manage': [
    'admin.page.bundles.manage',
    'admin.page.campaigns.manage',
    'admin.page.discount_codes.manage',
    'admin.page.grant_rules.manage',
    'admin.page.referrals.manage',
  ],
  'admin.channels.view': [
    'admin.page.channels.view',
    'admin.page.delivery_settings.view',
    'admin.catalog.channels.view',
  ],
  'admin.channels.manage': [
    'admin.channels.view',
    'admin.page.channels.manage',
    'admin.page.delivery_settings.manage',
    'admin.page.models.channel_manage',
  ],
  'admin.monitoring.view': [
    'admin.page.funnel.view',
    'admin.page.monitoring.view',
    'admin.page.publisher_sync_jobs.view',
    'admin.page.agent_observability.view',
    'admin.page.sessions.view',
  ],
  'admin.announcements.manage': ['admin.page.announcements.manage'],
  'admin.audit.view': [
    'admin.page.risk_users.view',
    'admin.page.risk_rules.view',
    'admin.page.alerts.view',
    'admin.page.audit_logs.view',
  ],
  'admin.audit.manage': [
    'admin.audit.view',
    'admin.page.risk_users.manage',
    'admin.page.risk_rules.manage',
    'admin.page.alerts.manage',
  ],
  'admin.system.manage': [
    'admin.page.enterprise_accounts.detach',
    'admin.page.coding_resale_config.manage',
    'admin.page.publisher_sync_jobs.manage',
    'admin.page.monitoring.manage',
    'admin.page.feature_flags.manage',
    'admin.page.system_prompts.manage',
    'admin.page.payment_config.manage',
    'admin.page.system_config.manage',
  ],
  'admin.members.manage': [
    'admin.page.roles.manage',
    'admin.page.members.manage',
  ],
  'admin.page.dashboard.view': [
    'admin.data.revenue.view',
    'admin.catalog.products.view',
  ],
  'admin.page.funnel.view': ['admin.catalog.user_segments.view'],
  'admin.page.finance_overview.view': ['admin.data.finance_reports.view'],
  'admin.page.finance_reports.view': ['admin.data.finance_reports.view'],
  'admin.page.finance_reconciliation.view': ['admin.data.finance_reports.view'],
  // The legacy manage atom only allowed technical retry. Do not let an
  // existing custom role acquire evidence-review or financial authority.
  'admin.page.gateway_billing_events.manage': [
    'admin.page.gateway_billing_events.retry',
  ],
  'admin.page.gateway_billing_events.retry': [
    'admin.page.gateway_billing_events.view',
  ],
  'admin.page.gateway_billing_events.review': [
    'admin.page.gateway_billing_events.view',
  ],
  'admin.page.gateway_billing_events.settle': [
    'admin.page.gateway_billing_events.view',
  ],
  'admin.page.gateway_billing_events.absorb': [
    'admin.page.gateway_billing_events.view',
  ],
  'admin.page.historical_platform_losses.export': [
    'admin.page.historical_platform_losses.view',
  ],
  'admin.page.historical_platform_losses.prepare': [
    'admin.page.historical_platform_losses.view',
  ],
  'admin.page.historical_platform_losses.approve_post': [
    'admin.page.historical_platform_losses.view',
  ],
  'admin.page.finance_reports.export': [
    'admin.page.finance_reports.view',
    'admin.page.finance_export_jobs.view',
    'admin.page.finance_export_jobs.download',
    'admin.data.finance_reports.export',
  ],
  'admin.page.finance_reconciliation.export': [
    'admin.page.finance_reconciliation.view',
    'admin.page.finance_export_jobs.view',
    'admin.page.finance_export_jobs.download',
    'admin.data.finance_reports.export',
  ],
  'admin.data.finance_reports.export': ['admin.data.finance_reports.view'],
  'admin.page.subscription_plans.view': [
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
    'admin.catalog.models.view',
  ],
  'admin.page.subscription_plans.manage': ['admin.data.model_access.manage'],
  'admin.page.subscription_booster_packs.view': [
    'admin.catalog.products.view',
    'admin.catalog.booster_packs.view',
  ],
  'admin.page.subscription_accounts.view': ['admin.catalog.products.view'],
  'admin.page.enterprise_accounts.view': ['admin.catalog.products.view'],
  'admin.page.products.view': [
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
  ],
  'admin.page.products.manage': ['admin.catalog.channels.view'],
  'admin.page.payg_pricing.view': [
    'admin.catalog.products.view',
    'admin.catalog.models.view',
  ],
  'admin.page.usage_pricing_policies.view': [
    'admin.catalog.products.view',
    'admin.catalog.models.view',
    'admin.catalog.user_segments.view',
  ],
  'admin.page.recharge_tiers.view': ['admin.catalog.products.view'],
  'admin.page.credit_policy.view': ['admin.catalog.user_segments.view'],
  'admin.page.coding_self_managed_plans.view': [
    'admin.data.coding_plan.view',
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
    'admin.catalog.models.view',
  ],
  'admin.page.coding_self_managed_plans.manage': ['admin.data.coding_plan.manage'],
  'admin.page.coding_quota_templates.view': ['admin.catalog.plans.view'],
  'admin.page.coding_third_party_plans.view': [
    'admin.data.coding_plan.view',
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
    'admin.catalog.channels.view',
  ],
  'admin.page.coding_third_party_plans.manage': ['admin.data.coding_plan.manage'],
  'admin.data.coding_plan.manage': ['admin.data.coding_plan.view'],
  'admin.page.coding_resale_config.view': [
    'admin.data.coding_plan.view',
    'admin.catalog.products.view',
    'admin.catalog.channels.view',
  ],
  'admin.page.coding_resale_report.view': ['admin.data.coding_plan.view'],
  'admin.page.bundles.view': [
    'admin.catalog.products.view',
    'admin.catalog.plans.view',
    'admin.catalog.booster_packs.view',
  ],
  'admin.page.campaigns.view': ['admin.catalog.plans.view'],
  'admin.page.discount_codes.view': ['admin.catalog.plans.view'],
  'admin.page.models.view': [
    'admin.catalog.models.view',
    'admin.catalog.channels.view',
  ],
  'admin.page.provider_cost_policies.view': [
    'admin.catalog.products.view',
    'admin.catalog.models.view',
    'admin.data.coding_plan.view',
  ],
  'admin.page.channels.view': [
    'admin.catalog.products.view',
    'admin.catalog.channels.view',
    'admin.catalog.user_segments.view',
  ],
  'admin.page.channels.manage': [
    'admin.data.delivery_routes.manage',
    'admin.data.channels.manage',
  ],
  'admin.page.delivery_settings.view': [
    'admin.catalog.products.view',
    'admin.catalog.channels.view',
    'admin.catalog.user_segments.view',
  ],
  'admin.page.delivery_settings.manage': ['admin.data.delivery_routes.manage'],
  'admin.page.models.channel_manage': ['admin.data.channels.manage'],
  'admin.page.payment_config.view': ['admin.catalog.products.view'],
  'admin.page.model_access.view': [
    'admin.catalog.plans.view',
    'admin.catalog.channels.view',
    'admin.catalog.models.view',
  ],
  'admin.page.model_access.manage': ['admin.data.model_access.manage'],
};

export function expandAdminPermissions(
  permissions: Iterable<string>,
  overrides?: Partial<Record<AdminPermissionAtom, boolean>>,
): AdminPermissionAtom[] {
  const base = new Set<AdminPermissionAtom>();
  for (const permission of permissions) base.add(permission as AdminPermissionAtom);
  if (overrides) {
    for (const [perm, value] of Object.entries(overrides)) {
      if (value === true) base.add(perm as AdminPermissionAtom);
      else if (value === false) base.delete(perm as AdminPermissionAtom);
    }
  }
  const queue = Array.from(base);
  for (let index = 0; index < queue.length; index += 1) {
    const permission = queue[index];
    const pageAction = /^admin\.page\.([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(permission);
    if (pageAction && pageAction[2] !== 'view') {
      const pageView = `admin.page.${pageAction[1]}.view` as AdminPermissionAtom;
      if (!base.has(pageView)) {
        base.add(pageView);
        queue.push(pageView);
      }
    }
    for (const implied of ADMIN_PERMISSION_IMPLICATIONS[permission] ?? []) {
      if (base.has(implied)) continue;
      base.add(implied);
      queue.push(implied);
    }
  }
  return Array.from(base);
}

export function resolveAdminPermissions(
  presetRole: AdminPresetRole,
  overrides?: Partial<Record<AdminPermissionAtom, boolean>>,
): AdminPermissionAtom[] {
  return expandAdminPermissions(ADMIN_PRESET_ROLE_PERMISSIONS[presetRole] ?? [], overrides);
}

// ============================
// API 通用类型
// ============================

export interface ApiResponse<T = unknown> {
  code: number | string;
  message: string;
  data: T;
}

export interface PaginationQuery {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ============================
// 认证
// ============================

export interface AuthResult {
  user: User;
}

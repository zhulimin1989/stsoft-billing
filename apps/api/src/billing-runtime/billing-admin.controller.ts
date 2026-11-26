import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  Optional,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { createHash, createPrivateKey, createPublicKey } from 'crypto';
import {
  ApiResponse,
  createBundleSkuSchema,
  paginationSchema,
  updateBundleSkuSchema,
} from '@ruidong/shared';
import { BillingAdminService } from '../billing/billing.admin.service';
import { CodingPlanProviderAdminService } from '../billing/coding-plan-provider-admin.service';
import {
  BALANCE_ADJUSTMENT_REASON_CODES,
  BillingService,
  type BalanceAdjustmentReasonCode,
} from '../billing/billing.service';
import { resolvePlatformCurrency, type PlatformCurrency } from '../billing/platform-currency';
import { MAX_MANUAL_CREDIT_GRANT } from '../billing/credit-limits';
import { BoosterPackService } from '../billing/booster-pack.service';
import { SystemConfigService } from '../billing/system-config.service';
import {
  RollingQuotaGateConfigService,
  ROLLING_QUOTA_GATE_CONFIG_KEY,
  coerceGateBool,
} from '../billing/rolling-quota-gate-config.service';
import {
  rollingQuotaGateEnvForced,
  selfopNegativeDeductEnvForced,
} from '../quota-templates/plan-quota-rule-views';
import {
  SelfopNegativeDeductConfigService,
  SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY,
} from '../billing/selfop-negative-deduct-config.service';
import {
  CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY,
  codingPlanMonthlyRefreshEnvForced,
} from '../billing/coding-plan-monthly-refresh.service';
// R6 开关关闭序列的集群收敛 fence：负额关闭时间戳 + 收敛等待窗口。
// 窗口 = 开关 override 刷新周期(30s) + 余量(15s)；关月度补发前要求负额已关闭并超过此窗口，
// 确保所有副本内存 override 已收敛为「负额关」，不会再有陈旧副本跨零产生无清偿点的欠额。
const SELFOP_NEGATIVE_DEDUCT_DISABLED_AT_KEY = 'selfop_negative_deduct_disabled_at';
const SWITCH_CONVERGENCE_MS = 45_000;
import { ChannelAdminService } from '../channel/channel.admin.service';
import { ChannelService } from '../channel/channel.service';
import { CreditService } from '../billing/credit.service';
import { GatewayRequestEventBillingService } from '../billing/gateway-request-event-billing.service';
import {
  HistoricalPlatformLossBatchService,
  type HistoricalPlatformLossBatchInput,
  type HistoricalPlatformLossPostCommand,
} from '../billing/historical-platform-loss-batch.service';
import { ProductService } from '../billing/product.service';
import { CampaignService, CreateCampaignInput, UpdateCampaignInput } from '../campaign/campaign.service';
import {
  CreateDiscountCodeInput,
  DiscountCodeService,
  UpdateDiscountCodeInput,
} from '../campaign/discount-code.service';
import { CreditGrantExecutor } from '../credit-grants/credit-grant-executor';
import {
  CreateGrantRuleInput,
  CreditGrantsService,
  UpdateGrantRuleInput,
} from '../credit-grants/credit-grants.service';
import { CreditPolicyService, CreditPolicyWriteInput } from '../credit-policy/credit-policy.service';
import { FunnelService } from '../funnel/funnel.service';
import {
  PaygModelPricingVersionInput,
  PaygProductModelUpdateInput,
  PaygProductModelWriteInput,
  EnterpriseModelDiscountMatrixInput,
  UsageBillingStrategyService,
  UsageDeductInput,
  UsagePolicyWriteInput,
  UsageQuoteInput,
} from '../billing/usage-billing-strategy.service';
import {
  ProviderCostPolicyListQuery,
  ProviderCostPolicyWriteInput,
  ProviderCostPricingService,
} from '../billing/provider-cost-pricing.service';
import {
  NoAdminPermissionRequired,
  RequireAdminPermission,
  RequireAdminPresetRole,
} from '../common/decorators/admin-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { decryptCredentials, encryptCredentials, maskCredential } from '../payment/credential-crypto';
import { PaymentProviderRegistry } from '../payment/payment-provider-registry';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncJobService } from '../publisher/publisher-sync-job.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import {
  CreateTemplateInput,
  QuotaTemplatesService,
  UpdateTemplateInput,
} from '../quota-templates/quota-templates.service';
import { RechargeTiersService } from '../recharge-tiers/recharge-tiers.service';
import {
  CreateProgramInput,
  ReferralsService,
  UpdateProgramInput,
} from '../referrals/referrals.service';
import { GrowthEventsService } from '../growth-events/growth-events.service';
import { AccountingReconciliationService } from './accounting-reconciliation.service';
import { BillingInternalGuard } from './billing-internal.guard';
import { BillingUserMirrorService } from './billing-user-mirror.service';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { Prisma, RechargeBonusType } from '@prisma/client';
import { usdNumber, usdToCents } from '../billing/money';
import {
  CreditPolicyRecoveryCondition,
  CreditPolicyTriggerAction,
  GrantExpirePolicy,
  GrantNotifyType,
  GrantRewardType,
  GrantTriggerType,
} from '@prisma/client';

const TOKEN_USAGE_SHANGHAI_DATE_SQL = Prisma.sql`
  (tu."created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
`;

type PlanWriteBody = {
  id?: string;
  productId?: string | null;
  name: string;
  description?: string;
  planType?: string;
  monthlyPrice?: number;
  quarterlyPrice?: number;
  yearlyPrice?: number;
  billingPeriod?: string;
  monthlyCredits?: number;
  creditsRollover?: boolean;
  rolloverMaxMonths?: number;
  rateLimitRpm?: number;
  rateLimitTpm?: number;
  maxContextWindow?: number;
  overageEnabled?: boolean;
  usageMultiplier?: number;
  memberLimit?: number;
  minimumSeats?: number;
  dataTraining?: string;
  supportTier?: string;
  ssoEnabled?: boolean;
  priorityAccess?: boolean;
  badge?: string | null;
  trialDays?: number;
  features?: unknown;
  isActive?: boolean;
  isLegacy?: boolean;
  salesLimit?: number;
  sortOrder?: number;
};

type BillingUserSnapshot = {
  id?: string;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
  isActive?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
};

type ReferralAttributionBody = {
  userId?: string;
  referralCode?: string | null;
  inviteeIp?: string | null;
  deviceId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  landingUrl?: string | null;
  capturedAt?: string | Date | null;
  referrer?: string | null;
  analyticsConsent?: boolean | null;
  analyticsClientId?: string | null;
  user?: BillingUserSnapshot;
};

const MAX_MANUAL_BALANCE_ADJUSTMENT_CENTS = 25_000 * 100;
const DEFAULT_CODING_PLAN_KEYS_PER_ENTITLEMENT_LIMIT = 5;

function assertManualBalanceAdjustmentAmount(
  amountCents: unknown,
  currencySymbol: string,
): asserts amountCents is number {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    throw new BadRequestException('amountCents 必须为整数分值');
  }
  if (amountCents === 0) {
    throw new BadRequestException('amountCents 不能为 0');
  }
  if (Math.abs(amountCents) > MAX_MANUAL_BALANCE_ADJUSTMENT_CENTS) {
    throw new BadRequestException(`单次调额不能超过 ${currencySymbol}25,000.00`);
  }
}

function normalizeStorageConfig(body: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  const stringKeys = [
    'bucket',
    's3Bucket',
    'invoiceS3Bucket',
    'region',
    's3Region',
    'invoiceS3Region',
    'endpoint',
    's3Endpoint',
    'invoiceS3Endpoint',
    'prefix',
    's3Prefix',
    'invoiceS3Prefix',
    'accessKey',
    'accessKeyId',
    's3AccessKeyId',
    'invoiceS3AccessKeyId',
    'secretAccessKey',
    'accessKeySecret',
    'secretKey',
    's3SecretAccessKey',
    'invoiceS3SecretAccessKey',
    'ossEndpoint',
    'invoiceOssEndpoint',
    'ossPublicEndpoint',
    'invoiceOssPublicEndpoint',
  ];
  for (const key of stringKeys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) {
      config[key] = value.trim();
    }
  }
  for (const key of ['forcePathStyle', 's3ForcePathStyle', 'invoiceS3ForcePathStyle']) {
    const value = body[key];
    if (typeof value === 'boolean') {
      config[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') config[key] = true;
    if (normalized === 'false') config[key] = false;
  }
  const provider =
    normalizeStorageProvider(body.provider ?? body.storageProvider ?? body.objectStoreProvider) ??
    inferStorageProvider(config);
  if (provider) config.provider = provider;
  stripInactiveStorageProviderFields(config);
  stripDeploymentStorageFields(config);
  return config;
}

function normalizeStorageProvider(value: unknown): 's3' | 'aliyun_oss' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 's3' || normalized === 'aws_s3' || normalized === 'aws-s3') return 's3';
  if (normalized === 'aliyun_oss' || normalized === 'aliyun-oss' || normalized === 'oss') {
    return 'aliyun_oss';
  }
  throw new BadRequestException('对象存储 provider 必须是 s3 或 aliyun_oss');
}

function inferStorageProvider(config: Record<string, unknown>): 'aliyun_oss' | undefined {
  return firstConfigString(config, ['ossEndpoint', 'invoiceOssEndpoint']) ? 'aliyun_oss' : undefined;
}

function firstConfigString(config: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stripInactiveStorageProviderFields(config: Record<string, unknown>) {
  const provider = firstConfigString(config, ['provider']);
  if (provider === 'aliyun_oss') {
    delete config.s3Endpoint;
    delete config.invoiceS3Endpoint;
    delete config.s3ForcePathStyle;
    delete config.invoiceS3ForcePathStyle;
    delete config.forcePathStyle;
    return;
  }
  if (provider === 's3') {
    delete config.ossEndpoint;
    delete config.invoiceOssEndpoint;
    delete config.ossPublicEndpoint;
    delete config.invoiceOssPublicEndpoint;
  }
}

function stripDeploymentStorageFields(config: Record<string, unknown>) {
  delete config.bucket;
  delete config.s3Bucket;
  delete config.invoiceS3Bucket;
  delete config.region;
  delete config.s3Region;
  delete config.invoiceS3Region;
}

function assertManualVoucherAmount(
  amountCents: unknown,
  currencySymbol: string,
): asserts amountCents is number {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    throw new BadRequestException('amountCents 必须为整数分值');
  }
  if (amountCents <= 0) {
    throw new BadRequestException('代金券金额必须大于 0');
  }
  if (amountCents > MAX_MANUAL_BALANCE_ADJUSTMENT_CENTS) {
    throw new BadRequestException(`单次发券不能超过 ${currencySymbol}25,000.00`);
  }
}

function assertRequiredString(value: unknown, fieldName: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new BadRequestException(`${fieldName} 不能为空`);
  }
  return text;
}

const BUSINESS_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function datePartsInBusinessTimezone(date: Date): { year: number; month: number; day: number } {
  const shifted = new Date(date.getTime() + BUSINESS_TIMEZONE_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function businessDateStartUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(
    year,
    month - 1,
    day,
    0,
    -BUSINESS_TIMEZONE_OFFSET_MINUTES,
    0,
    0,
  ));
}

function parseVoucherExpiresAt(value: unknown, fieldName: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const text = value instanceof Date ? '' : String(value).trim();
  let parts: { year: number; month: number; day: number };

  const dateOnly = text.match(DATE_ONLY_PATTERN);
  if (dateOnly) {
    parts = {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
    };
  } else {
    const date = value instanceof Date ? value : new Date(text);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${fieldName} 无效`);
    }
    parts = datePartsInBusinessTimezone(date);
  }

  const exclusiveExpiry = businessDateStartUtc(parts.year, parts.month, parts.day + 1);
  if (Number.isNaN(exclusiveExpiry.getTime())) {
    throw new BadRequestException(`${fieldName} 无效`);
  }
  if (exclusiveExpiry.getTime() <= Date.now()) {
    throw new BadRequestException(`${fieldName} 必须晚于当前时间`);
  }
  return exclusiveExpiry;
}

type ApiKeyMirrorInput = {
  id?: string;
  userId?: string;
  tenantId?: string | null;
  productId?: string | null;
  productSlug?: string | null;
  codingPlanEntitlementId?: string | null;
  name?: string;
  prefix?: string;
  keyHash?: string;
  isActive?: boolean;
  allowedModels?: string | null;
  budgetUsd?: string | number | null;
  expiresAt?: string | Date | null;
  ipWhitelist?: string | string[] | null;
  rateLimitRpm?: number | null;
  rateLimitTpm?: number | null;
  concurrencyLimit?: number | null;
  sseConcurrency?: number | null;
  maxTokensPerCall?: number | null;
  maxMessages?: number | null;
  allowTools?: boolean | null;
  allowVision?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
  lastUsedAt?: string | Date | null;
  deletedAt?: string | Date | null;
};

type PublisherReplayScope = 'all' | 'api_keys' | 'key_balances' | 'admin' | 'platform';

type RechargeTierBody = {
  productId?: string;
  amountCents?: number;
  bonusType?: RechargeBonusType;
  bonusValue?: number;
  badge?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
};

type GrantRuleBody = {
  name?: string;
  triggerType?: GrantTriggerType;
  cronExpr?: string | null;
  segmentId?: string | null;
  rewardType?: GrantRewardType;
  rewardAmount?: number;
  productId?: string | null;
  expirePolicy?: GrantExpirePolicy;
  expireDays?: number | null;
  perUserLimit?: number;
  globalDailyCap?: number | null;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  notifyType?: GrantNotifyType | null;
  notifyTemplate?: string | null;
};

type CreditPolicyBody = {
  productId?: string;
  segmentId?: string;
  allowOverdraft?: boolean;
  defaultCreditLimitCents?: number;
  triggerAction?: CreditPolicyTriggerAction;
  recoveryCondition?: CreditPolicyRecoveryCondition;
  recoveryDays?: number | null;
};

type ProductBillingModeInput = 'SUBSCRIPTION' | 'PAY_AS_YOU_GO' | 'CODING_PLAN';
type CodingPlanFulfillmentModeInput = 'platform_model_package' | 'provider_resale';

const PRODUCT_BILLING_MODES: ProductBillingModeInput[] = [
  'SUBSCRIPTION',
  'PAY_AS_YOU_GO',
  'CODING_PLAN',
];
const CODING_PLAN_FULFILLMENT_MODES: CodingPlanFulfillmentModeInput[] = [
  'platform_model_package',
  'provider_resale',
];

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBooleanQuery(raw: string | boolean | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function pickCreditPolicyWriteInput(body: CreditPolicyBody): CreditPolicyWriteInput {
  return {
    allowOverdraft: body.allowOverdraft,
    defaultCreditLimitCents: body.defaultCreditLimitCents,
    triggerAction: body.triggerAction,
    recoveryCondition: body.recoveryCondition,
    recoveryDays: body.recoveryDays ?? undefined,
  };
}

function fingerprintAlipayPublicKeyFromPrivateKey(privateKey: string): string | null {
  for (const candidate of alipayPrivateKeyCandidates(privateKey)) {
    try {
      const key = createPrivateKey(candidate);
      const publicKey = createPublicKey(key);
      return fingerprintPublicKey(publicKey.export({ type: 'spki', format: 'pem' }).toString());
    } catch {
      // Try the next supported PEM shape.
    }
  }
  return null;
}

function fingerprintAlipayPublicKey(publicKey: string): string | null {
  for (const candidate of alipayPublicKeyCandidates(publicKey)) {
    try {
      return fingerprintPublicKey(candidate);
    } catch {
      // Try the next supported PEM shape.
    }
  }
  return null;
}

function fingerprintPublicKey(publicKey: string): string {
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

function alipayPrivateKeyCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.includes('BEGIN')) return [trimmed];
  return [
    wrapPemBody(trimmed, 'PRIVATE KEY'),
    wrapPemBody(trimmed, 'RSA PRIVATE KEY'),
  ];
}

function alipayPublicKeyCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.includes('BEGIN')) return [trimmed];
  return [wrapPemBody(trimmed, 'PUBLIC KEY')];
}

function wrapPemBody(value: string, label: string): string {
  const body = value.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

@ApiTags('Billing Admin')
@Controller('internal/billing/admin')
@Public()
@UseGuards(BillingInternalGuard, AdminPermissionGuard)
export class BillingAdminController {
  constructor(
    private readonly billingAdmin: BillingAdminService,
    private readonly billingService: BillingService,
    private readonly creditService: CreditService,
    private readonly productService: ProductService,
    private readonly boosterPackService: BoosterPackService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly productSync: ProductSyncNotifier,
    private readonly usageBillingStrategy: UsageBillingStrategyService,
    private readonly providerCostPricing: ProviderCostPricingService,
    private readonly gatewayRequestEventBilling: GatewayRequestEventBillingService,
    private readonly channelAdmin: ChannelAdminService,
    private readonly channelService: ChannelService,
    private readonly campaignService: CampaignService,
    private readonly creditGrantExecutor: CreditGrantExecutor,
    private readonly creditGrantsService: CreditGrantsService,
    private readonly creditPolicyService: CreditPolicyService,
    private readonly discountCodeService: DiscountCodeService,
    private readonly funnelService: FunnelService,
    private readonly quotaTemplatesService: QuotaTemplatesService,
    private readonly publisherSyncJobs: PublisherSyncJobService,
    private readonly publisherSync: PublisherSyncService,
    private readonly rechargeTiersService: RechargeTiersService,
    private readonly systemConfig: SystemConfigService,
    private readonly rollingQuotaGateConfig: RollingQuotaGateConfigService,
    private readonly selfopNegativeDeductConfig: SelfopNegativeDeductConfigService,
    private readonly referralsService: ReferralsService,
    @Optional() private readonly accountingReconciliation?: AccountingReconciliationService,
    @Optional() private readonly codingPlanProviders?: CodingPlanProviderAdminService,
    @Optional() private readonly userMirror?: BillingUserMirrorService,
    @Optional() private readonly growthEvents?: GrowthEventsService,
    @Optional() private readonly historicalPlatformLosses?: HistoricalPlatformLossBatchService,
  ) {}

  private async platformCurrency(): Promise<PlatformCurrency> {
    const deploymentConfig = typeof this.systemConfig?.getDeploymentConfig === 'function'
      ? await this.systemConfig.getDeploymentConfig()
      : undefined;
    const config = typeof this.config?.get === 'function' ? this.config : undefined;
    return resolvePlatformCurrency(config, deploymentConfig);
  }

  private requireHistoricalPlatformLossService(): HistoricalPlatformLossBatchService {
    if (!this.historicalPlatformLosses) {
      throw new ServiceUnavailableException('历史平台损失批次服务未配置');
    }
    return this.historicalPlatformLosses;
  }

  // 滚动配额 gate 运行时开关（admin 可控，无需改 GitOps env）。effectiveEnabled = env强制开 || admin开。
  // 权限：归属 CodingPlan›配额模板域，故用 admin.plans.*。
  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('rolling-quota-gate')
  async getRollingQuotaGate(): Promise<ApiResponse<unknown>> {
    const adminRaw = await this.systemConfig.getFresh(ROLLING_QUOTA_GATE_CONFIG_KEY);
    const adminEnabled = coerceGateBool(adminRaw); // true/false/null(未配置=继承 env)
    // effectiveEnabled 直接由 DB 最新值算，避免本进程模块级 override 尚未刷新导致口径滞后。
    const effectiveEnabled = rollingQuotaGateEnvForced() || adminEnabled === true;
    return {
      code: 0,
      message: 'ok',
      data: { effectiveEnabled, envForced: rollingQuotaGateEnvForced(), adminEnabled },
    };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Put('rolling-quota-gate')
  async setRollingQuotaGate(
    @Body() body: { enabled?: unknown },
  ): Promise<ApiResponse<unknown>> {
    // 严格校验：仅接受 true/false/null。null=置空(继承 env)。缺失/非法一律 400，避免误关 gate。
    const raw = body?.enabled;
    if (raw !== true && raw !== false && raw !== null) {
      throw new BadRequestException('enabled 必须为 boolean 或 null（置空=继承环境变量）');
    }
    await this.systemConfig.set(ROLLING_QUOTA_GATE_CONFIG_KEY, raw);
    await this.rollingQuotaGateConfig.refresh(); // 本 Pod 即时生效；其余 Pod 经 30s 定时 getFresh 同步
    const adminEnabled = coerceGateBool(raw);
    const effectiveEnabled = rollingQuotaGateEnvForced() || adminEnabled === true;
    return {
      code: 0,
      message:
        adminEnabled === null
          ? '滚动配额 gate 开关已置空（继承环境变量）'
          : adminEnabled
            ? '滚动配额 gate 已开启'
            : '滚动配额 gate 已关闭',
      data: { adminEnabled, effectiveEnabled, envForced: rollingQuotaGateEnvForced() },
    };
  }

  // ── R3b 月度补发 运行时开关（与滚动 gate 同款：SystemConfig + env 强制；归 CodingPlan›配额模板域）──

  // debug-only：跳过 k 检查，直接对指定 entitlement 调 resetQuota(net)（R3b 清欠测试）。
  // 生产硬门禁 + 自营资格校验（除 k 外与 cron 同口径）+ 稳定幂等键（重试不重复发放）。
  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Post('coding-plan-monthly-refresh/debug-reset')
  async debugResetMonthlyRefresh(
    @Body() body: { entitlementId?: string; tag?: string },
  ): Promise<ApiResponse<unknown>> {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('debug-reset 仅限非生产环境');
    }
    const raw = body?.entitlementId;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BadRequestException('entitlementId 必填且为字符串');
    }
    const entitlementId = raw.trim();
    // tag 非字符串时拒绝（防 {tag:123} 静默降级）；空/缺省时 null（兼容旧无后缀幂等键）。
    if (body?.tag !== undefined && typeof body.tag !== 'string') {
      throw new BadRequestException('tag 必须为字符串');
    }
    const tag = typeof body?.tag === 'string' && body.tag.trim() ? body.tag.trim() : null;
    const ent = await this.prisma.codingPlanEntitlement.findUnique({
      where: { id: entitlementId },
      select: { id: true, userId: true, planId: true, status: true, fulfillmentMode: true },
    });
    if (!ent) throw new BadRequestException('entitlement 不存在');
    if (ent.fulfillmentMode !== 'platform_model_package') {
      throw new BadRequestException('仅限自营 platform_model_package entitlement');
    }
    if (ent.status !== 'ACTIVE') {
      throw new BadRequestException(`entitlement 状态=${ent.status}，仅 ACTIVE 可重置`);
    }
    const plan = await this.prisma.plan.findUnique({
      where: { id: ent.planId },
      select: { monthlyCredits: true, validityDays: true },
    });
    if (!plan) throw new BadRequestException('plan 不存在');
    if (plan.monthlyCredits <= 0) {
      throw new BadRequestException(`monthlyCredits 非法: ${plan.monthlyCredits}`);
    }
    // 幂等键含 tag：同 tag 重试幂等、不同 tag 可重新触发（test 用：改 monthlyCredits 后重发）。
    await this.creditService.resetQuota(
      entitlementId,
      ent.userId,
      plan.monthlyCredits,
      'coding-plan:monthly-refresh:debug',
      {
        idempotencyKey: tag
          ? `cpm:debug:${entitlementId}:${tag}`
          : `cpm:debug:${entitlementId}`,
        negativeSettleMode: 'net',
        requireActiveCodingPlanEntitlement: true,
      },
    );
    return {
      code: 0,
      message: `resetQuota(net) 已执行: entitlement=${entitlementId} monthlyCredits=${plan.monthlyCredits}`,
      data: { entitlementId, monthlyCredits: plan.monthlyCredits, validityDays: plan.validityDays },
    };
  }

  // debug-only：设置 entitlement 的 startedAt/expiresAt（test 用：验证到期/跨月场景）。
  // 生产硬门禁 + 自营校验。不改余额，仅改时间轴。
  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Post('coding-plan-monthly-refresh/debug-set-dates')
  async debugSetEntitlementDates(
    @Body() body: { entitlementId?: string; startedAt?: string; expiresAt?: string },
  ): Promise<ApiResponse<unknown>> {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('debug-set-dates 仅限非生产环境');
    }
    const raw = body?.entitlementId;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BadRequestException('entitlementId 必填且为字符串');
    }
    const entitlementId = raw.trim();
    const parseDate = (v: unknown, field: string): Date | undefined => {
      if (v === undefined) return undefined;
      if (typeof v !== 'string') throw new BadRequestException(`${field} 必须为 ISO 字符串`);
      // 严格 ISO 8601（YYYY-MM-DD 或带时间/时区），拒绝 1/2/2026 这类非 ISO；
      // 再校验解析后回写 ISO 是否与月日一致，拒绝 2026-02-30 静默归一化。
      if (!/^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v)) {
        throw new BadRequestException(`${field} 必须为 ISO 8601 日期(YYYY-MM-DD[...]): ${v}`);
      }
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} 非法日期: ${v}`);
      // 纯日期(YYYY-MM-DD)才校验日历合法性：解析为 UTC 午夜，比对回写月日拒绝 2026-02-30 归一化。
      // 带时间/时区的完整 ISO 交给 Date 解析（已通过 NaN 校验），不做 UTC 分量比对以免误伤偏移量。
      if (v.length === 10) {
        const [y, m, day] = v.split('-').map(Number);
        if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) {
          throw new BadRequestException(`${field} 日期不存在(被归一化): ${v}`);
        }
      }
      return d;
    };
    const startedAt = parseDate(body?.startedAt, 'startedAt');
    const expiresAt = parseDate(body?.expiresAt, 'expiresAt');
    if (!startedAt && !expiresAt) {
      throw new BadRequestException('startedAt / expiresAt 至少提供一个');
    }
    const ent = await this.prisma.codingPlanEntitlement.findUnique({
      where: { id: entitlementId },
      select: { id: true, fulfillmentMode: true },
    });
    if (!ent) throw new BadRequestException('entitlement 不存在');
    if (ent.fulfillmentMode !== 'platform_model_package') {
      throw new BadRequestException('仅限自营 platform_model_package entitlement');
    }
    const updated = await this.prisma.codingPlanEntitlement.update({
      where: { id: entitlementId },
      data: {
        ...(startedAt ? { startedAt } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      select: { id: true, startedAt: true, expiresAt: true, status: true },
    });
    return { code: 0, message: '时间轴已更新', data: updated };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('coding-plan-monthly-refresh/debug-balance')
  async debugGetBalance(
    @Query('entitlementId') entitlementId?: string,
  ): Promise<ApiResponse<unknown>> {
    if (!entitlementId?.trim()) {
      throw new BadRequestException('entitlementId 必填');
    }
    const ent = await this.prisma.codingPlanEntitlement.findUnique({
      where: { id: entitlementId.trim() },
      select: { id: true, userId: true, planId: true, status: true, startedAt: true, expiresAt: true },
    });
    if (!ent) throw new BadRequestException('entitlement 不存在');
    // 读权威余额（PG，不走 Redis 缓存）
    const balances = await this.creditService.getAuthoritativeBalances(ent.id, ent.userId);
    // 也读 credit_balance_states 原始行（version 是 BigInt，序列化前转 string 防 JSON.stringify 抛错）
    const stateRow = await this.prisma.creditBalanceState.findUnique({
      where: { subscriptionId: ent.id },
    });
    const state = stateRow
      ? { ...stateRow, version: stateRow.version.toString() }
      : null;
    // 最近 5 条流水
    const recentTx = await this.prisma.creditTransaction.findMany({
      where: { subscriptionId: ent.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { type: true, creditsAmount: true, quotaAfter: true, bonusAfter: true, source: true, idempotencyKey: true, createdAt: true },
    });
    return {
      code: 0,
      message: 'ok',
      data: { entitlement: ent, balances, balanceState: state, recentTransactions: recentTx },
    };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('coding-plan-monthly-refresh')
  async getCodingPlanMonthlyRefresh(): Promise<ApiResponse<unknown>> {
    const adminEnabled = coerceGateBool(
      await this.systemConfig.getFresh(CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY),
    );
    const envForced = codingPlanMonthlyRefreshEnvForced();
    return {
      code: 0,
      message: 'ok',
      data: { effectiveEnabled: envForced || adminEnabled === true, envForced, adminEnabled },
    };
  }

  /**
   * 双开关守卫写入（codex 评审 High：TOCTOU 竞态修复）。
   * 「读对端 → 判定 → 写自身」在同一事务内、以共享 advisory lock 串行化——两把 PUT 并发
   * （关月度 vs 开负额）不可能同时读到旧态而写出「负额开 + 月度关」的非法终态。
   * 写库后由调用方 getFresh 回填本地缓存（set 的缓存语义等价）。
   */
  private async guardedSwitchWrite(
    selfKey: string,
    raw: boolean | null,
    guard: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('selfop-r6-switch-guard'))`;
        await guard(tx);
        const valueStr = JSON.stringify(raw);
        await tx.systemConfig.upsert({
          where: { key: selfKey },
          update: { value: valueStr },
          create: { key: selfKey, value: valueStr },
        });
      },
      // 守卫正确性依赖「取锁后读到对端已提交值」：显式 ReadCommitted，不依赖部署默认隔离级别。
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    await this.systemConfig.getFresh(selfKey); // 回填本进程缓存（其余 Pod 走各自 getFresh）
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Put('coding-plan-monthly-refresh')
  async setCodingPlanMonthlyRefresh(
    @Body() body: { enabled?: unknown },
  ): Promise<ApiResponse<unknown>> {
    const raw = body?.enabled;
    if (raw !== true && raw !== false && raw !== null) {
      throw new BadRequestException('enabled 必须为 boolean 或 null（置空=继承环境变量）');
    }
    await this.guardedSwitchWrite(CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY, raw, async (tx) => {
      // 关闭前守卫：R6 负额结算仍开时不得关月度补发（欠额会失去自动了结点、续订用户断供）。
      if (raw !== true) {
        const negativeAdmin = coerceGateBool(
          await this.systemConfig.getFresh(SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY, undefined, tx),
        );
        const negativeEffective = selfopNegativeDeductEnvForced() || negativeAdmin === true;
        if (negativeEffective && !codingPlanMonthlyRefreshEnvForced()) {
          throw new BadRequestException(
            '终态负额结算（R6）仍在开启状态，关闭月度补发会让欠额失去自动清偿、续订用户断供；请先关闭负额结算开关。',
          );
        }
        // 集群收敛 fence（codex 终审 P1）：负额已关，但多副本开关 override 需 ~30s 收敛；
        // 若负额刚关闭、尚未过收敛窗口即关月度，未收敛副本仍可能跨零产生无清偿点的欠额。
        // 要求负额关闭已满 SWITCH_CONVERGENCE_MS 才放行关月度。月度 env 强制开时此路不可达，跳过。
        if (!negativeEffective && !codingPlanMonthlyRefreshEnvForced()) {
          const disabledRaw = await this.systemConfig.getFresh(
            SELFOP_NEGATIVE_DEDUCT_DISABLED_AT_KEY,
            undefined,
            tx,
          );
          if (typeof disabledRaw === 'string' && disabledRaw) {
            const ts = new Date(disabledRaw).getTime();
            const elapsed = Date.now() - ts;
            // fail-closed（codex fence 复审）：disabled_at 存在=负额曾关闭且未因重新开启清零；
            // 仅当「有限时间戳 && 已过收敛窗口」才放行。未满窗口 / 未来时间戳(跨 Pod 时钟回退,elapsed<0)
            // / 损坏值(NaN) 一律拒——月度维持开=保留清偿点(安全方向)，不因时钟偏差重开 P1 窗口。
            const converged = Number.isFinite(ts) && elapsed >= SWITCH_CONVERGENCE_MS;
            if (!converged) {
              const waitSec = Number.isFinite(ts)
                ? Math.max(0, Math.ceil((SWITCH_CONVERGENCE_MS - elapsed) / 1000))
                : Math.ceil(SWITCH_CONVERGENCE_MS / 1000);
              throw new BadRequestException(
                `终态负额结算关闭尚未确认集群收敛（需 ~${SWITCH_CONVERGENCE_MS / 1000}s）；`
                  + `期间陈旧副本仍可能跨零产生无清偿点欠额。请 ${waitSec}s 后重试关闭月度补发。`,
              );
            }
          }
        }
      }
    });
    const adminEnabled = coerceGateBool(raw);
    const envForced = codingPlanMonthlyRefreshEnvForced();
    return {
      code: 0,
      message:
        adminEnabled === null
          ? '月度补发开关已置空（继承环境变量）'
          : adminEnabled
            ? '月度补发已开启（每小时扫描，月边界 ~1h 内补发/清欠）'
            : '月度补发已关闭',
      data: { adminEnabled, effectiveEnabled: envForced || adminEnabled === true, envForced },
    };
  }

  // ── R6 自营积分终态负额结算 运行时开关（硬门禁：月度补发未生效时禁止开启）──
  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('selfop-negative-deduct')
  async getSelfopNegativeDeduct(): Promise<ApiResponse<unknown>> {
    const adminEnabled = coerceGateBool(
      await this.systemConfig.getFresh(SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY),
    );
    const envForced = selfopNegativeDeductEnvForced();
    // gatewayNegativeEnv=网关终态结算 env（BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE）：
    // R6 生效的另一前提，仅展示供诊断（部署层 env，不在此改）。
    const gatewayRaw = process.env.BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE ?? '';
    const gatewayNegativeEnv = ['1', 'true', 'yes', 'on'].includes(gatewayRaw.trim().toLowerCase());
    return {
      code: 0,
      message: 'ok',
      data: {
        effectiveEnabled: envForced || adminEnabled === true,
        envForced,
        adminEnabled,
        gatewayNegativeEnv,
      },
    };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Put('selfop-negative-deduct')
  async setSelfopNegativeDeduct(
    @Body() body: { enabled?: unknown },
  ): Promise<ApiResponse<unknown>> {
    const raw = body?.enabled;
    if (raw !== true && raw !== false && raw !== null) {
      throw new BadRequestException('enabled 必须为 boolean 或 null（置空=继承环境变量）');
    }
    await this.guardedSwitchWrite(SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY, raw, async (tx) => {
      // 开启前硬门禁（codex 评审确立）：月度补发必须已生效，否则末笔跨负的续订用户会
      // 永久锁死在负额（欠额没有自动了结点）。
      if (raw === true) {
        const refreshAdmin = coerceGateBool(
          await this.systemConfig.getFresh(CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY, undefined, tx),
        );
        const refreshEffective = codingPlanMonthlyRefreshEnvForced() || refreshAdmin === true;
        if (!refreshEffective) {
          throw new BadRequestException(
            '开启前置未满足：请先开启「月度补发」并确认其正常运行（负额欠款依赖月度补发净发清偿，否则续订用户会断供）。',
          );
        }
      }
      // 记/清负额关闭时间戳（同事务，与开关状态一致）：关闭时记 now，供关月度前的集群收敛 fence；
      // 开启时清 null（负额又开，之前的收敛计时作废）。
      const disabledAtValue = raw === true ? 'null' : JSON.stringify(new Date().toISOString());
      await tx.systemConfig.upsert({
        where: { key: SELFOP_NEGATIVE_DEDUCT_DISABLED_AT_KEY },
        update: { value: disabledAtValue },
        create: { key: SELFOP_NEGATIVE_DEDUCT_DISABLED_AT_KEY, value: disabledAtValue },
      });
    });
    await this.selfopNegativeDeductConfig.refresh(); // 本 Pod 即时生效；其余 Pod 经 30s 定时 getFresh 同步
    const adminEnabled = coerceGateBool(raw);
    const envForced = selfopNegativeDeductEnvForced();
    // codex Medium 修复：PUT 响应与 GET 同构（含 gatewayNegativeEnv），前端整体替换状态不丢诊断行。
    const gatewayRaw = process.env.BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE ?? '';
    const gatewayNegativeEnv = ['1', 'true', 'yes', 'on'].includes(gatewayRaw.trim().toLowerCase());
    return {
      code: 0,
      message:
        adminEnabled === null
          ? '终态负额结算开关已置空（继承环境变量）'
          : adminEnabled
            ? '终态负额结算已开启（仅自营套餐已交付末笔可跨零入账）'
            : '终态负额结算已关闭',
      data: {
        adminEnabled,
        effectiveEnabled: envForced || adminEnabled === true,
        envForced,
        gatewayNegativeEnv,
      },
    };
  }

  @RequireAdminPermission('admin.page.system_config.manage')
  @Put('deployment-config')
  async updateDeploymentConfig(
    @Body() body: unknown,
  ): Promise<ApiResponse<unknown>> {
    const deploymentConfig = await this.systemConfig.applyDeploymentConfig(body);
    return { code: 0, message: '部署配置已同步', data: deploymentConfig };
  }

  @RequireAdminPermission('admin.page.system_config.manage')
  @Put('storage-config')
  async updateStorageConfig(
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    const storageConfig = normalizeStorageConfig(body);
    await this.systemConfig.set('storageConfig', storageConfig);
    return { code: 0, message: '对象存储配置已保存', data: storageConfig };
  }

  @RequireAdminPermission('admin.data.coding_plan.view')
  @Get('coding-plan/provider-lines')
  async listCodingPlanProviderLines(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.codingPlanProviderAdmin().listProviderLines() };
  }

  @RequireAdminPermission('admin.page.coding_resale_config.manage')
  @Post('coding-plan/provider-lines')
  async createCodingPlanProviderLine(
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商线路已创建', data: await this.codingPlanProviderAdmin().createProviderLine(body) };
  }

  @RequireAdminPermission('admin.page.coding_resale_config.manage')
  @Put('coding-plan/provider-lines/:id')
  async updateCodingPlanProviderLine(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商线路已保存', data: await this.codingPlanProviderAdmin().updateProviderLine(id, body) };
  }

  @RequireAdminPermission('admin.page.coding_resale_config.manage')
  @Delete('coding-plan/provider-lines/:id')
  async deleteCodingPlanProviderLine(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商线路已删除', data: await this.codingPlanProviderAdmin().deleteProviderLine(id) };
  }

  @RequireAdminPermission('admin.page.coding_resale_config.manage')
  @Post('coding-plan/provider-lines/:id/test')
  async testCodingPlanProviderLine(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商线路连接成功', data: await this.codingPlanProviderAdmin().testProviderLine(id) };
  }

  @RequireAdminPermission('admin.page.coding_resale_config.manage')
  @Post('coding-plan/provider-lines/:id/sync-products')
  async syncCodingPlanProviderLineProducts(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商产品已同步', data: await this.codingPlanProviderAdmin().syncProviderProducts(id) };
  }

  @RequireAdminPermission('admin.data.coding_plan.view')
  @Get('coding-plan/provider-products')
  async listCodingPlanProviderProducts(
    @Query('providerLineId') providerLineId?: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.codingPlanProviderAdmin().listProviderProducts(this.normalizeNullableString(providerLineId)),
    };
  }

  @RequireAdminPermission('admin.data.coding_plan.view')
  @Get('coding-plan/resale-routes')
  async listCodingPlanResaleRoutes(
    @Query('planId') planId?: string,
    @Query('providerLineId') providerLineId?: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.codingPlanProviderAdmin().listResaleRoutes({
        planId: this.normalizeNullableString(planId),
        providerLineId: this.normalizeNullableString(providerLineId),
      }),
    };
  }

  @RequireAdminPermission('admin.page.coding_third_party_plans.manage')
  @Post('coding-plan/resale-plans')
  async createCodingPlanResalePlan(
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '三方转售套餐已创建',
      data: await this.billingAdmin.saveCodingPlanResalePlan(null, body),
    };
  }

  @RequireAdminPermission('admin.page.coding_third_party_plans.manage')
  @Put('coding-plan/resale-plans/:id')
  async updateCodingPlanResalePlan(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '三方转售套餐已保存',
      data: await this.billingAdmin.saveCodingPlanResalePlan(id, body),
    };
  }

  @RequireAdminPermission('admin.page.coding_resale_report.view')
  @Get('coding-plan/provider-entitlements')
  async listCodingPlanProviderEntitlements(
    @Query('status') status?: string,
    @Query('providerLineId') providerLineId?: string,
    @Query('providerLineCode') providerLineCode?: string,
    @Query('userId') userId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('orderId') orderId?: string,
    @Query('take') take?: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.codingPlanProviderAdmin().listProviderEntitlements({
        status: this.normalizeNullableString(status),
        providerLineId: this.normalizeNullableString(providerLineId),
        providerLineCode: this.normalizeNullableString(providerLineCode),
        userId: this.normalizeNullableString(userId),
        tenantId: this.normalizeNullableString(tenantId),
        orderId: this.normalizeNullableString(orderId),
        take: this.parseOptionalTake(take),
      }),
    };
  }

  @RequireAdminPermission('admin.page.coding_resale_report.manage')
  @Post('coding-plan/provider-entitlements/:id/retry')
  async retryCodingPlanProviderEntitlement(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '供应商履约已重试', data: await this.codingPlanProviderAdmin().retryProviderEntitlement(id) };
  }

  @RequireAdminPermission('admin.page.orders.view')
  @Get('orders')
  async listOrders(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      status?: string;
      userId?: string;
      productId?: string;
      orderType?: string;
      channel?: string;
      search?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const page = parseInt(query.page || '1', 10);
    const pageSize = parseInt(query.pageSize || '20', 10);
    const filters = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.orderType ? { orderType: query.orderType } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.search ? { search: query.search } : {}),
    };
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.listOrders(page, pageSize, filters),
    };
  }

  @RequireAdminPermission('admin.page.orders.view')
  @Get('orders/:id')
  async getOrder(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.getOrderDetail(id) };
  }

  @RequireAdminPermission('admin.page.users.view')
  @Get('users/:id/recent-orders')
  async listRecentOrdersForUser(
    @Param('id') userId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<ApiResponse<unknown>> {
    const limit = Math.min(Math.max(parsePositiveInteger(rawLimit, 5), 1), 20);
    const items = await this.billingAdmin.listRecentOrdersForUser(userId, limit);
    return { code: 0, message: 'ok', data: { items } };
  }

  @RequireAdminPermission('admin.page.orders.manage')
  @Post('orders/:id/cancel')
  async cancelOrder(
    @Param('id') id: string,
    @Body() body: { adminId: string; reason?: string },
  ): Promise<ApiResponse<null>> {
    await this.billingAdmin.adminCancelOrder(id, body.adminId, body.reason);
    return { code: 0, message: '订单已取消', data: null };
  }

  @RequireAdminPermission('admin.page.orders.manage')
  @Post('orders/:id/retry')
  async retryOrder(
    @Param('id') id: string,
    @Body() body: { adminId: string },
  ): Promise<ApiResponse<null>> {
    await this.billingAdmin.retryFailedOrder(id, body.adminId);
    return { code: 0, message: '重试已触发', data: null };
  }

  @RequireAdminPermission('admin.page.orders.manage')
  @Post('orders/:id/refund')
  async refundOrder(
    @Param('id') orderId: string,
    @Body() body: { reason: string },
  ): Promise<ApiResponse<unknown>> {
    if (!body.reason) throw new BadRequestException('退款原因为必填');
    const order = await this.billingAdmin.refundOrder(orderId, body.reason);
    return { code: 0, message: '退款成功', data: order };
  }

  @RequireAdminPermission('admin.page.dashboard.view')
  @Get('stats')
  async getStats(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.getStats() };
  }

  @RequireAdminPermission('admin.data.revenue.view')
  @Get('revenue')
  async getRevenue(@Query('productId') productId?: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.getRevenue(productId) };
  }

  @RequireAdminPermission('admin.data.revenue.view')
  @Get('revenue/overview')
  async getRevenueOverview(
    @Query('days') daysParam?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const days = parseInt(daysParam || '7', 10) || 7;
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getRevenueOverview(days, productId),
    };
  }

  @RequireAdminPermission('admin.data.finance_reports.view')
  @Get('finance-reports/dashboard')
  async getFinanceDashboard(@Query('month') month?: string): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getFinanceDashboard(month),
    };
  }

  @RequireAdminPermission('admin.data.finance_reports.view')
  @Get('finance-reports/overview')
  async getFinanceReportOverview(
    @Query('month') month?: string,
    @Query('billingMode') billingMode?: string,
    @Query('refresh') refreshParam?: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getCachedFinanceReportOverview(
        month,
        billingMode,
        refreshParam === 'true',
      ),
    };
  }

  @RequireAdminPermission('admin.data.finance_reports.view')
  @Get('finance-reports/details')
  async getFinanceReportDetail(
    @Query('month') month?: string,
    @Query('tab') tab?: string,
    @Query('billingMode') billingMode?: string,
    @Query('pageSize') pageSizeParam?: string,
    @Query('cursor') cursor?: string,
    @Query('filterField') filterField?: string,
    @Query('filterValue') filterValue?: string,
  ): Promise<ApiResponse<unknown>> {
    const pageSize = pageSizeParam === undefined ? undefined : Number(pageSizeParam);
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getFinanceReportDetail({
        month,
        tab,
        billingMode,
        pageSize,
        cursor,
        filterField,
        filterValue,
      }),
    };
  }

  @RequireAdminPermission('admin.data.finance_reports.export')
  @Post('finance-reports/export-jobs')
  async createFinanceReportExportJob(@Body() body: {
    month?: string;
    tab?: string;
    billingMode?: string;
    requestedByAdminId?: string | null;
  }): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.createFinanceReportExportJob(body ?? {}),
    };
  }

  @RequireAdminPermission('admin.page.finance_export_jobs.view')
  @Get('finance-reports/export-jobs')
  async listFinanceReportExportJobs(@Query('take') takeParam?: string): Promise<ApiResponse<unknown>> {
    const take = takeParam === undefined ? undefined : Number(takeParam);
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.listFinanceReportExportJobs({ take }),
    };
  }

  @RequireAdminPermission('admin.page.finance_export_jobs.view')
  @Get('finance-reports/export-jobs/:id')
  async getFinanceReportExportJob(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getFinanceReportExportJob(id),
    };
  }

  @RequireAdminPermission('admin.page.finance_reconciliation.manage')
  @Post('finance-reports/stripe-ledger/backfill')
  async backfillStripePaymentLedgers(@Body() body: {
    month?: string;
    limit?: number;
    dryRun?: boolean;
  }): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.backfillStripePaymentLedgers(body ?? {}),
    };
  }

  @RequireAdminPermission(
    'admin.page.finance_export_jobs.view',
    'admin.page.finance_export_jobs.download',
  )
  @Get('finance-reports/export-jobs/:id/download')
  async downloadFinanceReportExportJob(
    @Param('id') id: string,
    @Res() res: FastifyReply,
  ) {
    const file = await this.billingAdmin.downloadFinanceReportExportJob(id) as {
      filename: string;
      contentType: string;
      contentLength?: number | null;
      stream?: NodeJS.ReadableStream;
      content?: string | null;
    };
    res.header('content-type', file.contentType);
    res.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    if (file.contentLength != null) res.header('content-length', String(file.contentLength));
    return res.send(file.stream ?? file.content ?? '');
  }

  @RequireAdminPermission('admin.data.finance_reports.view')
  @Get('finance-reports')
  async getFinanceReports(@Query('month') month?: string): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.getFinanceReports(month),
    };
  }

  @RequireAdminPermission('admin.page.usage.view')
  @Get('transactions')
  async listTransactions(@Query() query: unknown): Promise<ApiResponse<unknown>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const userId = typeof query === 'object' && query && 'userId' in query
      ? String((query as { userId?: string }).userId || '').trim()
      : '';
    const productId = typeof query === 'object' && query && 'productId' in query
      ? String((query as { productId?: string }).productId || '').trim()
      : '';
    return {
      code: 0,
      message: 'ok',
      data: await this.billingAdmin.listTransactions(
        parsed.data.page,
        parsed.data.pageSize,
        userId || productId ? { ...(userId ? { userId } : {}), ...(productId ? { productId } : {}) } : undefined,
      ),
    };
  }

  @RequireAdminPermission('admin.page.subscription_accounts.view')
  @Get('subscriptions')
  async listSubscriptions(@Query() query: {
    page?: string;
    pageSize?: string;
    status?: string;
    expiringDays?: string;
    productId?: string;
    userId?: string;
  }): Promise<ApiResponse<unknown>> {
    const page = parseInt(query.page || '1', 10);
    const pageSize = parseInt(query.pageSize || '20', 10);
    const expiringDays = query.expiringDays ? parseInt(query.expiringDays, 10) : undefined;
    const data = await this.billingAdmin.listSubscriptions({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
      status: query.status,
      expiringDays: Number.isFinite(expiringDays) ? expiringDays : undefined,
      productId: query.productId,
      userId: query.userId,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.subscription_accounts.manage')
  @Post('subscriptions/:id/grant-credits')
  async grantSubscriptionCredits(
    @Param('id') subscriptionId: string,
    @Body() body: { amount: number; reason: string; idempotencyKey?: string },
  ): Promise<ApiResponse<unknown>> {
    const idempotencyKey = assertRequiredString(body.idempotencyKey, 'idempotencyKey');
    const data = await this.grantCreditsToSubscription(
      subscriptionId,
      body.amount,
      body.reason,
      idempotencyKey,
    );
    return { code: 0, message: '积分赠送成功', data };
  }

  @RequireAdminPermission('admin.page.payg_accounts.view')
  @Get('payg-accounts')
  async listPaygAccounts(@Query() query: {
    page?: string;
    pageSize?: string;
    search?: string;
    email?: string;
    status?: string;
    productId?: string;
  }): Promise<ApiResponse<unknown>> {
    const page = parseInt(query.page || '1', 10);
    const pageSize = parseInt(query.pageSize || '20', 10);
    const data = await this.billingAdmin.listPaygAccounts({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
      search: query.search,
      email: query.email,
      status: query.status,
      productId: query.productId,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.payg_accounts.manage')
  @Post('payg-accounts/:tenantId/issue-voucher')
  async issuePaygVoucher(
    @Param('tenantId') tenantIdParam: string,
    @Body() body: {
      userId?: string;
      productId?: string | null;
      amountCents?: number;
      reason?: string;
      expiresAt?: string | null;
      performedBy?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const tenantId = assertRequiredString(tenantIdParam, 'tenantId');
    const userId = assertRequiredString(body.userId, 'userId');
    const reason = assertRequiredString(body.reason, 'reason');
    const idempotencyKey = assertRequiredString(body.idempotencyKey, 'idempotencyKey');
    const amountCents = body.amountCents;
    assertManualVoucherAmount(amountCents, (await this.platformCurrency()).currencySymbol);
    const expiresAt = parseVoucherExpiresAt(body.expiresAt, 'expiresAt');
    const data = await this.billingService.issueVoucher(userId, amountCents, reason, {
      tenantId,
      productId: body.productId ?? null,
      expiresAt,
      performedBy: body.performedBy ?? null,
      idempotencyKey,
    });
    return { code: 0, message: '代金券发放成功', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.view')
  @Get('gateway-events')
  async listGatewayEvents(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      status?: string;
      requestId?: string;
      apiKeyId?: string;
      tenantId?: string;
      userId?: string;
      productId?: string;
      modelName?: string;
      evidenceVerdict?: string;
      reconciliationStatus?: string;
      fundingOutcome?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.listEvents(query);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.view')
  @Get('historical-platform-loss-batches')
  async listHistoricalPlatformLossBatches(
    @Query() query: {
      page?: string;
      pageSize?: string;
      status?: string;
      provider?: string;
      providerAccountRef?: string;
      region?: string;
      periodStart?: string;
      periodEnd?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().list(query);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.prepare')
  @Post('historical-platform-loss-batches/preview')
  async previewHistoricalPlatformLossBatch(
    @Body() body: HistoricalPlatformLossBatchInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().preview(body);
    return { code: 0, message: '历史差额批次预览已重算', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.prepare')
  @Post('historical-platform-loss-batches')
  async createHistoricalPlatformLossBatch(
    @Body() body: HistoricalPlatformLossBatchInput,
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().create(body, actorId);
    return { code: 0, message: '历史差额批次已创建，等待独立审批', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.approve_post')
  @RequireAdminPresetRole('finance', 'super_admin')
  @Post('historical-platform-loss-batches/:id/approve-and-post')
  async approveAndPostHistoricalPlatformLossBatch(
    @Param('id') batchId: string,
    @Body() body: HistoricalPlatformLossPostCommand,
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().approveAndPost(
      batchId,
      body,
      actorId,
    );
    return { code: 0, message: '历史差额已审批并由平台吸收', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.export')
  @Get('historical-platform-loss-batches/:id/export')
  async exportHistoricalPlatformLossBatch(
    @Param('id') batchId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().export(batchId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.historical_platform_losses.view')
  @Get('historical-platform-loss-batches/:id')
  async getHistoricalPlatformLossBatch(
    @Param('id') batchId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.requireHistoricalPlatformLossService().get(batchId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.view')
  @Get('gateway-events/:requestId')
  async getGatewayEvent(
    @Param('requestId') requestId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.getEvent(requestId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.retry')
  @Post('gateway-events/:requestId/retry')
  async retryGatewayEvent(
    @Param('requestId') requestId: string,
    @Body() body: {
      expectedRevision?: number;
      reason?: string;
      idempotencyKey?: string;
    },
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.retryEvent(requestId, {
      expectedRevision: body.expectedRevision as number,
      reason: body.reason ?? '',
      idempotencyKey: body.idempotencyKey ?? '',
      actorId,
    });
    return { code: 0, message: '重试已完成', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.review')
  @Post('gateway-events/:requestId/manual-review')
  async markGatewayEventManualReview(
    @Param('requestId') requestId: string,
    @Body() body: {
      expectedRevision?: number;
      reason?: string;
      idempotencyKey?: string;
    },
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.markManualReview(requestId, {
      expectedRevision: body.expectedRevision as number,
      reason: body.reason ?? '',
      idempotencyKey: body.idempotencyKey ?? '',
      actorId,
    });
    return { code: 0, message: '已进入人工复核', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.settle')
  @RequireAdminPresetRole('finance', 'super_admin')
  @Post('gateway-events/:requestId/reconcile-settle')
  async reconcileAndSettleGatewayEvent(
    @Param('requestId') requestId: string,
    @Body() body: {
      evidenceId?: string;
      expectedRevision?: number;
      reason?: string;
      idempotencyKey?: string;
    },
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.reconcileAndSettle(
      requestId,
      body.evidenceId as string,
      {
        expectedRevision: body.expectedRevision as number,
        reason: body.reason ?? '',
        idempotencyKey: body.idempotencyKey ?? '',
        actorId,
      },
    );
    return { code: 0, message: '权威证据已结算', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.absorb')
  @RequireAdminPresetRole('finance', 'super_admin')
  @Post('gateway-events/:requestId/absorb')
  async absorbGatewayEvent(
    @Param('requestId') requestId: string,
    @Body() body: {
      expectedRevision?: number;
      reason?: string;
      idempotencyKey?: string;
      protocol?: string;
      currencyRepairRunId?: string;
      currencyRepairItemId?: string;
      manifestHash?: string;
    },
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.absorb(requestId, {
      expectedRevision: body.expectedRevision as number,
      reason: body.reason ?? '',
      idempotencyKey: body.idempotencyKey ?? '',
      actorId,
      protocol: body.protocol,
      currencyRepairRunId: body.currencyRepairRunId,
      currencyRepairItemId: body.currencyRepairItemId,
      manifestHash: body.manifestHash,
    });
    return { code: 0, message: '平台吸收已记录', data };
  }

  @RequireAdminPermission('admin.page.gateway_billing_events.absorb')
  @RequireAdminPresetRole('finance', 'super_admin')
  @Post('gateway-events/:requestId/absorb-delta')
  async absorbGatewayEventDelta(
    @Param('requestId') requestId: string,
    @Body() body: {
      evidenceId?: string;
      expectedRevision?: number;
      reason?: string;
      idempotencyKey?: string;
    },
    @CurrentUser('id') actorId: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.gatewayRequestEventBilling.absorbTerminalDelta(
      requestId,
      body.evidenceId as string,
      {
        expectedRevision: body.expectedRevision as number,
        reason: body.reason ?? '',
        idempotencyKey: body.idempotencyKey ?? '',
        actorId,
      },
    );
    return { code: 0, message: '已结算请求的少计差额已由平台吸收', data };
  }

  @RequireAdminPermission('admin.page.publisher_sync_jobs.view')
  @Get('publisher-sync-jobs')
  async listPublisherSyncJobs(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      status?: string;
      namespace?: string;
      method?: string;
      path?: string;
      resourceType?: string;
      resourceId?: string;
      idempotencyKey?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const filters = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.namespace ? { namespace: query.namespace } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.path ? { path: query.path } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.idempotencyKey ? { idempotencyKey: query.idempotencyKey } : {}),
    };
    return {
      code: 0,
      message: 'ok',
      data: await this.publisherSyncJobs.listJobs({
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        ...filters,
      }),
    };
  }

  @RequireAdminPermission('admin.page.publisher_sync_jobs.view')
  @Get('publisher-sync-jobs/:id')
  async getPublisherSyncJob(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.publisherSyncJobs.getJob(id) };
  }

  @RequireAdminPermission('admin.page.publisher_sync_jobs.manage')
  @Post('publisher-sync-jobs/:id/retry')
  async retryPublisherSyncJob(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '重试已完成',
      data: await this.publisherSyncJobs.retryNow(id),
    };
  }

  @RequireAdminPermission('admin.page.publisher_sync_jobs.manage')
  @Post('publisher-sync-jobs/replay')
  async replayPublisherSync(
    @Body() body: { scope?: PublisherReplayScope },
  ): Promise<ApiResponse<unknown>> {
    const scope = body.scope || 'all';
    if (!['all', 'api_keys', 'key_balances', 'admin', 'platform'].includes(scope)) {
      throw new BadRequestException('scope 必须是 all/api_keys/key_balances/admin/platform');
    }
    return {
      code: 0,
      message: '重推已触发',
      data: await this.publisherSync.replayPublisherState(scope),
    };
  }

  @RequireAdminPermission('admin.catalog.plans.view')
  @Get('plans')
  async listPlans(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.listPlans() };
  }

  @RequireAdminPermission('admin.catalog.plans.view')
  @Get('plans/:id/prices')
  async listPlanPrices(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.listPlanPrices(id) };
  }

  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Put('plans/:id/prices/:currency')
  async upsertPlanPrice(
    @Param('id') id: string,
    @Param('currency') currency: string,
    @Body() body: {
      monthlyPrice: number;
      quarterlyPrice: number;
      yearlyPrice: number;
      isActive?: boolean;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.billingAdmin.upsertPlanPrice(id, { ...body, currency });
    return { code: 0, message: '保存成功', data };
  }

  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Delete('plans/:id/prices/:currency')
  async deletePlanPrice(
    @Param('id') id: string,
    @Param('currency') currency: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.billingAdmin.deletePlanPrice(id, currency);
    return { code: 0, message: '删除成功', data };
  }

  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Delete('plans/:id')
  async deletePlan(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.billingAdmin.deletePlan(id);
    return { code: 0, message: '删除成功', data };
  }

  @RequireAdminPermission('admin.catalog.plans.view')
  @Get('plans/:id')
  async getPlanById(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.getPlanById(id) };
  }

  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Post('plans')
  async createPlan(@Body() body: PlanWriteBody): Promise<ApiResponse<unknown>> {
    const result = await this.billingAdmin.createOrUpdatePlan(body);
    return { code: 0, message: result.message, data: result };
  }

  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Post('plans/:id')
  async updatePlan(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    const plan = await this.billingAdmin.updatePlan(id, body);
    return { code: 0, message: '更新成功', data: plan };
  }

  // 上架/下架窄写激活（finding #13）：自营套餐激活在 billing 侧原子权威校验绑定，
  // 只改 isActive，不整包 upsert。admin-api 的 publish/unpublish 走此端点。
  @RequireAdminPermission('admin.page.subscription_plans.manage')
  @Patch('plans/:id/active')
  async setPlanActive(
    @Param('id') id: string,
    @Body() body: { isActive?: unknown },
  ): Promise<ApiResponse<unknown>> {
    if (typeof body?.isActive !== 'boolean') {
      throw new BadRequestException('isActive 必须是布尔值');
    }
    const plan = await this.billingAdmin.setPlanActive(id, body.isActive);
    return { code: 0, message: body.isActive ? '已上架' : '已下架', data: plan };
  }

  @RequireAdminPermission('admin.page.bundles.view')
  @Get('bundles')
  async listBundles(@Query('isActive') isActive?: string): Promise<ApiResponse<unknown>> {
    const filters = isActive === undefined ? undefined : { isActive: isActive === 'true' };
    return { code: 0, message: 'ok', data: await this.billingAdmin.listBundleSkus(filters) };
  }

  @RequireAdminPermission('admin.page.bundles.view')
  @Get('bundles/:id')
  async getBundle(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.billingAdmin.getBundleSkuById(id) };
  }

  @RequireAdminPermission('admin.page.bundles.manage')
  @Post('bundles')
  async createBundle(@Body() body: unknown): Promise<ApiResponse<unknown>> {
    const parsed = createBundleSkuSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const data = await this.billingAdmin.createBundleSku(parsed.data);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.bundles.manage')
  @Put('bundles/:id')
  async updateBundle(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ApiResponse<unknown>> {
    const parsed = updateBundleSkuSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const data = await this.billingAdmin.updateBundleSku(id, parsed.data);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.bundles.manage')
  @Delete('bundles/:id')
  async deleteBundle(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.billingAdmin.deleteBundleSku(id);
    return {
      code: 0,
      message: data.disabled ? '组合套餐已停用' : '删除成功',
      data,
    };
  }

  @RequireAdminPermission('admin.page.campaigns.view')
  @Get('campaigns')
  async listCampaigns(@Query() query: {
    planId?: string;
    productId?: string;
    isActive?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.findAll({
      planId: query.planId,
      productId: query.productId,
      isActive: parseBooleanQuery(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.campaigns.view')
  @Get('campaigns/:id')
  async getCampaign(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.campaignService.findById(id) };
  }

  @RequireAdminPermission('admin.page.campaigns.view')
  @Get('campaigns/:id/stats')
  async getCampaignStats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.campaignService.stats(id) };
  }

  @RequireAdminPermission('admin.page.campaigns.manage')
  @Post('campaigns')
  async createCampaign(@Body() body: CreateCampaignInput): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.create(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.campaigns.manage')
  @Put('campaigns/:id')
  async updateCampaign(
    @Param('id') id: string,
    @Body() body: UpdateCampaignInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.update(id, body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.campaigns.manage')
  @Delete('campaigns/:id')
  async disableCampaign(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.disable(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.discount_codes.view')
  @Get('discount-codes')
  async listDiscountCodes(@Query('isActive') isActive?: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.findAll({
      isActive: parseBooleanQuery(isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.discount_codes.view')
  @Get('discount-codes/:id')
  async getDiscountCode(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.discountCodeService.findById(id) };
  }

  @RequireAdminPermission('admin.page.discount_codes.view')
  @Get('discount-codes/:id/stats')
  async getDiscountCodeStats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.discountCodeService.stats(id) };
  }

  @RequireAdminPermission('admin.page.discount_codes.manage')
  @Post('discount-codes')
  async createDiscountCode(@Body() body: CreateDiscountCodeInput): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.create(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.discount_codes.manage')
  @Put('discount-codes/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() body: UpdateDiscountCodeInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.update(id, body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.discount_codes.manage')
  @Delete('discount-codes/:id')
  async disableDiscountCode(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.disable(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/programs')
  async listReferralPrograms(): Promise<ApiResponse<unknown>> {
    const items = await this.referralsService.listPrograms();
    return { code: 0, message: 'ok', data: { items } };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Post('referrals/programs')
  async createReferralProgram(@Body() body: CreateProgramInput): Promise<ApiResponse<unknown>> {
    const data = await this.referralsService.createProgram(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Put('referrals/programs/:id')
  async updateReferralProgram(
    @Param('id') id: string,
    @Body() body: UpdateProgramInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.referralsService.updateProgram(id, body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Delete('referrals/programs/:id')
  async deleteReferralProgram(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.referralsService.deleteProgram(id);
    return { code: 0, message: 'ok', data: null };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Post('referrals/programs/:id/codes')
  async getReferralCodeForProgram(
    @Param('id') id: string,
    @Body() body: { inviterUser?: string; inviterUserId?: string; inviterEmail?: string },
  ): Promise<ApiResponse<unknown>> {
    const inviterUser = (
      body?.inviterUser ??
      body?.inviterUserId ??
      body?.inviterEmail ??
      ''
    ).trim();
    if (!inviterUser) {
      throw new BadRequestException('推广方邮箱或用户 ID 必填');
    }
    const normalizedEmail = inviterUser.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { id: inviterUser },
          { email: inviterUser },
          { email: normalizedEmail },
          { phone: inviterUser },
        ],
      },
      select: { id: true, email: true, phone: true },
    });
    if (!user) {
      throw new BadRequestException(
        '未找到推广方用户，请先创建推广专用用户，或输入正确的邮箱 / 用户 ID',
      );
    }
    const data = await this.referralsService.getMyReferralCode(user.id, id);
    return {
      code: 0,
      message: 'ok',
      data: {
        ...data,
        inviterUserId: user.id,
        inviterEmail: user.email,
        inviterPhone: user.phone,
      },
    };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/redemptions')
  async listReferralRedemptions(@Query() query: {
    programId?: string;
    inviterUserId?: string;
    triggered?: string | boolean;
    page?: string;
    pageSize?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.referralsService.listRedemptions({
      programId: query.programId?.trim() || undefined,
      inviterUserId: query.inviterUserId?.trim() || undefined,
      triggered: parseBooleanQuery(query.triggered),
      page: parsePositiveInteger(query.page, 1),
      pageSize: parsePositiveInteger(query.pageSize, 20),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/leaderboard')
  async referralLeaderboard(@Query() query: {
    programId?: string;
    days?: string;
  }): Promise<ApiResponse<unknown>> {
    const days = query.days ? parseInt(query.days, 10) : undefined;
    const data = await this.referralsService.leaderboard({
      programId: query.programId?.trim() || undefined,
      days: Number.isFinite(days as number) ? (days as number) : undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/summary')
  async referralSummary(@Query() query: {
    programId?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.referralsService.summary({
      programId: query.programId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/click-sources')
  async referralClickSources(@Query() query: {
    programId?: string;
  }): Promise<ApiResponse<unknown>> {
    const programId = query.programId?.trim();
    if (!programId) {
      throw new BadRequestException('programId 必填');
    }
    const data = await this.referralsService.clickSources({ programId });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('referrals/codes')
  async referralCodes(@Query() query: {
    programId?: string;
  }): Promise<ApiResponse<unknown>> {
    const programId = query.programId?.trim();
    if (!programId) {
      throw new BadRequestException('programId 必填');
    }
    const items = await this.referralsService.listCodes(programId);
    return { code: 0, message: 'ok', data: { items } };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('quota-templates')
  async listQuotaTemplates(@Query() query: {
    page?: string;
    pageSize?: string;
    search?: string;
    isActive?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.list({
      page: parsePositiveInteger(query.page, 1),
      pageSize: parsePositiveInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      isActive: parseBooleanQuery(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Post('quota-templates')
  async createQuotaTemplate(@Body() body: CreateTemplateInput): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.create(body);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('quota-templates/plan/:planId/rules')
  async listPlanQuotaRules(@Param('planId') planId: string): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.listPlanRules(planId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Put('quota-templates/plan/:planId/rules')
  async replacePlanQuotaRules(
    @Param('planId') planId: string,
    @Body() body: { templateIds?: string[] },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.replacePlanRules(planId, body.templateIds ?? []);
    return { code: 0, message: '保存成功', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('quota-templates/:id')
  async getQuotaTemplate(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.quotaTemplatesService.getById(id) };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Put('quota-templates/:id')
  async updateQuotaTemplate(
    @Param('id') id: string,
    @Body() body: UpdateTemplateInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.update(id, body);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Delete('quota-templates/:id')
  async deleteQuotaTemplate(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.quotaTemplatesService.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.manage')
  @Post('quota-templates/:id/clone')
  async cloneQuotaTemplate(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.clone(id);
    return { code: 0, message: '已复制', data };
  }

  @RequireAdminPermission('admin.page.coding_quota_templates.view')
  @Get('quota-templates/:id/references')
  async getQuotaTemplateReferences(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.quotaTemplatesService.references(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get('grant-rules')
  async listGrantRules(@Query() query: {
    page?: string;
    pageSize?: string;
    search?: string;
    triggerType?: string;
    isActive?: string;
    segmentId?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.creditGrantsService.list({
      page: parsePositiveInteger(query.page, 1),
      pageSize: parsePositiveInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      triggerType: query.triggerType as GrantTriggerType | undefined,
      isActive: parseBooleanQuery(query.isActive),
      segmentId: query.segmentId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post('grant-rules')
  async createGrantRule(@Body() body: GrantRuleBody): Promise<ApiResponse<unknown>> {
    if (!body?.name) throw new BadRequestException('name 必填');
    if (!body.triggerType) throw new BadRequestException('triggerType 必填');
    if (!body.rewardType) throw new BadRequestException('rewardType 必填');
    if (typeof body.rewardAmount !== 'number') {
      throw new BadRequestException('rewardAmount 必填');
    }
    if (!body.expirePolicy) throw new BadRequestException('expirePolicy 必填');
    const input: CreateGrantRuleInput = {
      name: body.name,
      triggerType: body.triggerType,
      cronExpr: body.cronExpr ?? null,
      segmentId: body.segmentId ?? null,
      rewardType: body.rewardType,
      rewardAmount: body.rewardAmount,
      productId: body.productId ?? null,
      expirePolicy: body.expirePolicy,
      expireDays: body.expireDays ?? null,
      perUserLimit: body.perUserLimit ?? 1,
      globalDailyCap: body.globalDailyCap ?? null,
      isActive: body.isActive ?? true,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
      notifyType: body.notifyType ?? null,
      notifyTemplate: body.notifyTemplate ?? null,
    };
    const data = await this.creditGrantsService.create(input);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get('grant-rules/:id')
  async getGrantRule(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.creditGrantsService.getById(id) };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Put('grant-rules/:id')
  async updateGrantRule(
    @Param('id') id: string,
    @Body() body: UpdateGrantRuleInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.creditGrantsService.update(id, body);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Delete('grant-rules/:id')
  async deleteGrantRule(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.creditGrantsService.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Post('grant-rules/:id/preview')
  async previewGrantRule(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.creditGrantsService.preview(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post('grant-rules/:id/manual-trigger')
  async manualTriggerGrantRule(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const rule = await this.creditGrantsService.getById(id);
    const result = await this.creditGrantExecutor.executeRule(rule, {
      manualTrigger: true,
    });
    return { code: 0, message: '已触发', data: result };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post('grant-rules/:id/trigger')
  async triggerGrantRule(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return this.manualTriggerGrantRule(id);
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get('grant-rules/:id/redemptions')
  async listGrantRedemptions(
    @Param('id') id: string,
    @Query() query: { page?: string; pageSize?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.creditGrantsService.listRedemptions(
      id,
      parsePositiveInteger(query.page, 1),
      parsePositiveInteger(query.pageSize, 20),
    );
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('credit-policy/global')
  async getCreditPolicyGlobal(@Query('productId') productId: string): Promise<ApiResponse<unknown>> {
    if (!productId) throw new BadRequestException('productId 必填');
    const data = await this.creditPolicyService.getGlobal(productId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.manage')
  @Put('credit-policy/global')
  async upsertCreditPolicyGlobal(@Body() body: CreditPolicyBody): Promise<ApiResponse<unknown>> {
    const productId = (body?.productId ?? '').toString().trim();
    if (!productId) throw new BadRequestException('productId 必填');
    const data = await this.creditPolicyService.upsertGlobal(
      productId,
      pickCreditPolicyWriteInput(body),
    );
    return { code: 0, message: '已保存', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('credit-policy/segments')
  async listCreditPolicySegments(@Query('productId') productId: string): Promise<ApiResponse<unknown>> {
    if (!productId) throw new BadRequestException('productId 必填');
    const items = await this.creditPolicyService.listSegments(productId);
    return { code: 0, message: 'ok', data: { items } };
  }

  @RequireAdminPermission('admin.page.credit_policy.manage')
  @Post('credit-policy/segments')
  async upsertCreditPolicySegment(@Body() body: CreditPolicyBody): Promise<ApiResponse<unknown>> {
    const productId = (body?.productId ?? '').toString().trim();
    const segmentId = (body?.segmentId ?? '').toString().trim();
    if (!productId) throw new BadRequestException('productId 必填');
    if (!segmentId) throw new BadRequestException('segmentId 必填');
    const data = await this.creditPolicyService.upsertSegment({
      productId,
      segmentId,
      data: pickCreditPolicyWriteInput(body),
    });
    return { code: 0, message: '已保存', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('credit-policy/overdue-users')
  async listCreditPolicyOverdueUsers(@Query() query: {
    productId?: string;
    page?: string;
    pageSize?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.creditPolicyService.listOverdueUsers({
      productId: query.productId?.trim() || undefined,
      page: parsePositiveInteger(query.page, 1),
      pageSize: parsePositiveInteger(query.pageSize, 20),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.funnel.view')
  @Get('funnel')
  async getOverallFunnel(@Query() query: {
    days?: string;
    segmentId?: string;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.funnelService.getOverallFunnel({
      days: parsePositiveInteger(query.days, 30),
      segmentId: query.segmentId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.funnel.view')
  @Get('funnel/subscription')
  async getSubscriptionFunnel(@Query('days') days?: string): Promise<ApiResponse<unknown>> {
    const data = await this.funnelService.getSubscriptionFunnel({
      days: parsePositiveInteger(days, 30),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.funnel.view')
  @Get('funnel/payg')
  async getPaygFunnel(@Query('days') days?: string): Promise<ApiResponse<unknown>> {
    const data = await this.funnelService.getPaygFunnel({
      days: parsePositiveInteger(days, 30),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.products.view')
  @Get('products')
  async listProducts(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productService.findAll() };
  }

  @NoAdminPermissionRequired()
  @Get('products/default')
  async getDefaultProduct(
    @Query('billingMode') billingMode: ProductBillingModeInput = 'PAY_AS_YOU_GO',
    @Query('productId') productId?: string,
    @Query('productSlug') productSlug?: string,
    @Query('codingPlanFulfillmentMode') codingPlanFulfillmentMode?: CodingPlanFulfillmentModeInput,
    @Query('fulfillmentMode') fulfillmentMode?: CodingPlanFulfillmentModeInput,
  ): Promise<ApiResponse<unknown>> {
    if (!PRODUCT_BILLING_MODES.includes(billingMode)) {
      throw new BadRequestException('billingMode 必须是 SUBSCRIPTION / PAY_AS_YOU_GO / CODING_PLAN 之一');
    }
    const requestedFulfillmentMode = codingPlanFulfillmentMode ?? fulfillmentMode;
    if (requestedFulfillmentMode && !CODING_PLAN_FULFILLMENT_MODES.includes(requestedFulfillmentMode)) {
      throw new BadRequestException('codingPlanFulfillmentMode 必须是 platform_model_package / provider_resale 之一');
    }
    const product = await this.productService.resolveDefaultProduct({
      billingMode,
      productId,
      productSlug,
      codingPlanFulfillmentMode: requestedFulfillmentMode,
    });
    return { code: 0, message: 'ok', data: product };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Post('products')
  async createProduct(@Body() body: {
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    webhookUrl?: string | null;
    allowedPaymentCallbackOrigins?: string[] | null;
    defaultPlanId?: string | null;
    billingMode?: 'SUBSCRIPTION' | 'PAY_AS_YOU_GO' | 'CODING_PLAN';
    codingPlanFulfillmentMode?: CodingPlanFulfillmentModeInput | null;
    fulfillmentMode?: CodingPlanFulfillmentModeInput | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<ApiResponse<unknown>> {
    if (!body.name || !body.slug) throw new BadRequestException('name, slug 为必填');
    if (body.billingMode && !['SUBSCRIPTION', 'PAY_AS_YOU_GO', 'CODING_PLAN'].includes(body.billingMode)) {
      throw new BadRequestException('billingMode 必须是 SUBSCRIPTION / PAY_AS_YOU_GO / CODING_PLAN 之一');
    }
    const requestedFulfillmentMode = body.codingPlanFulfillmentMode ?? body.fulfillmentMode;
    if (requestedFulfillmentMode && !CODING_PLAN_FULFILLMENT_MODES.includes(requestedFulfillmentMode)) {
      throw new BadRequestException('codingPlanFulfillmentMode 必须是 platform_model_package / provider_resale 之一');
    }
    const product = await this.productService.create(body);
    return { code: 0, message: '创建成功', data: product };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Put('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: {
    name?: string;
    description?: string;
    icon?: string;
    webhookUrl?: string | null;
    allowedPaymentCallbackOrigins?: string[] | null;
    defaultPlanId?: string | null;
    billingMode?: 'SUBSCRIPTION' | 'PAY_AS_YOU_GO' | 'CODING_PLAN';
    codingPlanFulfillmentMode?: CodingPlanFulfillmentModeInput | null;
    fulfillmentMode?: CodingPlanFulfillmentModeInput | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<ApiResponse<unknown>> {
    if (body.billingMode && !['SUBSCRIPTION', 'PAY_AS_YOU_GO', 'CODING_PLAN'].includes(body.billingMode)) {
      throw new BadRequestException('billingMode 必须是 SUBSCRIPTION / PAY_AS_YOU_GO / CODING_PLAN 之一');
    }
    const requestedFulfillmentMode = body.codingPlanFulfillmentMode ?? body.fulfillmentMode;
    if (requestedFulfillmentMode && !CODING_PLAN_FULFILLMENT_MODES.includes(requestedFulfillmentMode)) {
      throw new BadRequestException('codingPlanFulfillmentMode 必须是 platform_model_package / provider_resale 之一');
    }
    const product = await this.productService.update(id, body);
    return { code: 0, message: '更新成功', data: product };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Get('products/:id/integration')
  async getProductIntegration(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productService.getIntegrationStatus(id) };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('products/:id/runtime-policy')
  async getProductRuntimePolicy(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productService.getRuntimePolicy(id) };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Put('products/:id/runtime-policy')
  async updateProductRuntimePolicy(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '产品运行策略已保存', data: await this.productService.updateRuntimePolicy(id, body) };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Post('products/:id/integration-token/rotate')
  async rotateProductIntegrationToken(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '产品接入令牌已生成', data: await this.productService.rotateIntegrationToken(id) };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Post('products/:id/webhook-secret/rotate')
  async rotateProductWebhookSecret(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '产品 Webhook Secret 已生成', data: await this.productService.rotateWebhookSecret(id) };
  }

  @RequireAdminPermission('admin.page.products.manage')
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.productService.delete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.view')
  @Get('recharge-tiers/products')
  async listRechargeTierProducts(): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.rechargeTiersService.listPaygProducts(),
    };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.view')
  @Get('recharge-tiers')
  async listRechargeTiers(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      productId?: string;
      isActive?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.rechargeTiersService.list({
      page: parsePositiveInteger(query.page, 1),
      pageSize: parsePositiveInteger(query.pageSize, 20),
      productId: query.productId?.trim() || undefined,
      isActive: parseBooleanQuery(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Post('recharge-tiers')
  async createRechargeTier(@Body() body: RechargeTierBody): Promise<ApiResponse<unknown>> {
    if (!body?.productId) throw new BadRequestException('productId 必填');
    if (typeof body.amountCents !== 'number') {
      throw new BadRequestException('amountCents 必填');
    }
    if (!body.bonusType) throw new BadRequestException('bonusType 必填');
    if (typeof body.bonusValue !== 'number') {
      throw new BadRequestException('bonusValue 必填');
    }
    const data = await this.rechargeTiersService.create({
      productId: body.productId,
      amountCents: body.amountCents,
      bonusType: body.bonusType,
      bonusValue: body.bonusValue,
      badge: body.badge ?? null,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
    });
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.view')
  @Get('recharge-tiers/:id')
  async getRechargeTier(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.rechargeTiersService.getById(id),
    };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Put('recharge-tiers/:id')
  async updateRechargeTier(
    @Param('id') id: string,
    @Body() body: RechargeTierBody,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.rechargeTiersService.update(id, {
      productId: body.productId,
      amountCents: body.amountCents,
      bonusType: body.bonusType,
      bonusValue: body.bonusValue,
      badge: body.badge,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
      startAt: body.startAt,
      endAt: body.endAt,
    });
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Delete('recharge-tiers/:id')
  async deleteRechargeTier(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.rechargeTiersService.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Post('recharge-tiers/:id/clone')
  async cloneRechargeTier(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.rechargeTiersService.clone(id);
    return { code: 0, message: '已复制', data };
  }

  @RequireAdminPermission('admin.catalog.booster_packs.view')
  @Get('booster-packs')
  async listBoosterPacks(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.boosterPackService.findAll() };
  }

  @RequireAdminPermission('admin.page.subscription_booster_packs.manage')
  @Post('booster-packs')
  async createBoosterPack(@Body() body: {
    productId?: string;
    name: string;
    description?: string;
    creditsAmount: number;
    priceCents: number;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<ApiResponse<unknown>> {
    if (!body.name) throw new BadRequestException('name 为必填');
    const pack = await this.boosterPackService.create(body);
    return { code: 0, message: '创建成功', data: pack };
  }

  @RequireAdminPermission('admin.page.subscription_booster_packs.manage')
  @Put('booster-packs/:id')
  async updateBoosterPack(@Param('id') id: string, @Body() body: {
    name?: string;
    description?: string;
    creditsAmount?: number;
    priceCents?: number;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<ApiResponse<unknown>> {
    const pack = await this.boosterPackService.update(id, body);
    return { code: 0, message: '更新成功', data: pack };
  }

  @RequireAdminPermission('admin.page.subscription_booster_packs.manage')
  @Delete('booster-packs/:id')
  async deleteBoosterPack(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.boosterPackService.delete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.users.view')
  @Get('users/:id/balance')
  async getUserBalance(@Param('id') userId: string): Promise<ApiResponse<unknown>> {
    const balanceCents = await this.billingService.getBalance(userId);
    return { code: 0, message: 'ok', data: { userId, balanceCents } };
  }

  @NoAdminPermissionRequired()
  @Post('workspaces/balances')
  async getWorkspaceBalances(
    @Body() body: { tenantIds?: unknown },
  ): Promise<ApiResponse<unknown>> {
    const tenantIds = this.normalizeStringIds(body.tenantIds);

    if (tenantIds.length === 0) {
      return { code: 0, message: 'ok', data: [] };
    }

    const [balanceRows, usageRows, platformCurrency] = await Promise.all([
      Promise.all(tenantIds.map((tenantId) => this.billingService.getWorkspaceBalanceReport(tenantId))),
      this.prisma.tokenUsage.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds } },
        _sum: { totalTokens: true, costUsd: true },
      }),
      this.platformCurrency(),
    ]);
    const balanceByTenant = new Map(balanceRows.map((row) => [row.tenantId, row]));
    const usageByTenant = new Map(
      usageRows
        .filter((row) => row.tenantId)
        .map((row) => [
          row.tenantId as string,
          {
            totalTokens: row._sum.totalTokens ?? 0,
            costUsd: usdNumber(row._sum.costUsd ?? 0),
          },
        ]),
    );

    return {
      code: 0,
      message: 'ok',
      data: tenantIds.map((tenantId) => {
        const balance = balanceByTenant.get(tenantId);
        const usage = usageByTenant.get(tenantId);
        return {
          tenantId,
          balanceCents: balance?.balanceCents ?? 0,
          balanceUsd: balance?.balanceUsd ?? 0,
          accountBalanceCents: balance?.accountBalanceCents ?? 0,
          accountBalanceUsd: balance?.accountBalanceUsd ?? 0,
          currency: platformCurrency.currency,
          currencyCode: platformCurrency.currencyCode,
          currencySymbol: platformCurrency.currencySymbol,
          allowanceCents: balance?.allowanceCents ?? null,
          allowanceUsd: balance?.allowanceUsd ?? null,
          allowanceUsedCents: balance?.allowanceUsedCents ?? 0,
          allowanceUsedUsd: balance?.allowanceUsedUsd ?? 0,
          allowanceRemainingCents: balance?.allowanceRemainingCents ?? null,
          allowanceRemainingUsd: balance?.allowanceRemainingUsd ?? null,
          totalTokens: usage?.totalTokens ?? 0,
          costUsd: usage?.costUsd ?? 0,
        };
      }),
    };
  }

  @NoAdminPermissionRequired()
  @Put('workspaces/:tenantId/allowance')
  async updateWorkspaceAllowance(
    @Param('tenantId') tenantId: string,
    @Body() body: { allowanceCents?: unknown },
  ): Promise<ApiResponse<unknown>> {
    const allowanceCents = this.normalizeAllowanceCents(body.allowanceCents);
    const data = await this.billingService.updateWorkspaceAllowance(tenantId, allowanceCents);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.users.view')
  @Get('users/:id/credit-overview')
  async getUserCreditOverview(@Param('id') userId: string): Promise<ApiResponse<unknown>> {
    const balanceCents = await this.billingService.getBalance(userId).catch(() => 0);
    const sharedGrant = await this.creditService
      .getBalances('', userId)
      .then((v) => v.grant ?? v.total ?? 0)
      .catch(() => 0);
    const subscriptions = await this.prisma.subscriptionPeriod.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        product: { select: { id: true, name: true, slug: true, billingMode: true } },
        plan: {
          select: {
            id: true,
            name: true,
            monthlyPrice: true,
            quarterlyPrice: true,
            yearlyPrice: true,
            monthlyCredits: true,
          },
        },
      },
    });
    const subscriptionCredits = await Promise.all(
      subscriptions.map(async (sub) => {
        const summary = await this.creditService.getSummary(sub.id, userId).catch(() => null);
        return {
          subscriptionId: sub.id,
          status: sub.status,
          startedAt: sub.startedAt.toISOString(),
          expiresAt: sub.expiresAt?.toISOString() ?? null,
          product: {
            id: sub.product.id,
            name: sub.product.name,
            slug: sub.product.slug,
            billingMode: sub.product.billingMode,
          },
          plan: {
            id: sub.plan.id,
            name: sub.plan.name,
            monthlyPrice: sub.plan.monthlyPrice,
            quarterlyPrice: sub.plan.quarterlyPrice,
            yearlyPrice: sub.plan.yearlyPrice,
            monthlyCredits: sub.plan.monthlyCredits,
          },
          quotaCredits: summary?.quotaCredits ?? 0,
          bonusCredits: summary?.bonusCredits ?? 0,
          usedThisMonth: summary?.usedThisCycle ?? summary?.usedThisMonth ?? 0,
          billingCycleStart: summary?.billingCycleStart ?? null,
        };
      }),
    );
    return {
      code: 0,
      message: 'ok',
      data: { userId, balanceCents, sharedGrantCredits: sharedGrant, subscriptionCredits },
    };
  }

  @RequireAdminPermission('admin.page.users.manage')
  @Post('users/:id/credit-reconcile')
  async reconcileUserCredits(
    @Param('id') userId: string,
    @Body() body: { fix?: boolean } = {},
  ): Promise<ApiResponse<unknown>> {
    const data = await this.creditService.reconcileUserCreditCache(userId, {
      fix: body.fix === true,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.monitoring.view')
  @Get('reconciliation/accounting')
  async getAccountingReconciliation(
    @Query() query: {
      sampleLimit?: string;
      toleranceUsd?: string;
      providerCostWindowHours?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    if (!this.accountingReconciliation) {
      throw new BadRequestException('账务对账服务未启用');
    }
    const sampleLimit = query.sampleLimit ? Number(query.sampleLimit) : undefined;
    const providerCostWindowHours = query.providerCostWindowHours
      ? Number(query.providerCostWindowHours)
      : undefined;
    const data = await this.accountingReconciliation.buildReport({
      sampleLimit,
      toleranceUsd: this.normalizeNullableString(query.toleranceUsd) ?? undefined,
      providerCostWindowHours,
    });
    return { code: 0, message: 'ok', data };
  }

  @NoAdminPermissionRequired()
  @Get('api-keys/mirror')
  async listMirroredApiKeys(
    @Query()
    query: {
      userId?: string;
      tenantId?: string;
      productId?: string;
      apiKeyIds?: string | string[];
      ids?: string | string[];
      includeDeleted?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const userId = this.normalizeNullableString(query.userId);
    const tenantId = this.normalizeNullableString(query.tenantId);
    const productId = this.normalizeNullableString(query.productId);
    const apiKeyIds = this.normalizeQueryStringIds(query.apiKeyIds ?? query.ids);
    const includeDeleted = query.includeDeleted === 'true';
    if (!userId && !tenantId && apiKeyIds.length === 0) {
      throw new BadRequestException('userId、tenantId 或 apiKeyIds 至少需要一个');
    }

    const where: Prisma.ApiKeyWhereInput = {
      ...(userId ? { userId } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(productId ? { productId } : {}),
      ...(apiKeyIds.length > 0 ? { id: { in: apiKeyIds } } : {}),
      ...(includeDeleted ? {} : { deletedAt: null }),
    };

    const keys = await this.prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        productId: true,
        codingPlanEntitlementId: true,
        name: true,
        prefix: true,
        isActive: true,
        allowedModels: true,
        budgetUsd: true,
        expiresAt: true,
        ipWhitelist: true,
        rateLimitRpm: true,
        rateLimitTpm: true,
        concurrencyLimit: true,
        sseConcurrency: true,
        maxTokensPerCall: true,
        maxMessages: true,
        allowTools: true,
        allowVision: true,
        mirrorStatus: true,
        mirrorError: true,
        sourceUpdatedAt: true,
        mirroredAt: true,
        activatedAt: true,
        lastUsedAt: true,
        createdAt: true,
        deletedAt: true,
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            billingMode: true,
          },
        },
      },
    });
    const ids = keys.map((key) => key.id);
    const usageRows = ids.length
      ? await this.prisma.tokenUsage.groupBy({
          by: ['apiKeyId'],
          where: { apiKeyId: { in: ids } },
          _sum: { costUsd: true },
        })
      : [];
    const usageMap = new Map(
      usageRows.map((row) => [row.apiKeyId, usdNumber(row._sum.costUsd ?? 0)]),
    );

    return {
      code: 0,
      message: 'ok',
      data: keys.map((key) => {
        const usageUsd = usageMap.get(key.id) ?? 0;
        return {
          id: key.id,
          userId: key.userId,
          tenantId: key.tenantId,
          productId: key.productId,
          codingPlanEntitlementId: key.codingPlanEntitlementId,
          productName: key.product?.name ?? null,
          productSlug: key.product?.slug ?? null,
          productBillingMode: key.product?.billingMode ?? null,
          name: key.name,
          prefix: key.prefix,
          isActive: key.isActive,
          allowedModels: this.parseNullableStringArray(key.allowedModels),
          budgetUsd: key.budgetUsd == null ? null : usdNumber(key.budgetUsd),
          budgetCents: key.budgetUsd == null ? null : usdToCents(key.budgetUsd),
          usageUsd,
          usageCents: Math.round(usageUsd * 100),
          expiresAt: key.expiresAt?.toISOString() ?? null,
          ipWhitelist: this.parseNullableStringArray(key.ipWhitelist),
          rateLimitRpm: key.rateLimitRpm,
          rateLimitTpm: key.rateLimitTpm,
          concurrencyLimit: key.concurrencyLimit,
          sseConcurrency: key.sseConcurrency,
          maxTokensPerCall: key.maxTokensPerCall,
          maxMessages: key.maxMessages,
          allowTools: key.allowTools,
          allowVision: key.allowVision,
          provisioningStatus: key.mirrorStatus,
          provisioningError: key.mirrorError,
          sourceUpdatedAt: key.sourceUpdatedAt?.toISOString() ?? null,
          mirroredAt: key.mirroredAt?.toISOString() ?? null,
          activatedAt: key.activatedAt?.toISOString() ?? null,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
          deletedAt: key.deletedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  @NoAdminPermissionRequired()
  @Put('api-keys/:id/mirror')
  async mirrorApiKey(
    @Param('id') id: string,
    @Body() body: ApiKeyMirrorInput,
  ): Promise<ApiResponse<unknown>> {
    if (!id || body.id !== id) throw new BadRequestException('apiKey id 不一致');
    if (!body.userId || !body.name || !body.prefix || !body.keyHash) {
      throw new BadRequestException('userId, name, prefix, keyHash 为必填');
    }

    const user = await this.prisma.user.findUnique({ where: { id: body.userId } });
    if (!user) throw new BadRequestException('用户镜像不存在，请先同步用户');

    const requestedEntitlementId = this.normalizeNullableString(body.codingPlanEntitlementId);
    const tenantId = await this.resolveRequiredTenantId(body.tenantId);
    const productId = await this.resolveApiKeyMirrorProductId(
      id,
      body.productId,
      body.productSlug,
      !requestedEntitlementId,
    );
    const entitlement = requestedEntitlementId
      ? await this.resolveApiKeyCodingPlanEntitlement(requestedEntitlementId, tenantId, productId)
      : null;
    const effectiveProductId = productId ?? entitlement?.productId ?? null;
    const deletedAt = this.parseOptionalDate(body.deletedAt);
    const isActive = body.isActive !== false && !deletedAt;
    const mirrorStatus = deletedAt ? 'REVOKED' : isActive ? 'ACTIVE' : 'SUSPENDED';
    const mirroredAt = new Date();
    const data = {
      userId: body.userId,
      tenantId,
      productId: effectiveProductId,
      codingPlanEntitlementId: entitlement?.id ?? null,
      name: body.name,
      prefix: body.prefix,
      keyHash: body.keyHash,
      isActive,
      allowedModels: body.allowedModels ?? null,
      budgetUsd: body.budgetUsd == null || body.budgetUsd === ''
        ? null
        : String(body.budgetUsd),
      expiresAt: this.parseOptionalDate(body.expiresAt),
      ipWhitelist: this.normalizeStringArrayJson(body.ipWhitelist),
      rateLimitRpm: this.normalizeOptionalInt(body.rateLimitRpm, 'rateLimitRpm'),
      rateLimitTpm: this.normalizeOptionalInt(body.rateLimitTpm, 'rateLimitTpm'),
      concurrencyLimit: this.normalizeOptionalInt(body.concurrencyLimit, 'concurrencyLimit'),
      sseConcurrency: this.normalizeOptionalInt(body.sseConcurrency, 'sseConcurrency'),
      maxTokensPerCall: this.normalizeOptionalInt(body.maxTokensPerCall, 'maxTokensPerCall'),
      maxMessages: this.normalizeOptionalInt(body.maxMessages, 'maxMessages'),
      allowTools: body.allowTools ?? true,
      allowVision: body.allowVision ?? true,
      mirrorStatus,
      mirrorError: null,
      sourceUpdatedAt: this.parseOptionalDate(body.sourceUpdatedAt),
      mirroredAt,
      ...(mirrorStatus === 'ACTIVE' ? { activatedAt: mirroredAt } : {}),
      lastUsedAt: this.parseOptionalDate(body.lastUsedAt),
      deletedAt,
    };

    const apiKey = isActive && entitlement
      ? await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM coding_plan_entitlements WHERE id = ${entitlement.id} FOR UPDATE`;
          const lockedEntitlement =
            await this.resolveApiKeyCodingPlanEntitlement(
              entitlement.id,
              tenantId,
              productId,
              tx,
            );
          if (lockedEntitlement.fulfillmentMode === 'provider_resale') {
            const activeKeyLimit = this.codingPlanKeysPerEntitlementLimit();
            const activeKeyCount = await tx.apiKey.count({
              where: {
                codingPlanEntitlementId: lockedEntitlement.id,
                isActive: true,
                deletedAt: null,
                id: { not: id },
              },
            });
            if (activeKeyCount >= activeKeyLimit) {
              throw new BadRequestException(
                `CodingPlan 转售权益最多允许 ${activeKeyLimit} 把 active API Key`,
              );
            }
          }
          const lockedData = {
            ...data,
            productId: lockedEntitlement.productId,
            codingPlanEntitlementId: lockedEntitlement.id,
          };
          return tx.apiKey.upsert({
            where: { id },
            update: lockedData,
            create: { id, ...lockedData },
          });
        })
      : await this.prisma.apiKey.upsert({
          where: { id },
          update: data,
          create: { id, ...data },
        });
    await this.publisherSync.syncApiKeyMetaByIdRequired(apiKey.id);
    return { code: 0, message: 'ok', data: { id: apiKey.id, provisioningStatus: mirrorStatus } };
  }

  @NoAdminPermissionRequired()
  @Delete('api-keys/:id/mirror')
  async revokeMirroredApiKey(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const now = new Date();
    await this.prisma.apiKey.updateMany({
      where: { id },
      data: {
        isActive: false,
        deletedAt: now,
        mirrorStatus: 'REVOKED',
        mirrorError: null,
        mirroredAt: now,
      },
    });
    const existing = await this.prisma.apiKey.findUnique({
      where: { id },
      select: { id: true, keyHash: true },
    });
    if (existing) {
      await this.publisherSync.revokeApiKeyRequired(existing);
    } else {
      await this.publisherSync.syncKeyBalanceByIdRequired(id);
    }
    return { code: 0, message: 'ok', data: null };
  }

  @NoAdminPermissionRequired()
  @Get('coding-plan/entitlements/:id')
  async getCodingPlanEntitlementMirror(
    @Param('id') id: string,
    @Query('userId') userId?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const normalizedUserId = this.normalizeNullableString(userId);
    const normalizedProductId = this.normalizeNullableString(productId);
    const entitlement = await this.prisma.codingPlanEntitlement.findFirst({
      where: {
        id,
        ...(normalizedProductId ? { productId: normalizedProductId } : {}),
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        productId: true,
        planId: true,
        fulfillmentMode: true,
        billingPeriod: true,
        status: true,
        expiresAt: true,
        providerEntitlement: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });
    if (!entitlement) {
      throw new BadRequestException('CodingPlan 权益不存在或不可用');
    }
    if (
      entitlement.fulfillmentMode === 'provider_resale'
      && entitlement.providerEntitlement?.status !== 'ACTIVE'
    ) {
      throw new BadRequestException('CodingPlan 上游权益尚未激活');
    }
    if (normalizedUserId) {
      const membership = await this.prisma.tenantMember.findFirst({
        where: {
          userId: normalizedUserId,
          tenantId: entitlement.tenantId,
          status: 'active',
          tenant: { status: 'active', deletedAt: null },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new BadRequestException('CodingPlan 权益不属于当前用户可访问账号');
      }
    }

    return {
      code: 0,
      message: 'ok',
      data: {
        ...entitlement,
        expiresAt: entitlement.expiresAt?.toISOString() ?? null,
      },
    };
  }

  @NoAdminPermissionRequired()
  @Post('api-keys/spend')
  async getApiKeySpend(
    @Body() body: { apiKeyIds?: unknown },
  ): Promise<ApiResponse<unknown>> {
    const apiKeyIds = this.normalizeStringIds(body.apiKeyIds);

    if (apiKeyIds.length === 0) {
      return { code: 0, message: 'ok', data: [] };
    }

    const rows = await this.prisma.tokenUsage.groupBy({
      by: ['apiKeyId'],
      where: { apiKeyId: { in: apiKeyIds } },
      _sum: { costUsd: true },
    });
    const usageByKey = new Map(
      rows.map((row) => [row.apiKeyId, usdNumber(row._sum.costUsd ?? 0)]),
    );

    return {
      code: 0,
      message: 'ok',
      data: apiKeyIds.map((apiKeyId) => {
        const usageUsd = usageByKey.get(apiKeyId) ?? 0;
        return {
          apiKeyId,
          usageUsd,
          usageCents: Math.round(usageUsd * 100),
        };
      }),
    };
  }

  @NoAdminPermissionRequired()
  @Post('usage/api-key-stats')
  async getApiKeyUsageStats(
    @Body() body: {
      apiKeyIds?: unknown;
      tenantId?: unknown;
      cutoff?: string | Date | null;
    },
  ): Promise<ApiResponse<unknown>> {
    const apiKeyIds = this.normalizeStringIds(body.apiKeyIds);
    if (apiKeyIds.length === 0) {
      return {
        code: 0,
        message: 'ok',
        data: {
          totalTokens: 0,
          totalCostUsd: 0,
          totalCostCents: 0,
          totalRequests: 0,
          dailyUsage: [],
          modelUsage: [],
        },
      };
    }

    const tenantId = this.normalizeNullableString(body.tenantId);
    const cutoff = this.parseOptionalDate(body.cutoff);
    const where: Prisma.TokenUsageWhereInput = {
      apiKeyId: { in: apiKeyIds },
      ...(tenantId ? { tenantId } : {}),
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    };
    const sqlFilters = this.buildTokenUsageSqlFilters({
      apiKeyIds,
      tenantId,
      createdAt: cutoff ? { gte: cutoff } : undefined,
    });

    const [agg, modelRows, dailyRows] = await Promise.all([
      this.prisma.tokenUsage.aggregate({
        where,
        _sum: { totalTokens: true, costUsd: true },
        _count: true,
      }),
      this.prisma.tokenUsage.groupBy({
        by: ['model'],
        where,
        _sum: { totalTokens: true },
        orderBy: { _sum: { totalTokens: 'desc' } },
        take: 10,
      }),
      this.prisma.$queryRaw<Array<{ date: string; tokens: number | bigint; cost: Prisma.Decimal }>>(
        Prisma.sql`
          SELECT ${TOKEN_USAGE_SHANGHAI_DATE_SQL}::text AS date,
                 SUM(tu.total_tokens)::bigint AS tokens,
                 SUM(tu.cost_usd) AS cost
          FROM token_usage tu
          WHERE ${Prisma.join(sqlFilters, ' AND ')}
          GROUP BY ${TOKEN_USAGE_SHANGHAI_DATE_SQL}
          ORDER BY date ASC
        `,
      ),
    ]);
    const totalCostUsd = usdNumber(agg._sum.costUsd ?? 0);

    return {
      code: 0,
      message: 'ok',
      data: {
        totalTokens: agg._sum.totalTokens ?? 0,
        totalCostUsd,
        totalCostCents: Math.round(totalCostUsd * 100),
        totalRequests: agg._count,
        dailyUsage: dailyRows.map((row) => ({
          date: row.date,
          tokens: Number(row.tokens),
          cost: usdNumber(row.cost ?? 0),
        })),
        modelUsage: modelRows.map((row) => ({
          model: row.model,
          tokens: row._sum.totalTokens ?? 0,
        })),
      },
    };
  }

  @NoAdminPermissionRequired()
  @Post('usage/token-usage')
  async listTokenUsage(
    @Body() body: {
      apiKeyIds?: unknown;
      tenantId?: unknown;
      productId?: unknown;
      model?: unknown;
      createdAt?: unknown;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<ApiResponse<unknown>> {
    const apiKeyIds = this.normalizeStringIds(body.apiKeyIds);
    const page = this.normalizePage(body.page);
    const pageSize = this.normalizePageSize(body.pageSize);
    if (apiKeyIds.length === 0) {
      return { code: 0, message: 'ok', data: { items: [], total: 0, page, pageSize } };
    }
    const where = this.buildTokenUsageWhere(body, apiKeyIds);
    const [items, total] = await Promise.all([
      this.prisma.tokenUsage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          apiKeyId: true,
          productId: true,
          model: true,
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          totalTokens: true,
          costUsd: true,
          createdAt: true,
        },
      }),
      this.prisma.tokenUsage.count({ where }),
    ]);

    return {
      code: 0,
      message: 'ok',
      data: {
        items: items.map((item) => ({
          ...item,
          costUsd: usdNumber(item.costUsd ?? 0),
          createdAt: item.createdAt.toISOString(),
        })),
        total,
        page,
        pageSize,
      },
    };
  }

  @NoAdminPermissionRequired()
  @Post('usage/token-usage-summary')
  async getTokenUsageSummary(
    @Body() body: {
      apiKeyIds?: unknown;
      tenantId?: unknown;
      productId?: unknown;
      model?: unknown;
      createdAt?: unknown;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<ApiResponse<unknown>> {
    const apiKeyIds = this.normalizeStringIds(body.apiKeyIds);
    const page = this.normalizePage(body.page);
    const pageSize = this.normalizePageSize(body.pageSize);
    if (apiKeyIds.length === 0) {
      return { code: 0, message: 'ok', data: { items: [], total: 0, page, pageSize } };
    }

    const filters = this.buildTokenUsageSqlFilters({
      apiKeyIds,
      tenantId: this.normalizeNullableString(body.tenantId) ?? undefined,
      productId: this.normalizeNullableString(body.productId) ?? undefined,
      model: this.normalizeNullableString(body.model) ?? undefined,
      createdAt: this.parseDateFilter(body.createdAt),
    });
    const skip = (page - 1) * pageSize;
    const rows = await this.prisma.$queryRaw<Array<{
      date: string;
      apiKeyId: string;
      apiKeyName: string;
      apiKeyPrefix: string;
      model: string;
      calls: number | bigint;
      totalTokens: number | bigint;
      costUsd: Prisma.Decimal;
      totalGroups: number | bigint;
    }>>(Prisma.sql`
      WITH grouped AS (
        SELECT
          ${TOKEN_USAGE_SHANGHAI_DATE_SQL}::text AS "date",
          tu.api_key_id AS "apiKeyId",
          ak.name AS "apiKeyName",
          ak.prefix AS "apiKeyPrefix",
          tu.model AS "model",
          COUNT(*)::bigint AS "calls",
          SUM(
            GREATEST(
              COALESCE(tu.total_tokens, 0),
              COALESCE(tu.prompt_tokens, 0) + COALESCE(tu.completion_tokens, 0)
            )
          )::bigint AS "totalTokens",
          SUM(ABS(tu.cost_usd)) AS "costUsd"
        FROM token_usage tu
        JOIN api_keys ak ON ak.id = tu.api_key_id
        WHERE ${Prisma.join(filters, ' AND ')}
        GROUP BY
          ${TOKEN_USAGE_SHANGHAI_DATE_SQL},
          tu.api_key_id,
          ak.name,
          ak.prefix,
          tu.model
      )
      SELECT *, COUNT(*) OVER()::bigint AS "totalGroups"
      FROM grouped
      ORDER BY "date" DESC, "apiKeyName" ASC, "model" ASC
      OFFSET ${skip}
      LIMIT ${pageSize}
    `);

    return {
      code: 0,
      message: 'ok',
      data: {
        items: rows.map((row) => ({
          date: row.date,
          apiKeyId: row.apiKeyId,
          apiKeyName: row.apiKeyName,
          apiKeyPrefix: row.apiKeyPrefix,
          model: row.model,
          calls: Number(row.calls),
          totalTokens: Number(row.totalTokens),
          costUsd: usdNumber(row.costUsd ?? 0),
        })),
        total: rows.length > 0 ? Number(rows[0].totalGroups) : 0,
        page,
        pageSize,
      },
    };
  }

  @RequireAdminPermission('admin.page.users.manage')
  @Post('users/:id/adjust-balance')
  async adjustBalance(
    @Param('id') userId: string,
    @Body() body: {
      amountCents: number;
      description?: string;
      user?: BillingUserSnapshot;
      idempotencyKey?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    assertManualBalanceAdjustmentAmount(
      body.amountCents,
      (await this.platformCurrency()).currencySymbol,
    );
    const idempotencyKey = assertRequiredString(body.idempotencyKey, 'idempotencyKey');
    await this.ensureBillingUserMirror(userId, body.user);
    const tx = await this.billingService.adjust(
      userId,
      body.amountCents,
      body.description || '管理员调额',
      undefined,
      { idempotencyKey },
    );
    return { code: 0, message: '调额成功', data: tx };
  }

  @RequireAdminPermission('admin.page.users.manage')
  @Post('users/:id/billing-adjustment')
  async applyBillingAdjustment(
    @Param('id') userId: string,
    @Body() body: {
      amountCents: number;
      reasonCode?: string;
      description?: string;
      performedBy?: string | null;
      user?: BillingUserSnapshot;
      idempotencyKey?: string;
      tenantId?: string | null;
      billingAccountId?: string | null;
      productId?: string | null;
    },
  ): Promise<ApiResponse<unknown>> {
    assertManualBalanceAdjustmentAmount(
      body.amountCents,
      (await this.platformCurrency()).currencySymbol,
    );
    const reasonCode = assertRequiredString(body.reasonCode, 'reasonCode');
    if (!BALANCE_ADJUSTMENT_REASON_CODES.includes(reasonCode as BalanceAdjustmentReasonCode)) {
      throw new BadRequestException('reasonCode 无效');
    }
    const description = assertRequiredString(body.description, 'description');
    const idempotencyKey = assertRequiredString(body.idempotencyKey, 'idempotencyKey');
    await this.ensureBillingUserMirror(userId, body.user);
    const data = await this.billingService.applyClassifiedBalanceAdjustment(userId, {
      amountCents: body.amountCents,
      reasonCode: reasonCode as BalanceAdjustmentReasonCode,
      description,
      performedBy: body.performedBy,
      idempotencyKey,
      tenantId: body.tenantId,
      billingAccountId: body.billingAccountId,
      productId: body.productId,
    });
    return { code: 0, message: '账单调额成功', data };
  }

  @NoAdminPermissionRequired()
  @Post('users/:id/ensure-default-free-plan')
  async ensureDefaultFreePlan(
    @Param('id') userId: string,
    @Body() body: { source?: 'register_free' | 'auto_free'; user?: BillingUserSnapshot },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.ensureDefaultFreePlanForUser(
      userId,
      body.source ?? 'register_free',
      body.user,
    );
    return { code: 0, message: 'ok', data };
  }

  @NoAdminPermissionRequired()
  @Post('referrals/attribute')
  async attributeReferral(
    @Body() body: ReferralAttributionBody,
  ): Promise<ApiResponse<unknown>> {
    const userId = this.normalizeNullableString(body.userId);
    if (!userId) {
      throw new BadRequestException('userId 必填');
    }
    await this.ensureBillingUserMirror(userId, body.user);
    await this.growthEvents?.recordSignUp({
      userId,
      source: 'user_api',
      analyticsConsent: body.analyticsConsent ?? false,
      analyticsClientId: body.analyticsClientId ?? null,
      attribution: {
        referralCode: body.referralCode ?? null,
        deviceId: body.deviceId ?? null,
        utmSource: body.utmSource ?? null,
        utmMedium: body.utmMedium ?? null,
        utmCampaign: body.utmCampaign ?? null,
        utmContent: body.utmContent ?? null,
        utmTerm: body.utmTerm ?? null,
        landingUrl: body.landingUrl ?? null,
        capturedAt: body.capturedAt ?? null,
        referrer: body.referrer ?? null,
      },
    });
    await this.referralsService.attribute({
      inviteeUserId: userId,
      referralCode: body.referralCode ?? null,
      inviteeIp: body.inviteeIp ?? null,
      deviceId: body.deviceId ?? null,
      utmSource: body.utmSource ?? null,
      utmMedium: body.utmMedium ?? null,
      utmCampaign: body.utmCampaign ?? null,
      utmContent: body.utmContent ?? null,
      landingUrl: body.landingUrl ?? null,
      capturedAt: body.capturedAt ?? null,
      referrer: body.referrer ?? null,
    });
    return { code: 0, message: 'ok', data: null };
  }

  @Get('growth-events/summary')
  @RequireAdminPermission('admin.page.dashboard.view')
  async growthEventsSummary(
    @Query('hours') hours?: string,
  ): Promise<ApiResponse<unknown>> {
    if (!this.growthEvents) {
      throw new ServiceUnavailableException('Growth event measurement is unavailable');
    }
    const parsedHours = Number.parseInt(hours ?? '168', 10);
    const data = await this.growthEvents.summary(
      Number.isFinite(parsedHours) ? parsedHours : 168,
    );
    return { code: 0, message: 'ok', data };
  }

  @NoAdminPermissionRequired()
  @Post('referrals/click')
  async recordReferralClick(
    @Body()
    body: {
      referralCode?: string | null;
      visitorKey?: string | null;
      inviteeIp?: string | null;
      referrer?: string | null;
      utmSource?: string | null;
      utmMedium?: string | null;
      utmCampaign?: string | null;
      utmContent?: string | null;
    },
  ): Promise<ApiResponse<unknown>> {
    await this.referralsService.recordClick({
      referralCode: body.referralCode ?? null,
      visitorKey: body.visitorKey ?? null,
      ip: body.inviteeIp ?? null,
      referrer: body.referrer ?? null,
      utmSource: body.utmSource ?? null,
      utmMedium: body.utmMedium ?? null,
      utmCampaign: body.utmCampaign ?? null,
      utmContent: body.utmContent ?? null,
    });
    return { code: 0, message: 'ok', data: null };
  }

  @RequireAdminPermission('admin.page.payment_config.view')
  @Get('payment-instances')
  async listPaymentInstances(): Promise<ApiResponse<unknown>> {
    const instances = await this.prisma.paymentProviderInstance.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { code: 0, message: 'ok', data: instances.map((instance) => this.serializePaymentInstance(instance)) };
  }

  @RequireAdminPermission('admin.page.payment_config.manage')
  @Post('payment-instances')
  async createPaymentInstance(@Body() body: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    if (!body.providerKey || !body.name) {
      throw new BadRequestException('providerKey, name 为必填');
    }

    const providerKey = String(body.providerKey);
    const config = this.normalizePaymentInstanceConfig(body.config);
    const supportedTypes = this.normalizePaymentInstanceSupportedTypes(body.supportedTypes);
    this.validatePaymentInstanceConfig(providerKey, config);
    const data: Prisma.PaymentProviderInstanceCreateInput = {
      providerKey,
      name: String(body.name),
      config: encryptCredentials(JSON.stringify(config), this.getPaymentEncryptionKey()),
      supportedTypes: JSON.stringify(supportedTypes),
      isActive: body.isActive === undefined ? true : Boolean(body.isActive),
      dailyLimitCents: body.dailyLimitCents === undefined ? 0 : Number(body.dailyLimitCents),
      strategy: body.strategy === undefined ? 'round_robin' : String(body.strategy),
      sortOrder: body.sortOrder === undefined ? 0 : Number(body.sortOrder),
    };

    const created = await this.prisma.paymentProviderInstance.create({ data });
    await this.paymentProviderRegistry.loadInstances();
    return { code: 0, message: '创建成功', data: this.serializePaymentInstance(created) };
  }

  @RequireAdminPermission('admin.page.payment_config.manage')
  @Put('payment-instances/:id')
  async updatePaymentInstance(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    const existing = await this.prisma.paymentProviderInstance.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('支付实例不存在');

    const data: Prisma.PaymentProviderInstanceUpdateInput = {};
    const providerKey = body.providerKey !== undefined ? String(body.providerKey) : existing.providerKey;
    if (body.providerKey !== undefined) data.providerKey = providerKey;
    if (body.name !== undefined) data.name = String(body.name);
    if (body.config !== undefined) {
      const config = {
        ...this.parsePaymentInstanceConfig(existing.config),
        ...this.normalizePaymentInstanceConfig(body.config),
      };
      this.validatePaymentInstanceConfig(providerKey, config);
      data.config = encryptCredentials(JSON.stringify(config), this.getPaymentEncryptionKey());
    }
    if (body.supportedTypes !== undefined) {
      const supportedTypes = this.normalizePaymentInstanceSupportedTypes(body.supportedTypes);
      data.supportedTypes = JSON.stringify(supportedTypes);
    }
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (body.dailyLimitCents !== undefined) data.dailyLimitCents = Number(body.dailyLimitCents);
    if (body.strategy !== undefined) data.strategy = String(body.strategy);
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder);

    const updated = await this.prisma.paymentProviderInstance.update({
      where: { id },
      data,
    });
    await this.paymentProviderRegistry.loadInstances();
    return { code: 0, message: '更新成功', data: this.serializePaymentInstance(updated) };
  }

  @RequireAdminPermission('admin.page.payment_config.manage')
  @Delete('payment-instances/:id')
  async deletePaymentInstance(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const existing = await this.prisma.paymentProviderInstance.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('支付实例不存在');
    await this.prisma.paymentProviderInstance.delete({ where: { id } });
    await this.paymentProviderRegistry.loadInstances();
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.monitoring.view')
  @Get('channel-health')
  async getChannelHealth(): Promise<ApiResponse<unknown>> {
    const channels = await this.prisma.channel.findMany({
      where: { deletedAt: null },
      orderBy: { priority: 'asc' },
    });
    const data = channels.map((ch) => {
      const status = !ch.isActive ? 'inactive' : (ch.status === 'active' ? 'healthy' : ch.status);
      return {
        id: ch.id,
        name: ch.name,
        provider: ch.provider,
        status,
        isActive: ch.isActive,
        successRate: ch.successRate,
        totalReqs: ch.totalReqs,
        totalErrs: ch.totalErrs,
        avgLatencyMs: ch.avgLatencyMs,
      };
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('channels')
  async listChannels(@Query() query: unknown): Promise<ApiResponse<unknown>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const data = await this.channelService.findAll(parsed.data.page, parsed.data.pageSize);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('channels/protocol-templates')
  async getChannelProtocolTemplates(): Promise<ApiResponse<unknown>> {
    const data = this.channelService.getProtocolTemplates();
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('channels/:id')
  async getChannel(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.channelService.findById(id) };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('channels')
  async createChannel(@Body() body: {
    name: string;
    provider: string;
    providerAccountIdentityId?: string | null;
    baseUrl: string;
    apiKey: string;
    models?: string;
    modelConfigs?: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | string[] | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
    priority?: number;
    weight?: number;
    maxRpm?: number;
    maxTpm?: number;
    remark?: string;
  }): Promise<ApiResponse<unknown>> {
    if (!body.name || !body.provider || !body.baseUrl || !body.apiKey) {
      throw new BadRequestException('name, provider, baseUrl, apiKey 为必填');
    }
    return { code: 0, message: '创建成功', data: await this.channelService.create(body) };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('channels/publisher-compile-preview')
  async previewChannelPublisherCompile(@Body() body: {
    name?: string;
    provider: string;
    baseUrl: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | string[] | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
  }): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.channelService.previewPublisherCompile(body),
    };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Put('channels/:id')
  async updateChannel(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '更新成功', data: await this.channelService.update(id, body as never) };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Delete('channels/:id')
  async removeChannel(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.channelService.remove(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('channels/:id/test')
  async testChannel(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.test(id);
    return { code: 0, message: data.success ? '连接成功' : '连接失败', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('channels/:id/reset-stats')
  async resetChannelStats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '统计已重置', data: await this.channelService.resetStats(id) };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('channels/:id/discover-models')
  async discoverChannelModels(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.discoverModels(id);
    return {
      code: 0,
      message: data.success ? '拉取成功' : '拉取失败',
      data,
    };
  }

  @NoAdminPermissionRequired()
  @RequireAdminPermission('admin.catalog.models.view')
  @Get('model-pricing')
  async listModelPricing(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.channelAdmin.listModelPricing() };
  }

  @RequireAdminPermission('admin.page.models.manage')
  @Post('model-pricing')
  async upsertModelPricing(@Body() body: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    const result = await this.channelAdmin.upsertModelPricing(body as never);
    return { code: 0, message: '保存成功', data: result };
  }

  @RequireAdminPermission('admin.page.models.manage')
  @Post('model-pricing/sync')
  async syncModelPricing(): Promise<ApiResponse<unknown>> {
    const result = await this.channelAdmin.syncModelPricingFromProxy();
    return { code: 0, message: `同步完成，新增 ${result.added} 个模型`, data: result };
  }

  @RequireAdminPermission('admin.page.models.manage')
  @Delete('model-pricing/:modelName')
  async deleteModelPricing(@Param('modelName') modelName: string): Promise<ApiResponse<unknown>> {
    const result = await this.channelAdmin.deleteModelPricing(decodeURIComponent(modelName));
    return { code: 0, message: '已删除', data: result };
  }

  @RequireAdminPermission('admin.page.models.manage')
  @Post('model-pricing/deactivate-orphans')
  async deactivateOrphanModelPricing(
    @Body() body: { confirm?: boolean },
  ): Promise<ApiResponse<unknown>> {
    const result = await this.channelAdmin.deactivateOrphanModelPricing(body?.confirm === true);
    const message = result.dryRun
      ? `预览：找到 ${result.orphans.length} 个孤儿定价`
      : `已禁用 ${result.deactivated} 个孤儿定价`;
    return { code: 0, message, data: result };
  }

  @RequireAdminPermission('admin.page.models.manage')
  @Post('model-pricing/publish-all-active')
  async publishAllActiveModelPricing(): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '已开启用户端展示',
      data: await this.channelAdmin.publishAllActive(),
    };
  }

  @RequireAdminPermission('admin.catalog.models.view')
  @Get('model-access')
  async listModelAccess(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.channelAdmin.listModelAccess() };
  }

  @RequireAdminPermission('admin.data.model_access.manage')
  @Post('model-access/batch')
  async batchUpdateModelAccess(@Body() body: {
    items: {
      tierId?: string;
      planId?: string;
      modelName?: string;
      model?: string;
      isActive?: boolean;
      isAllowed?: boolean;
      creditMultiplier?: number;
    }[];
  }): Promise<ApiResponse<unknown>> {
    await this.channelAdmin.batchUpdateModelAccess(body.items);
    return { code: 0, message: '更新成功', data: null };
  }

  @RequireAdminPermission('admin.catalog.models.view')
  @Get('model-route-policies')
  async listModelRoutePolicies(): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.channelAdmin.listModelRoutePolicies() };
  }

  @RequireAdminPermission('admin.data.model_access.manage')
  @Post('model-route-policies/batch')
  async batchUpdateModelRoutePolicies(@Body() body: {
    items: {
      planId?: string;
      routeKey?: string;
      primaryModel?: string | null;
      fallbackModels?: string[];
      isActive?: boolean;
    }[];
  }): Promise<ApiResponse<unknown>> {
    await this.channelAdmin.batchUpdateModelRoutePolicies(body.items);
    return { code: 0, message: '更新成功', data: null };
  }

  // ============================
  // 用量计费策略引擎
  // ============================

  @NoAdminPermissionRequired()
  @RequireAdminPermission('admin.page.payg_pricing.view')
  @Get('payg-model-pricing')
  async listPaygModelPricing(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.listPaygModelPricing(productId ?? '');
    return { code: 0, message: 'ok', data };
  }

  @NoAdminPermissionRequired()
  @RequireAdminPermission('admin.page.payg_pricing.view')
  @Get('payg-product-model-candidates')
  async listPaygProductModelCandidates(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.listPaygModelCandidates(productId ?? '');
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.payg_pricing.manage')
  @Post('payg-product-models')
  async addPaygProductModels(
    @Body() body: PaygProductModelWriteInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.addPaygProductModels(body);
    return { code: 0, message: '已新增模型', data };
  }

  @RequireAdminPermission('admin.page.payg_pricing.manage')
  @Put('payg-product-models/:id')
  async updatePaygProductModel(
    @Param('id') id: string,
    @Body() body: PaygProductModelUpdateInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.updatePaygProductModelAvailability(id, body);
    return { code: 0, message: '已更新', data };
  }

  @RequireAdminPermission('admin.page.payg_pricing.manage')
  @Delete('payg-product-models/:id')
  async retirePaygProductModel(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.retirePaygProductModelAvailability(id);
    return { code: 0, message: '已移出产品', data };
  }

  @RequireAdminPermission('admin.page.payg_pricing.manage')
  @Post('payg-model-pricing')
  async createPaygModelPricingVersion(
    @Body() body: PaygModelPricingVersionInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.createPaygModelPricingVersion(body);
    return { code: 0, message: '保存成功', data };
  }

  @RequireAdminPermission('admin.page.payg_pricing.manage')
  @Delete('payg-model-pricing/:id')
  async deactivatePaygModelPricing(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.deactivatePaygModelPricingPolicy(id);
    return { code: 0, message: '已停用', data };
  }

  @RequireAdminPermission('admin.page.provider_cost_policies.view')
  @Get('provider-cost-policies')
  async listProviderCostPolicies(
    @Query() query: ProviderCostPolicyListQuery,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.providerCostPricing.listPolicies(query);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.provider_cost_policies.manage')
  @Post('provider-cost-policies')
  async createProviderCostPolicy(
    @Body() body: ProviderCostPolicyWriteInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.providerCostPricing.createPolicyVersion(body);
    return { code: 0, message: '保存成功', data };
  }

  @RequireAdminPermission('admin.page.provider_cost_policies.manage')
  @Post('provider-cost-policies/backfill-token-usage')
  async backfillProviderCostTokenUsage(
    @Body() body: Record<string, unknown>,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.providerCostPricing.backfillTokenUsageCosts(body);
    return { code: 0, message: '回填完成', data };
  }

  @RequireAdminPermission('admin.page.provider_cost_policies.manage')
  @Delete('provider-cost-policies/:id')
  async deactivateProviderCostPolicy(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.providerCostPricing.deactivatePolicy(id);
    return { code: 0, message: '已停用', data };
  }

  @RequireAdminPermission('admin.page.provider_cost_policies.manage')
  @Delete('provider-cost-policies/:id/hard')
  async deleteProviderCostPolicy(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.providerCostPricing.deletePolicy(id);
    return { code: 0, message: '已删除', data };
  }

  @RequireAdminPermission('admin.system.manage')
  @Post('usage/quote')
  async quoteUsage(@Body() body: UsageQuoteInput): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.quote(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.system.manage')
  @Post('usage/authorize')
  async authorizeUsage(@Body() body: UsageQuoteInput): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.authorize(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.system.manage')
  @Post('usage/deduct')
  async deductUsage(@Body() body: UsageDeductInput): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.deduct(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.enterprise_accounts.view')
  @Get('enterprise-model-discounts')
  async listEnterpriseModelDiscounts(
    @Query('billingAccountId') billingAccountId?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.listEnterpriseModelDiscounts(
      billingAccountId ?? '',
      productId ?? '',
    );
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.enterprise_accounts.manage')
  @Put('enterprise-model-discounts')
  async updateEnterpriseModelDiscounts(
    @Body() body: EnterpriseModelDiscountMatrixInput & { billingAccountId?: string | null },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.upsertEnterpriseModelDiscounts(
      body?.billingAccountId ?? '',
      body,
    );
    return { code: 0, message: '保存成功', data };
  }

  @RequireAdminPermission('admin.page.usage_pricing_policies.view')
  @Get('usage-policies')
  async listUsagePolicies(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.listPolicies(productId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.usage_pricing_policies.manage')
  @Post('usage-policies')
  async createUsagePolicy(@Body() body: UsagePolicyWriteInput): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.createPolicy(body);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.usage_pricing_policies.manage')
  @Put('usage-policies/:id')
  async updateUsagePolicy(
    @Param('id') id: string,
    @Body() body: Partial<UsagePolicyWriteInput>,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.usageBillingStrategy.updatePolicy(id, body);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.usage_pricing_policies.manage')
  @Delete('usage-policies/:id')
  async deleteUsagePolicy(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.usageBillingStrategy.deletePolicy(id);
    return { code: 0, message: '删除成功', data: null };
  }

  private async grantCreditsToSubscription(
    subscriptionId: string,
    amount: number,
    reason: string,
    idempotencyKey: string,
  ) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('积分数量必须为正整数');
    }
    if (amount > MAX_MANUAL_CREDIT_GRANT) {
      throw new BadRequestException(`单次积分赠送不能超过 ${MAX_MANUAL_CREDIT_GRANT}`);
    }
    if (!reason?.trim()) throw new BadRequestException('原因不能为空');

    const sub = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        id: subscriptionId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        user: { select: { id: true, email: true } },
        product: { select: { slug: true } },
      },
    });
    if (!sub) {
      throw new BadRequestException('请选择有效订阅后再赠送积分');
    }

    await this.creditService.addBonus(
      sub.id,
      sub.userId,
      amount,
      `admin_grant:${reason.trim()}`,
      { idempotencyKey },
    );
    if (sub.user?.email && sub.product?.slug) {
      this.productSync.notifyCreditChanged(sub.user.email, sub.product.slug).catch(() => {});
    }
    return {
      userId: sub.userId,
      subscriptionId: sub.id,
      amount,
      reason: reason.trim(),
    };
  }

  private async ensureDefaultFreePlanForUser(
    userId: string,
    source: 'register_free' | 'auto_free',
    userSnapshot?: BillingUserSnapshot,
  ): Promise<{ userId: string; subscriptionId: string | null; created: boolean }> {
    await this.ensureBillingUserMirror(userId, userSnapshot);

    const existingActiveSubscription = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (existingActiveSubscription) {
      return { userId, subscriptionId: existingActiveSubscription.id, created: false };
    }

    const plan = await this.resolveDefaultFreePlan();

    await this.billingService.activateSubscription(userId, plan.id, plan.productId);
    const sub = await this.prisma.subscriptionPeriod.findFirst({
      where: { userId, productId: plan.productId, status: 'ACTIVE' },
      select: { id: true },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (!sub) throw new ServiceUnavailableException('自动补齐 Free 套餐失败，请稍后重试');

    const balances = await this.creditService.getAuthoritativeBalances(sub.id, userId);
    if (balances.quota <= 0 && balances.bonus <= 0) {
      await this.creditService.grantQuota(
        sub.id,
        userId,
        plan.monthlyCredits,
        `plan:${plan.name}`,
        { idempotencyKey: `${source}:${sub.id}` },
      );
    }
    return { userId, subscriptionId: sub.id, created: true };
  }

  private async resolveDefaultFreePlan(): Promise<{
    id: string;
    name: string;
    productId: string;
    monthlyCredits: number;
  }> {
    const plans = await this.prisma.plan.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { billingPeriod: 'monthly', monthlyPrice: 0 },
          { billingPeriod: 'quarterly', quarterlyPrice: 0 },
          { billingPeriod: 'yearly', yearlyPrice: 0 },
        ],
        productId: { not: null },
        product: {
          is: {
            billingMode: 'SUBSCRIPTION',
            isActive: true,
            deletedAt: null,
          },
        },
      },
      select: {
        id: true,
        name: true,
        productId: true,
        monthlyCredits: true,
        billingPeriod: true,
        prices: {
          where: { isActive: true },
          select: {
            monthlyPrice: true,
            quarterlyPrice: true,
            yearlyPrice: true,
          },
        },
        product: { select: { defaultPlanId: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const candidates = plans.filter((plan) => plan.prices.every((price) => {
      if (plan.billingPeriod === 'quarterly') return price.quarterlyPrice === 0;
      if (plan.billingPeriod === 'yearly') return price.yearlyPrice === 0;
      return price.monthlyPrice === 0;
    }));
    const configured = candidates.filter((candidate) => (
      candidate.product?.defaultPlanId === candidate.id
    ));
    const selected = configured.length === 1
      ? configured[0]
      : configured.length === 0
        ? candidates.find((candidate) => candidate.id === 'free')
          ?? (candidates.length === 1 ? candidates[0] : null)
        : null;
    if (!selected?.productId) {
      const reason = configured.length > 1 || candidates.length > 1
        ? '系统存在多个可用的 Free 套餐，请为唯一目标产品配置 defaultPlanId'
        : '系统未配置可用的 Free 套餐';
      throw new ServiceUnavailableException(reason);
    }
    return {
      id: selected.id,
      name: selected.name,
      productId: selected.productId,
      monthlyCredits: selected.monthlyCredits,
    };
  }

  private async ensureBillingUserMirror(
    userId: string,
    snapshot?: BillingUserSnapshot,
  ): Promise<{ id: string; email: string | null }> {
    if (this.userMirror) {
      await this.userMirror.mirrorUser({ ...snapshot, id: userId });
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      return user ?? { id: userId, email: null };
    }

    const email = this.normalizeNullableString(snapshot?.email);
    const phone = this.normalizeNullableString(snapshot?.phone);
    const nickname = this.normalizeNickname(snapshot);
    const mirroredAt = new Date();

    return this.prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email,
        phone,
        nickname,
        isActive: snapshot?.isActive ?? true,
        mirroredAt,
      },
      update: {
        ...(email !== undefined ? { email } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(nickname ? { nickname } : {}),
        ...(snapshot?.isActive !== undefined && snapshot.isActive !== null
          ? { isActive: snapshot.isActive }
          : {}),
        mirroredAt,
      },
      select: { id: true, email: true },
    });
  }

  private normalizeNullableString(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  private parseOptionalTake(value: unknown): number | undefined {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return undefined;
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.min(parsed, 500);
  }

  private codingPlanKeysPerEntitlementLimit(): number {
    const raw = this.config.get<string | number>('CODING_PLAN_KEYS_PER_ENTITLEMENT_LIMIT');
    const parsed = raw === undefined || raw === null || raw === ''
      ? Number.NaN
      : Number.parseInt(String(raw), 10);
    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_CODING_PLAN_KEYS_PER_ENTITLEMENT_LIMIT;
  }

  private codingPlanProviderAdmin(): CodingPlanProviderAdminService {
    if (!this.codingPlanProviders) {
      throw new ServiceUnavailableException('CodingPlan 供应商线路服务未启用');
    }
    return this.codingPlanProviders;
  }

  private normalizeStringIds(value: unknown): string[] {
    return Array.isArray(value)
      ? Array.from(new Set(
          value
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim())
            .filter(Boolean),
        ))
      : [];
  }

  private normalizeQueryStringIds(value: unknown): string[] {
    if (Array.isArray(value)) {
      return Array.from(new Set(
        value
          .flatMap((item) => String(item).split(','))
          .map((item) => item.trim())
          .filter(Boolean),
      ));
    }
    if (typeof value === 'string') {
      return Array.from(new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ));
    }
    return [];
  }

  private normalizeAllowanceCents(value: unknown): number | null {
    if (value === null) return null;
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException('allowanceCents must be a non-negative integer or null');
    }
    // 0 / null /「不限制」同义：工作区不设预算上限。
    if (amount === 0) return null;
    return amount;
  }

  private normalizeStringArrayJson(value: string | string[] | null | undefined): string | null {
    if (value == null) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return JSON.stringify(parsed
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim()));
        }
      } catch {
        return JSON.stringify([trimmed]);
      }
      return null;
    }
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? JSON.stringify(Array.from(new Set(items))) : null;
  }

  private parseNullableStringArray(value: string | null | undefined): string[] | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return null;
      const items = parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      return items.length > 0 ? Array.from(new Set(items)) : null;
    } catch {
      return null;
    }
  }

  private normalizeOptionalInt(value: number | null | undefined, field: string): number | null {
    if (value == null) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${field} 必须是正整数`);
    }
    return parsed;
  }

  private normalizePage(value: unknown): number {
    const page = Number(value);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  }

  private normalizePageSize(value: unknown): number {
    const pageSize = Number(value);
    if (!Number.isFinite(pageSize)) return 20;
    return Math.min(Math.max(Math.floor(pageSize), 1), 100);
  }

  private parseDateFilter(value: unknown): { gte?: Date; lt?: Date } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as { gte?: string | Date | null; lt?: string | Date | null };
    const gte = this.parseOptionalDate(raw.gte);
    const lt = this.parseOptionalDate(raw.lt);
    return {
      ...(gte ? { gte } : {}),
      ...(lt ? { lt } : {}),
    };
  }

  private buildTokenUsageWhere(
    body: {
      tenantId?: unknown;
      productId?: unknown;
      model?: unknown;
      createdAt?: unknown;
    },
    apiKeyIds: string[],
  ): Prisma.TokenUsageWhereInput {
    const tenantId = this.normalizeNullableString(body.tenantId);
    const productId = this.normalizeNullableString(body.productId);
    const model = this.normalizeNullableString(body.model);
    const createdAt = this.parseDateFilter(body.createdAt);
    return {
      apiKeyId: { in: apiKeyIds },
      ...(tenantId ? { tenantId } : {}),
      ...(productId ? { productId } : {}),
      ...(model ? { model } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  }

  private buildTokenUsageSqlFilters(input: {
    apiKeyIds: string[];
    tenantId?: string | null;
    productId?: string | null;
    model?: string | null;
    createdAt?: { gte?: Date; lt?: Date };
  }): Prisma.Sql[] {
    const filters: Prisma.Sql[] = [
      Prisma.sql`tu.api_key_id = ANY(${input.apiKeyIds})`,
    ];
    if (input.tenantId) filters.push(Prisma.sql`tu.tenant_id = ${input.tenantId}`);
    if (input.productId) filters.push(Prisma.sql`tu.product_id = ${input.productId}`);
    if (input.model) filters.push(Prisma.sql`tu.model = ${input.model}`);
    if (input.createdAt?.gte) filters.push(Prisma.sql`tu.created_at >= ${input.createdAt.gte}`);
    if (input.createdAt?.lt) filters.push(Prisma.sql`tu.created_at < ${input.createdAt.lt}`);
    return filters;
  }

  private normalizeNickname(snapshot?: BillingUserSnapshot): string {
    const nickname = this.normalizeNullableString(snapshot?.nickname);
    if (nickname) return nickname;
    const email = this.normalizeNullableString(snapshot?.email);
    if (email) return email.split('@')[0] || '';
    return '';
  }

  private getPaymentEncryptionKey(): string {
    return this.config.getOrThrow<string>('ENCRYPTION_KEY');
  }

  private parseOptionalDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('日期格式不正确');
    }
    return date;
  }

  private async resolveOptionalTenantId(tenantId: string | null | undefined): Promise<string | null> {
    const normalized = tenantId?.trim();
    if (!normalized) return null;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: normalized }, select: { id: true } });
    return tenant ? tenant.id : null;
  }

  private async resolveRequiredTenantId(tenantId: string | null | undefined): Promise<string> {
    const normalized = tenantId?.trim();
    if (!normalized) {
      throw new BadRequestException('API Key 镜像必须绑定账号 tenantId');
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: normalized },
      select: { id: true },
    });
    if (!tenant) {
      throw new BadRequestException('账号不存在，请先同步 Workspace');
    }
    return tenant.id;
  }

  private async resolveApiKeyMirrorProductId(
    apiKeyId: string,
    productId: string | null | undefined,
    productSlug?: string | null,
    defaultToPayg = true,
  ): Promise<string | null> {
    const explicitProduct = await this.resolveOptionalProductId(productId, productSlug);
    if (explicitProduct) return explicitProduct;

    const existing = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { productId: true },
    });
    if (existing?.productId) return existing.productId;

    if (!defaultToPayg) return null;

    const defaultPayg = await this.productService.resolveDefaultProduct({
      billingMode: 'PAY_AS_YOU_GO',
    });
    return defaultPayg.id;
  }

  private async resolveApiKeyCodingPlanEntitlement(
    entitlementId: string,
    tenantId: string,
    productId: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{
    id: string;
    productId: string;
    fulfillmentMode: string;
    providerEntitlement?: { id: string; status: string; productEndTime: Date | null } | null;
  }> {
    const entitlement = await db.codingPlanEntitlement.findFirst({
      where: {
        id: entitlementId,
        tenantId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        productId: true,
        fulfillmentMode: true,
        providerEntitlement: {
          select: { id: true, status: true, productEndTime: true },
        },
      },
    });
    if (!entitlement) {
      throw new BadRequestException('CodingPlan 权益不存在或不可用');
    }
    if (productId && entitlement.productId !== productId) {
      throw new BadRequestException('CodingPlan 权益与产品不匹配');
    }
    if (
      entitlement.fulfillmentMode === 'provider_resale'
      && (
        entitlement.providerEntitlement?.status !== 'ACTIVE'
        || (
          entitlement.providerEntitlement.productEndTime
          && entitlement.providerEntitlement.productEndTime.getTime() <= Date.now()
        )
      )
    ) {
      throw new BadRequestException('CodingPlan 上游权益尚未激活');
    }
    return entitlement;
  }

  private async resolveOptionalProductId(
    productId: string | null | undefined,
    productSlug?: string | null,
  ): Promise<string | null> {
    const normalized = productId?.trim();
    const normalizedSlug = productSlug?.trim();
    if (!normalized && !normalizedSlug) return null;
    const product = await this.prisma.product.findFirst({
      where: normalized
        ? { id: normalized, deletedAt: null, isActive: true }
        : { slug: normalizedSlug, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!product) throw new BadRequestException('产品不存在或未启用');
    return product.id;
  }

  private normalizePaymentInstanceConfig(value: unknown): Record<string, string> {
    if (value === undefined || value === null) return {};
    const raw = typeof value === 'string'
      ? JSON.parse(value) as Record<string, unknown>
      : value as Record<string, unknown>;
    if (!raw || Array.isArray(raw) || typeof raw !== 'object') {
      throw new BadRequestException('config 必须为对象');
    }
    return Object.fromEntries(
      Object.entries(raw).map(([key, entryValue]) => [key, String(entryValue ?? '')]),
    );
  }

  private validatePaymentInstanceConfig(providerKey: string, config: Record<string, string>): void {
    if (providerKey.toLowerCase() !== 'alipay') return;

    const privateKey = config.privateKey?.trim();
    const alipayPublicKey = config.alipayPublicKey?.trim();
    if (!privateKey || !alipayPublicKey) return;

    const appPublicKeyFingerprint = fingerprintAlipayPublicKeyFromPrivateKey(privateKey);
    if (!appPublicKeyFingerprint) {
      throw new BadRequestException('支付宝应用私钥格式不正确');
    }

    const alipayPublicKeyFingerprint = fingerprintAlipayPublicKey(alipayPublicKey);
    if (!alipayPublicKeyFingerprint) {
      throw new BadRequestException('支付宝公钥格式不正确');
    }

    if (appPublicKeyFingerprint === alipayPublicKeyFingerprint) {
      throw new BadRequestException('支付宝公钥不能填写应用公钥，请填写支付宝平台提供的支付宝公钥');
    }
  }

  private normalizePaymentInstanceSupportedTypes(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        return value.split(',').map((v) => v.trim()).filter(Boolean);
      }
    }
    throw new BadRequestException('supportedTypes 必须为数组');
  }

  private parsePaymentInstanceConfig(value: string): Record<string, string> {
    try {
      const decrypted = decryptCredentials(value, this.getPaymentEncryptionKey());
      return JSON.parse(decrypted) as Record<string, string>;
    } catch {
      try {
        return JSON.parse(value) as Record<string, string>;
      } catch {
        return {};
      }
    }
  }

  private serializePaymentInstance(instance: {
    id: string;
    providerKey: string;
    name: string;
    config: string;
    supportedTypes: string;
    isActive: boolean;
    dailyLimitCents: number;
    strategy: string;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const parsedConfig = this.parsePaymentInstanceConfig(instance.config);
    let supportedTypes: string[] = [];
    try {
      supportedTypes = JSON.parse(instance.supportedTypes) as string[];
    } catch {
      supportedTypes = [];
    }
    return {
      ...instance,
      config: Object.fromEntries(
        Object.entries(parsedConfig).map(([key, value]) => [key, maskCredential(String(value ?? ''))]),
      ),
      supportedTypes,
    };
  }
}

import {
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Res,
  BadRequestException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { BillingService } from './billing.service';
import { TokenUsagePeriodSummaryV2Service } from './token-usage-period-summary-v2.service';
import { CodingPlanProviderUsageService } from './coding-plan-provider-usage.service';
import { CreditService } from './credit.service';
import { ProductService } from './product.service';
import { BoosterPackService } from './booster-pack.service';
import { SubscriptionResolverService } from './subscription-resolver.service';
import { CodingPlanProviderKeyRevealService } from './coding-plan-provider-key-reveal.service';
import { CampaignService, type PlanPromotions } from '../campaign/campaign.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import {
  ApiResponse,
  Plan,
  BalanceTransaction,
  CreditTransaction,
  PaginatedResult,
  CreditsSummary,
  CreditsSummaryV2,
  CreditDetailsResult,
  paginationSchema,
  CHAT_PRODUCT_SLUG,
  type PlanQuotaRuleView,
} from '@ruidong/shared';
import { usdString } from './money';
import { resolvePlatformCurrency, type PlatformCurrency } from './platform-currency';
import { SystemConfigService } from './system-config.service';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly creditService: CreditService,
    private readonly productService: ProductService,
    private readonly boosterPackService: BoosterPackService,
    private readonly subscriptionResolver: SubscriptionResolverService,
    private readonly config: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
    @Optional() private readonly providerUsage?: CodingPlanProviderUsageService,
    @Optional() private readonly providerKeyReveal?: CodingPlanProviderKeyRevealService,
    @Optional() private readonly campaignService?: CampaignService,
    @Optional() private readonly tokenUsagePeriodSummaryV2?: TokenUsagePeriodSummaryV2Service,
  ) {}

  private async platformCurrency(): Promise<PlatformCurrency> {
    const platformConfig = await this.systemConfig?.getDeploymentConfig();
    return resolvePlatformCurrency(this.config, platformConfig);
  }

  private resolveBillingSubject(userId: string, tenantId?: string) {
    return this.billingService.resolveSubjectForUser(userId, tenantId, {
      requireBillingRole: true,
    });
  }

  private resolveReadonlyBillingSubject(userId: string, tenantId?: string) {
    return this.billingService.resolveSubjectForUser(userId, tenantId);
  }

  private positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.trunc(parsed));
  }

  @Public()
  @Get('plans')
  async getPlans(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<Plan[]>> {
    const plans = await this.billingService.getPlans(productId);
    return { code: 0, message: 'ok', data: plans };
  }

  // benefits 选购页展示「限时活动价」用（已登录）：返回各 plan × 周期命中的最优活动定价。
  // currency 缺省取平台币种（卡片按平台币种展示价）；仅返回 Stripe Coupon 就绪的命中。
  @Get('plans/promotions')
  async getPlanPromotions(
    @CurrentUser('id') userId: string,
    @Query('productId') productId?: string,
    @Query('currency') currency?: string,
  ): Promise<ApiResponse<PlanPromotions>> {
    if (!productId) throw new BadRequestException('productId 必填');
    if (!this.campaignService) return { code: 0, message: 'ok', data: {} };
    const pc = await this.platformCurrency();
    const data = await this.campaignService.getPlanPromotions({
      productId,
      currency: currency?.trim() ? currency.trim().toLowerCase() : pc.currency,
      userId,
      platformCurrency: pc.currency,
    });
    return { code: 0, message: 'ok', data };
  }

  @Public()
  @Get('bundles')
  async getBundles(): Promise<ApiResponse<unknown[]>> {
    const bundles = await this.billingService.getActiveBundles();
    return { code: 0, message: 'ok', data: bundles };
  }

  @Get('balance')
  async getBalance(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<Record<string, unknown> & PlatformCurrency>> {
    const subject = await this.resolveReadonlyBillingSubject(userId, tenantId);
    const report = await this.billingService.getBalanceReportForUser(userId, subject);
    return {
      code: 0,
      message: 'ok',
      data: {
        ...report,
        balanceAmount: usdString(report.balanceUsd),
        accountBalanceAmount: usdString(report.accountBalanceUsd),
        accountAvailableBalanceAmount: usdString(report.accountAvailableBalanceUsd),
        creditLimitAmount: usdString(report.creditLimitUsd),
        creditUsedAmount: usdString(report.creditUsedUsd),
        creditRemainingAmount: usdString(report.creditRemainingUsd),
        ...(await this.platformCurrency()),
      },
    };
  }

  @Get('current-subscription')
  async getCurrentSubscription(
    @CurrentUser('id') userId: string,
    @Query('productId') productId?: string,
    @Query('productSlug') productSlug?: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<{
    productId: string | null;
    billingMode: string | null;
    fulfillmentMode?: string | null;
    planId: string | null;
    planName: string;
    billingPeriod: string | null;
    monthlyPrice: number;
    monthlyCredits: number;
    rateLimitRpm: number;
    rateLimitTpm: number;
    maxContextWindow: number;
    quotaRules?: PlanQuotaRuleView[];
    features: string[];
    status: string;
    expiresAt: string | null;
  }>> {
    // 自营 CodingPlan 是 per-user：其订阅显示绕开当前工作区成员/账务角色 gate（codex P1-1），
    // 切工作区/无成员也能看到自己的订阅；转售/SUBSCRIPTION 仍按当前工作区校验。
    const productRef = productId ?? productSlug;
    const selfOp = await this.billingService.isSelfOperatedCodingPlanProduct(productRef, CHAT_PRODUCT_SLUG);
    const subject = selfOp ? {} : await this.resolveBillingSubject(userId, tenantId);
    const data = await this.billingService.getCurrentSubscriptionBySlug(
      userId,
      productRef,
      CHAT_PRODUCT_SLUG,
      subject,
    );
    return { code: 0, message: 'ok', data };
  }

  @Get('coding-plan/entitlements')
  async getCodingPlanEntitlements(
    @CurrentUser('id') userId: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown[]>> {
    const entitlements = await this.billingService.listCodingPlanEntitlements(
      userId,
      productId?.trim() || undefined,
    );
    const summaries = await Promise.all(
      entitlements.map((entitlement) =>
        this.creditService.getSummary(entitlement.id, userId).catch(() => null),
      ),
    );
    const providerUsageById = await this.providerUsage
      ?.getUsageForEntitlements(entitlements)
      .catch(() => new Map())
      ?? new Map();
    return {
      code: 0,
      message: 'ok',
      data: entitlements.map((entitlement, index) => ({
        ...entitlement,
        credits: summaries[index],
        providerUsage: providerUsageById.get(entitlement.id) ?? null,
      })),
    };
  }

  @Get('coding-plan/entitlements/:entitlementId/usage-trend')
  async getCodingPlanUsageTrend(
    @CurrentUser('id') userId: string,
    @Param('entitlementId') entitlementId: string,
    @Query('productId') productId?: string,
    @Query('range') range?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.billingService.getCodingPlanUsageTrend(userId, entitlementId, {
      productId: productId?.trim() || null,
      range: range === 'day' || range === 'last7Days' || range === 'last30Days' ? range : undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @Get('coding-plan/entitlements/:entitlementId/upstream-key')
  async revealCodingPlanProviderKey(
    @CurrentUser('id') userId: string,
    @Param('entitlementId') entitlementId: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    if (!this.providerKeyReveal) {
      throw new ServiceUnavailableException('CodingPlan 上游 key 显示服务不可用');
    }
    const data = await this.providerKeyReveal.revealForUser(userId, entitlementId, {
      productId: productId?.trim() || null,
    });
    return { code: 0, message: 'ok', data };
  }

  @Get('credits-summary')
  async getCreditsSummary(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<CreditsSummary>> {
    const subject = await this.resolveReadonlyBillingSubject(userId, tenantId);
    const summary = await this.billingService.getCreditsSummary(userId, subject);
    return { code: 0, message: 'ok', data: { ...summary, ...(await this.platformCurrency()) } };
  }

  @Get('transactions')
  async getTransactions(
    @CurrentUser('id') userId: string,
    @Query() query: unknown,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<PaginatedResult<BalanceTransaction>>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }
    const productId = (query as Record<string, string>)?.productId?.trim();
    const subject = await this.resolveBillingSubject(userId, tenantId);
    const result = await this.billingService.getTransactions(
      userId,
      parsed.data.page,
      parsed.data.pageSize,
      productId || undefined,
      subject,
    );
    return { code: 0, message: 'ok', data: result };
  }

  @Get('credit-details')
  async getCreditDetails(
    @CurrentUser('id') userId: string,
    @Query() query: Record<string, string>,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<CreditDetailsResult>> {
    const subject = await this.resolveBillingSubject(userId, tenantId);
    const result = await this.billingService.getCreditDetails(
      userId,
      {
        creditPage: this.positiveInt(query.creditPage, 1),
        voucherPage: this.positiveInt(query.voucherPage, 1),
        pageSize: this.positiveInt(query.pageSize, 20, 100),
        productId: query.productId?.trim() || undefined,
      },
      subject,
    );
    return { code: 0, message: 'ok', data: result };
  }

  // ============================
  // 积分（双池）
  // ============================

  @Get('credits')
  async getCredits(
    @CurrentUser('id') userId: string,
    @Query('productId') productId?: string,
    @Query('entitlementId') entitlementId?: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<CreditsSummaryV2>> {
    let subscriptionId: string;
    if (entitlementId) {
      subscriptionId = (await this.billingService.assertCodingPlanEntitlementAccess(userId, entitlementId, {
        productId: productId?.trim() || null,
      })).id;
    } else {
      // 自营 CodingPlan per-user：按 userId 拿活跃 entitlement.id，绕开当前工作区成员 gate（codex P1-1/P1-2）；
      // 未订阅 → '' → getSummary 空结果（与既有空订阅路径一致）。转售/SUBSCRIPTION 维持原按工作区解析。
      // 传 CHAT_PRODUCT_SLUG 兜底：与 current-subscription 一致，credits 缺省 productId 时也能命中默认自营产品
      // （否则 resolveActiveProduct(undefined,undefined)→null→selfOp=false→回落工作区 gate，切工作区仍 403，codex High）。
      const selfOp = await this.billingService.resolveSelfOpEntitlementId(userId, productId, CHAT_PRODUCT_SLUG);
      subscriptionId = selfOp.selfOp
        ? (selfOp.entitlementId ?? '')
        : await this.resolveSubscriptionId(
            userId,
            productId,
            (await this.resolveBillingSubject(userId, tenantId)).tenantId,
          );
    }
    const summary = await this.creditService.getSummary(subscriptionId, userId);
    return { code: 0, message: 'ok', data: summary };
  }

  @Get('credit-transactions')
  async getCreditTransactions(
    @CurrentUser('id') userId: string,
    @Query() query: unknown,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<PaginatedResult<CreditTransaction>>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }
    // Extract productId from raw query (not in paginationSchema)
    const productId = (query as Record<string, string>)?.productId;
    const entitlementId = (query as Record<string, string>)?.entitlementId;
    // 与 getCredits 同口径：自营 CodingPlan per-user——无 entitlementId 时按 userId 拿自营 entitlement.id，
    // 绕开当前工作区成员 gate；未订阅→'' →空结果。转售/SUBSCRIPTION/PAYG 维持原按工作区解析。
    let subscriptionId: string;
    if (entitlementId) {
      subscriptionId = (await this.billingService.assertCodingPlanEntitlementAccess(userId, entitlementId, {
        productId: productId?.trim() || null,
      })).id;
    } else {
      const selfOp = await this.billingService.resolveSelfOpEntitlementId(userId, productId, CHAT_PRODUCT_SLUG);
      subscriptionId = selfOp.selfOp
        ? (selfOp.entitlementId ?? '')
        : await this.resolveSubscriptionId(
            userId,
            productId,
            (await this.resolveBillingSubject(userId, tenantId)).tenantId,
          );
    }
    const result = await this.creditService.getTransactions(
      subscriptionId,
      userId,
      parsed.data.page,
      parsed.data.pageSize,
    );
    return { code: 0, message: 'ok', data: result };
  }

  @Get('token-usage')
  async getTokenUsage(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('productId') productId?: string,
    @Query('model') model?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ApiResponse<unknown>> {
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20));
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId);
    const data = await this.billingService.getTokenUsage(
      userId,
      {
        startDate,
        endDate,
        apiKeyId: apiKeyId?.trim() || undefined,
        productId: productId?.trim() || undefined,
        model: model?.trim() || undefined,
        source: source === 'api_key' || source === 'saas' || source === 'all' ? source : undefined,
        page: pageNum,
        pageSize: size,
      },
      subject,
    );
    return { code: 0, message: 'ok', data };
  }

  @Get('token-usage-summary')
  async getTokenUsageSummary(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('productId') productId?: string,
    @Query('model') model?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ApiResponse<unknown>> {
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize || '20', 10) || 20));
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId);
    const data = await this.billingService.getTokenUsageSummary(
      userId,
      {
        startDate,
        endDate,
        apiKeyId: apiKeyId?.trim() || undefined,
        productId: productId?.trim() || undefined,
        model: model?.trim() || undefined,
        page: pageNum,
        pageSize: size,
      },
      subject,
    );
    return { code: 0, message: 'ok', data };
  }

  @Get('token-usage-period-summary')
  async getTokenUsagePeriodSummary(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('productId') productId?: string,
    @Query('model') model?: string,
    @Query('granularity') granularity?: string,
  ): Promise<ApiResponse<unknown>> {
    if (granularity !== 'day' && granularity !== 'month') {
      throw new BadRequestException('granularity must be day or month');
    }
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId);
    const data = await this.billingService.getTokenUsagePeriodSummary(
      userId,
      {
        startDate,
        endDate,
        apiKeyId: apiKeyId?.trim() || undefined,
        productId: productId?.trim() || undefined,
        model: model?.trim() || undefined,
        granularity,
      },
      subject,
    );
    return { code: 0, message: 'ok', data };
  }

  /**
   * Token 用量周期汇总 V2（v1 保留不变）。
   *
   * - `granularity=month`：对齐企业账单 `/admin/v2/enterprise-accounts/:id/bills`
   *   的现算口径（消耗金额 / 账户支付金额 / 代金券抵扣金额）；
   * - `granularity=day`：沿用现有日账单聚合逻辑。
   *
   * 与 v1 并存，前端按需切换；不修改 v1 的任何代码路径。
   */
  @Get('token-usage-period-summary-v2')
  async getTokenUsagePeriodSummaryV2(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('productId') productId?: string,
    @Query('model') model?: string,
    @Query('granularity') granularity?: string,
  ): Promise<ApiResponse<unknown>> {
    if (granularity !== 'day' && granularity !== 'month') {
      throw new BadRequestException('granularity must be day or month');
    }
    const service = this.tokenUsagePeriodSummaryV2;
    if (!service) {
      throw new ServiceUnavailableException('token usage period summary v2 is not available');
    }
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId);
    const data = await service.getPeriodSummary(
      {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        billingAccountType: subject.billingAccountType,
      },
      {
        startDate,
        endDate,
        granularity,
        apiKeyId: apiKeyId?.trim() || undefined,
        productId: productId?.trim() || undefined,
        model: model?.trim() || undefined,
      },
    );
    return { code: 0, message: 'ok', data };
  }

  // ============================
  // 产品 & 加量包（公开）
  // ============================

  @Public()
  @Get('products')
  async getProducts(): Promise<ApiResponse<unknown>> {
    const products = await this.productService.findAll(true);
    return { code: 0, message: 'ok', data: products };
  }

  @Public()
  @Get('booster-packs')
  async getBoosterPacks(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const packs = await this.boosterPackService.findAll(true, productId);
    return { code: 0, message: 'ok', data: packs };
  }

  // ============================
  // 日账单汇总（Task 1）
  // ============================

  @Get('daily-summary')
  async getDailySummary(
    @CurrentUser('id') userId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('productId') productId?: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    if (!startDate || !endDate) {
      throw new BadRequestException('startDate 和 endDate 必填');
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('日期格式不正确');
    }
    // endDate 取当天结束（次日零点）
    end.setDate(end.getDate() + 1);

    const subject = await this.resolveBillingSubject(userId, tenantId);
    const data = await this.billingService.getDailySummary(
      userId,
      start,
      end,
      apiKeyId,
      subject,
      productId?.trim() || undefined,
    );
    return { code: 0, message: 'ok', data };
  }

  // ============================
  // 月账单汇总（Task 2）
  // ============================

  @Get('monthly-summary')
  async getMonthlySummary(
    @CurrentUser('id') userId: string,
    @Query('year') year: string,
    @Query('productId') productId?: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const y = parseInt(year, 10);
    if (!year || isNaN(y) || y < 2020 || y > 2100) {
      throw new BadRequestException('year 必须是合法的年份（2020-2100）');
    }
    const subject = await this.resolveBillingSubject(userId, tenantId);
    const data = await this.billingService.getMonthlySummary(
      userId,
      y,
      subject,
      productId?.trim() || undefined,
    );
    return { code: 0, message: 'ok', data };
  }

  // ============================
  // 账单导出 CSV（Task 4）
  // ============================

  @Get('export')
  async exportBilling(
    @CurrentUser('id') userId: string,
    @Query('type') type: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('year') yearStr?: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Res() res?: FastifyReply,
  ): Promise<void> {
    if (!type || !['daily', 'monthly', 'transactions'].includes(type)) {
      throw new BadRequestException('type 必须是 daily / monthly / transactions');
    }

    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    const year = yearStr ? parseInt(yearStr, 10) : undefined;

    const subject = await this.resolveBillingSubject(userId, tenantId);
    const { filename, csv } = await this.billingService.exportCsv(
      userId,
      type as 'daily' | 'monthly' | 'transactions',
      start,
      end,
      year,
      subject,
    );

    // 添加 BOM 以确保 Excel 正确识别 UTF-8
    const bom = '\uFEFF';
    await res!
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(bom + csv);
  }

  /**
   * 根据 productId 解析 subscriptionId，无 productId 时返回空字符串（不再 fallback 查 DB）
   */
  private async resolveSubscriptionId(
    userId: string,
    productId?: string,
    tenantId?: string | null,
  ): Promise<string> {
    if (!productId) return '';
    const sub = await this.subscriptionResolver.resolve(userId, productId, { tenantId });
    return sub?.subscriptionId ?? '';
  }
}

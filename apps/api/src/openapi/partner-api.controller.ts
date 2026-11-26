import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Query,
  Req,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiResponse,
  CreateOrderInput,
  CreateOrderResponse,
  Order,
  PaginatedResult,
  PaymentMethodsResponse,
} from '@ruidong/shared';
import { z } from 'zod';
import { BillingService } from '../billing/billing.service';
import { CreditService } from '../billing/credit.service';
import { ProductPortalCatalogService } from '../billing/product-portal-catalog.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { SaasProvisioningService } from '../billing-runtime/saas-provisioning.service';
import { buildPartnerApiEndpoints } from '../common/openapi/partner-api-endpoints';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  partnerCreateOrderSchema,
  partnerCreditQuerySchema,
  partnerCreditTransactionsQuerySchema,
  partnerDailySummaryQuerySchema,
  partnerMonthlySummaryQuerySchema,
  partnerOrderIdParamsSchema,
  partnerOrdersQuerySchema,
  partnerPaymentMethodsQuerySchema,
  partnerProvisionRequestSchema,
  partnerTransactionsQuerySchema,
  partnerUserScopeSchema,
  PartnerCreateOrderRequest,
  PartnerCreditQuery,
  PartnerUserScope,
} from './partner-api.contract';
import { PartnerApiAuthGuard, PartnerApiRequest } from './partner-api-auth.guard';
import { PartnerOperation } from './partner-api-route.decorator';
import { PartnerApiResponseContractInterceptor } from './partner-api-response-contract.interceptor';

type PartnerBillingSubject = { tenantId: string; billingAccountId: string };
type PartnerCreditsSummary = Awaited<ReturnType<CreditService['getSummary']>>;
@Controller('partner/v1')
@UseGuards(PartnerApiAuthGuard)
@UseInterceptors(PartnerApiResponseContractInterceptor)
export class PartnerApiController {
  constructor(
    private readonly catalog: ProductPortalCatalogService,
    private readonly provisioning: SaasProvisioningService,
    private readonly payment: PaymentService,
    private readonly billing: BillingService,
    private readonly credits: CreditService,
    private readonly subscriptionResolver: SubscriptionResolverService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @PartnerOperation('getCurrentProduct')
  async getCurrentProduct(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const productContext = this.requireProductContext(req);
    const product = await this.prisma.product.findFirst({
      where: { id: productContext.id, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        billingMode: true,
        isActive: true,
        defaultPlanId: true,
        webhookUrl: true,
      },
    });
    if (!product) throw new NotFoundException('产品不存在');

    return {
      code: 0,
      message: 'ok',
      data: {
        productId: product.id,
        productSlug: product.slug,
        name: product.name,
        billingMode: product.billingMode,
        isActive: product.isActive,
        defaultPlanId: product.defaultPlanId,
        hasWebhookUrl: Boolean(product.webhookUrl),
        endpoints: this.partnerEndpoints(),
      },
    };
  }

  @PartnerOperation('getCatalog')
  async getCatalog(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    const catalog = await this.catalog.getCatalog(product);
    return { code: 0, message: 'ok', data: catalog };
  }

  @PartnerOperation('getProducts')
  async getProducts(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: this.catalog.getProducts(product) };
  }

  @PartnerOperation('getPlans')
  async getPlans(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getPlans(product) };
  }

  @PartnerOperation('getBoosterPacks')
  async getBoosterPacks(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getBoosterPacks(product) };
  }

  @PartnerOperation('getModels')
  async getModels(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getModels(product) };
  }

  @PartnerOperation('getModelAccess')
  async getModelAccess(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getModelAccess(product) };
  }

  @PartnerOperation('getModelRoutePolicies')
  async getModelRoutePolicies(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getModelRoutePolicies(product) };
  }

  @PartnerOperation('getChannels')
  async getChannels(@Req() req: PartnerApiRequest): Promise<ApiResponse<unknown>> {
    this.assertNoQueryParameters(req);
    const product = await this.resolveTokenProduct(req);
    return { code: 0, message: 'ok', data: await this.catalog.getChannels(product) };
  }

  @PartnerOperation('getBillingCurrentSubscription')
  async getBillingCurrentSubscription(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    const externalScope = this.parsePartnerUserScope(query);
    const scope = await this.resolveProductScope(product.id, externalScope);
    const data = await this.resolvePartnerCurrentSubscription(product, scope);
    return { code: 0, message: 'ok', data };
  }

  @PartnerOperation('getBillingCredits')
  async getBillingCredits(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    const externalQuery = this.parsePartnerCreditQuery(query);
    const parsed = await this.resolveProductCreditQuery(product.id, externalQuery);
    const data = await this.resolvePartnerCredits(product.id, parsed);
    return { code: 0, message: 'ok', data };
  }

  @PartnerOperation('getBillingCreditsSummary')
  async getBillingCreditsSummary(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    const externalScope = this.parsePartnerUserScope(query);
    const scope = await this.resolveProductScope(product.id, externalScope);
    const [subscription, credits] = await Promise.all([
      this.resolvePartnerCurrentSubscription(product, scope),
      this.resolvePartnerCredits(product.id, scope),
    ]);
    return {
      code: 0,
      message: 'ok',
      data: {
        productId: product.id,
        productSlug: product.slug,
        userId: externalScope.userId,
        tenantId: externalScope.tenantId ?? null,
        subscription,
        credits,
        ...credits,
      },
    };
  }

  @PartnerOperation('getBillingCreditTransactions')
  async getBillingCreditTransactions(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const externalQuery = this.parse(partnerCreditTransactionsQuerySchema, query);
    const parsed = await this.resolveProductCreditQuery(product.id, externalQuery);
    const subscriptionId = await this.resolvePartnerCreditSubscriptionId(product.id, parsed);
    const result = await this.credits.getTransactions(
      subscriptionId,
      parsed.userId,
      parsed.page,
      parsed.pageSize,
    );
    const items = await this.externalizeLedgerActorUserIds(product.id, result.items);
    return {
      code: 0,
      message: 'ok',
      data: {
        ...result,
        items: items.map((item) => ({
          ...item,
          tenantId: externalQuery.tenantId ?? null,
          balanceAfter: (item.quotaAfter ?? 0) + (item.bonusAfter ?? 0),
        })),
      },
    };
  }

  @PartnerOperation('getBillingTransactions')
  async getBillingTransactions(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const externalQuery = this.parse(partnerTransactionsQuerySchema, query);
    const parsed = await this.resolveProductScope(product.id, externalQuery);
    const subject = await this.resolvePartnerBillingSubject(parsed);
    const result = await this.billing.getTransactions(
      parsed.userId,
      parsed.page,
      parsed.pageSize,
      product.id,
      subject,
    );
    const items = await this.externalizeLedgerActorUserIds(product.id, result.items);
    return {
      code: 0,
      message: 'ok',
      data: {
        ...result,
        items: items.map((item) => ({
          ...item,
          tenantId: externalQuery.tenantId ?? null,
        })),
      },
    };
  }

  @PartnerOperation('getBillingDailySummary')
  async getBillingDailySummary(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const externalQuery = this.parse(partnerDailySummaryQuerySchema, query);
    const parsed = await this.resolveProductScope(product.id, externalQuery);
    const { start, end } = this.parseDailyDateRange(parsed.startDate, parsed.endDate);
    const subject = await this.resolvePartnerBillingSubject(parsed);
    const data = await this.billing.getDailySummary(
      parsed.userId,
      start,
      end,
      parsed.apiKeyId,
      subject,
      product.id,
    );
    return { code: 0, message: 'ok', data };
  }

  @PartnerOperation('getBillingMonthlySummary')
  async getBillingMonthlySummary(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const externalQuery = this.parse(partnerMonthlySummaryQuerySchema, query);
    const parsed = await this.resolveProductScope(product.id, externalQuery);
    const year = this.parseBillingYear(parsed.year);
    const subject = await this.resolvePartnerBillingSubject(parsed);
    const data = await this.billing.getMonthlySummary(parsed.userId, year, subject, product.id);
    return { code: 0, message: 'ok', data };
  }

  @PartnerOperation('createPaymentOrder')
  async createPaymentOrder(
    @Req() req: PartnerApiRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<CreateOrderResponse>> {
    const product = this.requireProductContext(req);
    // Partner requests must be deterministic across retries. Do not derive
    // callback URLs from Origin/Referer/Host: those headers can change after a
    // lost response and would otherwise alter the idempotency fingerprint.
    const input = this.parsePartnerCreateOrder(body);
    const { userId, tenantId, ...orderInput } = input;
    const externalScope = { userId, tenantId };
    const resolved = await this.resolveProductScopeWithContact(product.id, externalScope);
    const scope = resolved.scope;
    const dto = orderInput as CreateOrderInput;
    if (dto.orderType === 'RECHARGE') {
      (dto as CreateOrderInput & { productId: string }).productId = product.id;
    }
    const purchaseVerificationSubject = {
      ...externalScope,
      ...(resolved.email ? { customerEmail: resolved.email } : {}),
    };
    const result = await this.payment.createOrder(
      scope.userId,
      dto,
      scope.tenantId,
      product,
      purchaseVerificationSubject,
    );
    return {
      code: 0,
      message: '订单创建成功',
      data: {
        ...result,
        order: this.externalizeOrder(result.order, externalScope),
      },
    };
  }

  @PartnerOperation('getPaymentOrders')
  async getPaymentOrders(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<PaginatedResult<Order>>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const externalQuery = this.parse(partnerOrdersQuerySchema, query);
    const parsed = await this.resolveProductScope(product.id, externalQuery);
    const result = await this.payment.getUserOrders(
      parsed.userId,
      parsed.page,
      parsed.pageSize,
      parsed.status,
      parsed.orderType,
      parsed.tenantId,
      product.id,
    );
    return {
      code: 0,
      message: 'ok',
      data: {
        ...result,
        items: result.items.map((order) => this.externalizeOrder(order, externalQuery)),
      },
    };
  }

  @PartnerOperation('getPaymentOrderStatus')
  async getPaymentOrderStatus(
    @Req() req: PartnerApiRequest,
    @Param('id') orderId: string,
    @Query() query: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    orderId = this.parse(partnerOrderIdParamsSchema, { id: orderId }).id;
    const externalScope = this.parsePartnerUserScope(query);
    const scope = await this.resolveProductScope(product.id, externalScope);
    const result = await this.payment.getOrderStatus(
      orderId,
      scope.userId,
      scope.tenantId,
      product.id,
    );
    return { code: 0, message: 'ok', data: result };
  }

  @PartnerOperation('getPaymentOrder')
  async getPaymentOrder(
    @Req() req: PartnerApiRequest,
    @Param('id') orderId: string,
    @Query() query: unknown,
  ): Promise<ApiResponse<Order>> {
    const product = this.requireProductContext(req);
    orderId = this.parse(partnerOrderIdParamsSchema, { id: orderId }).id;
    const externalScope = this.parsePartnerUserScope(query);
    const scope = await this.resolveProductScope(product.id, externalScope);
    const order = await this.payment.getOrder(orderId, scope.userId, scope.tenantId, product.id);
    return { code: 0, message: 'ok', data: this.externalizeOrder(order, externalScope) };
  }

  @PartnerOperation('getPaymentMethods')
  async getPaymentMethods(
    @Req() req: PartnerApiRequest,
    @Query() query: unknown,
  ): Promise<ApiResponse<PaymentMethodsResponse>> {
    const product = this.requireProductContext(req);
    this.rejectExternalProductSelectors(query);
    const parsed = this.parse(partnerPaymentMethodsQuerySchema, query);
    const result = await this.payment.getAvailablePaymentMethods({
      ...parsed,
      productId: product.id,
      allowedPaymentCallbackOrigins: product.allowedPaymentCallbackOrigins,
    });
    return { code: 0, message: 'ok', data: result };
  }

  @PartnerOperation('provision')
  async provision(
    @Req() req: PartnerApiRequest,
    @Body() body: unknown,
  ): Promise<ApiResponse<unknown>> {
    const product = this.requireProductContext(req);
    const parsed = this.parse(partnerProvisionRequestSchema, body);
    const provisioned = await this.provisioning.provision({
      ...parsed,
      productId: product.id,
      productSlug: product.slug,
    });
    return {
      code: 0,
      message: 'ok',
      data: {
        ...provisioned,
        userId: parsed.user.id,
        tenantId: parsed.tenant?.id ?? null,
      },
    };
  }

  private async resolveTokenProduct(req: PartnerApiRequest) {
    const product = this.requireProductContext(req);
    return this.catalog.resolveProduct({ productId: product.id });
  }

  private requireProductContext(req: PartnerApiRequest) {
    if (!req.productContext) {
      throw new NotFoundException('产品不存在');
    }
    return req.productContext;
  }

  private parsePartnerCreateOrder(body: unknown): PartnerCreateOrderRequest {
    this.rejectExternalProductSelectors(body);
    this.rejectForbiddenPaymentSelectors(body);
    return this.parse(partnerCreateOrderSchema, body);
  }

  private parsePartnerUserScope(input: unknown): PartnerUserScope {
    this.rejectExternalProductSelectors(input);
    return this.parse(partnerUserScopeSchema, input);
  }

  private parsePartnerCreditQuery(input: unknown): PartnerCreditQuery {
    this.rejectExternalProductSelectors(input);
    return this.parse(partnerCreditQuerySchema, input);
  }

  private async resolveProductScope<T extends PartnerUserScope>(
    productId: string,
    externalScope: T,
  ): Promise<T> {
    return (await this.resolveProductScopeWithContact(productId, externalScope)).scope;
  }

  private async resolveProductScopeWithContact<T extends PartnerUserScope>(
    productId: string,
    externalScope: T,
  ): Promise<{ scope: T; email: string | null }> {
    const resolved = await this.provisioning.resolveProductSubject(
      productId,
      externalScope.userId,
      externalScope.tenantId,
    );
    return {
      scope: {
        ...externalScope,
        userId: resolved.userId,
        tenantId: resolved.tenantId ?? undefined,
      },
      email: resolved.email ?? null,
    };
  }

  private resolveProductCreditQuery<T extends PartnerCreditQuery>(
    productId: string,
    externalQuery: T,
  ): Promise<T> {
    return this.resolveProductScope(productId, externalQuery);
  }

  private externalizeOrder(
    order: Order,
    externalScope: PartnerUserScope,
  ): Order {
    return {
      ...order,
      userId: externalScope.userId,
      tenantId: externalScope.tenantId ?? null,
    };
  }

  private async externalizeLedgerActorUserIds<T extends { userId: string }>(
    productId: string,
    items: T[],
  ): Promise<Array<Omit<T, 'userId'> & { userId: string | null }>> {
    const actorUserIds = Array.from(new Set(
      items
        .map((item) => item.userId?.trim())
        .filter((userId): userId is string => Boolean(userId)),
    ));
    const bindings = actorUserIds.length > 0
      ? await this.prisma.productExternalUserBinding.findMany({
          where: {
            productId,
            userId: { in: actorUserIds },
          },
          select: {
            userId: true,
            externalUserId: true,
          },
        })
      : [];
    const externalUserIdByInternalId = new Map<string, string>();
    for (const binding of bindings) {
      const externalUserId = binding.externalUserId.trim();
      // Legacy backfills can only prove a binding, not an external identifier.
      // A self-valued binding would expose the internal User.id, so fail closed.
      if (externalUserId && externalUserId !== binding.userId) {
        externalUserIdByInternalId.set(binding.userId, externalUserId);
      }
    }

    return items.map((item) => ({
      ...item,
      // Never echo an internal billing User.id through the Partner API.
      userId: externalUserIdByInternalId.get(item.userId) ?? null,
    }));
  }

  private async resolvePartnerCurrentSubscription(
    product: { id: string; slug: string },
    scope: PartnerUserScope,
  ): Promise<unknown> {
    const selfOp = await this.billing.isSelfOperatedCodingPlanProduct(product.id);
    const subject = selfOp ? {} : await this.resolvePartnerBillingSubject(scope);
    return this.billing.getCurrentSubscriptionBySlug(
      scope.userId,
      product.id,
      product.slug,
      subject,
    );
  }

  private async resolvePartnerCredits(
    productId: string,
    scope: PartnerCreditQuery,
  ): Promise<PartnerCreditsSummary> {
    const subscriptionId = await this.resolvePartnerCreditSubscriptionId(productId, scope);
    return this.credits.getSummary(subscriptionId, scope.userId);
  }

  private async resolvePartnerCreditSubscriptionId(
    productId: string,
    scope: PartnerCreditQuery,
  ): Promise<string> {
    if (scope.entitlementId) {
      return (await this.billing.assertCodingPlanEntitlementAccess(scope.userId, scope.entitlementId, {
        productId,
        tenantId: scope.tenantId ?? null,
      })).id;
    }

    const selfOp = await this.billing.resolveSelfOpEntitlementId(scope.userId, productId);
    if (selfOp.selfOp) return selfOp.entitlementId ?? '';

    const subject = await this.resolvePartnerBillingSubject(scope);
    const resolved = await this.subscriptionResolver.resolve(scope.userId, productId, {
      tenantId: subject.tenantId,
    });
    return resolved?.subscriptionId ?? '';
  }

  private resolvePartnerBillingSubject(scope: PartnerUserScope): Promise<PartnerBillingSubject> {
    return this.billing.resolveSubjectForUser(scope.userId, scope.tenantId);
  }

  private parseDailyDateRange(startDate: string, endDate: string): { start: Date; end: Date } {
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const inclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
    if (
      Number.isNaN(start.getTime())
      || Number.isNaN(inclusiveEnd.getTime())
      || start.toISOString().slice(0, 10) !== startDate
      || inclusiveEnd.toISOString().slice(0, 10) !== endDate
    ) {
      throw new BadRequestException('日期格式不正确');
    }
    if (start.getTime() > inclusiveEnd.getTime()) {
      throw new BadRequestException('startDate 不能晚于 endDate');
    }
    // Inclusive range: a 365-day difference covers exactly 366 calendar days.
    const maxRangeMs = 365 * 24 * 60 * 60 * 1000;
    if (inclusiveEnd.getTime() - start.getTime() > maxRangeMs) {
      throw new BadRequestException('日期范围不能超过 366 天');
    }
    const end = new Date(inclusiveEnd.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  private parseBillingYear(year: string): number {
    if (!/^\d{4}$/.test(year)) {
      throw new BadRequestException('year 必须是合法的年份（2020-2100）');
    }
    const parsed = Number(year);
    if (parsed < 2020 || parsed > 2100) {
      throw new BadRequestException('year 必须是合法的年份（2020-2100）');
    }
    return parsed;
  }

  private parse<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown): z.output<TSchema> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }
    return parsed.data;
  }

  private rejectExternalProductSelectors(value: unknown): void {
    const record = this.objectOrNull(value);
    if (!record) return;
    if (record.productId !== undefined || record.productSlug !== undefined) {
      throw new BadRequestException('product identity is derived from the integration token');
    }
  }

  private assertNoQueryParameters(req: PartnerApiRequest): void {
    const query = this.objectOrNull(req.query);
    if (query && Object.keys(query).length > 0) {
      throw new BadRequestException(
        `Unrecognized query parameter(s): ${Object.keys(query).sort().join(', ')}`,
      );
    }
  }

  private rejectForbiddenPaymentSelectors(value: unknown): void {
    const record = this.objectOrNull(value);
    if (!record) return;
    if (record.tierId !== undefined) {
      throw new BadRequestException('recharge tier is derived from product and amount');
    }
  }

  private objectOrNull(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private partnerEndpoints() {
    const baseUrl = this.config.get<string>('PARTNER_API_PUBLIC_BASE_URL')
      ?? this.config.get<string>('OPENAPI_PUBLIC_BASE_URL');
    return buildPartnerApiEndpoints(baseUrl);
  }
}

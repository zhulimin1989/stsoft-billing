import {
  Controller,
  Post,
  Get,
  Headers,
  Param,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { PaymentService } from './payment.service';
import { WechatPayService } from './wechat-pay.service';
import { AlipayService } from './alipay.service';
import { AlertEventService } from '../alert-events/alert-events.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RedisService } from '../redis/redis.service';
import { usdToCents } from '../billing/money';
import { paymentNotifyReplayKey, redisKeySegment } from '../common/utils/redis-key.util';
import {
  ApiResponse,
  CreateOrderResponse,
  Order,
  OrderStatus,
  PaymentMethodsResponse,
  PaginatedResult,
  createOrderSchema,
  paymentMethodsQuerySchema,
  paginationSchema,
} from '@ruidong/shared';
import {
  assertAllowedPaymentCallbackUrl,
  isAllowedPaymentCallbackUrl,
} from './payment-callback-url-policy';

const PAYMENT_NOTIFY_REPLAY_TTL_SECONDS = 30 * 86400;

@ApiTags('Payment')
@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly wechatPayService: WechatPayService,
    private readonly alipayService: AlipayService,
    private readonly redis: RedisService,
    // P2-A2: 可选 inject — 现有 controller 测试不 wire AlertEventsModule。
    @Optional() private readonly alertEvents?: AlertEventService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Replay-protection helper. Records a one-time notification ID in Redis.
   * Returns true if this is the first time we see `key`, false if duplicate.
   *
   * SETNX + EXPIRE pattern (avoids TOCTOU).
   */
  private async markNotifyOnce(
    key: string,
    ttlSec = PAYMENT_NOTIFY_REPLAY_TTL_SECONDS,
  ): Promise<boolean> {
    const res = await this.redis.set(key, '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  private async clearNotifyOnce(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(
        `支付通知 replay key 清理失败 key=${key}: ${(err as Error).message}`,
      );
    }
  }

  private parsePaidAmountCents(value: string | undefined): number | undefined {
    if (!value) return undefined;
    try {
      const paidAmountCents = usdToCents(value);
      return Number.isFinite(paidAmountCents) ? paidAmountCents : undefined;
    } catch {
      return undefined;
    }
  }

  @Post('create')
  async createOrder(
    @CurrentUser('id') userId: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<CreateOrderResponse>> {
    const explicitTenantId = tenantId?.trim();
    if (!explicitTenantId) {
      throw new BadRequestException('充值和购买必须明确指定工作区');
    }
    const parsed = createOrderSchema.safeParse(
      this.withDefaultRedirectCallbackUrls(body, req),
    );
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }

    const result = await this.paymentService.createOrder(userId, parsed.data, explicitTenantId);
    return { code: 0, message: '订单创建成功', data: result };
  }

  @Public()
  @Get('methods')
  async getPaymentMethods(
    @Query() query: unknown,
  ): Promise<ApiResponse<PaymentMethodsResponse>> {
    const parsed = paymentMethodsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }

    const result = await this.paymentService.getAvailablePaymentMethods(parsed.data);
    return { code: 0, message: 'ok', data: result };
  }

  private withDefaultRedirectCallbackUrls(body: unknown, req: FastifyRequest): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return body;
    }

    const input = body as Record<string, unknown>;
    if (
      (input.channel !== 'STRIPE' && input.channel !== 'ALIPAY') ||
      (input.successUrl && input.cancelUrl)
    ) {
      this.assertAllowedCallbackUrls(input);
      return body;
    }
    this.assertAllowedCallbackUrls(input);

    const baseUrl = this.resolveFrontendBaseUrl(req);
    if (!baseUrl) {
      return body;
    }

    return {
      ...input,
      successUrl: input.successUrl || `${baseUrl}/payment/success`,
      cancelUrl: input.cancelUrl || `${baseUrl}/payment/cancel`,
    };
  }

  private resolveFrontendBaseUrl(req: FastifyRequest): string | null {
    const origin = this.firstHeader(req.headers.origin);
    if (origin && this.isHttpUrl(origin) && isAllowedPaymentCallbackUrl(origin, this.config)) {
      return origin.replace(/\/$/, '');
    }

    const referer = this.firstHeader(req.headers.referer);
    if (referer) {
      try {
        const url = new URL(referer);
        if (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          isAllowedPaymentCallbackUrl(url.origin, this.config)
        ) {
          const mountPath =
            url.pathname === '/console' || url.pathname.startsWith('/console/')
              ? '/console'
              : '';
          return `${url.origin}${mountPath}`;
        }
      } catch {
        // Ignore malformed referers and fall back to forwarded host below.
      }
    }

    const host =
      this.firstHeader(req.headers['x-forwarded-host']) ||
      this.firstHeader(req.headers.host);
    if (!host) {
      return null;
    }

    const proto = this.firstHeader(req.headers['x-forwarded-proto']) || 'https';
    if (proto !== 'http' && proto !== 'https') {
      return null;
    }
    const baseUrl = `${proto}://${host}`;
    return isAllowedPaymentCallbackUrl(baseUrl, this.config) ? baseUrl : null;
  }

  private assertAllowedCallbackUrls(input: Record<string, unknown>): void {
    if (typeof input.successUrl === 'string') {
      assertAllowedPaymentCallbackUrl(input.successUrl, this.config, 'successUrl');
    }
    if (typeof input.cancelUrl === 'string') {
      assertAllowedPaymentCallbackUrl(input.cancelUrl, this.config, 'cancelUrl');
    }
  }

  private firstHeader(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] || null;
    return value || null;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** 轻量轮询 — 前端 3s 间隔查询支付状态 */
  @Get('orders/:id/status')
  async getOrderStatus(
    @CurrentUser('id') userId: string,
    @Param('id') orderId: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<{ status: OrderStatus; paidAt: string | null }>> {
    const result = await this.paymentService.getOrderStatus(orderId, userId, tenantId, productId);
    return { code: 0, message: 'ok', data: result };
  }

  @Get('orders')
  async getUserOrders(
    @CurrentUser('id') userId: string,
    @Query() query: unknown,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<ApiResponse<PaginatedResult<Order>>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }
    const raw = query as Record<string, string>;
    const status = raw?.status || undefined;
    const orderType = raw?.orderType || undefined;
    const result = await this.paymentService.getUserOrders(
      userId,
      parsed.data.page,
      parsed.data.pageSize,
      status,
      orderType,
      tenantId,
    );
    return { code: 0, message: 'ok', data: result };
  }

  @Get('orders/:id')
  async getOrder(
    @CurrentUser('id') userId: string,
    @Param('id') orderId: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<Order>> {
    const order = await this.paymentService.getOrder(orderId, userId, tenantId, productId);
    return { code: 0, message: 'ok', data: order };
  }

  @Post('orders/:id/cancel')
  async cancelOrder(
    @CurrentUser('id') userId: string,
    @Param('id') orderId: string,
    @Headers('x-tenant-id') tenantId?: string,
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<null>> {
    await this.paymentService.cancelOrder(orderId, userId, tenantId, productId);
    return { code: 0, message: '订单已取消', data: null };
  }

  // ============================
  // 微信 V3 异步通知
  // ============================

  @Public()
  @Post('notify/wechat')
  @HttpCode(HttpStatus.OK)
  async wechatNotify(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let replayKey: string | null = null;
    let replayMarked = false;
    let callbackCommitted = false;
    try {
      const headers = req.headers as Record<string, string>;
      const body = req.body as {
        id: string;
        resource: {
          ciphertext: string;
          nonce: string;
          associated_data: string;
        };
      };

      // fastify-raw-body plugin exposes the untouched bytes as (req as any).rawBody.
      // wechatpay-node-v3 verifySign hashes the raw response body; any re-serialization
      // would break key ordering and fail verification.
      const rawBody = (req as unknown as { rawBody?: Buffer | string }).rawBody;
      if (!rawBody) {
        this.logger.error('微信回调: rawBody 不可用 (fastify-raw-body 未注册)');
        await reply.status(500).send({ code: 'FAIL', message: 'rawBody unavailable' });
        return;
      }
      const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf-8') : rawBody;

      const decrypted = await this.wechatPayService.verifyNotifySign(
        headers,
        rawString,
        body,
      );

      // Replay protection: wechat notify carries a stable `id` per notification.
      if (body.id) {
        const idHash = redisKeySegment(body.id);
        replayKey = paymentNotifyReplayKey('wechat', body.id);
        const fresh = await this.markNotifyOnce(replayKey);
        if (!fresh) {
          this.logger.log(`微信通知重放 (idHash=${idHash}) 跳过`);
          await reply.send({ code: 'SUCCESS', message: '成功' });
          return;
        }
        replayMarked = true;
      }

      if (decrypted.trade_state === 'SUCCESS') {
        const handled = await this.paymentService.handlePaymentCallback(
          decrypted.transaction_id,
          decrypted.out_trade_no,
          'WECHAT',
          {
            paidAmountCents: decrypted.amount?.total,
            ...(decrypted.amount?.currency
              ? { paidCurrency: decrypted.amount.currency }
              : {}),
          },
        );
        if (!handled) {
          if (replayKey) await this.clearNotifyOnce(replayKey);
          await reply.status(500).send({ code: 'FAIL', message: '处理失败' });
          return;
        }
        callbackCommitted = true;
      } else {
        callbackCommitted = true;
      }

      // 微信要求返回 JSON { code: 'SUCCESS', message: '成功' }
      await reply.send({ code: 'SUCCESS', message: '成功' });
    } catch (err) {
      if (replayKey && replayMarked && !callbackCommitted) {
        await this.clearNotifyOnce(replayKey);
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`微信回调处理失败: ${msg}`);
      // 错误码映射:
      //   - 验签失败 / header 缺失 → 401(微信会停止重试,本端拒收)
      //   - 配置缺失 → 503(运维问题,微信会重试到运维修复)
      //   - 其他 → 500(未知错误,微信会重试)
      const isSigFailure = /签名|verifySign|缺少必需 header/.test(msg);
      const isConfigMissing = /未配置/.test(msg);
      const status = isSigFailure ? 401 : isConfigMissing ? 503 : 500;
      const code = isSigFailure ? 'signature invalid' : isConfigMissing ? '微信支付未配置' : '处理失败';
      await reply
        .status(status)
        .send({ code: 'FAIL', message: code });
    }
  }

  // ============================
  // 支付宝异步通知（form-urlencoded）
  // ============================

  @Public()
  @Post('notify/alipay')
  @HttpCode(HttpStatus.OK)
  async alipayNotify(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    let replayKey: string | null = null;
    let replayMarked = false;
    let callbackCommitted = false;
    try {
      const params = req.body as Record<string, string>;

      // Step 1: signature verification
      const verification = await this.paymentService.verifyAlipayNotify(params);
      if (!verification.valid) {
        this.logger.warn('支付宝验签失败');
        await reply.type('text/plain').send('fail');
        return;
      }

      // Step 2: replay protection via notify_id (alipay stable per notification)
      const notifyId = params.notify_id;
      if (notifyId) {
        const idHash = redisKeySegment(notifyId);
        replayKey = paymentNotifyReplayKey('alipay', notifyId);
        const fresh = await this.markNotifyOnce(replayKey);
        if (!fresh) {
          this.logger.log(`支付宝通知重放 (notifyIdHash=${idHash}) 跳过`);
          await reply.type('text/plain').send('success');
          return;
        }
        replayMarked = true;
      } else {
        this.logger.warn('支付宝回调无 notify_id，跳过重放保护');
      }

      if (params.trade_status === 'TRADE_SUCCESS') {
        const paidAmountCents = this.parsePaidAmountCents(params.total_amount);
        const handled = await this.paymentService.handlePaymentCallback(
          params.trade_no,
          params.out_trade_no,
          'ALIPAY',
          {
            paidAmountCents,
            paidCurrency: 'cny',
            ...(verification.verifiedPaymentProviderInstanceIds
              ? {
                  verifiedPaymentProviderInstanceIds:
                    verification.verifiedPaymentProviderInstanceIds,
                }
              : {}),
          },
        );
        if (!handled) {
          if (replayKey) await this.clearNotifyOnce(replayKey);
          await reply.type('text/plain').send('fail');
          return;
        }
        callbackCommitted = true;
      } else {
        callbackCommitted = true;
      }

      // 支付宝要求返回纯文本 "success"
      await reply.type('text/plain').send('success');
    } catch (err) {
      if (replayKey && replayMarked && !callbackCommitted) {
        await this.clearNotifyOnce(replayKey);
      }
      this.logger.error(`支付宝回调处理失败: ${err}`);
      await reply.type('text/plain').send('fail');
    }
  }

  // ============================
  // Stripe Webhook
  // ============================

  @Public()
  @Post('notify/stripe')
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const sig = req.headers['stripe-signature'] as string;
    if (!sig) {
      // P2-A2 review fix(Important #1): missing-header 也是攻击信号(无签名重放、
      // LB/反代切换丢 header、密钥配错等),按 spec §7.2.b 同样写
      // PAYMENT/CRITICAL AlertEvent。
      // - sourceId=null:此时连 stripe event 都没有
      // - reason='missing_signature_header' 让运营快速区分这条与"验签失败"
      // - fire-and-forget,不阻塞 400 reply;5min 去重在 createAlert 内部
      this.alertEvents
        ?.createAlert({
          category: 'PAYMENT',
          severity: 'CRITICAL',
          title: 'Stripe webhook 缺 Stripe-Signature header',
          message:
            'Stripe webhook 请求缺少 Stripe-Signature header,可能是攻击或反代/LB 配置错误',
          sourceType: 'order',
          sourceId: null,
          context: {
            ip: req.ip ?? null,
            userAgent:
              (req.headers['user-agent'] as string | undefined) ?? null,
            reason: 'missing_signature_header',
          },
        })
        .catch(() => {});
      await reply.code(400).send({ error: 'Missing stripe-signature header' });
      return;
    }

    try {
      // Stripe 签名验证需要原始请求体（由 fastify-raw-body 插件提供）
      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
      if (!rawBody) {
        this.logger.error('Stripe webhook: rawBody unavailable — fastify-raw-body 插件未正确注册');
        await reply.code(500).send({ error: 'Server misconfiguration: raw body not available' });
        return;
      }

      const verification = await this.paymentService.verifyStripeWebhook(rawBody, sig);
      await this.paymentService.handleStripeEvent(
        verification.event,
        verification.verifiedPaymentProviderInstanceIds,
      );
      await reply.code(200).send({ received: true });
    } catch (err) {
      this.logger.error(`Stripe webhook 处理失败: ${err}`);
      // P2-A2: Stripe webhook 验签 / 处理失败 → 写 PAYMENT/CRITICAL AlertEvent
      // (spec §7.2.b)。可能是攻击(伪造签名)或配置错误(STRIPE_WEBHOOK_SECRET
      // 漂移),运营需要立即知道。
      // - sourceId=null:验签失败时拿不到 stripe event,后续可补 stripe event id
      // - 5min 去重(在 createAlert 内部按 (PAYMENT, 'order', null))避免攻击雪崩
      // - fire-and-forget,不阻塞 reply
      const errMsg = err instanceof Error ? err.message : String(err);
      this.alertEvents
        ?.createAlert({
          category: 'PAYMENT',
          severity: 'CRITICAL',
          title: 'Stripe webhook 验签失败',
          message: `验签或处理异常,可能是攻击或配置错误:${errMsg}`,
          sourceType: 'order',
          sourceId: null,
          context: {
            ip: req.ip ?? null,
            userAgent:
              (req.headers['user-agent'] as string | undefined) ?? null,
          },
        })
        .catch(() => {});
      await reply.code(400).send({ error: 'Webhook verification failed' });
    }
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { BillingPortalClient } from '../billing/billing-portal.client';
import { Public } from '../common/decorators/public.decorator';
import {
  createOrderSchema,
  paginationSchema,
} from '@ruidong/shared';

@ApiTags('Payment')
@Controller('payment')
export class PaymentProxyController {
  constructor(private readonly billingPortal: BillingPortalClient) {}

  @Post('create')
  createOrder(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const parsed = createOrderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.billingPortal.requestEnvelope(
      'POST',
      '/payment/create',
      undefined,
      parsed.data,
      forwardHeaders(req),
    );
  }

  @Get('orders/:id/status')
  getOrderStatus(
    @Param('id') orderId: string,
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope(
      'GET',
      `/payment/orders/${encodeURIComponent(orderId)}/status`,
      query, // 透传 productId 等 query（自营/partner 产品隔离）
      undefined,
      forwardHeaders(req),
    );
  }

  @Get('orders')
  getUserOrders(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.billingPortal.requestEnvelope(
      'GET',
      '/payment/orders',
      query,
      undefined,
      forwardHeaders(req),
    );
  }

  @Get('orders/:id')
  getOrder(
    @Param('id') orderId: string,
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope(
      'GET',
      `/payment/orders/${encodeURIComponent(orderId)}`,
      query, // 透传 productId 等 query
      undefined,
      forwardHeaders(req),
    );
  }

  @Post('orders/:id/cancel')
  cancelOrder(
    @Param('id') orderId: string,
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope(
      'POST',
      `/payment/orders/${encodeURIComponent(orderId)}/cancel`,
      query, // 透传 productId 等 query
      {},
      forwardHeaders(req),
    );
  }

  @Public()
  @Post('notify/wechat')
  async wechatNotify(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.forwardNotification('/payment/notify/wechat', req, reply);
  }

  @Public()
  @Post('notify/alipay')
  async alipayNotify(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.forwardNotification('/payment/notify/alipay', req, reply);
  }

  @Public()
  @Post('notify/stripe')
  async stripeWebhook(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.forwardNotification('/payment/notify/stripe', req, reply);
  }

  private async forwardNotification(
    path: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = rawBody(req);
    if (!body) {
      await reply.status(500).send({
        code: 500,
        message: 'Payment notification raw body unavailable',
        data: null,
      });
      return;
    }
    const result = await this.billingPortal.requestRaw(
      'POST',
      path,
      undefined,
      body,
      forwardHeaders(req, true),
    );
    sendRaw(reply, result.status, result.headers, result.body);
  }
}

function rawBody(req: FastifyRequest): Buffer | null {
  const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody;
  if (!raw) return null;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

function forwardHeaders(
  req: FastifyRequest,
  includeContentHeaders = false,
): Record<string, string | undefined> {
  return {
    authorization: firstHeader(req.headers.authorization),
    cookie: firstHeader(req.headers.cookie),
    origin: firstHeader(req.headers.origin),
    referer: firstHeader(req.headers.referer),
    'user-agent': firstHeader(req.headers['user-agent']),
    'x-forwarded-for': firstHeader(req.headers['x-forwarded-for']),
    'x-forwarded-host': firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host),
    'x-forwarded-proto': firstHeader(req.headers['x-forwarded-proto']),
    ...(includeContentHeaders
      ? {
          'content-type': firstHeader(req.headers['content-type']),
          'wechatpay-signature': firstHeader(req.headers['wechatpay-signature']),
          'wechatpay-timestamp': firstHeader(req.headers['wechatpay-timestamp']),
          'wechatpay-nonce': firstHeader(req.headers['wechatpay-nonce']),
          'wechatpay-serial': firstHeader(req.headers['wechatpay-serial']),
          'stripe-signature': firstHeader(req.headers['stripe-signature']),
        }
      : {}),
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0] || undefined;
  return value || undefined;
}

function sendRaw(
  reply: FastifyReply,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
  reply.status(status).send(body);
}

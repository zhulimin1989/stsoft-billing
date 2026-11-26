import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { BillingPortalClient } from './billing-portal.client';
import { Public } from '../common/decorators/public.decorator';
import { paginationSchema } from '@ruidong/shared';

@ApiTags('Billing')
@Controller('billing')
export class BillingProxyController {
  constructor(private readonly billingPortal: BillingPortalClient) {}

  @Public()
  @Get('plans')
  getPlans(@Query() query: Record<string, string>, @Req() req: FastifyRequest) {
    return this.billingPortal.requestEnvelope('GET', '/billing/plans', query, undefined, forwardHeaders(req));
  }

  @Public()
  @Get('bundles')
  getBundles(@Req() req: FastifyRequest) {
    return this.billingPortal.requestEnvelope('GET', '/billing/bundles', undefined, undefined, forwardHeaders(req));
  }

  @Get('balance')
  getBalance(@Req() req: FastifyRequest) {
    return this.billingPortal.requestEnvelope('GET', '/billing/balance', undefined, undefined, forwardHeaders(req));
  }

  @Get('current-subscription')
  getCurrentSubscription(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope('GET', '/billing/current-subscription', query, undefined, forwardHeaders(req));
  }

  @Get('credits-summary')
  getCreditsSummary(@Req() req: FastifyRequest) {
    return this.billingPortal.requestEnvelope('GET', '/billing/credits-summary', undefined, undefined, forwardHeaders(req));
  }

  @Get('transactions')
  getTransactions(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.billingPortal.requestEnvelope('GET', '/billing/transactions', query, undefined, forwardHeaders(req));
  }

  @Get('credits')
  getCredits(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope('GET', '/billing/credits', query, undefined, forwardHeaders(req));
  }

  @Get('credit-transactions')
  getCreditTransactions(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    return this.billingPortal.requestEnvelope('GET', '/billing/credit-transactions', query, undefined, forwardHeaders(req));
  }

  @Public()
  @Get('products')
  getProducts(@Req() req: FastifyRequest) {
    return this.billingPortal.requestEnvelope('GET', '/billing/products', undefined, undefined, forwardHeaders(req));
  }

  @Public()
  @Get('booster-packs')
  getBoosterPacks(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope('GET', '/billing/booster-packs', query, undefined, forwardHeaders(req));
  }

  @Get('daily-summary')
  getDailySummary(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope('GET', '/billing/daily-summary', query, undefined, forwardHeaders(req));
  }

  @Get('monthly-summary')
  getMonthlySummary(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.billingPortal.requestEnvelope('GET', '/billing/monthly-summary', query, undefined, forwardHeaders(req));
  }

  @Get('export')
  async exportBilling(
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.billingPortal.requestRaw('GET', '/billing/export', query, undefined, forwardHeaders(req));
    sendRaw(reply, result.status, result.headers, result.body);
  }
}

function forwardHeaders(req: FastifyRequest): Record<string, string | undefined> {
  return {
    authorization: firstHeader(req.headers.authorization),
    cookie: firstHeader(req.headers.cookie),
    origin: firstHeader(req.headers.origin),
    referer: firstHeader(req.headers.referer),
    'user-agent': firstHeader(req.headers['user-agent']),
    'x-forwarded-for': firstHeader(req.headers['x-forwarded-for']),
    'x-forwarded-host': firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host),
    'x-forwarded-proto': firstHeader(req.headers['x-forwarded-proto']),
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

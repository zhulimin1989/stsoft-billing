import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { BillingService } from '../billing/billing.service';
import { CreditService } from '../billing/credit.service';
import { ProductPortalCatalogService } from '../billing/product-portal-catalog.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { SaasProvisioningService } from '../billing-runtime/saas-provisioning.service';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerApiAuthGuard } from './partner-api-auth.guard';
import { PartnerApiController } from './partner-api.controller';
import { PartnerApiResponseContractInterceptor } from './partner-api-response-contract.interceptor';

describe('Partner API response-contract binding', () => {
  let app: NestFastifyApplication;
  const getAvailablePaymentMethods = jest.fn();

  beforeAll(async () => {
    const guard = {
      canActivate: jest.fn((context) => {
        context.switchToHttp().getRequest().productContext = {
          id: 'product-1',
          slug: 'product-one',
          allowedPaymentCallbackOrigins: null,
        };
        return true;
      }),
    };

    @Module({
      controllers: [PartnerApiController],
      providers: [
        PartnerApiResponseContractInterceptor,
        { provide: PartnerApiAuthGuard, useValue: guard },
        { provide: ProductPortalCatalogService, useValue: {} },
        { provide: SaasProvisioningService, useValue: {} },
        {
          provide: PaymentService,
          useValue: { getAvailablePaymentMethods },
        },
        { provide: BillingService, useValue: {} },
        { provide: CreditService, useValue: {} },
        { provide: SubscriptionResolverService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    })
    class PartnerResponseContractProbeModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [PartnerResponseContractProbeModule],
    })
      .overrideGuard(PartnerApiAuthGuard)
      .useValue(guard)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useLogger(false);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    getAvailablePaymentMethods.mockReset();
  });

  it('allows a controller response that matches the registered operation schema', async () => {
    getAvailablePaymentMethods.mockResolvedValue({
      methods: [{
        channel: 'STRIPE',
        label: '银行卡',
        currency: 'usd',
        mode: 'redirect',
      }],
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/partner/v1/payment/methods',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      code: 0,
      message: 'ok',
      data: {
        methods: [{
          channel: 'STRIPE',
          label: '银行卡',
          currency: 'usd',
          mode: 'redirect',
        }],
      },
    });
  });

  it('fails the real controller route closed when its response drifts from the schema', async () => {
    getAvailablePaymentMethods.mockResolvedValue({
      methods: [{
        channel: 'UNSUPPORTED',
        label: 'must-not-leak',
        currency: 'usd',
        mode: 'redirect',
      }],
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/partner/v1/payment/methods',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('must-not-leak');
    expect(response.body).toContain('Partner API response contract violation');
  });
});

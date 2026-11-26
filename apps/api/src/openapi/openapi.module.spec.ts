import { Test } from '@nestjs/testing';
import { PaymentService } from '../payment/payment.service';
import { ProviderRefundSagaService } from '../payment/provider-refund-saga.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OpenApiModule } from './openapi.module';

describe('OpenApiModule', () => {
  it('compiles the production provider graph for PaymentService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OpenApiModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile();

    expect(moduleRef.get(PaymentService)).toBeInstanceOf(PaymentService);
    expect(moduleRef.get(ProviderRefundSagaService)).toBeInstanceOf(
      ProviderRefundSagaService,
    );
    await moduleRef.close();
  });
});

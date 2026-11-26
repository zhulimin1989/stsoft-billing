import { Test } from '@nestjs/testing';
import { CodingPlanFulfillmentService } from '../payment/coding-plan-fulfillment.service';
import { PaymentService } from '../payment/payment.service';
import { MetricsController } from '../metrics/metrics.controller';
import { BillingRuntimeModule } from './billing-runtime.module';
import { ReferralsUserController } from '../referrals/referrals.user.controller';

describe('BillingRuntimeModule', () => {
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  it('compiles as a standalone billing runtime', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BillingRuntimeModule],
    }).compile();

    await moduleRef.close();
  });

  it('wires CodingPlan fulfillment into the runtime payment service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BillingRuntimeModule],
    }).compile();

    const paymentService = moduleRef.get(PaymentService);
    const fulfillment = (
      paymentService as unknown as {
        codingPlanFulfillment?: CodingPlanFulfillmentService;
      }
    ).codingPlanFulfillment;

    expect(fulfillment).toBeInstanceOf(CodingPlanFulfillmentService);

    await moduleRef.close();
  });

  it('wires the authenticated metrics endpoint into the standalone runtime', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BillingRuntimeModule],
    }).compile();

    expect(moduleRef.get(MetricsController)).toBeInstanceOf(MetricsController);

    await moduleRef.close();
  });
  // 2026-09-11 真实故障:ReferralsUserController 声明在 ReferralsModule 里,而
  // ReferralsModule 只被 PaymentModule 引入、PaymentModule 全仓无人引入 ⇒
  // billing-api 上从来没有 GET /api/user/referral-code,请求一律 `Cannot GET` → 404。
  // 而用户端「推介计划」页面把 404 渲染成「当前没有正在进行的推介活动」,
  // 把「路由没挂」伪装成了「数据没配」。光有 providers 里的 ReferralsService 不够。
  it('mounts ReferralsUserController so /api/user/referral-code exists', () => {
    const controllers: unknown[] =
      Reflect.getMetadata('controllers', BillingRuntimeModule) ?? [];
    expect(controllers).toContain(ReferralsUserController);
  });
});

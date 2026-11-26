import { ConfigService } from '@nestjs/config';
import { BillingService } from '../billing/billing.service';
import { GatewayRequestEventBillingService } from '../billing/gateway-request-event-billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RetryWaitRecoveryWorkerService } from './retry-wait-recovery-worker.service';

describe('RetryWaitRecoveryWorkerService', () => {
  function build() {
    const prisma = {
      gatewayBillingEvent: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'evt-1', requestId: 'req-1' },
          { id: 'evt-2', requestId: 'req-2' },
        ]),
      },
      gatewayUsageFundingReservation: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: { requestId: string } }) => (
          where.requestId === 'req-1' ? { id: 'resv-1' } : null
        )),
      },
    };
    const billing = {
      releaseGatewayBalanceFundingReservation: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayBilling = {
      recoverFrozenRetryWaitEvent: jest.fn().mockResolvedValue({ recovered: true, requestId: 'req-2' }),
    };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const service = new RetryWaitRecoveryWorkerService(
      prisma as unknown as PrismaService,
      billing as unknown as BillingService,
      gatewayBilling as unknown as GatewayRequestEventBillingService,
      redis as unknown as RedisService,
      config as unknown as ConfigService,
    );
    return { service, prisma, billing, gatewayBilling, redis };
  }

  it('带泄漏 reservation 的冻结只告警要求人工 absorb,其余正常收口', async () => {
    const { service, prisma, billing, gatewayBilling } = build();

    const result = await service.runOnce('manual');

    expect(result.scanned).toBe(2);
    // req-1 有泄漏 ACTIVE reservation —— 不自动释放(RELEASED 有 DB 断言,
    // 只认 non_financial/financial_absorption 两种带证明的 reason)
    expect(billing.releaseGatewayBalanceFundingReservation).not.toHaveBeenCalled();
    expect(result.manualAbsorptionRequired).toBe(1);
    // req-2 无 reservation —— 正常收口
    expect(gatewayBilling.recoverFrozenRetryWaitEvent).toHaveBeenCalledTimes(1);
    expect(gatewayBilling.recoverFrozenRetryWaitEvent).toHaveBeenCalledWith('evt-2');
    expect(result.eventsRecovered).toBe(1);
    expect(prisma.gatewayBillingEvent.findMany).toHaveBeenCalled();
  });

  it('收口失败计入 failed 且不阻断整轮', async () => {
    const { service, gatewayBilling } = build();
    gatewayBilling.recoverFrozenRetryWaitEvent
      .mockRejectedValueOnce(new Error('boom'));

    const result = await service.runOnce('manual');

    // evt-1 走 manual 分支不被收口;evt-2 收口抛错 —— 计入 failed 且整轮正常返回
    expect(result.eventsRecovered).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('无冻结事件时安静空转', async () => {
    const { service, prisma, gatewayBilling } = build();
    prisma.gatewayBillingEvent.findMany.mockResolvedValue([]);

    const result = await service.runOnce('manual');

    expect(result).toMatchObject({ scanned: 0, eventsRecovered: 0, failed: 0 });
    expect(gatewayBilling.recoverFrozenRetryWaitEvent).not.toHaveBeenCalled();
  });
});

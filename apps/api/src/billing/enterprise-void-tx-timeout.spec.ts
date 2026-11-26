import { EnterpriseAccountService } from './enterprise-account.service';

/**
 * 复合回收事务超时的**跨仓不等式**：
 *   maxWait(10s) + tx上界 + 提交/网络余量 < user 侧 HTTP 超时(90s) < 执行权租约(120s)
 *
 * 原 clamp 是 110s，会把它配穿（10+110=120s 已顶到租约、且 > 90s）：
 * user 侧先抛 502、billing 还在跑，而租约同时已可被接管 ⇒ 重复回收 + 调用方拿不到确定结果。
 * 而 clamp 值原本**零测试** —— 改回 110_000 或删掉 clamp 都全绿。
 */
describe('复合回收事务超时的上界', () => {
  const MAX_WAIT_MS = 10_000;
  const USER_HTTP_TIMEOUT_MS = 90_000;
  const VOID_EXEC_LEASE_MS = 120_000;

  function txTimeout(envValue?: string): number {
    const service = new EnterpriseAccountService(
      {} as never, {} as never, {} as never,
      { get: () => envValue } as never,
      undefined as never,
    );
    // voidTxTimeoutMs 是私有的：这里按名取用，因为它就是本文件要钉的那个值。
    return (service as unknown as { voidTxTimeoutMs(): number }).voidTxTimeoutMs();
  }

  it('默认值满足不等式', () => {
    const tx = txTimeout(undefined);
    expect(tx + MAX_WAIT_MS).toBeLessThan(USER_HTTP_TIMEOUT_MS);
    expect(USER_HTTP_TIMEOUT_MS).toBeLessThan(VOID_EXEC_LEASE_MS);
  });

  it.each([['110000'], ['200000'], ['999999']])(
    'env 配成 %s 也不得把不等式配穿（clamp 生效）',
    (raw) => {
      const tx = txTimeout(raw);
      expect(tx + MAX_WAIT_MS).toBeLessThan(USER_HTTP_TIMEOUT_MS);
    });

  it('env 配小值时按配置走（clamp 只封上界，不抬下界）', () => {
    expect(txTimeout('20000')).toBe(20_000);
  });
});

/**
 * ⚠️ 上面几条只钉了 voidTxTimeoutMs() 这个**取值**，钉不住它有没有真的传给 Prisma。
 * 终审实测：把 `timeout: this.voidTxTimeoutMs()` 改成硬编码 `110_000`，上面 5 条照旧全绿，
 * 而不等式被配穿 —— 又是「值存在但从未流到消费点」。这里断言 $transaction 实到的 options。
 */
describe('复合回收事务的 options 必须真的传到 Prisma', () => {
  it('$transaction 收到的 timeout 来自 voidTxTimeoutMs、maxWait 为 10s', async () => {
    const txOptions: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
      billingAccount: { findMany: jest.fn(async () => []) },
      enterpriseRecoveryFanoutJob: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 0 })),
        groupBy: jest.fn(async () => []),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (cb: unknown, options?: Record<string, unknown>) => {
        if (options) txOptions.push(options);
        return typeof cb === 'function' ? (cb as (t: unknown) => unknown)(tx) : cb;
      }),
    };
    const service = new EnterpriseAccountService(
      prisma as never, {} as never, {} as never,
      { get: () => '40000' } as never,
      undefined as never,
    );

    await service.voidProvisioning({ verificationId: 'v1', reason: 'r' });

    expect(txOptions).toHaveLength(1);
    // env 给的是 40s（在 clamp 上界内）⇒ 必须原样到达 Prisma。
    expect(txOptions[0]).toMatchObject({ timeout: 40_000, maxWait: 10_000 });
  });
});

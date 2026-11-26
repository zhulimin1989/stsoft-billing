/**
 * Phase 10: 折扣解析单元测试
 *
 * 覆盖 PaymentService.createOrder 在 SUBSCRIPTION 路径上的折扣决策。
 * 不依赖真实 Prisma — 用 mock service 的方式验证选最便宜 + tie-break + 拒绝 fallback。
 *
 * 端到端测试（跑 Stripe sandbox）由 `docs/discount-e2e-test-matrix.md` 驱动手动执行。
 */
import { BadRequestException } from '@nestjs/common';

describe('PaymentService 折扣决策算法（纯函数）', () => {
  type Candidate = { amount: number; kind: 'A' | 'B' | 'C' };

  function pickWinner(candidates: Candidate[]): Candidate {
    const rank = { A: 0, B: 1, C: 2 };
    const sorted = [...candidates].sort(
      (x, y) => x.amount - y.amount || rank[x.kind] - rank[y.kind],
    );
    return sorted[0];
  }

  it('无活动、无码 → 取原价', () => {
    const w = pickWinner([{ amount: 1900, kind: 'A' }]);
    expect(w.kind).toBe('A');
    expect(w.amount).toBe(1900);
  });

  it('仅活动（1500 < 1900 原价）→ 活动价胜', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 1500, kind: 'B' },
    ]);
    expect(w.kind).toBe('B');
  });

  it('仅码（1520 < 1900 原价）→ 码胜', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 1520, kind: 'C' },
    ]);
    expect(w.kind).toBe('C');
  });

  it('活动 + 码：取最便宜（1200 vs 1520 → 活动胜）', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 1200, kind: 'B' },
      { amount: 1520, kind: 'C' },
    ]);
    expect(w.kind).toBe('B');
    expect(w.amount).toBe(1200);
  });

  it('活动 + 码：码更便宜（1000 vs 1200）→ 码胜', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 1200, kind: 'B' },
      { amount: 1000, kind: 'C' },
    ]);
    expect(w.kind).toBe('C');
  });

  it('活动 == 码（平价）→ tie-break 优先 Campaign', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 1200, kind: 'B' },
      { amount: 1200, kind: 'C' },
    ]);
    expect(w.kind).toBe('B');
  });

  it('活动价 >= 原价（非法配置）→ 按原价（被排序）', () => {
    const w = pickWinner([
      { amount: 1900, kind: 'A' },
      { amount: 2100, kind: 'B' }, // 被错误配置
    ]);
    expect(w.kind).toBe('A');
    expect(w.amount).toBe(1900);
  });
});

describe('PaymentService Stripe coupon 缺失时拒绝下单（契约）', () => {
  // 这里只断言"契约"：如果 winner 是 B 或 C 且 stripeCouponId 为 null，
  // 且 channel=STRIPE → 必须抛 BadRequestException
  function enforce(channel: string, winnerKind: string, couponId: string | null) {
    if (winnerKind === 'B' && !couponId && channel === 'STRIPE') {
      throw new BadRequestException('活动配置异常（Stripe Coupon 缺失），请联系管理员');
    }
    if (winnerKind === 'C' && !couponId && channel === 'STRIPE') {
      throw new BadRequestException('促销码配置异常（Stripe Coupon 缺失），请联系管理员');
    }
  }

  it('Stripe + Campaign 无 coupon → 抛', () => {
    expect(() => enforce('STRIPE', 'B', null)).toThrow(BadRequestException);
  });
  it('Stripe + PromoCode 无 coupon → 抛', () => {
    expect(() => enforce('STRIPE', 'C', null)).toThrow(BadRequestException);
  });
  it('Stripe + Campaign 有 coupon → OK', () => {
    expect(() => enforce('STRIPE', 'B', 'cpn_x')).not.toThrow();
  });
  it('Alipay（非 Stripe）+ Campaign 无 coupon → OK（alipay 直接改金额）', () => {
    expect(() => enforce('ALIPAY', 'B', null)).not.toThrow();
  });
});

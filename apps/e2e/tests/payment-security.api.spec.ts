import { test, expect } from '@playwright/test';

/**
 * Money-path security guards. These don't attempt to execute a real payment
 * (no provider sandbox wired in CI yet), but verify that the signature +
 * origin checks reject malformed requests.
 *
 * A regression here means a fraudster could POST a fake "paid" callback
 * and get subscription credits granted. Treat these as canaries.
 */

test.describe('Payment webhook signature guards', () => {
  test('Stripe webhook without signature header returns 400', async ({ request }) => {
    const res = await request.post('/api/payment/notify/stripe', {
      data: { type: 'checkout.session.completed', data: { object: {} } },
      headers: { 'content-type': 'application/json' },
    });
    // Stripe SDK rejects missing Stripe-Signature before any handler work.
    // Current controller responds 400; accept 400/401/403 to guard behavior
    // without pinning implementation detail.
    expect([400, 401, 403]).toContain(res.status());
  });

  test('Stripe webhook with fake signature returns 400', async ({ request }) => {
    const res = await request.post('/api/payment/notify/stripe', {
      data: { type: 'checkout.session.completed', data: { object: {} } },
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=fake-signature-bytes',
      },
    });
    expect([400, 401, 403]).toContain(res.status());
  });

  test('WeChat Pay callback with bogus body is rejected (no SUCCESS response)', async ({ request }) => {
    const res = await request.post('/api/payment/notify/wechat', {
      data: { bogus: 'data' },
      headers: {
        'content-type': 'application/json',
        'wechatpay-signature': 'fake',
        'wechatpay-timestamp': String(Math.floor(Date.now() / 1000)),
        'wechatpay-nonce': 'nonce',
        'wechatpay-serial': 'fake-serial',
      },
    });
    // 微信回调拒收路径(controller catch 后):
    //   - 验签失败 / header 缺失 → 401
    //   - 配置缺失(CI 默认) → 503
    //   - 其他 → 500
    // 关键 canary:绝不能是 200(代表"成功处理"会让微信把订单标为"通知已送达"
    // 不再重试 → 真订单永远拿不到积分)。任何非 200 status 都安全。
    expect(res.status()).not.toBe(200);
    // 同样不能是 2xx 任何成功码
    expect(res.status()).toBeGreaterThanOrEqual(400);
    // 但不限制 4xx vs 5xx —— 业务规约层面 4xx 让微信停止重试,5xx 让微信继续重试,
    // 两者都没"被骗"发积分,本期都 OK。
  });

  test('Alipay callback without sign returns success-text but does NOT credit (verification fails silently)', async ({ request }) => {
    const res = await request.post('/api/payment/notify/alipay', {
      form: { trade_status: 'TRADE_SUCCESS', out_trade_no: 'fake-order' },
    });
    // 支付宝业务规约:回调必须 HTTP 200 + 纯文本 body("success"/"fail")。
    // 4xx/5xx 会被支付宝判定为"未送达"并按指数退避重试 ~22 次,生产会被
    // 重试风暴。验签失败时正确做法:HTTP 200 + body="fail"(本端拒绝,
    // 但返回 200 让支付宝停止重试)。
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toBe('fail');
  });
});

test.describe('Payment endpoints are exempt from global rate limit', () => {
  test('10 payment callbacks in quick succession do not 429', async ({ request }) => {
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        request.post('/api/payment/notify/stripe', {
          data: {},
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const statuses = results.map((r) => r.status());
    expect(statuses.every((s) => s !== 429)).toBe(true);
  });
});

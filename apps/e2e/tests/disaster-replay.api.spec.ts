import { expect, test } from '@playwright/test';

/**
 * Replay and degraded-callback drills for payment webhooks.
 *
 * These probes intentionally use bogus provider signatures. They exercise the
 * externally visible failure contract: repeated bad notifications must never
 * look successful to the provider in a way that could credit an order, and the
 * payment callback endpoints must stay exempt from the global rate limiter.
 */

test.describe('Payment webhook replay drills', () => {
  test('Stripe fake-signed replay stays rejected and is not rate-limited', async ({ request }) => {
    const payload = {
      id: 'evt_e2e_replay_probe',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_e2e_replay_probe',
          metadata: { orderId: 'e2e-replay-order' },
        },
      },
    };

    const results = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        request.post('/api/payment/notify/stripe', {
          data: payload,
          headers: {
            'content-type': 'application/json',
            'stripe-signature': 't=1800000000,v1=fake-signature-bytes',
          },
        }),
      ),
    );

    const statuses = results.map((res) => res.status());
    expect(statuses.every((status) => status !== 429)).toBe(true);
    expect(statuses.every((status) => [400, 401, 403].includes(status))).toBe(true);
  });

  test('WeChat fake replay never returns SUCCESS', async ({ request }) => {
    const payload = {
      id: 'wx-e2e-replay-probe',
      resource: {
        ciphertext: 'fake-ciphertext',
        nonce: 'fake-nonce',
        associated_data: 'fake-associated-data',
      },
    };

    const results = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        request.post('/api/payment/notify/wechat', {
          data: payload,
          headers: {
            'content-type': 'application/json',
            'wechatpay-signature': 'fake-signature',
            'wechatpay-timestamp': String(Math.floor(Date.now() / 1000)),
            'wechatpay-nonce': 'fake-nonce',
            'wechatpay-serial': 'fake-serial',
          },
        }),
      ),
    );

    const statuses = results.map((res) => res.status());
    expect(statuses.every((status) => status !== 429)).toBe(true);
    expect(statuses.every((status) => status >= 400)).toBe(true);
    const bodies = await Promise.all(results.map((res) => res.text()));
    expect(bodies.every((body) => !body.includes('SUCCESS'))).toBe(true);
  });

  test('Alipay unsigned replay consistently returns fail text', async ({ request }) => {
    const results = await Promise.all(
      Array.from({ length: 3 }).map(() =>
        request.post('/api/payment/notify/alipay', {
          form: {
            notify_id: 'ali-e2e-replay-probe',
            trade_status: 'TRADE_SUCCESS',
            trade_no: 'ali-e2e-trade',
            out_trade_no: 'e2e-replay-order',
            total_amount: '99.00',
          },
        }),
      ),
    );

    const statuses = results.map((res) => res.status());
    expect(statuses.every((status) => status !== 429)).toBe(true);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const bodies = await Promise.all(results.map((res) => res.text()));
    expect(bodies).toEqual(['fail', 'fail', 'fail']);
  });
});

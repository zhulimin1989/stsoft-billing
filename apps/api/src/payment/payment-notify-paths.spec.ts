import { paymentNotifyPathname, shouldCapturePaymentNotifyRawBody } from './payment-notify-paths';

describe('payment notify rawBody paths', () => {
  it('matches payment notify paths even when providers append query params', () => {
    expect(paymentNotifyPathname('/api/payment/notify/stripe?x=1')).toBe('/api/payment/notify/stripe');
    expect(shouldCapturePaymentNotifyRawBody('/api/payment/notify/stripe?x=1')).toBe(true);
    expect(shouldCapturePaymentNotifyRawBody('/api/payment/notify/wechat?nonce=abc')).toBe(true);
    expect(shouldCapturePaymentNotifyRawBody('/api/payment/notify/alipay?charset=utf-8')).toBe(true);
  });

  it('does not match longer attacker-controlled prefixes', () => {
    expect(shouldCapturePaymentNotifyRawBody('/api/payment/notify/stripe/extra?x=1')).toBe(false);
    expect(shouldCapturePaymentNotifyRawBody('/api/payment/notify-attacker/stripe')).toBe(false);
  });
});

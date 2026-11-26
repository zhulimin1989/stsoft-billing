import { isCsrfExemptPath } from './csrf-exempt-paths';

describe('isCsrfExemptPath', () => {
  it.each([
    '/api/payment/notify/stripe',
    '/api/payment/notify/wechat',
    '/api/payment/notify/alipay',
    '/api/payment/notify/stripe?x=1',
    '/api/internal/billing/admin/orders',
  ])('allows signed callback and internal service path %s', (url) => {
    expect(isCsrfExemptPath(url)).toBe(true);
  });

  it.each([
    '/api/payment/notify',
    '/api/payment/notify/',
    '/api/payment/notify/wechat/extra',
    '/api/payment/notify-attacker',
    '/prefix/api/payment/notify/wechat',
  ])('does not allow broad payment callback match %s', (url) => {
    expect(isCsrfExemptPath(url)).toBe(false);
  });

  it.each(['/api/v1/chat/completions', '/v1/chat/completions'])(
    'does not exempt removed local runtime API path %s',
    (url) => {
      expect(isCsrfExemptPath(url)).toBe(false);
    },
  );
});

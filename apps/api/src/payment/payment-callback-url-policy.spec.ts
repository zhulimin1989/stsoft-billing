import { paymentCallbackOriginSchema } from '@ruidong/shared';
import {
  isAllowedPaymentCallbackUrl,
  normalizePaymentCallbackOrigin,
  normalizeProductPaymentCallbackOrigins,
  resolvePaymentCallbackAllowedOrigins,
} from './payment-callback-url-policy';

describe('payment callback URL policy', () => {
  const config = {
    get: jest.fn((key: string): string | undefined => {
      if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') {
        return 'https://app.example.com, https://console.example.com';
      }
      if (key === 'CORS_ORIGINS') {
        return 'https://user-test.codesphere.run';
      }
      if (key === 'STRIPE_SUCCESS_URL') {
        return 'https://stripe-return.example.com/payment/success';
      }
      return '';
    }),
  };

  it('resolves allowed origins from explicit callback, CORS, and configured callback URLs', () => {
    expect(resolvePaymentCallbackAllowedOrigins(config)).toEqual(new Set([
      'https://app.example.com',
      'https://console.example.com',
      'https://user-test.codesphere.run',
      'https://stripe-return.example.com',
    ]));
  });

  it('allows only http(s) URLs on approved origins', () => {
    expect(isAllowedPaymentCallbackUrl('https://app.example.com/payment/success', config)).toBe(true);
    expect(isAllowedPaymentCallbackUrl('https://user-test.codesphere.run/payment/success', config)).toBe(true);
    expect(isAllowedPaymentCallbackUrl('https://evil.example/payment/success', config)).toBe(false);
    expect(isAllowedPaymentCallbackUrl('javascript:alert(1)', config)).toBe(false);
  });

  it('canonicalizes callback URLs without changing the legacy global behavior', () => {
    expect(normalizePaymentCallbackOrigin('https://APP.example.com:443/payment/success')).toBe(
      'https://app.example.com',
    );
    expect(normalizePaymentCallbackOrigin('javascript:alert(1)')).toBeNull();
  });

  it('uses a non-null product allowlist instead of unioning it with global origins', () => {
    const productOrigins = ['https://product.example.com'];

    expect(resolvePaymentCallbackAllowedOrigins(config, productOrigins)).toEqual(
      new Set(['https://product.example.com']),
    );
    expect(
      isAllowedPaymentCallbackUrl(
        'https://product.example.com/payment/success',
        config,
        productOrigins,
      ),
    ).toBe(true);
    expect(
      isAllowedPaymentCallbackUrl('https://app.example.com/payment/success', config, productOrigins),
    ).toBe(false);
  });

  it('matches product origins by exact scheme, host, and non-default port', () => {
    const productOrigins = ['https://product.example.com:8443'];

    expect(isAllowedPaymentCallbackUrl(
      'https://product.example.com:8443/payment/success',
      config,
      productOrigins,
    )).toBe(true);
    expect(isAllowedPaymentCallbackUrl(
      'http://product.example.com:8443/payment/success',
      config,
      productOrigins,
    )).toBe(false);
    expect(isAllowedPaymentCallbackUrl(
      'https://checkout.product.example.com:8443/payment/success',
      config,
      productOrigins,
    )).toBe(false);
    expect(isAllowedPaymentCallbackUrl(
      'https://product.example.com/payment/success',
      config,
      productOrigins,
    )).toBe(false);
    expect(isAllowedPaymentCallbackUrl(
      'https://product.example.com.evil.test:8443/payment/success',
      config,
      productOrigins,
    )).toBe(false);
  });

  it('treats an empty product allowlist as deny-all and null as global fallback', () => {
    expect(isAllowedPaymentCallbackUrl('https://app.example.com/success', config, [])).toBe(false);
    expect(isAllowedPaymentCallbackUrl('https://app.example.com/success', config, null)).toBe(true);
  });

  it('fails closed for malformed product storage values and entries', () => {
    expect(normalizeProductPaymentCallbackOrigins({ origin: 'https://product.example.com' })).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://product.example.com/path'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://product.example.com/.'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://product.example.com\\path'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://product.example.com?'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://product.example.com#'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://user@product.example.com'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['http://product.example.com'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(['https://*.example.com'])).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins(new Array(51).fill('https://product.example.com'))).toEqual([]);
    expect(normalizeProductPaymentCallbackOrigins([`https://${'a'.repeat(512)}.example.com`])).toEqual([]);
    expect(
      isAllowedPaymentCallbackUrl(
        'https://app.example.com/success',
        config,
        { origin: 'https://app.example.com' },
      ),
    ).toBe(false);
  });

  it('normalizes valid product origins and permits HTTP only for loopback development hosts', () => {
    expect(normalizeProductPaymentCallbackOrigins([
      'https://PRODUCT.example.com/',
      'https://product.example.com',
      'http://localhost:3010',
      'http://127.0.0.1:3010/',
      'http://[::1]:3010',
    ])).toEqual([
      'https://product.example.com',
      'http://localhost:3010',
      'http://127.0.0.1:3010',
      'http://[::1]:3010',
    ]);
  });

  it.each([
    [`${' '.repeat(600)}https://product.example.com${' '.repeat(10)}`, true],
    ['https://product.example.com/.', false],
    ['https://product.example.com\\path', false],
    ['https://product.example.com?next=1', false],
    ['https:product.example.com/payment/success', false],
    ['https:/product.example.com/payment/success', false],
    ['https:\\product.example.com', false],
    ['https://@product.example.com', false],
    ['https://%2a.product.example.com', false],
    ['https://prod\tuct.example.com', false],
  ] as Array<[string, boolean]>)('keeps shared schema and runtime normalization aligned for %s', (value, expectedValid) => {
    expect(paymentCallbackOriginSchema.safeParse(value).success).toBe(expectedValid);
    expect(normalizeProductPaymentCallbackOrigins([value])).toEqual(
      expectedValid ? ['https://product.example.com'] : [],
    );
  });
});

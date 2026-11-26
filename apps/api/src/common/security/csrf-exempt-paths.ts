const PAYMENT_NOTIFY_PATHS = new Set([
  '/api/payment/notify/stripe',
  '/api/payment/notify/wechat',
  '/api/payment/notify/alipay',
]);

export function isCsrfExemptPath(url: string): boolean {
  const path = url.split('?')[0] || '';
  return PAYMENT_NOTIFY_PATHS.has(path) || path.startsWith('/api/internal/');
}

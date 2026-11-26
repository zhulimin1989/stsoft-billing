const PAYMENT_NOTIFY_RAW_BODY_PATHS = new Set([
  '/api/payment/notify/stripe',
  '/api/payment/notify/wechat',
  '/api/payment/notify/alipay',
]);

export function paymentNotifyPathname(url: string | undefined): string {
  return (url ?? '').split('?')[0] || '';
}

export function shouldCapturePaymentNotifyRawBody(url: string | undefined): boolean {
  return PAYMENT_NOTIFY_RAW_BODY_PATHS.has(paymentNotifyPathname(url));
}

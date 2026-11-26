export const PARTNER_API_BASE_PATH = '/partner/v1';

export const PARTNER_API_ENDPOINT_KEYS = [
  'base',
  'currentProduct',
  'provision',
  'catalog',
  'products',
  'plans',
  'boosterPacks',
  'models',
  'modelAccess',
  'modelRoutePolicies',
  'channels',
  'paymentCreate',
  'paymentOrders',
  'paymentOrderStatus',
  'paymentOrder',
  'paymentMethods',
  'billingCurrentSubscription',
  'billingCredits',
  'billingCreditsSummary',
  'billingCreditTransactions',
  'billingTransactions',
  'billingDailySummary',
  'billingMonthlySummary',
] as const;

export type PartnerApiEndpointKey = typeof PARTNER_API_ENDPOINT_KEYS[number];
export type PartnerApiEndpoints = Record<PartnerApiEndpointKey, string>;

export function buildPartnerApiEndpoints(publicBaseUrl?: string | null): PartnerApiEndpoints {
  const base = normalizeBaseUrl(publicBaseUrl);
  return {
    base: withBase(base, PARTNER_API_BASE_PATH),
    currentProduct: withBase(base, `${PARTNER_API_BASE_PATH}/product/current`),
    provision: withBase(base, `${PARTNER_API_BASE_PATH}/tenants/provision`),
    catalog: withBase(base, `${PARTNER_API_BASE_PATH}/catalog`),
    products: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/products`),
    plans: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/plans`),
    boosterPacks: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/booster-packs`),
    models: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/models`),
    modelAccess: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/model-access`),
    modelRoutePolicies: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/model-route-policies`),
    channels: withBase(base, `${PARTNER_API_BASE_PATH}/catalog/channels`),
    paymentCreate: withBase(base, `${PARTNER_API_BASE_PATH}/payment/create`),
    paymentOrders: withBase(base, `${PARTNER_API_BASE_PATH}/payment/orders`),
    paymentOrderStatus: withBase(base, `${PARTNER_API_BASE_PATH}/payment/orders/{id}/status`),
    paymentOrder: withBase(base, `${PARTNER_API_BASE_PATH}/payment/orders/{id}`),
    paymentMethods: withBase(base, `${PARTNER_API_BASE_PATH}/payment/methods`),
    billingCurrentSubscription: withBase(base, `${PARTNER_API_BASE_PATH}/billing/current-subscription`),
    billingCredits: withBase(base, `${PARTNER_API_BASE_PATH}/billing/credits`),
    billingCreditsSummary: withBase(base, `${PARTNER_API_BASE_PATH}/billing/credits-summary`),
    billingCreditTransactions: withBase(base, `${PARTNER_API_BASE_PATH}/billing/credit-transactions`),
    billingTransactions: withBase(base, `${PARTNER_API_BASE_PATH}/billing/transactions`),
    billingDailySummary: withBase(base, `${PARTNER_API_BASE_PATH}/billing/daily-summary`),
    billingMonthlySummary: withBase(base, `${PARTNER_API_BASE_PATH}/billing/monthly-summary`),
  };
}

function normalizeBaseUrl(value?: string | null): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function withBase(base: string, path: string): string {
  return base ? `${base}${path}` : path;
}

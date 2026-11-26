import { BadRequestException } from '@nestjs/common';
import {
  canonicalizePaymentCallbackOrigin,
  PAYMENT_CALLBACK_ORIGIN_MAX_COUNT,
} from '@ruidong/shared';

type ConfigLike = {
  get(key: string): string | undefined;
};

function configValue(config: ConfigLike | undefined, key: string): string | undefined {
  return config?.get(key) ?? process.env[key];
}

function splitConfigList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizePaymentCallbackOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '*') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Converts the JSON-backed product setting into the runtime contract.
 *
 * `null` means that the product has no override and may use the global
 * configuration. Any malformed non-null value is converted to an explicit
 * empty allowlist so corrupted database state fails closed.
 */
export function normalizeProductPaymentCallbackOrigins(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  if (value.length > PAYMENT_CALLBACK_ORIGIN_MAX_COUNT) return [];

  const origins = new Set<string>();
  for (const item of value) {
    try {
      origins.add(canonicalizePaymentCallbackOrigin(item));
    } catch {
      return [];
    }
  }
  return [...origins];
}

export function resolvePaymentCallbackAllowedOrigins(
  config?: ConfigLike,
  productOrigins?: unknown,
): Set<string> {
  if (productOrigins !== null && productOrigins !== undefined) {
    return new Set(normalizeProductPaymentCallbackOrigins(productOrigins) ?? []);
  }

  const origins = new Set<string>();
  const configured = [
    ...splitConfigList(configValue(config, 'PAYMENT_CALLBACK_ALLOWED_ORIGINS')),
    ...splitConfigList(configValue(config, 'CORS_ORIGINS')),
    configValue(config, 'STRIPE_SUCCESS_URL'),
    configValue(config, 'STRIPE_CANCEL_URL'),
    configValue(config, 'ALIPAY_RETURN_URL'),
  ];

  for (const value of configured) {
    const origin = normalizePaymentCallbackOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isAllowedPaymentCallbackUrl(
  value: string,
  config?: ConfigLike,
  productOrigins?: unknown,
): boolean {
  const origin = normalizePaymentCallbackOrigin(value);
  if (!origin) return false;
  return resolvePaymentCallbackAllowedOrigins(config, productOrigins).has(origin);
}

export function assertAllowedPaymentCallbackUrl(
  value: string | undefined,
  config: ConfigLike | undefined,
  field: string,
  productOrigins?: unknown,
): void {
  if (!value) return;
  if (!isAllowedPaymentCallbackUrl(value, config, productOrigins)) {
    throw new BadRequestException(`${field} 不在允许的支付回跳域名内`);
  }
}

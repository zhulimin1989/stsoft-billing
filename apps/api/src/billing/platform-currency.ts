import type { ConfigService } from '@nestjs/config';

export type PlatformCurrency = {
  currency: string;
  currencyCode: string;
  currencySymbol: string;
};

export type PlatformRegion = 'domestic' | 'overseas';

const DEFAULT_PLATFORM_CURRENCY = 'usd';
const CURRENCY_SYMBOLS: Record<string, string> = {
  cny: '¥',
  eur: '€',
  gbp: '£',
  hkd: 'HK$',
  jpy: '¥',
  sgd: 'S$',
  usd: '$',
};

type ConfigReader = Pick<ConfigService, 'get'> | undefined;

export function resolvePlatformCurrency(config?: ConfigReader, platformConfig?: unknown): PlatformCurrency {
  const region = resolvePlatformRegion(config, platformConfig);
  const fallbackCurrency = region === 'domestic' ? 'cny' : DEFAULT_PLATFORM_CURRENCY;
  const raw =
    extractPlatformConfigCurrency(platformConfig) ??
    config?.get<string>('BILLING_PLATFORM_CURRENCY') ??
    config?.get<string>('PLATFORM_CURRENCY') ??
    config?.get<string>('BILLING_CURRENCY') ??
    process.env.BILLING_PLATFORM_CURRENCY ??
    process.env.PLATFORM_CURRENCY ??
    process.env.BILLING_CURRENCY ??
    fallbackCurrency;
  const currency = normalizeCurrencyCode(raw, fallbackCurrency);
  return {
    currency,
    currencyCode: currency.toUpperCase(),
    currencySymbol: CURRENCY_SYMBOLS[currency] ?? `${currency.toUpperCase()} `,
  };
}

export function normalizeCurrencyCode(
  value: string | null | undefined,
  fallback = DEFAULT_PLATFORM_CURRENCY,
): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (/^[a-z]{3}$/.test(normalized)) return normalized;
  const normalizedFallback = String(fallback ?? '').trim().toLowerCase();
  return /^[a-z]{3}$/.test(normalizedFallback) ? normalizedFallback : DEFAULT_PLATFORM_CURRENCY;
}

function extractPlatformConfigCurrency(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const currency = (value as { currency?: unknown }).currency;
  return typeof currency === 'string' && currency.trim() ? currency : undefined;
}

function resolvePlatformRegion(config?: ConfigReader, platformConfig?: unknown): PlatformRegion | undefined {
  return normalizePlatformRegion(
    extractPlatformConfigRegion(platformConfig) ??
      config?.get<string>('BILLING_PLATFORM_REGION') ??
      config?.get<string>('PLATFORM_REGION') ??
      config?.get<string>('BILLING_REGION') ??
      process.env.BILLING_PLATFORM_REGION ??
      process.env.PLATFORM_REGION ??
      process.env.BILLING_REGION,
  );
}

function extractPlatformConfigRegion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const region = (value as { region?: unknown }).region;
  return typeof region === 'string' && region.trim() ? region : undefined;
}

export function normalizePlatformRegion(value: unknown): PlatformRegion | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'domestic' || normalized === 'cn' || normalized === 'china') return 'domestic';
  if (
    normalized === 'overseas' ||
    normalized === 'global' ||
    normalized === 'intl' ||
    normalized === 'international'
  ) {
    return 'overseas';
  }
  return undefined;
}

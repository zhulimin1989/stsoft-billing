import { Prisma } from '@prisma/client';

export type DecimalLike = Prisma.Decimal | number | string;

export const USD_SCALE = 12;

export function usd(value: DecimalLike | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function centsToUsd(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100).toDecimalPlaces(USD_SCALE);
}

export function usdToCents(value: DecimalLike | null | undefined): number {
  return usd(value).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** 月/组合计进分：先 SUM(USD) 再 HALF_UP 到分。禁止先按条 usdToCents 再加总。 */
export function sumUsdToCents(
  values: Array<DecimalLike | null | undefined>,
): number {
  return usdToCents(values.reduce(
    (total: Prisma.Decimal, value) => total.plus(usd(value)),
    usd(0),
  ));
}

export function usdNumber(value: DecimalLike | null | undefined): number {
  return usd(value).toNumber();
}

export function usdString(value: DecimalLike | null | undefined): string {
  return usd(value).toFixed(USD_SCALE);
}

/**
 * 账户可用余额 = max(0, 钱包余额) + 剩余信用。
 * 管理端企业详情与用户侧余额接口共用；负余额不冲减剩余信用，正余额计入现金。
 */
export function accountAvailableFromWalletAndRemainingUsd(
  walletUsd: DecimalLike | null | undefined,
  remainingCreditUsd: DecimalLike | null | undefined,
): Prisma.Decimal {
  const wallet = usd(walletUsd);
  const remaining = usd(remainingCreditUsd);
  const cash = wallet.gt(0) ? wallet : new Prisma.Decimal(0);
  return cash.plus(remaining);
}

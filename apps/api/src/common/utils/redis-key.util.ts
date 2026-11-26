import { createHash } from 'crypto';

export function redisKeySegment(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function adminPermissionsCacheKey(adminId: string): string {
  return `admin:perms:${redisKeySegment(adminId)}`;
}

export function adminForceLogoutKey(adminId: string): string {
  return `admin:force_logout:${redisKeySegment(adminId)}`;
}

export function paymentNotifyReplayKey(channel: 'wechat' | 'alipay', notifyId: string): string {
  return `payment:notify:${channel}:${redisKeySegment(notifyId)}`;
}

export function syncDeductCacheKey(idempotencyKey: string): string {
  return `sync:deduct:${redisKeySegment(idempotencyKey)}`;
}

export function syncDeductLockKey(idempotencyKey: string): string {
  return `sync:deduct:lock:${redisKeySegment(idempotencyKey)}`;
}

export function billingKafkaUsageCacheKey(requestId: string): string {
  return `billing:kafka:usage:${redisKeySegment(requestId)}`;
}

export function billingUsageDeductLockKey(idempotencyKey: string): string {
  return `billing:usage:deduct:lock:${redisKeySegment(idempotencyKey)}`;
}

export function modelPricingCacheKey(modelName: string): string {
  return `modelpricing:v3:${redisKeySegment(modelName)}`;
}

export function publicModelPricingCacheKey(modelName: string): string {
  return `modelpricing:public:v3:${redisKeySegment(modelName)}`;
}

export function creditMultiplierCacheKey(planId: string, modelName: string): string {
  return `credit_mult:${redisKeySegment(planId)}:${redisKeySegment(modelName)}`;
}

export function refreshTokenBlacklistKey(jti: string): string {
  return `bl:${redisKeySegment(jti)}`;
}

export function adminRefreshTokenBlacklistKey(jti: string): string {
  return `bl:admin:${redisKeySegment(jti)}`;
}

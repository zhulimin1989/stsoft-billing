export { ErrorCode } from './error-codes';

// Token 过期时间
export const ACCESS_TOKEN_EXPIRY = '15m';
export const REFRESH_TOKEN_EXPIRY = '7d';

// 分页默认值
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Amount unit: cents
export const CURRENCY_UNIT = 100; // $1 = 100 cents

// 密码加密
export const BCRYPT_SALT_ROUNDS = 12;

// API Key
export const API_KEY_PREFIX_LENGTH = 8;
export const MAX_API_KEYS_PER_USER = 10;

// Rate Limiting
export const RATE_LIMIT_GLOBAL = 1000; // 全局每分钟
export const RATE_LIMIT_PER_KEY = 60; // 每 Key 每分钟
export const RATE_LIMIT_PER_USER = 100; // 每用户每分钟

// 产品标识
export const CHAT_PRODUCT_SLUG = 'raytone';

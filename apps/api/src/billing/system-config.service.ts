import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  authProviderForRegion,
  type DeploymentConfigSnapshot,
  type DeploymentLanguage,
  type DeploymentOAuthPublicConfig,
  type DeploymentRegion,
} from '@ruidong/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SystemConfigService {
  private cache: Record<string, unknown> = {};
  private cacheTime = 0;
  // Tracks whether we've successfully loaded from DB at least once within TTL.
  // Without this flag, an empty system_config table means `Object.keys(cache).length === 0`,
  // which makes ensureCache() re-query DB on every request.
  private loaded = false;
  private readonly TTL = 300_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Security-critical deployment state always bypasses the process-local cache. */
  async getDeploymentConfig(
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<DeploymentConfigSnapshot | undefined> {
    const row = await db.systemConfig.findUnique({
      where: { key: 'deploymentConfig' },
    });
    if (row) return normalizeStoredSnapshot(parseValue(row.value), row.version.toString());

    const [platformValue, authValue] = await Promise.all([
      this.getFresh('platformConfig', undefined, db),
      this.getFresh('authConfig', undefined, db),
    ]);
    const platform = asRecord(platformValue);
    const auth = asRecord(authValue);
    const region = normalizeRegion(platform.region) ?? regionForProvider(auth.provider);
    if (!region) return undefined;
    return {
      version: '0',
      region,
      provider: authProviderForRegion(region),
      currency: normalizeCurrency(platform.currency, region === 'domestic' ? 'cny' : 'usd'),
      defaultLanguage: normalizeLanguage(platform.defaultLanguage) ??
        (region === 'domestic' ? 'zh' : 'en'),
      oauth: {},
    };
  }

  async applyDeploymentConfig(value: unknown): Promise<DeploymentConfigSnapshot> {
    const incoming = normalizeIncomingSnapshot(value);
    const version = BigInt(incoming.version);
    const storedValue = JSON.stringify(toStoredSnapshot(incoming));
    const updated = await this.prisma.systemConfig.updateMany({
      where: { key: 'deploymentConfig', version: { lt: version } },
      data: { value: storedValue, version },
    });
    if (updated.count === 0) {
      const existing = await this.prisma.systemConfig.findUnique({
        where: { key: 'deploymentConfig' },
      });
      if (!existing) {
        try {
          await this.prisma.systemConfig.create({
            data: {
              key: 'deploymentConfig',
              value: storedValue,
              version,
              description: '统一部署运行时配置；provider 由 region 派生',
            },
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          await this.prisma.systemConfig.updateMany({
            where: { key: 'deploymentConfig', version: { lt: version } },
            data: { value: storedValue, version },
          });
        }
      }
    }
    const applied = await this.getDeploymentConfig();
    if (!applied) throw new InternalServerErrorException('deploymentConfig 写入后不可读');
    return applied;
  }

  async get(key: string, defaultValue?: unknown): Promise<unknown> {
    await this.ensureCache();
    return this.cache[key] ?? defaultValue;
  }

  async getNumber(key: string, defaultValue: number): Promise<number> {
    const val = await this.get(key);
    return typeof val === 'number' ? val : defaultValue;
  }

  /**
   * 绕过 300s 进程缓存直读 DB 单 key（并回填缓存）。用于多副本下需「尽快」看到其它 Pod 写入的
   * 运行时开关（如 rolling-quota gate）——常规 get 受本进程缓存影响最长 300s 才更新。
   */
  async getFresh(
    key: string,
    defaultValue?: unknown,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<unknown> {
    const row = await db.systemConfig.findUnique({ where: { key } });
    if (!row) {
      delete this.cache[key]; // 行已删除时清掉本地缓存，避免 get/getAll 残留旧值
      return defaultValue;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = row.value;
    }
    this.cache[key] = value;
    return value;
  }

  async getAll(): Promise<Record<string, unknown>> {
    await this.ensureCache();
    return { ...this.cache };
  }

  async set(key: string, value: unknown): Promise<void> {
    if (
      key === 'deploymentConfig' ||
      key === 'authConfig' ||
      key === 'platformConfig'
    ) {
      throw new BadRequestException(`${key} 只能通过版本化 deploymentConfig 快照修改`);
    }
    const valueStr = JSON.stringify(value);
    await this.prisma.systemConfig.upsert({
      where: { key },
      update: { value: valueStr },
      create: { key, value: valueStr },
    });
    this.cache[key] = value;
    this.cacheTime = Date.now();
  }

  invalidateCache() {
    this.cacheTime = 0;
    this.loaded = false;
  }

  private async ensureCache() {
    if (this.loaded && Date.now() - this.cacheTime < this.TTL) {
      return;
    }

    const rows = await this.prisma.systemConfig.findMany();
    this.cache = {};

    for (const row of rows) {
      try {
        this.cache[row.key] = JSON.parse(row.value);
      } catch {
        this.cache[row.key] = row.value;
      }
    }

    this.cacheTime = Date.now();
    this.loaded = true;
  }
}

function normalizeIncomingSnapshot(value: unknown): DeploymentConfigSnapshot {
  const source = asRecord(value);
  const version = normalizeVersion(source.version);
  const region = normalizeRegion(source.region);
  if (!region) throw new BadRequestException('deploymentConfig.region 非法');
  const provider = authProviderForRegion(region);
  if (source.provider !== provider) {
    throw new BadRequestException(`deploymentConfig.provider 必须由 region 派生为 ${provider}`);
  }
  return {
    version,
    region,
    provider,
    currency: normalizeCurrency(source.currency),
    ...(normalizeLanguage(source.defaultLanguage)
      ? { defaultLanguage: normalizeLanguage(source.defaultLanguage) }
      : {}),
    oauth: normalizeOAuth(source.oauth),
  };
}

function normalizeStoredSnapshot(value: unknown, version: string): DeploymentConfigSnapshot {
  const source = asRecord(value);
  const region = normalizeRegion(source.region);
  if (!region) throw new InternalServerErrorException('已存 deploymentConfig.region 非法');
  return {
    version,
    region,
    provider: authProviderForRegion(region),
    currency: normalizeCurrency(source.currency, region === 'domestic' ? 'cny' : 'usd'),
    defaultLanguage: normalizeLanguage(source.defaultLanguage) ??
      (region === 'domestic' ? 'zh' : 'en'),
    oauth: normalizeOAuth(source.oauth),
  };
}

function toStoredSnapshot(snapshot: DeploymentConfigSnapshot) {
  return {
    region: snapshot.region,
    currency: snapshot.currency,
    ...(snapshot.defaultLanguage ? { defaultLanguage: snapshot.defaultLanguage } : {}),
    oauth: snapshot.oauth,
  };
}

function normalizeVersion(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new BadRequestException('deploymentConfig.version 必须为正整数');
  }
  return BigInt(normalized).toString();
}

function normalizeRegion(value: unknown): DeploymentRegion | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'domestic' || normalized === 'cn' || normalized === 'china') return 'domestic';
  if (
    normalized === 'overseas' ||
    normalized === 'global' ||
    normalized === 'intl' ||
    normalized === 'international'
  ) return 'overseas';
  return undefined;
}

function regionForProvider(value: unknown): DeploymentRegion | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'authing') return 'domestic';
  if (normalized === 'auth0') return 'overseas';
  return undefined;
}

function normalizeCurrency(value: unknown, fallback?: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (/^[a-z]{3}$/.test(normalized)) return normalized;
  if (fallback) return fallback;
  throw new BadRequestException('deploymentConfig.currency 必须为 3 位币种代码');
}

function normalizeLanguage(value: unknown): DeploymentLanguage | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn') return 'zh';
  if (normalized === 'en' || normalized === 'en-us') return 'en';
  return undefined;
}

function normalizeOAuth(value: unknown): DeploymentOAuthPublicConfig {
  const source = asRecord(value);
  const output: DeploymentOAuthPublicConfig = {};
  for (const key of [
    'auth0Domain',
    'auth0ClientId',
    'auth0DbConnection',
    'authingAppHost',
    'authingAppId',
    'authingWechatConnection',
  ] as const) {
    const raw = source[key];
    if (typeof raw === 'string' && raw.trim()) output[key] = raw.trim();
  }
  return output;
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

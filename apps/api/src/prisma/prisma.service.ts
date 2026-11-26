import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, Prisma } from '@prisma/client';

function createSoftDeleteExtension() {
  return {
    model: {
      user: createSoftDeleteModel('user'),
      plan: createSoftDeleteModel('plan'),
      apiKey: createSoftDeleteModel('apiKey'),
      channel: createSoftDeleteModel('channel'),
      conversation: createSoftDeleteModel('conversation'),
    },
  };
}

function createSoftDeleteModel(modelName: string) {
  return {
    async softDelete<T extends { update: (args: any) => any }>(this: T, args: { where: { id: string } }) {
      return (this as any).update({
        where: args.where,
        data: { deletedAt: new Date() },
      });
    },
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Optional() config?: ConfigService) {
    super(createPrismaClientOptions(config));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export function resolvePrismaDatasourceUrl(
  env: NodeJS.ProcessEnv,
  config?: Pick<ConfigService, 'get'>,
): string | undefined {
  const getValue = (key: string) => config?.get<string>(key) || env[key];
  const serviceRole =
    getValue('RUIDONG_SERVICE') ||
    getValue('SERVICE_ROLE') ||
    (getValue('BILLING_RUNTIME') === 'true' ? 'billing' : 'api');
  const isProductionRuntime =
    getValue('NODE_ENV') === 'production' || getValue('APP_ENV') === 'production';

  if (serviceRole === 'billing' || serviceRole === 'openapi') {
    const billingDatabaseUrl = getValue('BILLING_DATABASE_URL');
    if (billingDatabaseUrl) return billingDatabaseUrl;
    if (isProductionRuntime) {
      throw new Error(
        'BILLING_DATABASE_URL is required for billing data runtimes in production',
      );
    }
    return getValue('DATABASE_URL');
  }

  return getValue('DATABASE_URL');
}

/** Session advisory locks need one physical connection to the same owned datasource. */
export function createBillingAdvisoryLockClient(): PrismaClient | null {
  const url = resolvePrismaDatasourceUrl(process.env);
  if (!url) return null;
  let sessionUrl: string;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('connection_limit', '1');
    sessionUrl = parsed.toString();
  } catch {
    sessionUrl = `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
  }
  return new PrismaClient({ datasources: { db: { url: sessionUrl } } });
}

/**
 * Operational Billing commands are intentionally stricter than local runtime
 * startup: they must name the Billing datasource explicitly and never inherit
 * a control-plane DATABASE_URL by accident.
 */
export function requireBillingDatabaseUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, 'BILLING_DATABASE_URL' | 'DATABASE_URL'>> = process.env,
): string {
  const billingDatabaseUrl = env.BILLING_DATABASE_URL?.trim();
  if (!billingDatabaseUrl) {
    throw new Error(
      'BILLING_DATABASE_URL is required; refusing to use DATABASE_URL for billing operations',
    );
  }
  return billingDatabaseUrl;
}

function createPrismaClientOptions(config?: ConfigService): Prisma.PrismaClientOptions | undefined {
  const url = resolvePrismaDatasourceUrl(process.env, config);
  if (!url) return undefined;
  return {
    datasources: {
      db: { url },
    },
  };
}

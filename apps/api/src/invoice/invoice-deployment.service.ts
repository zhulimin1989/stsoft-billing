import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../billing/system-config.service';

export type InvoiceDeployment = 'domestic' | 'international';

/**
 * 国内/海外按登录方式判定：Authing = 国内，Auth0 = 海外。
 * 与开票工作流同一套部署配置；登录方式与区域冲突或都缺失时失败，不猜测。
 */
export function invoiceRegionFromLogin(input: {
  provider?: unknown;
  region?: unknown;
}): InvoiceDeployment {
  const fromProvider = regionFromAuthProvider(input.provider);
  const fromRegion = regionFromPlatformRegion(input.region);
  if (fromProvider && fromRegion && fromProvider !== fromRegion) {
    throw new Error(
      `登录方式与部署区域不一致: provider=${String(input.provider ?? '')} region=${String(input.region ?? '')}（authing=国内，auth0=海外）`,
    );
  }
  const resolved = fromProvider ?? fromRegion;
  if (!resolved) {
    throw new Error('无法判定国内/海外环境：缺少登录方式（authing=国内，auth0=海外）');
  }
  return resolved;
}

@Injectable()
export class InvoiceDeploymentService {
  constructor(
    private readonly config: ConfigService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async resolve(): Promise<InvoiceDeployment> {
    const deploymentConfig = await this.systemConfig.getDeploymentConfig();
    const region = normalizePlatformRegion(
      deploymentConfig?.region ?? this.config.get<string>('PLATFORM_REGION'),
    );
    return region === 'domestic' ? 'domestic' : 'international';
  }

  async resolveLoginRegion(): Promise<InvoiceDeployment> {
    const deploymentConfig = await this.systemConfig.getDeploymentConfig();
    return invoiceRegionFromLogin({
      provider: deploymentConfig?.provider,
      region: deploymentConfig?.region ?? this.config.get<string>('PLATFORM_REGION'),
    });
  }
}

function regionFromAuthProvider(value: unknown): InvoiceDeployment | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'authing') return 'domestic';
  if (normalized === 'auth0') return 'international';
  return undefined;
}

function regionFromPlatformRegion(value: unknown): InvoiceDeployment | undefined {
  const region = normalizePlatformRegion(value);
  if (region === 'domestic') return 'domestic';
  if (region === 'overseas') return 'international';
  return undefined;
}

function normalizePlatformRegion(value: unknown): 'overseas' | 'domestic' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'domestic' || normalized === 'cn' || normalized === 'china') return 'domestic';
  if (
    normalized === 'overseas'
    || normalized === 'global'
    || normalized === 'intl'
    || normalized === 'international'
  ) return 'overseas';
  return undefined;
}

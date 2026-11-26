export type DeploymentRegion = 'domestic' | 'overseas';
export type DeploymentAuthProvider = 'authing' | 'auth0';
export type DeploymentLanguage = 'zh' | 'en';

export interface DeploymentOAuthPublicConfig {
  auth0Domain?: string;
  auth0ClientId?: string;
  auth0DbConnection?: string;
  authingAppHost?: string;
  authingAppId?: string;
  authingWechatConnection?: string;
}

/**
 * 跨服务部署配置快照。version 是 admin 数据库生成的单调递增十进制字符串；
 * provider 仅用于传输和校验，实际值必须始终由 region 唯一派生。
 */
export interface DeploymentConfigSnapshot {
  version: string;
  region: DeploymentRegion;
  provider: DeploymentAuthProvider;
  currency: string;
  defaultLanguage?: DeploymentLanguage;
  oauth: DeploymentOAuthPublicConfig;
}

export function authProviderForRegion(region: DeploymentRegion): DeploymentAuthProvider {
  return region === 'domestic' ? 'authing' : 'auth0';
}

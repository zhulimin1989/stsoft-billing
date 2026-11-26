import { InvoiceDeploymentService, invoiceRegionFromLogin } from '../invoice-deployment.service';

describe('invoiceRegionFromLogin', () => {
  it('maps authing to domestic and auth0 to international', () => {
    expect(invoiceRegionFromLogin({ provider: 'authing' })).toBe('domestic');
    expect(invoiceRegionFromLogin({ provider: 'Authing' })).toBe('domestic');
    expect(invoiceRegionFromLogin({ provider: 'auth0' })).toBe('international');
    expect(invoiceRegionFromLogin({ provider: 'AUTH0' })).toBe('international');
  });

  it('falls back to platform region when provider is missing', () => {
    expect(invoiceRegionFromLogin({ region: 'domestic' })).toBe('domestic');
    expect(invoiceRegionFromLogin({ region: 'cn' })).toBe('domestic');
    expect(invoiceRegionFromLogin({ region: 'overseas' })).toBe('international');
    expect(invoiceRegionFromLogin({ region: 'international' })).toBe('international');
  });

  it('accepts matching provider and region', () => {
    expect(invoiceRegionFromLogin({ provider: 'authing', region: 'domestic' })).toBe('domestic');
    expect(invoiceRegionFromLogin({ provider: 'auth0', region: 'overseas' })).toBe('international');
  });

  it('fails closed when provider and region conflict', () => {
    expect(() => invoiceRegionFromLogin({ provider: 'authing', region: 'overseas' }))
      .toThrow('登录方式与部署区域不一致');
    expect(() => invoiceRegionFromLogin({ provider: 'auth0', region: 'domestic' }))
      .toThrow('登录方式与部署区域不一致');
  });

  it('fails closed when login method and region are both missing', () => {
    expect(() => invoiceRegionFromLogin({}))
      .toThrow('无法判定国内/海外环境：缺少登录方式（authing=国内，auth0=海外）');
  });
});

describe('InvoiceDeploymentService.resolveLoginRegion', () => {
  it('prefers deployment provider from system config', async () => {
    const service = new InvoiceDeploymentService(
      { get: jest.fn() } as never,
      { getDeploymentConfig: jest.fn(async () => ({ provider: 'authing', region: 'domestic' })) } as never,
    );
    await expect(service.resolveLoginRegion()).resolves.toBe('domestic');
  });

  it('uses auth0 as overseas even if PLATFORM_REGION is unset', async () => {
    const service = new InvoiceDeploymentService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { getDeploymentConfig: jest.fn(async () => ({ provider: 'auth0', region: 'overseas' })) } as never,
    );
    await expect(service.resolveLoginRegion()).resolves.toBe('international');
  });

  it('falls back to PLATFORM_REGION when deployment config is missing', async () => {
    const service = new InvoiceDeploymentService(
      { get: jest.fn().mockReturnValue('domestic') } as never,
      { getDeploymentConfig: jest.fn(async () => undefined) } as never,
    );
    await expect(service.resolveLoginRegion()).resolves.toBe('domestic');
  });

  it('fails closed when neither provider nor region is available', async () => {
    const service = new InvoiceDeploymentService(
      { get: jest.fn().mockReturnValue(undefined) } as never,
      { getDeploymentConfig: jest.fn(async () => undefined) } as never,
    );
    await expect(service.resolveLoginRegion())
      .rejects.toThrow('无法判定国内/海外环境：缺少登录方式（authing=国内，auth0=海外）');
  });
});

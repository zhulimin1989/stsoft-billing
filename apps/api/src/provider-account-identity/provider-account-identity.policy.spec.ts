import {
  normalizeProviderAccountCode,
  requireProviderAccountRef,
  resolveDedicatedProviderCode,
  validateDedicatedProviderAccountIdentityInheritance,
  validateProviderAccountIdentityForProvider,
  validateProviderResaleRouteGroupAccountIdentity,
} from './provider-account-identity.policy';

describe('provider account identity policy', () => {
  it('normalizes the canonical Moonshot alias to Kimi', () => {
    expect(normalizeProviderAccountCode(' MoonShot ')).toBe('kimi');
  });

  it('accepts a valid active identity for the expected provider', () => {
    expect(validateProviderAccountIdentityForProvider({
      ref: 'pa_8e1c4f78-8fb9-497e-a48e-1717852dc270',
      providerCode: 'kimi',
      status: 'active',
    }, 'moonshot')).toEqual({
      ref: 'pa_8e1c4f78-8fb9-497e-a48e-1717852dc270',
      providerCode: 'kimi',
      status: 'active',
    });
  });

  it('rejects inactive identities and provider ownership mismatches', () => {
    expect(() => validateProviderAccountIdentityForProvider({
      ref: 'pa_inactive',
      providerCode: 'kimi',
      status: 'inactive',
    }, 'kimi')).toThrow('已停用');

    expect(() => validateProviderAccountIdentityForProvider({
      ref: 'pa_openai',
      providerCode: 'openai',
      status: 'active',
    }, 'kimi')).toThrow('不匹配');
  });

  it('rejects malformed refs and refs that reuse a credential identifier', () => {
    expect(() => requireProviderAccountRef(' ref with spaces ')).toThrow('格式不合法');
    expect(() => validateProviderAccountIdentityForProvider({
      ref: 'key-123',
      providerCode: 'openai',
      status: 'active',
    }, 'openai', { forbiddenValues: ['key-123'] })).toThrow('不能复用');
  });

  it('resolves dedicated providers from provider line, then snapshots, and canonicalizes', () => {
    expect(resolveDedicatedProviderCode({
      providerLine: { providerCode: ' MoonShot ' },
      providerCode: 'openai',
      provider: 'anthropic',
    })).toBe('kimi');
    expect(resolveDedicatedProviderCode({
      providerLine: { providerCode: null },
      providerCode: ' ZHIPU ',
      provider: 'openai',
    })).toBe('zhipu');
    expect(resolveDedicatedProviderCode({
      providerLine: null,
      providerCode: null,
      provider: 'MoonShot',
    })).toBe('kimi');
  });

  it('fails closed when the authoritative provider-line code is present but empty', () => {
    expect(() => resolveDedicatedProviderCode({
      providerLine: { providerCode: '' },
      providerCode: 'openai',
      provider: 'openai',
    })).toThrow('providerCode 为必填字符串');
  });

  it('requires a provider entitlement to inherit the exact provider-line identity', () => {
    expect(validateDedicatedProviderAccountIdentityInheritance({
      providerAccountIdentityId: 'identity-1',
      providerLine: { providerAccountIdentityId: 'identity-1' },
    })).toBe('identity-1');
    expect(() => validateDedicatedProviderAccountIdentityInheritance({
      providerAccountIdentityId: 'identity-2',
      providerLine: { providerAccountIdentityId: 'identity-1' },
    })).toThrow('与供应商线路不一致');
    expect(() => validateDedicatedProviderAccountIdentityInheritance({
      providerAccountIdentityId: 'identity-1',
      providerLine: { providerAccountIdentityId: null },
    })).toThrow('供应商线路未绑定');
  });

  it('requires every provider-resale route line to share the exact primary account identity', () => {
    expect(validateProviderResaleRouteGroupAccountIdentity([
      { id: 'line-primary', providerAccountIdentityId: 'identity-1' },
      { id: 'line-runtime', providerAccountIdentityId: 'identity-1' },
    ], {
      requireIdentity: true,
      expectedProviderAccountIdentityId: 'identity-1',
    })).toBe('identity-1');

    expect(() => validateProviderResaleRouteGroupAccountIdentity([
      { id: 'line-primary', providerAccountIdentityId: 'identity-1' },
      { code: 'line-runtime', providerAccountIdentityId: 'identity-2' },
    ], { requireIdentity: true })).toThrow('必须共享同一供应商账户身份: line-runtime');
  });

  it('allows an entirely unbound draft route group but requires identity for live use', () => {
    expect(validateProviderResaleRouteGroupAccountIdentity([
      { id: 'line-primary', providerAccountIdentityId: null },
      { id: 'line-runtime', providerAccountIdentityId: null },
    ])).toBeNull();
    expect(() => validateProviderResaleRouteGroupAccountIdentity([
      { id: 'line-primary', providerAccountIdentityId: null },
    ], { requireIdentity: true })).toThrow('主线路未绑定');
  });
});

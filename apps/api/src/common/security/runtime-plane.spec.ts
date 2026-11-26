import { isRuntimePlanePathAllowed } from './runtime-plane';

describe('runtime plane route isolation', () => {
  it('allows user routes and rejects admin routes on the user plane', () => {
    expect(isRuntimePlanePathAllowed('user', '/api/auth/login')).toBe(true);
    expect(isRuntimePlanePathAllowed('user', '/api/v1/chat/completions')).toBe(false);
    expect(isRuntimePlanePathAllowed('user', '/api/v1/models')).toBe(false);
    expect(isRuntimePlanePathAllowed('user', '/api/v1/models/catalog')).toBe(true);
    expect(isRuntimePlanePathAllowed('user', '/api/admin/auth/profile')).toBe(false);
    expect(isRuntimePlanePathAllowed('user', '/api/admin/v2/risk-rules')).toBe(false);
  });

  it('allows admin routes and rejects user routes on the admin plane', () => {
    expect(isRuntimePlanePathAllowed('admin', '/api/admin/auth/profile')).toBe(true);
    expect(isRuntimePlanePathAllowed('admin', '/api/admin/v2/risk-rules')).toBe(true);
    expect(isRuntimePlanePathAllowed('admin', '/api/auth/login')).toBe(false);
    expect(isRuntimePlanePathAllowed('admin', '/api/v1/chat/completions')).toBe(false);
  });
});

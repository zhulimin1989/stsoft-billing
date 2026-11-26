import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_NO_PERMISSION_REQUIRED_KEY,
  ADMIN_PERMISSION_KEY,
  ADMIN_PRESET_ROLE_KEY,
} from '../decorators/admin-permission.decorator';
import { AdminPermissionGuard } from './admin-permission.guard';

describe('AdminPermissionGuard', () => {
  let guard: AdminPermissionGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new AdminPermissionGuard(reflector);
  });

  function mockMetadata(input: {
    requiredPermissions?: string[];
    noPermissionRequired?: boolean;
    requiredPresetRoles?: string[];
  }): void {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: string) => {
        if (key === ADMIN_PERMISSION_KEY) return input.requiredPermissions as never;
        if (key === ADMIN_NO_PERMISSION_REQUIRED_KEY) return input.noPermissionRequired as never;
        if (key === ADMIN_PRESET_ROLE_KEY) return input.requiredPresetRoles as never;
        return undefined as never;
      });
  }

  function createMockContext(input: {
    internalCaller?: 'admin-api' | 'user-api';
    user?: {
      id: string;
      presetRole?: string;
      adminPermissions?: unknown;
      permissions?: unknown;
    };
  } = {}): ExecutionContext {
    const request = {
      internalCaller: input.internalCaller,
      user: input.user,
    };
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('should deny admin access when permission metadata is missing', async () => {
    mockMetadata({});
    const ctx = createMockContext();
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should allow non-admin internal callers when explicitly marked as no admin permission required', async () => {
    mockMetadata({ noPermissionRequired: true });
    const ctx = createMockContext({ internalCaller: 'user-api' });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should not let admin-api bypass permissions with only no-admin metadata', async () => {
    mockMetadata({ noPermissionRequired: true });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: { id: 'admin-1', adminPermissions: ['admin.dashboard'] },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should require permissions for admin-api on dual-use routes', async () => {
    mockMetadata({
      requiredPermissions: ['admin.plans.view'],
      noPermissionRequired: true,
    });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: { id: 'admin-1', adminPermissions: ['admin.plans.view'] },
    });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('should deny access when user has no admin permissions', async () => {
    mockMetadata({ requiredPermissions: ['admin.users.manage'] });

    const ctx = createMockContext({ user: { id: 'admin-1' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should allow access when admin has required permission', async () => {
    mockMetadata({ requiredPermissions: ['admin.dashboard'] });

    const ctx = createMockContext({
      user: {
        id: 'admin-2',
        adminPermissions: ['admin.dashboard'],
      },
    });
    expect(await guard.canActivate(ctx)).toBe(true);
    const request = ctx.switchToHttp().getRequest() as { user?: { adminPermissions?: string[] } };
    expect(request.user?.adminPermissions).toContain('admin.dashboard');
  });

  it.each(['finance', 'super_admin'])('allows protected finance actions for %s preset', async (presetRole) => {
    mockMetadata({
      requiredPermissions: ['admin.page.historical_platform_losses.approve_post'],
      requiredPresetRoles: ['finance', 'super_admin'],
    });
    const ctx = createMockContext({
      user: {
        id: 'finance-checker',
        presetRole,
        adminPermissions: ['admin.page.historical_platform_losses.approve_post'],
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it.each(['admin', 'operator', undefined])(
    'rejects protected finance actions for non-finance preset %s even with the atom',
    async (presetRole) => {
      mockMetadata({
        requiredPermissions: ['admin.page.historical_platform_losses.approve_post'],
        requiredPresetRoles: ['finance', 'super_admin'],
      });
      const ctx = createMockContext({
        user: {
          id: 'custom-checker',
          ...(presetRole ? { presetRole } : {}),
          adminPermissions: ['admin.page.historical_platform_losses.approve_post'],
        },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    },
  );

  it('uses forwarded permissions without querying the billing database', async () => {
    mockMetadata({ requiredPermissions: ['admin.plans.manage'] });

    const ctx = createMockContext({
      user: {
        id: 'admin-5',
        adminPermissions: ['admin.plans.manage'],
      },
    });

    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('does not derive permissions from preset role in billing', async () => {
    mockMetadata({ requiredPermissions: ['admin.orders.manage'] });

    const ctx = createMockContext({
      user: {
        id: 'admin-6',
        presetRole: 'admin',
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('expands manage permissions to matching view permissions', async () => {
    mockMetadata({ requiredPermissions: ['admin.orders.view'] });

    const ctx = createMockContext({
      user: {
        id: 'admin-4',
        adminPermissions: ['admin.orders.manage'],
      },
    });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it('expands legacy finance permissions to page data capabilities', async () => {
    mockMetadata({ requiredPermissions: ['admin.data.finance_reports.export'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'legacy-finance',
        adminPermissions: ['admin.revenue.view'],
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('maps legacy gateway manage permission only to technical retry', async () => {
    mockMetadata({ requiredPermissions: ['admin.page.gateway_billing_events.retry'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'legacy-gateway-operator',
        adminPermissions: ['admin.page.gateway_billing_events.manage'],
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const resolved = ctx.switchToHttp().getRequest() as {
      user?: { adminPermissions?: string[] };
    };
    expect(resolved.user?.adminPermissions).not.toContain(
      'admin.page.gateway_billing_events.review',
    );
    expect(resolved.user?.adminPermissions).not.toContain(
      'admin.page.gateway_billing_events.settle',
    );
    expect(resolved.user?.adminPermissions).not.toContain(
      'admin.page.gateway_billing_events.absorb',
    );
  });

  it('requires explicit settlement authority for authoritative gateway evidence', async () => {
    mockMetadata({ requiredPermissions: ['admin.page.gateway_billing_events.settle'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'legacy-gateway-operator',
        adminPermissions: ['admin.page.gateway_billing_events.manage'],
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows an administrator with explicit gateway settlement authority', async () => {
    mockMetadata({ requiredPermissions: ['admin.page.gateway_billing_events.settle'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'gateway-settlement-admin',
        adminPermissions: ['admin.page.gateway_billing_events.settle'],
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('does not let transaction viewers acquire gateway financial absorption', async () => {
    mockMetadata({ requiredPermissions: ['admin.page.gateway_billing_events.absorb'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'transaction-viewer',
        adminPermissions: ['admin.transactions.view'],
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('does not let legacy Gateway manage or revenue permissions approve historical losses', async () => {
    mockMetadata({
      requiredPermissions: ['admin.page.historical_platform_losses.approve_post'],
    });
    for (const permission of [
      'admin.page.gateway_billing_events.manage',
      'admin.revenue.view',
    ]) {
      const ctx = createMockContext({
        internalCaller: 'admin-api',
        user: { id: 'legacy-admin', adminPermissions: [permission] },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    }
  });

  it('allows only an explicitly forwarded historical-loss approval atom', async () => {
    mockMetadata({
      requiredPermissions: ['admin.page.historical_platform_losses.approve_post'],
    });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'finance-checker',
        adminPermissions: ['admin.page.historical_platform_losses.approve_post'],
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('does not expand one subscription page into a sibling page', async () => {
    mockMetadata({ requiredPermissions: ['admin.page.subscription_booster_packs.view'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'plans-only',
        adminPermissions: ['admin.page.subscription_plans.view'],
      },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('expands a page into hidden catalogs required to render that page', async () => {
    mockMetadata({ requiredPermissions: ['admin.catalog.booster_packs.view'] });
    const ctx = createMockContext({
      internalCaller: 'admin-api',
      user: {
        id: 'bundle-viewer',
        adminPermissions: ['admin.page.bundles.view'],
      },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const resolved = ctx.switchToHttp().getRequest() as {
      user?: { adminPermissions?: string[] };
    };
    expect(resolved.user?.adminPermissions).not.toContain(
      'admin.page.subscription_booster_packs.view',
    );
  });

  it('rejects malformed forwarded permissions', async () => {
    mockMetadata({ requiredPermissions: ['admin.dashboard'] });
    const ctx = createMockContext({
      user: {
        id: 'admin-5',
        adminPermissions: ['admin.dashboard', 1],
      },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});

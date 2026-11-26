import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { expandAdminPermissions } from '@ruidong/shared';
import {
  ADMIN_NO_PERMISSION_REQUIRED_KEY,
  ADMIN_PERMISSION_KEY,
  ADMIN_PRESET_ROLE_KEY,
} from '../decorators/admin-permission.decorator';

type AdminPermissionRequest = {
  internalCaller?: 'admin-api' | 'user-api';
  user?: {
    id?: string;
    presetRole?: string;
    adminPermissions?: unknown;
    permissions?: unknown;
  };
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      ADMIN_PERMISSION_KEY,
      targets,
    );
    const noPermissionRequired = this.reflector.getAllAndOverride<boolean>(
      ADMIN_NO_PERMISSION_REQUIRED_KEY,
      targets,
    );
    const requiredPresetRoles = this.reflector.getAllAndOverride<string[]>(
      ADMIN_PRESET_ROLE_KEY,
      targets,
    );

    const request = context.switchToHttp().getRequest<AdminPermissionRequest>();
    const isNonAdminInternalCaller =
      request.internalCaller !== undefined && request.internalCaller !== 'admin-api';

    if (noPermissionRequired && isNonAdminInternalCaller) {
      return true;
    }

    if (!requiredPermissions || requiredPermissions.length === 0) {
      throw new ForbiddenException('后台接口缺少权限配置');
    }

    const adminId: string | undefined = request.user?.id;

    if (!adminId) {
      throw new ForbiddenException('权限不足');
    }
    if (
      requiredPresetRoles?.length
      && !requiredPresetRoles.includes(request.user?.presetRole ?? '')
    ) {
      throw new ForbiddenException('权限不足');
    }

    const forwardedPermissions = request.user?.adminPermissions ?? request.user?.permissions;
    if (!isStringArray(forwardedPermissions)) {
      throw new ForbiddenException('管理员权限上下文缺失');
    }
    const resolvedPermissions = expandAdminPermissions(forwardedPermissions);
    request.user = {
      ...request.user,
      adminPermissions: resolvedPermissions,
    };

    const permissionSet = new Set<string>(resolvedPermissions);
    const hasAll = requiredPermissions.every((p) =>
      permissionSet.has(p),
    );

    if (!hasAll) {
      throw new ForbiddenException('权限不足');
    }

    return true;
  }
}

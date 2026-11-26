import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AdminJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token: string | undefined = (request as any).cookies?.admin_access_token;

    if (!token) {
      throw new UnauthorizedException('未登录');
    }

    let payload: { sub: string; adminId?: string; presetRole?: string };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Token 无效或已过期');
    }

    if (!payload.adminId) {
      throw new UnauthorizedException('无效的管理端 Token');
    }

    request.user = {
      id: payload.adminId,
      presetRole: payload.presetRole,
    };

    return true;
  }
}

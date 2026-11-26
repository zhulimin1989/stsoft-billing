import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

type BillingJwtPayload = {
  sub?: string;
  role?: string;
  adminId?: string;
  presetRole?: string;
};

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

@Injectable()
export class BillingAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('未登录');
    }

    let payload: BillingJwtPayload;
    try {
      payload = this.jwt.verify<BillingJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token 无效或已过期');
    }

    const userId = payload.adminId || payload.sub;
    if (!userId) {
      throw new UnauthorizedException('Token 缺少用户标识');
    }

    (request as unknown as { user: unknown }).user = {
      id: userId,
      role: payload.adminId ? 'ADMIN' : payload.role,
      presetRole: payload.presetRole,
    };
    if (!payload.adminId) {
      await this.ensureBillingUserMirror(userId);
    }
    return true;
  }

  private async ensureBillingUserMirror(userId: string): Promise<void> {
    const mirroredAt = new Date();
    await this.prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: null,
        phone: null,
        nickname: '',
        isActive: true,
        mirroredAt,
      },
      update: { mirroredAt },
    });
  }

  private extractToken(request: FastifyRequest): string | null {
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies;
    if (cookies?.access_token) return cookies.access_token;
    if (cookies?.admin_access_token) return cookies.admin_access_token;

    const authorization = firstHeader(request.headers.authorization);
    if (authorization?.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim();
    }
    return null;
  }
}

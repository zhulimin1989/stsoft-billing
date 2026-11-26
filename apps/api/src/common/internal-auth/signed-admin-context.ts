import { UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

type HeaderValue = string | string[] | undefined;

export type VerifiedAdminContext = {
  adminId: string;
  presetRole?: string;
  permissions: string[];
  requestId?: string;
  issuedAt: Date;
};

type SignedAdminContextPayload = {
  version?: unknown;
  adminId?: unknown;
  presetRole?: unknown;
  permissions?: unknown;
  requestId?: unknown;
  issuedAt?: unknown;
};

function firstHeader(value: HeaderValue): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function parsePayload(encoded: string): SignedAdminContextPayload {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new UnauthorizedException('Invalid admin context');
  }
}

export function verifySignedAdminContext(
  headers: Record<string, HeaderValue>,
  secret: string | undefined,
  options: { ttlSeconds?: number; now?: Date } = {},
): VerifiedAdminContext {
  if (!secret?.trim()) {
    throw new UnauthorizedException('Admin context signing secret is not configured');
  }
  const encoded = firstHeader(headers['x-admin-context'])?.trim();
  const signature = firstHeader(headers['x-admin-context-signature'])?.trim();
  if (!encoded || !signature) {
    throw new UnauthorizedException('Admin context is required');
  }
  const expected = signPayload(encoded, secret.trim());
  if (!safeEqual(signature, expected)) {
    throw new UnauthorizedException('Invalid admin context signature');
  }

  const payload = parsePayload(encoded);
  if (payload.version !== 1 || typeof payload.adminId !== 'string' || !payload.adminId.trim()) {
    throw new UnauthorizedException('Invalid admin context');
  }
  if (!Array.isArray(payload.permissions) ||
    !payload.permissions.every((p) => typeof p === 'string' && p.trim())) {
    throw new UnauthorizedException('Invalid admin context');
  }
  if (typeof payload.issuedAt !== 'string') {
    throw new UnauthorizedException('Invalid admin context');
  }
  const issuedAt = new Date(payload.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new UnauthorizedException('Invalid admin context');
  }

  const ttlMs = Math.max(1, options.ttlSeconds ?? 300) * 1000;
  const now = options.now ?? new Date();
  if (Math.abs(now.getTime() - issuedAt.getTime()) > ttlMs) {
    throw new UnauthorizedException('Admin context expired');
  }

  return {
    adminId: payload.adminId.trim(),
    ...(typeof payload.presetRole === 'string' && payload.presetRole.trim()
      ? { presetRole: payload.presetRole.trim() }
      : {}),
    permissions: payload.permissions.map((p) => p.trim()),
    ...(typeof payload.requestId === 'string' && payload.requestId.trim()
      ? { requestId: payload.requestId.trim() }
      : {}),
    issuedAt,
  };
}

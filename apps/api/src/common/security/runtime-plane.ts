import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type RuntimePlane = 'user' | 'admin';

const USER_API_PREFIXES = [
  '/api/health',
  '/api/docs',
  '/api/auth',
  '/api/user',
  // Legacy billing-plane API key route. `BillingRuntimeModule` does not mount
  // `ApiKeyModule`; current API key flows are served by `codesphere-user`.
  '/api/apikeys',
  '/api/v1/models/catalog',
  '/api/models/catalog',
  '/api/v1/tickets',
  '/api/tickets',
  '/api/members',
  '/api/billing',
  '/api/payment',
] as const;

const ADMIN_API_PREFIXES = [
  '/api/health',
  '/api/docs',
  '/api/admin',
  '/api/admin/v2',
  '/api/metrics',
] as const;

function requestPath(url: string): string {
  return url.split('?', 1)[0] || '/';
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isRuntimePlanePathAllowed(plane: RuntimePlane, path: string): boolean {
  const prefixes = plane === 'admin' ? ADMIN_API_PREFIXES : USER_API_PREFIXES;
  return prefixes.some((prefix) => matchesPrefix(path, prefix));
}

export async function registerRuntimePlaneGuard(
  fastify: FastifyInstance,
  plane: RuntimePlane,
): Promise<void> {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = requestPath(request.url);
    if (isRuntimePlanePathAllowed(plane, path)) return;

    await reply.code(404).send({
      code: 'NOT_FOUND',
      message: 'Not Found',
      data: null,
    });
  });
}

import { Params } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { isProductionEnv } from '../runtime/is-production';

export function sanitizeRequestUrlForLogs(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.split(/[?#]/, 1)[0];
  return path || '/';
}

export function sanitizeRequestIdForLogs(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

export function createLoggerConfig(): Params {
  const isProduction = isProductionEnv();

  return {
    pinoHttp: {
      genReqId: (req) => {
        return sanitizeRequestIdForLogs(req.headers['x-request-id'])
          ?? randomUUID();
      },
      autoLogging: true,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            // Query values contain Partner userId/tenantId/entitlementId.
            // Access logs need the route path, never the external subject.
            url: sanitizeRequestUrlForLogs(req.url),
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-product-token',
          'req.headers.x-billing-product-token',
          // Request bodies can contain Partner identity, callback URLs,
          // idempotency keys, passwords, and provisioned key policy. The
          // access log never needs any of it.
          'req.body',
        ],
        censor: '[REDACTED]',
      },
      level: isProduction ? 'info' : 'debug',
      transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, singleLine: true } },
    },
  };
}

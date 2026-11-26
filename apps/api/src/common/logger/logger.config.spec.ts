import {
  createLoggerConfig,
  sanitizeRequestIdForLogs,
  sanitizeRequestUrlForLogs,
} from './logger.config';

describe('logger config data minimization', () => {
  it('logs only the request path and drops query/fragment PII', () => {
    expect(
      sanitizeRequestUrlForLogs(
        '/partner/v1/billing/credits?userId=external-user&tenantId=external-tenant#debug',
      ),
    ).toBe('/partner/v1/billing/credits');
    expect(sanitizeRequestUrlForLogs('/health/live')).toBe('/health/live');
    expect(sanitizeRequestUrlForLogs(undefined)).toBeUndefined();
  });

  it('accepts only bounded opaque request ids for logging', () => {
    expect(sanitizeRequestIdForLogs('req_01JZ.test:retry-2')).toBe(
      'req_01JZ.test:retry-2',
    );
    expect(sanitizeRequestIdForLogs('alice@example.com')).toBeUndefined();
    expect(sanitizeRequestIdForLogs('Bearer secret')).toBeUndefined();
    expect(sanitizeRequestIdForLogs(['request-1'])).toBeUndefined();
    expect(sanitizeRequestIdForLogs('r'.repeat(129))).toBeUndefined();
  });

  it('keeps Partner credentials and provision identity fields in the redact policy', () => {
    const config = createLoggerConfig();
    const pinoHttp = config.pinoHttp as {
      genReqId: (request: {
        headers: Record<string, unknown>;
      }) => string;
      redact: { paths: string[] };
      serializers: {
        req: (request: {
          id: string;
          method: string;
          url: string;
        }) => Record<string, unknown>;
      };
    };

    expect(pinoHttp.redact.paths).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-product-token',
      'req.headers.x-billing-product-token',
      'req.body',
    ]));
    expect(pinoHttp.serializers.req({
      id: 'request-1',
      method: 'GET',
      url: '/partner/v1/payment/orders?userId=external-user',
    })).toEqual({
      id: 'request-1',
      method: 'GET',
      url: '/partner/v1/payment/orders',
    });
    expect(pinoHttp.genReqId({
      headers: { 'x-request-id': 'request-1' },
    })).toBe('request-1');
    expect(pinoHttp.genReqId({
      headers: { 'x-request-id': 'user@example.com' },
    })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

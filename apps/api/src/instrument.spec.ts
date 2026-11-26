import { buildSentryOptions, initSentry } from './instrument';

describe('buildSentryOptions', () => {
  it('returns null when SENTRY_DSN is unset', () => {
    expect(buildSentryOptions({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null when SENTRY_DSN is empty string', () => {
    expect(buildSentryOptions({ SENTRY_DSN: '' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns production sampling when NODE_ENV=production', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);

    expect(opts).not.toBeNull();
    expect(opts!.dsn).toBe('https://x@y/1');
    expect(opts!.tracesSampleRate).toBe(0.1);
    expect(opts!.profileSessionSampleRate).toBe(0.1);
    expect(opts!.environment).toBe('production');
    expect(opts!.sendDefaultPii).toBe(false);
  });

  it('returns production sampling when APP_ENV=production', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      NODE_ENV: 'development',
      APP_ENV: 'production',
    } as NodeJS.ProcessEnv);

    expect(opts).not.toBeNull();
    expect(opts!.tracesSampleRate).toBe(0.1);
    expect(opts!.profileSessionSampleRate).toBe(0.1);
    expect(opts!.environment).toBe('development');
  });

  it('returns full sampling in development', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);

    expect(opts!.tracesSampleRate).toBe(1.0);
    expect(opts!.profileSessionSampleRate).toBe(1.0);
    expect(opts!.environment).toBe('development');
  });

  it('prefers SENTRY_RELEASE over GIT_COMMIT_SHA when both set', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      SENTRY_RELEASE: 'v1.2.3',
      GIT_COMMIT_SHA: 'abcdef',
    } as NodeJS.ProcessEnv);
    expect(opts!.release).toBe('v1.2.3');
  });

  it('falls back to GIT_COMMIT_SHA when SENTRY_RELEASE unset', () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      GIT_COMMIT_SHA: 'abc123',
    } as NodeJS.ProcessEnv);
    expect(opts!.release).toBe('abc123');
  });

  it('replaces RequestData with a method-only request context', async () => {
    const opts = buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)!;
    const integrations = opts.integrations as Array<{
      name: string;
      processEvent?: (
        event: unknown,
        hint: unknown,
        client: unknown,
      ) => unknown;
    }>;
    const requestData = integrations.find((integration) => integration.name === 'RequestData');
    const event = {
      sdkProcessingMetadata: {
        normalizedRequest: {
          method: 'POST',
          url: 'https://api.example.test/partner/v1/tenants/provision?user=external-user',
          headers: {
            authorization: 'Bearer partner-secret',
            'x-product-token': 'product-secret',
            'x-billing-product-token': 'legacy-product-secret',
          },
          cookies: { session: 'session-secret' },
          query_string: 'user=external-user',
          data: JSON.stringify({
            user: { email: 'customer@example.test' },
            tenant: { id: 'external-tenant' },
          }),
        },
      },
    };

    expect(requestData).toBeDefined();
    const processed = await requestData!.processEvent!(
      event,
      {},
      { getOptions: () => ({ sendDefaultPii: false }) },
    ) as typeof event & { request?: Record<string, unknown> };

    expect(processed.request).toEqual({ method: 'POST' });
  });
});

describe('buildSentryOptions.beforeSend', () => {
  function make() {
    return buildSentryOptions({
      SENTRY_DSN: 'https://x@y/1',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv)!;
  }

  it('drops 404 events (noisy client errors)', () => {
    const { beforeSend } = make();
    const event = { contexts: { response: { status_code: 404 } } };
    expect(beforeSend!(event as any, {} as any)).toBeNull();
  });

  it('drops 400 and 422 events', () => {
    const { beforeSend } = make();
    expect(
      beforeSend!({ contexts: { response: { status_code: 400 } } } as any, {} as any),
    ).toBeNull();
    expect(
      beforeSend!({ contexts: { response: { status_code: 422 } } } as any, {} as any),
    ).toBeNull();
  });

  it('keeps 401/403/429 — these often indicate real attacks', () => {
    const { beforeSend } = make();
    for (const code of [401, 403, 429]) {
      const event = { contexts: { response: { status_code: code } } };
      expect(beforeSend!(event as any, {} as any)).toBe(event);
    }
  });

  it('keeps all 5xx events', () => {
    const { beforeSend } = make();
    const event = { contexts: { response: { status_code: 500 } } };
    expect(beforeSend!(event as any, {} as any)).toBe(event);
  });

  it.each([403, 500])(
    'scrubs Partner credentials and provision PII from a kept %i event',
    (statusCode) => {
      const { beforeSend } = make();
      const event = {
        contexts: { response: { status_code: statusCode } },
        request: {
          method: 'POST',
          url: 'https://api.example.test/partner/v1/tenants/provision?user=external-user#debug',
          headers: {
            authorization: 'Bearer partner-secret',
            'x-product-token': 'product-secret',
            'x-billing-product-token': 'legacy-product-secret',
          },
          cookies: { session: 'session-secret' },
          query_string: 'user=external-user',
          data: {
            user: { id: 'external-user', email: 'customer@example.test' },
            tenant: { id: 'external-tenant' },
            key: { budgetUsd: 50 },
          },
        },
        extra: {
          provision: {
            user: { id: 'external-user' },
            tenant: { id: 'external-tenant' },
            contact: { phone: '+86-13800000000' },
            apiKey: 'sk-plain-secret',
            productToken: 'rpi_codesphere_abcdefghijklmnopqrstuvwxyz123456',
            note: 'retry with Bearer another-partner-secret',
          },
        },
      };

      expect(beforeSend!(event as any, {} as any)).toBe(event);
      expect(event.request).toEqual({
        method: 'POST',
        url: 'https://api.example.test/partner/v1/tenants/provision',
        headers: '[REDACTED]',
        cookies: '[REDACTED]',
        query_string: '[REDACTED]',
        data: '[REDACTED]',
      });
      expect(event.extra.provision).toEqual({
        user: '[REDACTED]',
        tenant: '[REDACTED]',
        contact: '[REDACTED]',
        apiKey: '[REDACTED]',
        productToken: '[REDACTED]',
        note: 'retry with Bearer [REDACTED]',
      });
    },
  );

  it('scrubs transaction, span, breadcrumb, log, and metric payloads', () => {
    const opts = make();
    const transaction = {
      type: 'transaction',
      request: {
        method: 'GET',
        url: 'https://api.example.test/partner/v1/billing/credits?externalUserId=user-1',
        headers: { 'x-product-token': 'product-secret' },
        query_string: 'externalUserId=user-1',
      },
      spans: [{
        data: {
          'http.url': 'https://api.example.test/partner/v1/billing/credits?externalUserId=user-1',
          'http.target': '/partner/v1/billing/credits?externalUserId=user-1',
          'url.full': 'https://api.example.test/partner/v1/billing/credits?externalUserId=user-1',
          'url.query': 'externalUserId=user-1',
          'http.request.header.x_product_token': 'product-secret',
          'request.body': '{"user":{"id":"user-1"}}',
          tokenCount: 42,
          inputTokens: 20,
          outputTokens: 22,
          routeKey: 'partner-credit-ledger',
          tierKey: 'standard',
          queryDuration: 12,
        },
      }],
    };
    const span = {
      data: {
        'http.url': 'https://api.example.test/partner/v1/payments/orders?tenant=tenant-1',
        'http.target': '/partner/v1/payments/orders?tenant=tenant-1',
        'http.request.header.authorization': 'Bearer partner-secret',
      },
    };
    const breadcrumb = {
      category: 'http',
      data: {
        url: 'https://api.example.test/partner/v1/tenants/provision?user=user-1',
        headers: { 'x-billing-product-token': 'legacy-product-secret' },
        body: { tenant: 'tenant-1' },
      },
    };
    const log = {
      body: 'Bearer partner-secret',
      attributes: { externalUser: 'user-1', productToken: 'product-secret' },
    };
    const metric = {
      name: 'partner.request',
      attributes: { tenantId: 'tenant-1', authorization: 'Bearer partner-secret' },
    };

    expect(opts.beforeSendTransaction!(transaction as any, {} as any)).toBe(transaction);
    expect(transaction.request).toEqual({
      method: 'GET',
      url: 'https://api.example.test/partner/v1/billing/credits',
      headers: '[REDACTED]',
      query_string: '[REDACTED]',
    });
    expect(transaction.spans[0].data).toEqual({
      'http.url': 'https://api.example.test/partner/v1/billing/credits',
      'http.target': '/partner/v1/billing/credits',
      'url.full': 'https://api.example.test/partner/v1/billing/credits',
      'url.query': '[REDACTED]',
      'http.request.header.x_product_token': '[REDACTED]',
      'request.body': '[REDACTED]',
      tokenCount: 42,
      inputTokens: 20,
      outputTokens: 22,
      routeKey: 'partner-credit-ledger',
      tierKey: 'standard',
      queryDuration: 12,
    });

    expect(opts.beforeSendSpan!(span as any)).toBe(span);
    expect(span.data).toEqual({
      'http.url': 'https://api.example.test/partner/v1/payments/orders',
      'http.target': '/partner/v1/payments/orders',
      'http.request.header.authorization': '[REDACTED]',
    });

    expect(opts.beforeBreadcrumb!(breadcrumb as any)).toBe(breadcrumb);
    expect(breadcrumb.data).toEqual({
      url: 'https://api.example.test/partner/v1/tenants/provision',
      headers: '[REDACTED]',
      body: '[REDACTED]',
    });

    expect(opts.beforeSendLog!(log as any)).toBe(log);
    expect(log).toEqual({
      body: '[REDACTED]',
      attributes: {
        externalUser: '[REDACTED]',
        productToken: '[REDACTED]',
      },
    });

    expect(opts.beforeSendMetric!(metric as any)).toBe(metric);
    expect(metric).toEqual({
      name: 'partner.request',
      attributes: {
        tenantId: '[REDACTED]',
        authorization: '[REDACTED]',
      },
    });
  });

  it('falls back to originalException.status if no response context', () => {
    const { beforeSend } = make();
    const event = {};
    expect(
      beforeSend!(event as any, { originalException: { status: 404 } } as any),
    ).toBeNull();
  });

  it('keeps event when no status is available (unknown errors)', () => {
    const { beforeSend } = make();
    const event = {};
    expect(beforeSend!(event as any, {} as any)).toBe(event);
  });
});

describe('initSentry', () => {
  it('skips init when DSN missing', () => {
    const initFn = jest.fn();
    const ok = initSentry({ env: {} as NodeJS.ProcessEnv, initFn });
    expect(ok).toBe(false);
    expect(initFn).not.toHaveBeenCalled();
  });

  it('calls init with built options when DSN present', () => {
    const initFn = jest.fn();
    const ok = initSentry({
      env: {
        SENTRY_DSN: 'https://x@y/1',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv,
      initFn,
    });
    expect(ok).toBe(true);
    expect(initFn).toHaveBeenCalledWith(expect.objectContaining({ dsn: 'https://x@y/1' }));
  });
});

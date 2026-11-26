/**
 * Sentry bootstrap — MUST be the first import in main.ts.
 *
 * @sentry/nestjs 10.x is built on OpenTelemetry. Instrumentation is set up
 * by monkey-patching Node's require cache, which only works if this file
 * runs before any HTTP/DB/queue client is imported. Put it at the top.
 *
 * Behavior matrix:
 *   SENTRY_DSN unset            → init() is skipped, Sentry becomes a no-op.
 *   SENTRY_DSN set + dev        → DSN active, verbose debug, 100% sample.
 *   SENTRY_DSN set + production → DSN active, 10% trace/profile sample.
 *   SENTRY_DSN unset in prod    → init() is skipped; Sentry is currently optional.
 */

import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { isProductionEnv } from './common/runtime/is-production';

const SENTRY_REDACTED = '[REDACTED]';
const SENTRY_PRODUCT_SECRET_PATTERN =
  /\b(?:rpi|rwh)_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{20,}\b/g;
const SENTRY_BEARER_SECRET_PATTERN = /\bBearer\s+[^\s,;]+/gi;

type MutableSentryPayload = Record<string, unknown>;

const SENSITIVE_SENTRY_FIELDS = new Set([
  'authorization',
  'proxyauthorization',
  'token',
  'producttoken',
  'billingproducttoken',
  'xproducttoken',
  'xbillingproducttoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apitoken',
  'authtoken',
  'bearertoken',
  'integrationtoken',
  'servicetoken',
  'sessiontoken',
  'tokenhash',
  'tokenprefix',
  'apikey',
  'xapikey',
  'plainkey',
  'privatekey',
  'secretkey',
  'accesskey',
  'signingkey',
  'encryptionkey',
  'cookie',
  'cookies',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'webhooksecret',
  'body',
  'rawbody',
  'requestbody',
  'payload',
  'query',
  'querystring',
  'rawquery',
  'urlquery',
  'httpquery',
  'searchparams',
  'headers',
  'user',
  'userid',
  'username',
  'externaluser',
  'externaluserid',
  'tenant',
  'tenantid',
  'externaltenant',
  'externaltenantid',
  'contact',
  'contactinfo',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'address',
  'postaladdress',
]);

const SENSITIVE_SENTRY_FIELD_SUFFIXES = [
  'authorization',
  'producttoken',
  'billingproducttoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apitoken',
  'authtoken',
  'bearertoken',
  'integrationtoken',
  'servicetoken',
  'sessiontoken',
  'tokenhash',
  'tokenprefix',
  'apikey',
  'plainkey',
  'privatekey',
  'secretkey',
  'accesskey',
  'signingkey',
  'encryptionkey',
  'cookie',
  'cookies',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'requestbody',
  'rawbody',
  'querystring',
  'headers',
  'userid',
  'username',
  'tenantid',
  'contactinfo',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'postaladdress',
] as const;

export interface InstrumentOptions {
  env?: NodeJS.ProcessEnv;
  initFn?: typeof Sentry.init;
}

function normalizeSentryFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveSentryField(field: string): boolean {
  const normalized = normalizeSentryFieldName(field);
  return SENSITIVE_SENTRY_FIELDS.has(normalized) || (
    normalized.length > 0
    && SENSITIVE_SENTRY_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function isSentryUrlField(field: string): boolean {
  const normalized = normalizeSentryFieldName(field);
  return (
    normalized === 'url'
    || normalized.endsWith('url')
    || normalized === 'urlfull'
    || normalized.endsWith('urlfull')
    || normalized === 'urloriginal'
    || normalized.endsWith('urloriginal')
    || normalized === 'httptarget'
    || normalized.endsWith('httptarget')
    || normalized === 'referer'
    || normalized.endsWith('referer')
    || normalized === 'referrer'
    || normalized.endsWith('referrer')
  );
}

function stripUrlSecrets(value: string): string {
  const queryIndex = value.indexOf('?');
  const fragmentIndex = value.indexOf('#');
  const cutoff = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length);
  return value
    .slice(0, cutoff)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
}

function scrubSentryString(value: string): string {
  return value
    .replace(SENTRY_BEARER_SECRET_PATTERN, 'Bearer [REDACTED]')
    .replace(SENTRY_PRODUCT_SECRET_PATTERN, SENTRY_REDACTED);
}

function scrubSentryValue(
  value: unknown,
  seen: WeakSet<object>,
  parentField?: string,
): unknown {
  if (typeof value === 'string') {
    return scrubSentryString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubSentryValue(value[index], seen);
    }
    return value;
  }

  const record = value as MutableSentryPayload;
  const normalizedParent = parentField ? normalizeSentryFieldName(parentField) : '';
  const isRequestContainer =
    normalizedParent === 'request' || normalizedParent.endsWith('request');

  for (const [field, fieldValue] of Object.entries(record)) {
    const normalizedField = normalizeSentryFieldName(field);
    if (
      isSensitiveSentryField(field)
      || (isRequestContainer && normalizedField === 'data')
    ) {
      record[field] = SENTRY_REDACTED;
      continue;
    }
    if (typeof fieldValue === 'string' && isSentryUrlField(field)) {
      record[field] = scrubSentryString(stripUrlSecrets(fieldValue));
      continue;
    }
    record[field] = scrubSentryValue(fieldValue, seen, field);
  }

  return record;
}

/**
 * Defense in depth for event sources which do not pass through RequestData
 * (transactions, spans, breadcrumbs, logs, metrics, and future SDK integrations).
 */
export function scrubSentryPayload<T>(payload: T): T {
  return scrubSentryValue(payload, new WeakSet()) as T;
}

export function buildSentryOptions(env: NodeJS.ProcessEnv): Parameters<typeof Sentry.init>[0] | null {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return null;

  const isProd = isProductionEnv(env);

  return {
    dsn,
    environment: env.NODE_ENV ?? 'development',
    release: env.SENTRY_RELEASE ?? env.GIT_COMMIT_SHA,
    sendDefaultPii: false,

    // Trace sampling: 10% in prod keeps cost bounded while still catching
    // slow-request patterns. In non-prod we trace everything for debugging.
    tracesSampleRate: isProd ? 0.1 : 1.0,

    // CPU/heap profiling on the same budget as traces. Expensive enough
    // that we never sample more than the trace rate.
    profileSessionSampleRate: isProd ? 0.1 : 1.0,
    profileLifecycle: 'trace',

    integrations: [
      nodeProfilingIntegration(),
      // Override the SDK's default Http integration so request bodies never
      // enter Sentry's request scope, even before event processing.
      Sentry.httpIntegration({
        maxIncomingRequestBodySize: 'none',
        incomingRequestSpanHook(span, request) {
          if (!request.url) return;
          const safeUrl = stripUrlSecrets(request.url);
          span.setAttribute('http.url', safeUrl);
          span.setAttribute('http.target', safeUrl);
        },
      }),
      // The default RequestData integration includes headers, cookies, body,
      // query string, and a URL which still contains the query. Replace it
      // with a method-only request context.
      Sentry.requestDataIntegration({
        include: {
          headers: false,
          cookies: false,
          data: false,
          query_string: false,
          url: false,
          ip: false,
        },
      }),
    ],

    // Don't ship 4xx as issues — they're client errors, not bugs.
    // Keep unexpected 4xx from auth/rate-limit by not filtering 401/403/429.
    beforeSend(event, hint) {
      const status =
        (event.contexts?.response as { status_code?: number } | undefined)?.status_code ??
        (hint?.originalException as { status?: number } | undefined)?.status;
      if (status && status >= 400 && status < 500) {
        const noisy4xx = [400, 404, 422];
        if (noisy4xx.includes(status)) return null;
      }
      return scrubSentryPayload(event);
    },
    beforeSendTransaction: (event) => scrubSentryPayload(event),
    beforeSendSpan: (span) => scrubSentryPayload(span),
    beforeBreadcrumb: (breadcrumb) => scrubSentryPayload(breadcrumb),
    beforeSendLog: (log) => scrubSentryPayload(log),
    beforeSendMetric: (metric) => scrubSentryPayload(metric),

    // Prevent Sentry itself from capturing events it generates
    // while trying to capture something else (infinite loop guard).
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
    ],
  };
}

export function initSentry(opts: InstrumentOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const options = buildSentryOptions(env);
  if (!options) return false;
  const initFn = opts.initFn ?? Sentry.init;
  initFn(options);
  return true;
}

// Eager side effect — triggers when main.ts imports this module.
initSentry();

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { FastifyRequest, FastifyReply } from 'fastify';
import { httpRequestDuration, httpRequestTotal } from './metrics.registry';

/**
 * Records request duration + count for every HTTP call.
 *
 * Label strategy:
 *   - `route` is Fastify's matched route pattern (e.g. "/api/user/:id"),
 *     NOT the raw URL. This bounds cardinality — a high-traffic
 *     "/api/user/123" + "/api/user/456" ... would otherwise explode the
 *     Prometheus series count.
 *   - `status_class` ("2xx", "4xx", "5xx") instead of exact status.
 *     Individual codes (401 vs 403, 404 vs 405) rarely matter for alerting
 *     and multiply the series count by 5x.
 *   - /api/metrics itself is excluded — scrapers would create a
 *     self-observation feedback loop.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const start = process.hrtime.bigint();

    const record = (statusCode: number) => {
      if (isMetricsRequest(req.url)) return;

      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const method = req.method ?? 'UNKNOWN';
      const route = resolveRoute(req);
      const statusClass = classify(statusCode);

      httpRequestDuration.labels(method, route, statusClass).observe(durationSec);
      httpRequestTotal.labels(method, route, statusClass).inc();
    };

    return next.handle().pipe(
      tap({
        next: () => record(reply.statusCode),
        error: (err) => {
          // Handler threw: prefer the error's own status. `reply.statusCode`
          // is typically still at its default (200) here because no response
          // has been written yet, so falling back to it would mislabel 5xx as 2xx.
          const status =
            (typeof err?.status === 'number' && err.status) ||
            (typeof err?.getStatus === 'function' && err.getStatus()) ||
            500;
          record(status);
        },
      }),
    );
  }
}

function classify(code: number): string {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  if (code >= 200) return '2xx';
  return '1xx';
}

function resolveRoute(req: FastifyRequest): string {
  // Fastify 5 exposes the matched route template here. Never fall back to the
  // raw URL: it can contain request/user IDs and create unbounded label sets.
  const routePattern = req.routeOptions?.url;
  return routePattern || '__unmatched__';
}

function isMetricsRequest(url: string | undefined): boolean {
  const path = url?.split('?', 1)[0];
  return path === '/api/metrics' || path === '/api/metrics/';
}

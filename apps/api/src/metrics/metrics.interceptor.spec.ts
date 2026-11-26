import { of, throwError, lastValueFrom } from 'rxjs';
import { MetricsInterceptor } from './metrics.interceptor';
import { registry } from './metrics.registry';

function ctx(opts: {
  method?: string;
  url?: string;
  routePattern?: string;
  statusCode?: number;
}): any {
  const req = {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/api/thing',
    routeOptions: opts.routePattern ? { url: opts.routePattern } : undefined,
  };
  const reply = { statusCode: opts.statusCode ?? 200 };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => reply,
    }),
  };
}

describe('MetricsInterceptor', () => {
  const interceptor = new MetricsInterceptor();

  async function run(
    context: any,
    handler: { handle: () => any },
  ): Promise<void> {
    const observable = interceptor.intercept(context, handler as any);
    await lastValueFrom(observable).catch(() => {});
  }

  function countFor(method: string, route: string, statusClass: string): Promise<number> {
    return registry
      .getSingleMetricAsString('ruidong_http_requests_total')
      .then((text) => {
        // Find the matching sample line and parse its count.
        const pattern = new RegExp(
          `ruidong_http_requests_total\\{method="${method}",route="${route}",status_class="${statusClass}"\\}\\s+(\\S+)`,
        );
        const match = text.match(pattern);
        return match ? Number(match[1]) : 0;
      });
  }

  it('increments counter for successful request with matched route pattern', async () => {
    const before = await countFor('GET', '/api/user/:id', '2xx');

    await run(
      ctx({ method: 'GET', routePattern: '/api/user/:id', statusCode: 200 }),
      { handle: () => of('result') },
    );

    const after = await countFor('GET', '/api/user/:id', '2xx');
    expect(after).toBe(before + 1);
  });

  it('classifies 4xx and 5xx status codes', async () => {
    const before5xx = await countFor('POST', '/api/err', '5xx');

    await run(
      ctx({ method: 'POST', routePattern: '/api/err', statusCode: 500 }),
      { handle: () => of(null) },
    );

    const after5xx = await countFor('POST', '/api/err', '5xx');
    expect(after5xx).toBe(before5xx + 1);
  });

  it('records errors with status from the thrown exception', async () => {
    const before = await countFor('POST', '/api/broken', '4xx');

    await run(
      ctx({ method: 'POST', routePattern: '/api/broken', statusCode: 200 }),
      { handle: () => throwError(() => ({ status: 404 })) },
    );

    const after = await countFor('POST', '/api/broken', '4xx');
    expect(after).toBe(before + 1);
  });

  it('defaults to 500 when thrown error has no status', async () => {
    const before = await countFor('GET', '/api/boom', '5xx');

    await run(
      ctx({ method: 'GET', routePattern: '/api/boom' }),
      { handle: () => throwError(() => new Error('weird')) },
    );

    const after = await countFor('GET', '/api/boom', '5xx');
    expect(after).toBe(before + 1);
  });

  it('skips /api/metrics, including query strings, to avoid self-observation', async () => {
    const before = await countFor('GET', '/api/metrics', '2xx');
    await run(
      ctx({
        method: 'GET',
        url: '/api/metrics?format=prometheus',
        routePattern: '/api/metrics',
        statusCode: 200,
      }),
      { handle: () => of('# HELP ...') },
    );
    const after = await countFor('GET', '/api/metrics', '2xx');
    expect(after).toBe(before);
  });

  it('uses one bounded label when no matched route template is available', async () => {
    const before = await countFor('GET', '__unmatched__', '4xx');

    await run(
      ctx({ method: 'GET', url: '/api/nope/first-id?trace=1', statusCode: 404 }),
      { handle: () => of(null) },
    );
    await run(
      ctx({ method: 'GET', url: '/api/nope/second-id', statusCode: 404 }),
      { handle: () => of(null) },
    );

    const after = await countFor('GET', '__unmatched__', '4xx');
    expect(after).toBe(before + 2);
    const metricsText = await registry.getSingleMetricAsString('ruidong_http_requests_total');
    expect(metricsText).not.toContain('/api/nope/first-id');
    expect(metricsText).not.toContain('/api/nope/second-id');
  });

  it('collapses different resource IDs into the Fastify 5 route template', async () => {
    const routePattern = '/api/user/:id';
    const before = await countFor('GET', routePattern, '2xx');

    for (const id of ['cardinality-probe-a', 'cardinality-probe-b']) {
      await run(
        ctx({ method: 'GET', url: `/api/user/${id}`, routePattern, statusCode: 200 }),
        { handle: () => of('ok') },
      );
    }

    const after = await countFor('GET', routePattern, '2xx');
    expect(after).toBe(before + 2);
    const metricsText = await registry.getSingleMetricAsString('ruidong_http_requests_total');
    expect(metricsText).not.toContain('cardinality-probe-a');
    expect(metricsText).not.toContain('cardinality-probe-b');
  });

  it('observes a duration histogram entry', async () => {
    await run(
      ctx({ method: 'GET', routePattern: '/api/timed', statusCode: 200 }),
      { handle: () => of('ok') },
    );
    const histogramText = await registry.getSingleMetricAsString(
      'ruidong_http_request_duration_seconds',
    );
    expect(histogramText).toContain('/api/timed');
    expect(histogramText).toContain('status_class="2xx"');
  });
});

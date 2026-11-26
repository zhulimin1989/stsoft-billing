import {
  attributedMs,
  createStageTimings,
  formatStageTimings,
  runWithStageTimings,
  timed,
  unattributedMs,
} from './usage-stage-timings';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('usage stage timings', () => {
  it('is a pass-through when no collector is active (HTTP request path)', async () => {
    await expect(timed('stage', async () => 'value')).resolves.toBe('value');
  });

  it('accumulates call count and span per stage name', async () => {
    const stages = createStageTimings();
    await runWithStageTimings(stages, async () => {
      await timed('a', () => tick(15));
      await timed('a', () => tick(15));
      await timed('b', () => tick(1));
    });
    expect(stages.a.count).toBe(2);
    expect(stages.b.count).toBe(1);
    expect(stages.a.ms).toBeGreaterThan(stages.b.ms);
  });

  it('passes the callee return value through untouched', async () => {
    const stages = createStageTimings();
    const payload = { requestId: 'req-1' };
    const result = await runWithStageTimings(stages, () =>
      timed('stage', async () => payload),
    );
    expect(result).toBe(payload);
  });

  it('records the stage and rethrows the original error on failure', async () => {
    const stages = createStageTimings();
    const boom = new Error('boom');
    await expect(
      runWithStageTimings(stages, () =>
        timed('failing', async () => {
          await tick(2);
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
    expect(stages.failing.count).toBe(1);
    expect(stages.failing.ms).toBeGreaterThan(0);
  });

  it('keeps concurrent messages isolated', async () => {
    const first = createStageTimings();
    const second = createStageTimings();
    await Promise.all([
      runWithStageTimings(first, async () => {
        await timed('shared', () => tick(20));
      }),
      runWithStageTimings(second, async () => {
        await timed('shared', () => tick(1));
        await timed('onlySecond', () => tick(1));
      }),
    ]);
    expect(first.shared.count).toBe(1);
    expect(first.onlySecond).toBeUndefined();
    expect(second.onlySecond.count).toBe(1);
  });

  // The bug this replaces: nested spans were summed against the wall clock, so
  // the remainder always clamped to 0 and looked like "fully explained".
  it('excludes nested stages from the enclosing stage self time', async () => {
    const stages = createStageTimings();
    await runWithStageTimings(stages, () =>
      timed('outer', async () => {
        await timed('inner', () => tick(40));
        await tick(40); // outer's own work
      }),
    );
    expect(stages.outer.ms).toBeGreaterThan(stages.outer.selfMs);
    // outer spans ~80ms but only ~40ms of it is its own.
    expect(stages.outer.selfMs).toBeLessThan(stages.outer.ms - stages.inner.selfMs + 15);
    expect(stages.inner.selfMs).toBeCloseTo(stages.inner.ms, 0);
  });

  it('attributes nested work exactly once so self times stay additive', async () => {
    const stages = createStageTimings();
    await runWithStageTimings(stages, () =>
      timed('outer', () => timed('inner', () => tick(30))),
    );
    // Not 2x the elapsed time, which is what summing spans would have given.
    expect(attributedMs(stages)).toBeCloseTo(stages.inner.ms, 0);
  });

  it('attributes to the correct parent when stages run concurrently', async () => {
    const stages = createStageTimings();
    await runWithStageTimings(stages, async () => {
      await Promise.all([
        timed('branchA', () => timed('leafA', () => tick(30))),
        timed('branchB', () => tick(30)),
      ]);
    });
    // branchA's span is covered by leafA, so its own self time is near zero;
    // a shared-stack implementation would have mis-nested these.
    expect(stages.branchA.selfMs).toBeLessThan(stages.leafA.selfMs);
    expect(stages.branchB.selfMs).toBeGreaterThan(stages.branchA.selfMs);
  });

  it('reports uninstrumented time and clamps at zero', () => {
    const stages = {
      a: { count: 1, ms: 300, selfMs: 300 },
      b: { count: 1, ms: 200, selfMs: 200 },
    };
    expect(attributedMs(stages)).toBe(500);
    expect(unattributedMs(stages, 900)).toBe(400);
    expect(unattributedMs(stages, 400)).toBe(0);
  });

  it('formats by self time, slowest first', () => {
    const stages = {
      outerSpan: { count: 1, ms: 900, selfMs: 10 },
      realCost: { count: 3, ms: 500, selfMs: 500 },
    };
    expect(formatStageTimings(stages)).toBe('realCost=500ms/3 outerSpan=10ms/1');
  });

  // Documents the known limit rather than asserting a wrong invariant: two
  // stages awaited together each measure their own span, so self times sum past
  // wall clock. `attributed > total` is the concurrency signal.
  it('over-attributes when stages overlap, which is how concurrency shows up', async () => {
    const stages = createStageTimings();
    const startedAt = Date.now();
    await runWithStageTimings(stages, async () => {
      await Promise.all([timed('left', () => tick(40)), timed('right', () => tick(40))]);
    });
    const totalMs = Date.now() - startedAt;
    expect(attributedMs(stages)).toBeGreaterThan(totalMs);
    expect(unattributedMs(stages, totalMs)).toBe(0);
  });
});

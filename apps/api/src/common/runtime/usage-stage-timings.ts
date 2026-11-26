import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-message stage timing for the gateway usage consumer.
 *
 * Why this exists: the consumer's per-message cost (~2.1s in cn prod as of
 * 2026-08-26) could not be attributed from the outside. RDS slow logs only
 * surface single statements above log_min_duration_statement (1s), so a cost
 * shaped as "many sequential sub-second round trips" is invisible there — and
 * two successive guesses at the cause (COMMIT/deferred constraints, then a
 * competing full-table scan) were both falsified by measurement.
 *
 * Stages nest (billingProcess contains recordReceived, ...), so wall-clock
 * totals cannot simply be summed. Each stage therefore records both its total
 * span and its *self* time — the span minus the spans of stages nested inside
 * it. Self times are additive, so `attributed` and `unattributed` below are
 * meaningful; a large self time on an outer stage is precisely "time spent in
 * this stage that no inner probe covers", which is the signal we want.
 *
 * Concurrency: parent/child nesting is tracked through AsyncLocalStorage rather
 * than a shared stack, so concurrently awaited stages (Promise.all) attribute
 * to the right parent instead of mis-nesting. The consumer also runs
 * partitionsConsumedConcurrently partitions in one process, so a module-level
 * accumulator would mix messages together.
 *
 * Instrumentation must never change behaviour: `timed` is a pass-through when
 * no collector is active (i.e. every HTTP request path), preserves the callee's
 * return value and thrown error untouched, and swallows any bookkeeping error.
 */
export type StageTotals = Record<
  string,
  { count: number; ms: number; selfMs: number }
>;

type Frame = { childMs: number };
type Collector = { stages: StageTotals; parent: Frame | null };

const storage = new AsyncLocalStorage<Collector>();

export function createStageTimings(): StageTotals {
  return {};
}

/**
 * Runs `fn` with `stages` as the active collector. The caller owns `stages`, so
 * it can still read partial timings when `fn` rejects.
 */
export function runWithStageTimings<T>(
  stages: StageTotals,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ stages, parent: null }, fn);
}

/**
 * Records span, self time and call count for a named stage. Records on the
 * failure path too — a stage that is slow only when it throws is exactly the
 * kind of thing we are looking for.
 */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  const frame: Frame = { childMs: 0 };
  const startedAt = process.hrtime.bigint();
  try {
    return await storage.run({ stages: ctx.stages, parent: frame }, fn);
  } finally {
    try {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // Report this whole span to the enclosing stage so its self time excludes us.
      if (ctx.parent) ctx.parent.childMs += ms;
      const entry = (ctx.stages[name] ??= { count: 0, ms: 0, selfMs: 0 });
      entry.count += 1;
      entry.ms += ms;
      entry.selfMs += Math.max(0, ms - frame.childMs);
    } catch {
      // Bookkeeping must never mask the callee's own outcome.
    }
  }
}

/**
 * Sum of self times: total work the probes account for, NOT a share of the
 * message's duration.
 *
 * Freely exceeds the wall-clock total, and that is not a defect: concurrently
 * awaited stages each measure their own elapsed span, and overlapping spans sum
 * past real time. The excess scales with how wide the fan-out is, so it is not
 * a small correction — measured on nprod 2026-08-27 at ~8% on messages that
 * skip the publisher key projection, and ~490% (attributed ≈ 9.8s against a
 * 1.7s message) on messages where the projection re-syncs 15 account keys
 * concurrently. Do not "fix" it by clamping; that hides the concurrency.
 *
 * Consequence for readers: never turn these figures into a percentage of
 * `total`. Self time answers "how much work happened here in aggregate"; it
 * cannot say which stage owns the wall clock, because under concurrency the
 * critical path is a subset of the overlapping spans and this model does not
 * track it. Read each stage as `selfMs / count` (per-call latency) together
 * with `count` (how often it ran) — that is what identified the real defect
 * here: 438ms per publisher HTTP round trip, invoked 15 times per event.
 */
export function attributedMs(stages: StageTotals): number {
  return Object.values(stages).reduce((sum, stage) => sum + stage.selfMs, 0);
}

/**
 * Wall-clock total minus every stage's self time: work done outside any probe
 * (event parsing, scheduling, anything not yet instrumented at all).
 *
 * Reads 0 whenever concurrency pushed `attributedMs` past the total, so a 0
 * here only means "nothing uninstrumented" when `attributed <= total`. Compare
 * the two figures in the log line before trusting it.
 */
export function unattributedMs(stages: StageTotals, totalMs: number): number {
  return Math.max(0, totalMs - attributedMs(stages));
}

/**
 * `stage=<selfMs>ms/<count>` slowest-self first. Self time is used because it
 * is the additive quantity; a stage whose span is much larger than its self
 * time has that difference already accounted for by its nested stages.
 *
 * `<count>` is emitted precisely because the total alone is ambiguous: one slow
 * call and twenty cheap ones look identical. Divide to get per-call latency
 * before drawing conclusions — see the note on `attributedMs`.
 */
export function formatStageTimings(stages: StageTotals): string {
  return Object.entries(stages)
    .sort((left, right) => right[1].selfMs - left[1].selfMs)
    .map(([name, { count, selfMs }]) => `${name}=${selfMs.toFixed(0)}ms/${count}`)
    .join(' ');
}

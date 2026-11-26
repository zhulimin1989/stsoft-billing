import { Logger as PinoNestLogger } from 'nestjs-pino';

/**
 * provisional exposure 的可运营信号在**没有采集栈**的环境里只有结构化日志，
 * 所以「日志真的产出可按字段过滤的根字段」本身就是交付物的一部分，必须实测。
 *
 * ⚠️ 这条测试存在的直接原因：我第一版写的是 `logger.log(JSON.stringify({...}))`。
 * nestjs-pino 的 `Logger.call` 只在 `typeof message === 'object'` 时执行
 * `Object.assign(objArg, message)` 把字段并到交给 pino 的**根**对象上；传字符串则走
 * `this.logger[level](objArg, message)`，整段只落到 `msg`。
 * 结果是全文能搜到、但按字段过滤失效 —— 而排查查询恰恰是按 `"outcome":"..."` 过滤的。
 * 设计稿早已冻结「必须传对象」，我却写成了字符串；没有这条测试，这个差别在任何单测里都看不出来。
 *
 * 断言的边界是「交给 pino 的那个对象」而不是 pino 的最终输出：pino 在本仓是传递依赖、
 * apps/api 里不可直接 import，而根字段是否成立完全由上面那段 nestjs-pino 逻辑决定。
 */
describe('provisional exposure 结构化日志的根字段', () => {
  type Recorded = { level: string; obj: Record<string, unknown>; rest: unknown[] };

  function captureLogger(): { logger: PinoNestLogger; recorded: Recorded[] } {
    const recorded: Recorded[] = [];
    const record = (level: string) => (obj: Record<string, unknown>, ...rest: unknown[]) => {
      recorded.push({ level, obj, rest });
    };
    const underlying = {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      setContext: () => {},
      assign: () => {},
    };
    return {
      logger: new PinoNestLogger(underlying as never, {}),
      recorded,
    };
  }

  it('传**对象**时字段落在根上（可按字段过滤）', () => {
    const { logger, recorded } = captureLogger();
    logger.log({
      event: 'gateway_provisional_exposure_startup',
      enabled: true,
      cutover_at: '2026-08-28T00:00:00.000Z',
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].level).toBe('info');
    expect(recorded[0].obj).toMatchObject({
      event: 'gateway_provisional_exposure_startup',
      enabled: true,
      cutover_at: '2026-08-28T00:00:00.000Z',
    });
    // 对象形态下不会额外塞一个字符串 message。
    expect(recorded[0].rest).toHaveLength(0);
  });

  it('传 JSON 字符串时根上**没有**这些字段（这就是必须传对象的理由）', () => {
    const { logger, recorded } = captureLogger();
    logger.log(JSON.stringify({
      event: 'gateway_provisional_exposure_startup',
      enabled: true,
    }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].obj.event).toBeUndefined();
    expect(recorded[0].obj.enabled).toBeUndefined();
    // 整段被当作 message 传给 pino ⇒ 最终只出现在 msg 里。
    expect(String(recorded[0].rest[0])).toContain('gateway_provisional_exposure_startup');
  });

  it('writer 的 outcome 日志同样按根字段可过滤，且级别正确', () => {
    const { logger, recorded } = captureLogger();
    const line = {
      event: 'gateway_provisional_exposure_outcome',
      outcome: 'invariant_error',
      request_id: 'req-1',
      gateway_billing_event_id: 'gateway-billing-event-1',
    };
    logger.error(line);
    logger.warn({ ...line, outcome: 'schema_not_ready' });
    logger.log({ ...line, outcome: 'inserted' });

    // 排查查询是 grep '"outcome":"(invariant_error|stream_field_absent_or_invalid|schema_not_ready)"'，
    // 它要求 outcome 出现在根上而不是被包进 msg 字符串。
    expect(recorded.map((r) => [r.level, r.obj.outcome])).toEqual([
      ['error', 'invariant_error'],
      ['warn', 'schema_not_ready'],
      ['info', 'inserted'],
    ]);
    for (const entry of recorded) {
      expect(entry.obj.event).toBe('gateway_provisional_exposure_outcome');
      expect(entry.obj.request_id).toBe('req-1');
    }
  });
});

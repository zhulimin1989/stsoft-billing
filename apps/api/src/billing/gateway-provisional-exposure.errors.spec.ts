import {
  GatewayProvisionalExposureInvariantError,
  PROVISIONAL_EXPOSURE_INVARIANT_CODES,
  PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX,
  isQuarantineDefaultInvariantCode,
  parseProvisionalExposureInvariantReason,
} from './gateway-provisional-exposure.errors';

describe('provisional exposure 不变量错误契约', () => {
  const ctx = {
    requestId: 'req-1',
    gatewayBillingEventId: 'gateway-billing-event-1',
  };

  it('每个 code 都有默认 disposition（新增 code 忘记补 disposition 会在这里失败）', () => {
    expect(PROVISIONAL_EXPOSURE_INVARIANT_CODES).toHaveLength(9);
    for (const code of PROVISIONAL_EXPOSURE_INVARIANT_CODES) {
      const err = new GatewayProvisionalExposureInvariantError(code, ctx);
      expect(['BLOCK_PARTITION', 'QUARANTINE_AND_DLQ']).toContain(err.disposition);
    }
  });

  it('系统性 code 默认 block，记录级 code 默认 quarantine', () => {
    expect(isQuarantineDefaultInvariantCode('decision_missing')).toBe(false);
    for (const code of PROVISIONAL_EXPOSURE_INVARIANT_CODES) {
      if (code === 'decision_missing') continue;
      expect(isQuarantineDefaultInvariantCode(code)).toBe(true);
    }
  });

  it('withDisposition 返回新实例且不改原实例', () => {
    const original = new GatewayProvisionalExposureInvariantError('source_evidence_missing', ctx);
    expect(original.disposition).toBe('QUARANTINE_AND_DLQ');
    const downgraded = original.withDisposition('BLOCK_PARTITION');
    expect(downgraded).not.toBe(original);
    expect(downgraded.disposition).toBe('BLOCK_PARTITION');
    // 原实例可能已被记录或传递，就地改写会让同一个错误在不同调用点表现不同。
    expect(original.disposition).toBe('QUARANTINE_AND_DLQ');
    expect(downgraded.code).toBe(original.code);
    expect(downgraded.context).toBe(original.context);
    expect(downgraded.stack).toBe(original.stack);
  });

  it('parentReason 是前缀 + code', () => {
    const err = new GatewayProvisionalExposureInvariantError(
      'source_evidence_binding_mismatch',
      ctx,
    );
    expect(err.parentReason).toBe(
      `${PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX}source_evidence_binding_mismatch`,
    );
  });

  it('parser 只接受完整已知 code —— 任意前缀与未知后缀都必须拒绝', () => {
    // 放宽到前缀匹配会让「未知 invariant」也被当成可重放，从而绕过 quarantine。
    expect(parseProvisionalExposureInvariantReason(
      'provisional_exposure_invariant:decision_missing',
    )).toBe('decision_missing');
    expect(parseProvisionalExposureInvariantReason(
      'provisional_exposure_invariant:decision_miss',
    )).toBeNull();
    expect(parseProvisionalExposureInvariantReason(
      'provisional_exposure_invariant:decision_missing_extra',
    )).toBeNull();
    expect(parseProvisionalExposureInvariantReason(
      'provisional_exposure_invariant:',
    )).toBeNull();
    // 原型链上的属性名不能被当成合法 code。
    expect(parseProvisionalExposureInvariantReason(
      'provisional_exposure_invariant:toString',
    )).toBeNull();
    expect(parseProvisionalExposureInvariantReason('settlement_anchor_conflict')).toBeNull();
    expect(parseProvisionalExposureInvariantReason(null)).toBeNull();
    expect(parseProvisionalExposureInvariantReason(undefined)).toBeNull();
  });

  it('message 带上 requestId 与 detail 便于定位，但不吞掉 code', () => {
    const err = new GatewayProvisionalExposureInvariantError('exposure_missing_after_insert', {
      ...ctx,
      detail: 'read-back empty',
    });
    expect(err.message).toContain('exposure_missing_after_insert');
    expect(err.message).toContain('req-1');
    expect(err.message).toContain('read-back empty');
    expect(err).toBeInstanceOf(Error);
  });
});

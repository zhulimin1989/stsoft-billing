/**
 * provisional exposure（平台暂估敞口）写入过程中的**不变量破坏**。
 *
 * 为什么需要单独一族错误：普通 `Error` 会被 service 归为 processing_error ⇒ 写成
 * `RETRYABLE_FAILED` 并重新抛出、consumer 保留 offset ⇒ 对**不可修**的记录级矛盾会
 * 无限重试并卡住整个 partition；而若抛 `MalformedGatewayUsageEventError`，行为又变成
 * quarantine 后 commit ⇒ 会把**系统性代码缺陷**静默放行、连续永久漏记。
 * 两者都不对，必须按「系统性可修复」与「记录级不可变矛盾」分类。
 */

/** 破坏点的分类。取值集合是契约的一部分，新增必须同时补默认 disposition。 */
export type ProvisionalExposureInvariantCode =
  | 'decision_missing'
  | 'source_evidence_missing'
  | 'source_evidence_revision_not_one'
  | 'source_evidence_observed_at_mismatch'
  | 'source_evidence_raw_not_object'
  | 'source_evidence_binding_mismatch'
  | 'existing_exposure_content_conflict'
  | 'exposure_missing_after_insert'
  // 写入本身失败（连接中断、语句超时、表权限被收、约束/schema 漂移、正缓存后表被删）。
  // 不是记录内容的矛盾，但**必须**归到这一族：否则普通异常会原样抛穿到 consumer 的
  // transient 分支，offset 不提交 ⇒ 持久性失败会让该分区所有租户的计费永久停摆。
  | 'writer_persistence_failed';

/**
 * 破坏之后的命运。
 *
 * - `BLOCK_PARTITION`：**不** DLQ、**不** commit，直接抛出 ⇒ partition 停在这条消息上。
 *   用于系统性缺陷：放行等于连续永久漏记，必须 fail-closed。
 * - `QUARANTINE_AND_DLQ`：投 DLQ 成功后才 commit ⇒ partition 可继续。
 *   仅用于**已收窄到单条不可变记录**、且**资金已确定落地**（有永久 receipt）的矛盾。
 */
export type ProvisionalExposureInvariantDisposition =
  | 'BLOCK_PARTITION'
  | 'QUARANTINE_AND_DLQ';

/**
 * 每个 code 的**默认** disposition。
 *
 * ⚠️ 默认值不是最终值：service 在**无 TokenUsage proof**时会把任何 quarantine 强制降级为
 * `BLOCK_PARTITION` —— quarantine 的前提是钱已确定落地，否则 DLQ+commit 会同时丢掉
 * 敞口与结算。
 */
const DEFAULT_DISPOSITIONS: Readonly<Record<
  ProvisionalExposureInvariantCode,
  ProvisionalExposureInvariantDisposition
>> = {
  // 系统性：目标 reason 却没带 decision，属代码 wiring 缺陷。
  decision_missing: 'BLOCK_PARTITION',
  // 系统性：writer 已启用但没有通过校验的共享配置。
  // 以下均已收窄到单条不可变记录。
  source_evidence_missing: 'QUARANTINE_AND_DLQ',
  source_evidence_revision_not_one: 'QUARANTINE_AND_DLQ',
  source_evidence_observed_at_mismatch: 'QUARANTINE_AND_DLQ',
  source_evidence_raw_not_object: 'QUARANTINE_AND_DLQ',
  source_evidence_binding_mismatch: 'QUARANTINE_AND_DLQ',
  existing_exposure_content_conflict: 'QUARANTINE_AND_DLQ',
  exposure_missing_after_insert: 'QUARANTINE_AND_DLQ',
  // 已收窄到单条记录的旁路写入；钱的 receipt 已独立提交，隔离它不会丢结算。
  // 注意方向：瞬时抖动本可自愈（重放会重试），归到 quarantine 等于多一张运维单；
  // 但持久性失败若走 transient 就是整分区停摆 —— 用运维单换停摆是划算的。
  writer_persistence_failed: 'QUARANTINE_AND_DLQ',
};

export const PROVISIONAL_EXPOSURE_INVARIANT_CODES: readonly
  ProvisionalExposureInvariantCode[] = Object.keys(DEFAULT_DISPOSITIONS) as
    ProvisionalExposureInvariantCode[];

/** 写进父事件 `reason` 的前缀。窄例外的 parser 依赖它。 */
export const PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX =
  'provisional_exposure_invariant:';

export type ProvisionalExposureInvariantContext = {
  requestId: string;
  gatewayBillingEventId: string;
  detail?: string;
};

export class GatewayProvisionalExposureInvariantError extends Error {
  readonly disposition: ProvisionalExposureInvariantDisposition;

  constructor(
    readonly code: ProvisionalExposureInvariantCode,
    readonly context: ProvisionalExposureInvariantContext,
    disposition?: ProvisionalExposureInvariantDisposition,
  ) {
    super(
      `gateway provisional exposure invariant: ${code}`
      + ` requestId=${context.requestId}`
      + (context.detail ? ` detail=${context.detail}` : ''),
    );
    this.name = 'GatewayProvisionalExposureInvariantError';
    this.disposition = disposition ?? DEFAULT_DISPOSITIONS[code];
  }

  /**
   * 返回**新实例**（不改原实例）——原实例可能已被记录/传递，就地改写会让同一个错误
   * 在不同调用点表现不同。
   */
  withDisposition(
    disposition: ProvisionalExposureInvariantDisposition,
  ): GatewayProvisionalExposureInvariantError {
    const next = new GatewayProvisionalExposureInvariantError(
      this.code,
      this.context,
      disposition,
    );
    next.stack = this.stack;
    // cause 也要搬：writer_persistence_failed 把原始 Prisma 异常挂在 cause 上，
    // 只搬 stack 会让「到底是权限被收还是约束漂移」在降级/升级后丢失 —— 那正是
    // 运维唯一能据以行动的信息。
    if (this.cause !== undefined) next.cause = this.cause;
    return next;
  }

  /** 写进父事件 `reason` 的完整值。 */
  get parentReason(): string {
    return `${PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX}${this.code}`;
  }
}

/**
 * 从父事件 `reason` 还原 code。
 *
 * ⚠️ 只接受**完整已知 code**：任意前缀、未知后缀都返回 null。窄例外重放依赖它，
 * 放宽到前缀匹配会让「未知 invariant」也被当成可重放，从而绕过 quarantine。
 */
export function parseProvisionalExposureInvariantReason(
  reason: string | null | undefined,
): ProvisionalExposureInvariantCode | null {
  if (!reason?.startsWith(PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX)) return null;
  const suffix = reason.slice(PROVISIONAL_EXPOSURE_INVARIANT_REASON_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(DEFAULT_DISPOSITIONS, suffix)
    ? (suffix as ProvisionalExposureInvariantCode)
    : null;
}

/**
 * 该 code 的**默认** disposition 是否为 quarantine。窄例外只对这一族开放：
 * 系统性 code（block 族）不该出现在父 reason 里，出现了也不允许自动重放。
 */
export function isQuarantineDefaultInvariantCode(
  code: ProvisionalExposureInvariantCode,
): boolean {
  return DEFAULT_DISPOSITIONS[code] === 'QUARANTINE_AND_DLQ';
}

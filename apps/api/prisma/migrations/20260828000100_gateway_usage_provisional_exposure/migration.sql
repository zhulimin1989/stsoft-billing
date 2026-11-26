-- 平台暂估敞口（provisional exposure）：非流式请求上游已产 token 但未完整投递时，
-- 平台吃掉的成本的**历史毛观测**。
--
-- 设计依据见 codesphere-admin/me/payg-multiplier-verify-timeout-v2.md §3.8-F8-f。
-- 三条不可动摇的性质：
--   1. 本表**不是**正式平台损失（不进 gateway_usage_platform_losses），
--      也**永不代表当前余额/未决金额** —— 每行是"某一时刻观测到的一笔敞口"。
--   2. **永久 append-only**：无状态流转、无冲正列。行级 UPDATE/DELETE 与 TRUNCATE 都被拒绝。
--   3. 只登记**非流式**、且**首收证据**可信的请求。

-- ---------------------------------------------------------------------------
-- 1) lineage 墓碑：legacy_original_evidence_missing_at
-- ---------------------------------------------------------------------------
-- 为什么需要它：cutover 必须用"首收 evidence 的 observed_at"做判据，但历史父事件里
-- 有大量没有 original evidence 的行。若不冻结，它们被重新收件时会用**本轮**的
-- observed_at 冒充首次观察时间，从而被误判为"T 之后首收"而错误计入敞口。
--
-- ⚠️ 这是 lineage 元数据冻结，**不是** exposure 历史回补 —— 不违反"历史不回补"约束。
-- ⚠️ 锁等待上限（评审 P1）：ALTER TABLE 需要 ACCESS EXCLUSIVE，动作本身是元数据级，
-- 但**等锁**时间无上限；下面的回填也会与正在收件的同一父行排队。宁可迁移失败重试，
-- 也不要在收件高峰期把父表卡住。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "gateway_billing_events"
  ADD COLUMN "legacy_original_evidence_missing_at" TIMESTAMP(3);

-- 一次性冻结存量。迁移当时实测：24,009 个父事件中 21,593 个没有 original evidence
-- （其中 1,509 仍为 RETRYABLE_FAILED），且这些行全部 evidence_hash IS NULL。
--
-- ⚠️ 谓词必须同时要求 evidence_revision = 1（评审 P1）：库里允许「匹配 hash 的 evidence
-- 是 rev2、rev1 缺失」这种异常状态。只按 hash 判会漏冻结这类行，而 exposure 又被三列
-- 复合 FK 要求只能引用 rev1 ⇒ writer 必然撞 FK。
-- 把「父 hash 为空」写成显式分支而不是塞进 NOT EXISTS，是为了让这条意图直接可读，
-- 不依赖读者推导 NULL 语义。
UPDATE "gateway_billing_events" b
SET "legacy_original_evidence_missing_at" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
WHERE b."legacy_original_evidence_missing_at" IS NULL
  AND (
    b."evidence_hash" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "gateway_usage_evidences" e
      WHERE e."gateway_billing_event_id" = b."id"
        AND e."evidence_revision" = 1
        AND e."evidence_hash" = b."evidence_hash"
    )
  );

-- 墓碑单调性：**不替换**既有 enforce_gateway_billing_event_immutable_receipt()，
-- 而是新建独立函数 + 第二条 BEFORE UPDATE 触发器。
--
-- ⚠️ 为什么必须这样做（这是本次改动里代价最高的一课）：
-- 我最初用 CREATE OR REPLACE 重写了那个既有函数，函数体是凭**早前被截断的 grep 片段**拼的。
-- 查 pg_get_functiondef 才发现线上真实函数检查 **18 列**（我先写 5 列、后又误称 20 列，两次都错），
-- 那次 replace 会**静默删掉十余列**（含 input_tokens / output_tokens / total_tokens /
-- token_source / api_key_id / tenant_id / user_id 等资金相关列）的不可变保护。
-- 独立函数 + 独立触发器让这类风险在**机制上**不可能发生：既有函数一个字都不动。
CREATE OR REPLACE FUNCTION enforce_gateway_billing_event_legacy_tombstone_write_once()
RETURNS trigger AS $$
BEGIN
  -- 只允许 NULL -> 非 NULL；一旦非空即禁止修改或清空。
  IF OLD."legacy_original_evidence_missing_at" IS NOT NULL
     AND NEW."legacy_original_evidence_missing_at"
         IS DISTINCT FROM OLD."legacy_original_evidence_missing_at"
  THEN
    RAISE EXCEPTION 'legacy_original_evidence_missing_at is write-once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_gateway_billing_event_legacy_tombstone_write_once"
  BEFORE UPDATE ON "gateway_billing_events"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gateway_billing_event_legacy_tombstone_write_once();

-- ---------------------------------------------------------------------------
-- 2) evidence 侧三列唯一键 uq_evidence_id_event_revision
-- ---------------------------------------------------------------------------
-- 由**前置**迁移 20260828000050 以 CREATE UNIQUE INDEX CONCURRENTLY 建立：
-- 普通 CREATE UNIQUE INDEX 会阻塞 gateway_usage_evidences 的写入，而该表在收件热路径上
-- （评审 P1）。这里只依赖它已经存在 —— 下面 exposure 的三列复合 FK 会引用它。

-- ---------------------------------------------------------------------------
-- 3) exposure 表
-- ---------------------------------------------------------------------------
CREATE TABLE "gateway_usage_provisional_exposures" (
  "id"                       TEXT           NOT NULL,
  "gateway_billing_event_id" TEXT           NOT NULL,
  "source_evidence_id"       TEXT           NOT NULL,
  "source_evidence_revision" INTEGER        NOT NULL,
  "exposure_kind"            TEXT           NOT NULL,
  "source_reason"            TEXT           NOT NULL,
  "http_status"              INTEGER        NOT NULL,
  "output_tokens"            BIGINT         NOT NULL,
  "input_tokens"             BIGINT,
  "token_source"             TEXT,
  "amount_usd"               DECIMAL(20,12),
  "amount_status"            TEXT           NOT NULL,
  "created_at"               TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gateway_usage_provisional_exposures_pkey" PRIMARY KEY ("id"),

  -- 本期恒定语义直接写进数据库：正文禁止的状态数据库也要拒绝，
  -- 否则"字段语义冻结"只是 writer 约定。将来机制定稿再迁表放宽。
  CONSTRAINT "ck_exposure_reason" CHECK ("source_reason" =
    'customer_protective_zero:unproven_no_charge:quota_settlement_skipped'),
  CONSTRAINT "ck_exposure_revision" CHECK ("source_evidence_revision" = 1),
  CONSTRAINT "ck_exposure_input" CHECK ("input_tokens" IS NULL),
  CONSTRAINT "ck_exposure_amount" CHECK (
    "amount_status" = 'unpriced' AND "amount_usd" IS NULL),
  CONSTRAINT "ck_exposure_tokens" CHECK ("output_tokens" > 0),
  -- 状态码**唯一决定** kind：数据库层面不允许 499+platform_timeout 这类组合。
  CONSTRAINT "ck_exposure_kind_status" CHECK (
    ("http_status" = 504 AND "exposure_kind" = 'platform_timeout') OR
    ("http_status" = 499 AND "exposure_kind" = 'client_cancellation')),

  -- 两条具名 FK，显式 RESTRICT：匿名 REFERENCES 会得到 PostgreSQL 自动命名与
  -- NO ACTION，与 Prisma relation 的 map/action 不一致，进而产生 drift。
  CONSTRAINT "fk_exposure_billing_event"
    FOREIGN KEY ("gateway_billing_event_id")
    REFERENCES "gateway_billing_events" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- 三列复合 FK：保证 source evidence 与父事件同属一笔、且必须是 rev1。
  CONSTRAINT "fk_exposure_evidence_same_event_rev1"
    FOREIGN KEY ("source_evidence_id", "gateway_billing_event_id", "source_evidence_revision")
    REFERENCES "gateway_usage_evidences" ("id", "gateway_billing_event_id", "evidence_revision")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- 幂等键：父表已有 UNIQUE(request_id)，故 event 与 request 一一对应，
-- 用 event id 作幂等键即可，不再冗余存 request_id。
-- 同样用 UNIQUE INDEX 形式与 Prisma 生成结果对齐。
CREATE UNIQUE INDEX "uq_exposure_billing_event"
  ON "gateway_usage_provisional_exposures" ("gateway_billing_event_id");

-- 分页/报表游标是 (created_at, id)，索引必须匹配其排序方向。
CREATE INDEX "ix_exposure_created_id"
  ON "gateway_usage_provisional_exposures" ("created_at" DESC, "id" DESC);

-- append-only：复用既有触发器函数（函数体只 RAISE EXCEPTION，不引用 OLD/NEW，
-- 因此同一函数既可用于行级 UPDATE/DELETE，也可用于语句级 TRUNCATE）。
CREATE TRIGGER "trg_exposure_append_only_row"
  BEFORE UPDATE OR DELETE ON "gateway_usage_provisional_exposures"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

-- ⚠️ 既有触发器只拦行级 UPDATE/DELETE，不拦 TRUNCATE；财务类表被 TRUNCATE 的后果
-- 不可接受，故额外加一条语句级触发器。
CREATE TRIGGER "trg_exposure_append_only_truncate"
  BEFORE TRUNCATE ON "gateway_usage_provisional_exposures"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

COMMIT;

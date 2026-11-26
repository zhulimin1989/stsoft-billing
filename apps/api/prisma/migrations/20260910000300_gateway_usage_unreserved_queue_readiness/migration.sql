-- 队列的 readiness 闸门 + 提交后校正 + 写入侧一致性保护。
--
-- 本文件回应 codex 对 20260910000100/000200 的三条复核意见。100/200 已在 nprod 与两个 UAT
-- apply 过,Prisma 校验 migration.sql 的 checksum ⇒ 不能回改,所有补强只能放在本文件。
--
-- ## 1) 为什么需要 readiness 闸门(codex「反对」项)
--
-- 100 号提交后触发器即生效,但历史上符合「BALANCE + V1 + sequence 非空 + 尚无 reservation」
-- 的 anchor 要等 200 号回填才进队。若新代码在这个窗口里已经只从 queue 查 blocker,
-- 后到的 receipt 会查到空、成功预留,**直接越过更早的 receipt(FIFO false negative)**。
-- 「三地实测该集合为 0 行」只是当前数据巧合,不是结构安全性;而且本仓历史上出现过
-- 「新代码先于 schema」的部署缺口。
-- ★ `compare` 模式**不能**充当保护:它先返回 queue 结果、再把 guard 结果仅作诊断,
--   两者 diverge 时**仍返回 queue 结果**。
-- ⇒ 应用侧改为:readiness 未就绪就走保留的旧 NOT EXISTS 查询(语义等价、只是慢),
--   只有本文件的断言全部通过并写入标记后才启用 queue 版。标记由 migration 写,不靠应用配置。
--
-- ## 2) 为什么校正 DELETE 必须放在本文件而不是 200 号(codex「需修改」项)
--
-- 200 号末尾那条校正 DELETE 消不掉这个竞态:
--   ① 回填事务插入 queue 行但未提交;② 并发 reservation 提交,其出队触发器看不到未提交的
--   queue 行 ⇒ 删 0 行;③ 回填自己的校正 DELETE 在 reservation 提交前取快照 ⇒ 也看不到它;
--   ④ 双方提交后 ⇒ reservation 已存在而 queue 行仍在 ⇒ 该账户后续 receipt 被长期假阻塞。
-- 放到独立事务(本文件)后收敛可靠:此时回填插入的 queue 行已提交可见,
-- 并发 reservation 要么看得到并删除它,要么在本校正之后执行、只会删 0 行。
--
-- ## 3) 为什么加写入侧一致性触发器(codex「需修改」项)
--
-- queue 与 anchor 的 event/account/sequence 恒等此前只是「约定」:queue 无 FK、无不可变
-- 触发器、无写权限隔离,Prisma model 还把它暴露给应用。误改 sequence 就能造成真实错序
-- (queue.sequence 偏大 ⇒ 真正更早的 blocker 被过滤掉、FIFO 被越过)。
-- 本文件把它变成 DB 保证:INSERT 必须与 anchor 三列一致,UPDATE 一律拒绝。

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- A) 写入侧一致性:queue 只允许 INSERT / DELETE,且 INSERT 必须与 anchor 三列一致
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_unreserved_queue_matches_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a_account TEXT;
  a_seq     BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- queue 是入队/出队两态,没有「改一行」的语义。禁止 UPDATE 可同时挡住
    -- 人工 SQL 误改 sequence/account 造成的 FIFO 错序。
    RAISE EXCEPTION 'gateway_usage_unreserved_queue is insert/delete only'
      USING ERRCODE = '55000';
  END IF;

  SELECT a."billing_account_id", a."first_receipt_sequence"
    INTO a_account, a_seq
    FROM "gateway_usage_settlement_anchors" a
   WHERE a."gateway_billing_event_id" = NEW."gateway_billing_event_id";

  IF a_account IS NULL THEN
    RAISE EXCEPTION 'unreserved queue row references unknown anchor event %',
      NEW."gateway_billing_event_id" USING ERRCODE = '23514';
  END IF;

  IF NEW."billing_account_id" IS DISTINCT FROM a_account
     OR NEW."first_receipt_sequence" IS DISTINCT FROM a_seq THEN
    RAISE EXCEPTION 'unreserved queue row disagrees with anchor % (account %/% , sequence %/%)',
      NEW."gateway_billing_event_id", NEW."billing_account_id", a_account,
      NEW."first_receipt_sequence", a_seq USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_usage_unreserved_queue_matches_anchor
BEFORE INSERT OR UPDATE ON "gateway_usage_unreserved_queue"
FOR EACH ROW EXECUTE FUNCTION enforce_unreserved_queue_matches_anchor();

-- ---------------------------------------------------------------------------
-- B) 提交后校正:清掉「已预留却仍在队里」的行(200 号回填的竞态残留)
--    幂等收敛;方向上只会少阻塞 —— 被删的行都确有 reservation,按原
--    NOT EXISTS(reservation) 语义本就不该阻塞。
-- ---------------------------------------------------------------------------
DELETE FROM "gateway_usage_unreserved_queue" q
 WHERE EXISTS (
   SELECT 1 FROM "gateway_usage_funding_reservations" r
    WHERE r."gateway_billing_event_id" = q."gateway_billing_event_id");

-- ---------------------------------------------------------------------------
-- C) 断言:三项都必须为 0,否则本 migration 失败、readiness 不写入、
--    应用继续走旧查询(安全侧)。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing   BIGINT;
  stale     BIGINT;
  mismatched BIGINT;
BEGIN
  SELECT count(*) INTO missing
    FROM "gateway_usage_settlement_anchors" a
   WHERE a."billing_unit" = 'BALANCE'
     AND a."funding_reservation_protocol" = 'V1'
     AND a."first_receipt_sequence" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "gateway_usage_funding_reservations" r
                      WHERE r."gateway_billing_event_id" = a."gateway_billing_event_id")
     AND NOT EXISTS (SELECT 1 FROM "gateway_usage_unreserved_queue" q
                      WHERE q."gateway_billing_event_id" = a."gateway_billing_event_id");

  SELECT count(*) INTO stale
    FROM "gateway_usage_unreserved_queue" q
   WHERE EXISTS (SELECT 1 FROM "gateway_usage_funding_reservations" r
                  WHERE r."gateway_billing_event_id" = q."gateway_billing_event_id");

  SELECT count(*) INTO mismatched
    FROM "gateway_usage_unreserved_queue" q
    LEFT JOIN "gateway_usage_settlement_anchors" a
      ON a."gateway_billing_event_id" = q."gateway_billing_event_id"
   WHERE a."gateway_billing_event_id" IS NULL
      OR a."billing_account_id" IS DISTINCT FROM q."billing_account_id"
      OR a."first_receipt_sequence" IS DISTINCT FROM q."first_receipt_sequence";

  IF missing <> 0 OR stale <> 0 OR mismatched <> 0 THEN
    RAISE EXCEPTION
      'unreserved queue invariant violated: missing=% stale=% mismatched=% — readiness not granted',
      missing, stale, mismatched USING ERRCODE = '23514';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- D) readiness 标记。单行表,存在即表示「回填已完成且断言已通过」。
--    应用只读它;一旦置位就不会撤销(队列此后由触发器维持)。
-- ---------------------------------------------------------------------------
CREATE TABLE "gateway_usage_unreserved_queue_readiness" (
  "id" BOOLEAN NOT NULL DEFAULT true,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "granted_by_migration" TEXT NOT NULL,
  CONSTRAINT "gateway_usage_unreserved_queue_readiness_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_unreserved_queue_readiness_singleton" CHECK ("id")
);

COMMENT ON TABLE "gateway_usage_unreserved_queue_readiness" IS
  '存在一行即表示 gateway_usage_unreserved_queue 已完成回填且不变量断言通过,应用方可改用队列版 FIFO 队头查询。由 migration 写入,不受应用配置影响;未就绪时应用必须走旧的 NOT EXISTS(reservation) 查询。';

INSERT INTO "gateway_usage_unreserved_queue_readiness" ("granted_by_migration")
VALUES ('20260910000300_gateway_usage_unreserved_queue_readiness');

-- 稀疏队列表：让「该账户存在更早且未预留的 anchor」这个判定可索引。
--
-- ## 为什么需要
--
-- findGatewayFundingBlockerFromAnchors 要证明「不存在更早且未预留的 anchor」。这是一个反连接,
-- 而热点账户的更早 anchor 全部已预留 ⇒ 结果恒空 ⇒ LIMIT 1 无法提前终止 ⇒ 恒定全扫。
-- 2026-09-10 国内 prod 实测:热点账户 563,062 行 anchor、该查询 p50 2,119ms,
-- 单笔用量事件处理 4,830ms(正常分区 510ms),处理 635 笔/小时 < 进料 2,076 笔/小时
-- ⇒ 积压永久净增长、约 21 天后触及 Kafka 保留期开始丢用量。
-- 查询形态改写已被穷尽:NOT EXISTS 改写只 +7%、MATERIALIZED CTE 是负收益。
-- 只要「未预留」这个状态不可索引,任何查询形态都要扫全部历史 anchor。
--
-- ## 为什么是独立表,而不是给 anchors 加一列
--
-- `gateway_usage_settlement_anchors` 是 **DB 层强制的 append-only 表**:
-- 触发器 gateway_usage_settlement_anchors_append_only(BEFORE DELETE OR UPDATE)
-- 无条件 RAISE EXCEPTION ... ERRCODE='55000'(见 20260806000106)。
-- ⇒ 「给 anchor 加物化列 + 触发器更新」的方案不可行:回填与触发器的 UPDATE 都会抛 55000,
-- 而且触发器抛错会**回滚整个 reservation INSERT 事务** ⇒ 账户资金预留彻底卡死。
-- 也**不能靠删除/放开 append-only 触发器绕过** —— 那会允许任意 UPDATE、制造「已预留」假阳性,
-- 使后来的收据越过更早的收据(正是这条队列要防的资金错序)。
-- 独立表把可变状态放在自己身上,anchors 的不可变契约一行不动。
--
-- ## 不变量
--
--   queue 中存在 event ⟺ 该 anchor 参与 V1 资金预留队列 且 尚无 reservation
--
-- 由本文件的两个触发器在 DB 层维护,不依赖应用逻辑:
--   * anchors AFTER INSERT  → 满足入队条件则插入(带 NOT EXISTS(reservation) 兜底,
--                             即使将来出现「reservation 先于 anchor」也不会误入队)
--   * reservations AFTER INSERT → 删除该 event 的 queue 行
-- reservation 的 status 流转(ACTIVE→CONSUMED/RELEASED)**不触碰 queue**,
-- 这与被替换的原查询语义一致:原 NOT EXISTS 不看 status,只看行是否存在
-- ⇒ RELEASED 也算已预留、不重新入队。reservation 在 DB 层禁止 DELETE,
-- 故「已预留」不会回退,queue 行删除后无需恢复。
--
-- ## 并发与锁序
--
-- 读侧(blocker 查询)对 queue 只做普通 SELECT、只在 anchor 上取 FOR UPDATE;
-- 写侧(reservation 事务)删 queue 行、不等 queue 上的读锁 ⇒ 两侧锁对象不构成环。
-- READ COMMITTED 下读侧可能看到一条即将被删的 queue 行,后果是**多阻塞一次**(保守),
-- 不会放行本该被阻塞的收据 —— 方向安全。
--
-- ## 回填在下一个 migration(20260910000200),不在本文件 —— 这是为了锁时长
--
-- CREATE TRIGGER 取 anchors / reservations 的 ACCESS EXCLUSIVE 锁,而 PG 的锁持到事务结束。
-- 回填的 INSERT...SELECT 在国内 prod 实测 **3,347ms**(扫 111 万 buffers、hash 溢出 32 batches、
-- temp 21MB)。两者放同一事务 ⇒ anchors 被独占锁 **约 3.5-4 秒**,期间该表读写全部排队
-- (实测该表 1.08 笔/秒插入 ⇒ 约 4 笔被挡住重试)。拆开后本文件只改 catalog、不扫表,
-- ACCESS EXCLUSIVE 只持**毫秒级**;回填那条只持 AccessShare(anchors)+ROW EXCLUSIVE(queue),
-- 不阻塞 anchors 写入。
--
-- ⚠️ 顺序不能反,也不能合并:回填必须在触发器**生效之后的独立事务**里跑。
-- 若两者同事务(无论谁先),存在这个 MVCC 竞态:回填按快照 T 判定「未预留」,而在 T 之后、
-- 本事务 COMMIT 之前提交的 reservation,其出队触发器执行 DELETE 时**看不到本事务尚未提交的
-- queue 行**(影响 0 行)⇒ 提交后留下「已预留却仍在队里」的行 ⇒ false positive
-- ⇒ 该账户后续 reservation 被**假阻塞**直到有人手工删行。
-- 触发器先独立提交,则此后所有 reservation 都能正确出队,回填只需补历史。

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1) 队列表
-- ---------------------------------------------------------------------------
CREATE TABLE "gateway_usage_unreserved_queue" (
  "gateway_billing_event_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "first_receipt_sequence" BIGINT NOT NULL,
  "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_unreserved_queue_pkey" PRIMARY KEY ("gateway_billing_event_id")
);

COMMENT ON TABLE "gateway_usage_unreserved_queue" IS
  '稀疏队列:参与 V1 资金预留且尚无 reservation 的 anchor。由 DB 触发器维护(anchors AFTER INSERT 入队 / reservations AFTER INSERT 出队),不要用应用代码直接写。存在的唯一目的是让 FIFO 队头判定可索引,取代对 anchors 的全历史反连接扫描。';

-- 队头查询走这个索引:按账户定位 + 按 sequence 有序 ⇒ LIMIT 1 可立即终止。
CREATE INDEX "gateway_usage_unreserved_queue_account_sequence_idx"
  ON "gateway_usage_unreserved_queue" ("billing_account_id", "first_receipt_sequence");

-- ---------------------------------------------------------------------------
-- 2) 入队:anchors AFTER INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_unreserved_settlement_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 只有参与 V1 资金预留队列的 anchor 才入队。CREDITS 与 protocol 为空的历史 anchor
  -- 按设计不在此队列(schema 注释:CREDITS anchors deliberately remain outside this queue)。
  IF NEW."billing_unit" = 'BALANCE'
     AND NEW."funding_reservation_protocol" = 'V1'
     AND NEW."first_receipt_sequence" IS NOT NULL
     -- 兜底:实测不存在「reservation 先于 anchor」的行(0 条),但真出现时也不能误入队,
     -- 否则一条永远不会被出队的行会把该账户的队头永久卡住。
     AND NOT EXISTS (
       SELECT 1 FROM "gateway_usage_funding_reservations" r
        WHERE r."gateway_billing_event_id" = NEW."gateway_billing_event_id")
  THEN
    INSERT INTO "gateway_usage_unreserved_queue" (
      "gateway_billing_event_id", "billing_account_id", "first_receipt_sequence")
    VALUES (NEW."gateway_billing_event_id", NEW."billing_account_id", NEW."first_receipt_sequence")
    ON CONFLICT ("gateway_billing_event_id") DO NOTHING;
  END IF;
  RETURN NULL;  -- AFTER 触发器的返回值被忽略
END;
$$;

CREATE TRIGGER gateway_usage_settlement_anchors_enqueue_unreserved
AFTER INSERT ON "gateway_usage_settlement_anchors"
FOR EACH ROW EXECUTE FUNCTION enqueue_unreserved_settlement_anchor();

-- ---------------------------------------------------------------------------
-- 3) 出队:reservations AFTER INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dequeue_reserved_settlement_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "gateway_usage_unreserved_queue"
   WHERE "gateway_billing_event_id" = NEW."gateway_billing_event_id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER gateway_usage_funding_reservations_dequeue_anchor
AFTER INSERT ON "gateway_usage_funding_reservations"
FOR EACH ROW EXECUTE FUNCTION dequeue_reserved_settlement_anchor();

-- 历史回填见 20260910000200_gateway_usage_unreserved_queue_backfill(独立事务,理由见文件头)。

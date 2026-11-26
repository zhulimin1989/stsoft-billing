-- gateway_usage_unreserved_queue 的历史回填。
--
-- 必须与 20260910000100(建表 + 触发器)分开成两个 migration,两条理由:
--
-- 1) **锁时长**。CREATE TRIGGER 取 anchors / reservations 的 ACCESS EXCLUSIVE 锁,PG 的锁持到
--    事务结束。下面这条 INSERT...SELECT 在国内 prod 实测 3,347ms(扫 111 万 buffers、
--    hash 溢出 32 batches、temp 21MB)。若与触发器同事务,anchors 会被独占锁约 3.5-4 秒,
--    期间该表读写全部排队(实测 1.08 笔/秒插入)。拆开后本文件只取
--    AccessShare(anchors) + ROW EXCLUSIVE(queue),**不阻塞 anchors 写入**。
--
-- 2) **MVCC 正确性**。回填必须在触发器已生效的**独立事务**里跑。若同事务,回填按快照 T
--    判定「未预留」,而 T 之后、COMMIT 之前提交的 reservation,其出队触发器执行 DELETE 时
--    看不到本事务尚未提交的 queue 行(影响 0 行)⇒ 提交后留下「已预留却仍在队里」的行
--    ⇒ false positive ⇒ 该账户后续 reservation 被假阻塞,直到有人手工删行。
--    触发器先独立提交后,此后所有 reservation 都能正确出队,本文件只补历史。
--
-- 幂等:INSERT 带 NOT EXISTS + ON CONFLICT DO NOTHING,DELETE 是收敛操作 ⇒ 可重复执行。
--
-- 2026-09-10 实测目标集为 **0 行**(未预留的 408,616 行全是 CREDITS / protocol NULL,
-- 按设计不入此队列;V1+BALANCE 的 744,633 行全部已预留)⇒ 本次回填是空插入,
-- 无写放大、无膨胀、不需要分批。那 3.3 秒是 SELECT 确认「确实没有漏的」的代价,只付一次。
-- ★ 但不能因此省掉本文件:海外 use1 与将来的环境未必是 0,漏回填 = 队列漏掉历史未预留
-- 的 anchor = FIFO 队头被越过(后来的收据抢先占资金)。

-- 1) 补历史:把「参与队列条件、且尚无 reservation」的 anchor 入队。
INSERT INTO "gateway_usage_unreserved_queue" (
  "gateway_billing_event_id", "billing_account_id", "first_receipt_sequence")
SELECT a."gateway_billing_event_id", a."billing_account_id", a."first_receipt_sequence"
  FROM "gateway_usage_settlement_anchors" a
 WHERE a."billing_unit" = 'BALANCE'
   AND a."funding_reservation_protocol" = 'V1'
   AND a."first_receipt_sequence" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "gateway_usage_funding_reservations" r
      WHERE r."gateway_billing_event_id" = a."gateway_billing_event_id")
ON CONFLICT ("gateway_billing_event_id") DO NOTHING;

-- 2) 校正:兜住上面 INSERT...SELECT 单语句内的残余竞态 —— 若某 anchor 在本语句的快照里
--    还未预留、而 INSERT 落盘前其 reservation 已提交(出队触发器那时还没有队行可删),
--    就会留下一条已预留的队行。这条 DELETE 是幂等收敛,把这类 false positive 清掉。
--    方向上它只会「少阻塞」,不会漏掉真 blocker:被删的行都确有 reservation。
DELETE FROM "gateway_usage_unreserved_queue" q
 WHERE EXISTS (
   SELECT 1 FROM "gateway_usage_funding_reservations" r
    WHERE r."gateway_billing_event_id" = q."gateway_billing_event_id");

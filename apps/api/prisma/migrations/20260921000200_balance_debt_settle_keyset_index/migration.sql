-- 欠款核销候选的 keyset 索引。
--
-- 现状走的是 (billing_account_id, ledger_sequence) 这个 unique 索引,而
-- settled_at / source / funding_classification_complete 全靠回表 Filter:
-- 国内 prod 实测(2026-09-20)单批要扫掉 47,671 行才凑够 200 行、耗时 85ms,
-- 且已核销行越堆越多 ⇒ Rows Removed by Filter 持续增长,是 O(N²) 退化。
--
-- 对 pending worker 尤其关键:它每轮是独立事务、keyset 游标从头开始,
-- 没有这个部分索引就要在每轮开头重新 Filter 掉该账户全部已核销行
-- ⇒ 欠款越接近清偿、每轮起步越慢。WHERE settled_at IS NULL 让已核销行
-- 直接离开索引,索引规模随欠款收敛而下降。
--
-- 既有的 balance_allocations_account_funding_open_idx 用不上:它的排序键是
-- created_at 而核销按 ledger_sequence FIFO(换列即丢掉有序性、LIMIT 无法提前终止),
-- 且缺 source 列。
CREATE INDEX CONCURRENTLY "balance_allocations_debt_settle_seq_idx"
  ON "balance_consumption_allocations" (
    "billing_account_id",
    "source",
    "funding_classification_complete",
    "ledger_sequence",
    "id"
  )
  WHERE "settled_at" IS NULL;

-- balance_consumption_allocations 的跨列统计:修正 planner 对 (billing_account_id, source)
-- 相关性的误估,让 ledSnapshot 的三个子查询用上已有的账户复合索引。
--
-- ## 问题
--
-- readReconciledBalanceLedgerSnapshotInner(billing.service.ts:5146,埋点名 ledSnapshot)
-- 在队列表上线后成为单笔用量事件的最大单项:国内 prod 实测 p50 505ms、占单笔 973ms 的 52%
-- (2,036 笔样本;上线前它排第三,被 resvBlockingScan 的 2,119ms 盖住)。
--
-- 它一条 SELECT 里拼了 8 个子查询,其中三个扫 balance_consumption_allocations。
-- EXPLAIN 实测(热点账户 3c395adf):三条**全部走单列索引、把 billing_account_id 丢进 Filter
-- 后过滤**,合计 242.8ms / 69,648 buffers:
--   open_debt      83.8ms / 32,722 buffers / Rows Removed by Filter 86,522 x3
--   invalid_debt  114.1ms / 32,635 buffers / Rows Removed by Filter 130,414 x2
--   哨兵子查询     44.7ms(见文末,本 migration 不解决它)
--
-- ## 根因:不是缺索引,也不是统计过时,是缺跨列相关性
--
-- 复合索引早就有:balance_consumption_allocations_account_source_created_idx
--   (billing_account_id, source, created_at);统计也是新鲜的(last_autoanalyze 09-09 19:23、
-- 死元组 0.1%)。planner 不选它,是因为把两个列当**独立事件**相乘:
--   pg_stats: source 的 ENTERPRISE_CREDIT 占 19.98%;billing_account_id 的热点账户占 73.18%
--   ⇒ 估 1,277,430 x 0.1998 x 0.7318 ≈ 186,000 行(并行后报 75,844)
-- 而真实分布是**强负相关**:热点账户的 92.6 万行几乎全是 BALANCE_GRANT,
-- 它的 ENTERPRISE_CREDIT 只有 1,225 行 ⇒ **planner 高估约 150 倍**,
-- 于是认为"按账户过滤没什么用",转而选单列 source_idx 全扫。
--
-- ## 效果(2026-09-10 在国内 prod 用 BEGIN...ROLLBACK 实测,零残留)
--
--   执行时间 242.8ms → 42.7ms(-82%);buffers 69,648 → 4,498(-94%)
--   open_debt     83.8ms / 32,722 buffers → 0.45ms / 98 buffers
--   invalid_debt 114.1ms / 32,635 buffers → 0.24ms / 101 buffers
--   planner 行数估计 75,844 → 6,219(实际 1,225);前两条子查询从并行全扫变单进程索引扫
--
-- ## 代价与回滚
--
-- 纯优化器提示:不建索引、不改表结构、不动任何数据。
-- CREATE STATISTICS 只写 catalog;ANALYZE 取 ShareUpdateExclusive —— **不阻塞业务读写**,
-- 只与并发 VACUUM/ANALYZE/DDL 互斥。回滚一句 DROP STATISTICS。
--
-- ⚠️ 本 migration **不解决第三个子查询**(数据完整性哨兵:
-- source NOT IN (NEGATIVE_BALANCE, ENTERPRISE_CREDIT, BALANCE_GRANT, UNRECONCILED_GRANT),
-- 正常恒为 0)。它的 NOT IN 用不上索引、跨列统计帮不了,实测仍 42ms / 扫 30.9 万行,
-- 占优化后 42.7ms 的 98%。改法要动代码(给它补 billing_account_id 索引条件,
-- 单独实测 170ms → 59ms),留作下一步。

SET LOCAL lock_timeout = '15s';

CREATE STATISTICS "balance_consumption_allocations_account_source_stat"
  (dependencies, ndistinct, mcv)
  ON "billing_account_id", "source"
  FROM "balance_consumption_allocations";

-- 扩展统计要 ANALYZE 才会被填充;不 ANALYZE 则该对象存在但对 planner 无效。
ANALYZE "balance_consumption_allocations";

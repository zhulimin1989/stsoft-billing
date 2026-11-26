-- 供 gateway_usage_provisional_exposures 的三列复合 FK 引用：它使
-- "exposure 的 source evidence 必须与父事件同属一笔、且必须是 rev1" 成为**数据库约束**。
--
-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
--
-- ⚠️ 必须 CONCURRENTLY 且单独成一次迁移：普通 CREATE UNIQUE INDEX 会阻塞
-- gateway_usage_evidences 的写入，而该表在收件热路径上。
-- ⚠️ 用 UNIQUE INDEX 而不是 ADD CONSTRAINT UNIQUE：Prisma 的
-- `migrate diff --to-schema-datamodel` 生成的正是 UNIQUE INDEX 形式，
-- 两种写法在 pg_constraint 里表现不同，constraint 形式会被判 drift。
-- PostgreSQL 的复合 FK 引用 unique index 同样成立。
CREATE UNIQUE INDEX CONCURRENTLY "uq_evidence_id_event_revision"
  ON "gateway_usage_evidences" ("id", "gateway_billing_event_id", "evidence_revision");

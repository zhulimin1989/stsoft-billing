-- 修：投影 intent 的时间戳被写成本地时间，导致每条限制投影延迟一个时区偏移量
--
-- billing_restriction_projection_intents 的 next_run_at / created_at / updated_at 都是
-- `timestamp without time zone`，全库其余写入方（应用侧）存的是 UTC。
-- 但本触发器用的是 `clock_timestamp()`（timestamptz），隐式转换按**会话时区**取墙上时间：
-- 生产会话是 Asia/Shanghai ⇒ 存进去比 UTC 快 8 小时。
--
-- 后果：worker 的可领条件是 next_run_at <= now()（UTC），于是触发器入队的 intent
-- 在 8 小时内根本领不到。2026-09-20 国内 prod 实测 17,672 条 PENDING 里只有 1 条是
-- 当下可领的，其余 17,671 条都是未来时间 —— 看上去像"消费者没跑"，其实 worker 一直在跑
-- （SUCCEEDED 1,412,998 条、最新一条就在当秒），只是每条投影都被自己的时间戳推迟了 8 小时。
--
-- 封禁之所以仍能立刻生效，是因为建行时应用另有一条同步路径（syncEventRestriction）直推
-- publisher/Redis；**解封没有这条同步路径**，只能靠本 outbox ⇒ 解封被整整推迟一个时区。
--
-- 只改函数体的时间取值，入队条件、列、ON CONFLICT 全部保持原样。
-- 存量的偏移行不在本迁移里回填：一次性放行约 1.7 万条会造成 publisher 扇出突发，
-- 需要分批 + 单独审批（见 ops 脚本），本迁移只保证**新入队**的是 UTC。

CREATE OR REPLACE FUNCTION enqueue_billing_restriction_projection_intent()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  INSERT INTO "billing_restriction_projection_intents" (
    "id",
    "billing_access_restriction_id",
    "gateway_billing_event_id",
    "api_key_id",
    "billing_account_id",
    "restriction_status",
    "status",
    "attempts",
    "next_run_at",
    "created_at",
    "updated_at"
  ) VALUES (
    gen_random_uuid()::TEXT,
    NEW."id",
    NEW."gateway_billing_event_id",
    NEW."api_key_id",
    NEW."billing_account_id",
    NEW."status",
    'PENDING',
    0,
    (clock_timestamp() AT TIME ZONE 'UTC'),
    (clock_timestamp() AT TIME ZONE 'UTC'),
    (clock_timestamp() AT TIME ZONE 'UTC')
  )
  ON CONFLICT ("billing_access_restriction_id", "restriction_status") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

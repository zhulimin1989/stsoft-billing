-- 种一个默认推介活动「全员推广」,保证每个环境都至少有一个 active program。
--
-- 为什么需要:用户端 GET /api/user/referral-code 找不到 active program 时抛 404
-- (「当前没有可用的邀请活动」)。而活动此前只能由运营在 admin 后台逐环境手建,
-- 漏建的环境上,用户控制台的「推介计划」页面对所有人都是空的。
--
-- 为什么现在可以写进 migration:referrals.service.ts createProgram 第一行强制
-- `input.trackingOnly = true`,并且 `if (trackingOnly) return program;` 跳过创建
-- hidden GrantRule ⇒ **当前实现不发任何奖励**,奖励按业务决定走线下发放。
-- 所以这条 seed 不等于把发钱规则写进代码,inviter/invitee reward 填 0 最诚实。
-- ★ 一旦将来放开线上发奖(删掉那行强制 trackingOnly),本活动会立刻变成发钱配置 ——
--   那时必须回来复核这里的 0/0 与 reward_condition 是否仍然合适。
--
-- 幂等性:仅当「不存在任何 active 且未删除的 program」时才插入。
-- 因此在运营已经手建过活动的环境上是彻底的 no-op,不会造出第二个活动
-- (服务端不传 programId 时取 created_at 最早的 active program,多活动会产生歧义)。
-- 反过来,若运营日后**有意**停用全部活动,本 migration 早已执行完毕,不会把它复活。

-- 不设 lock_timeout:本文件只有一条 INSERT,取 ROW EXCLUSIVE,不与 DDL 争强锁
-- (scripts/check-migration-lock-timeout.mjs 也明确把 DML 排除在管控之外)。
-- 而 SET LOCAL 在非事务块里执行会发 WARNING,平添排障噪音。

INSERT INTO "referral_programs" (
  "id",
  "name",
  "inviter_reward",
  "invitee_reward",
  "reward_condition",
  "tracking_only",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  'a1f5c7e2-0000-4000-8000-000000000001',  -- 固定 id:便于跨环境对照与排障
  '全员推广',
  0,                                        -- 线上不发奖(见上方说明)
  0,
  'REGISTER'::"ReferralRewardCondition",
  TRUE,                                     -- 仅追踪:与 service 的强制值保持一致
  TRUE,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "referral_programs"
  WHERE "is_active" = TRUE AND "deleted_at" IS NULL
);

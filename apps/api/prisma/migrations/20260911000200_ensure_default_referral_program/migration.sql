-- 无条件保证存在一条叫「全员推广」的活动,并让它成为用户实际拿到码的那一个。
--
-- 为什么要再来一条 migration(而不是改上一条):
-- 20260911000100 已在香港/上海 UAT 与 test 环境 applied,Prisma 的 migration
-- checksum 不可变 —— 改动已应用的文件会让这些环境的 migrate deploy 直接校验失败。
--
-- 上一条的幂等条件是「库里没有任何 active 活动才插入」。实测两个 UAT 库里运营
-- 2026-07 就建过 3~4 个 active 活动,于是上一条成了 no-op,「全员推广」没进去。
-- 本条改为无条件保证其存在。
--
-- ★ 关键:光插入不够。服务端(referrals.service.ts getMyReferralCode)在调用方
--   不传 programId 时取 **created_at 最早** 的 active 活动。若「全员推广」是
--   今天新插的,它永远排在 2026-07 那批后面,用户仍然拿不到它。
--   因此这里把它的 created_at 固定为一个早于所有历史活动的时间戳,使它确定性地
--   成为被选中的那一个。created_at 对活动而言只是排序元数据,不参与任何资金计算。
--
-- 影响面(上线前必读):
-- - 用户打开「推介计划」时拿到的码,会从挂在旧活动下改为挂在「全员推广」下。
--   码是按 (program, inviter) 唯一的 ⇒ 已经拿过旧码的用户会看到一个**新码**,
--   旧码仍然有效(旧行还在、仍指向旧活动),此前分享出去的链接不会失效。
-- - 页面刚上线、正式推广尚未开始,现在切换代价最小;等用户开始分享后再切会造成
--   「同一个人有两个码」的困惑。
-- - 归因记录(referral_redemptions)按 program 归属 ⇒ 切换后新增归因会记到
--   「全员推广」名下,旧活动的历史数据不受影响、也不会被合并。
--
-- 当前实现不发任何奖励(service 强制 tracking_only=true 并跳过 GrantRule 创建),
-- 奖励按业务决定走线下发放,故 reward 填 0/0。
-- ★ 将来若放开线上发奖,本活动会立刻变成发钱配置,届时必须回来复核 0/0 与
--   reward_condition,以及「它是被默认选中的活动」这一事实。

-- 1) 不存在同名活动时插入(按 name 判重,避免与运营手建的同名活动重复)
INSERT INTO "referral_programs" (
  "id", "name", "inviter_reward", "invitee_reward", "reward_condition",
  "tracking_only", "is_active", "created_at", "updated_at"
)
SELECT
  'a1f5c7e2-0000-4000-8000-000000000001',
  '全员推广',
  0, 0,
  'REGISTER'::"ReferralRewardCondition",
  TRUE, TRUE,
  TIMESTAMP '2020-01-01 00:00:00',  -- 刻意早于所有历史活动,见上方说明
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "referral_programs"
  WHERE "name" = '全员推广' AND "deleted_at" IS NULL
);

-- 2) 归正「全员推广」的 created_at,让它在所有环境都确定性地成为最早的 active 活动。
--    按 **name** 而不是固定 id 匹配,覆盖三种来源:
--      a) 上一条 migration 在空库环境插的(created_at=NOW());
--      b) 本文件上方刚插的(已经是 2020,被 WHERE 过滤掉,不做无谓写入);
--      c) 运营在 admin 手建的同名活动 —— 这种情况上方的 INSERT 会按 name 判重跳过,
--         若这里也只按固定 id 更新,它就会停在自己的创建时间、**仍然不被选中**,
--         那本条 migration 对该环境就等于没生效(实测场景④ 发现的缺口)。
--    只动 created_at / is_active,不碰奖励、风控上限等任何运营参数。
UPDATE "referral_programs"
SET "created_at" = TIMESTAMP '2020-01-01 00:00:00',
    "is_active"  = TRUE,
    "updated_at" = NOW()
WHERE "name" = '全员推广'
  AND "deleted_at" IS NULL
  AND ("created_at" <> TIMESTAMP '2020-01-01 00:00:00' OR "is_active" = FALSE);

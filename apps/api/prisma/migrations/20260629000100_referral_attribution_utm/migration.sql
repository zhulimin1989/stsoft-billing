-- Referral attribution tables were introduced in the Prisma schema before a
-- corresponding production migration existed. Keep this migration tolerant so
-- environments that already materialized the tables only receive the new UTM
-- and tracking-only columns.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferralRewardCondition') THEN
    CREATE TYPE "ReferralRewardCondition" AS ENUM ('REGISTER', 'FIRST_RECHARGE', 'FIRST_SUBSCRIBE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "referral_programs" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "inviter_reward" INTEGER NOT NULL,
  "invitee_reward" INTEGER NOT NULL,
  "reward_condition" "ReferralRewardCondition" NOT NULL,
  "product_id" TEXT,
  "tracking_only" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "start_at" TIMESTAMP(3),
  "end_at" TIMESTAMP(3),
  "same_ip_limit" INTEGER,
  "same_device_limit" INTEGER,
  "per_user_invite_limit" INTEGER,
  "inviter_grant_rule_id" TEXT,
  "invitee_grant_rule_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "referral_programs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "referral_codes" (
  "id" TEXT NOT NULL,
  "program_id" TEXT NOT NULL,
  "inviter_user_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "referral_redemptions" (
  "id" TEXT NOT NULL,
  "program_id" TEXT NOT NULL,
  "code_id" TEXT NOT NULL,
  "inviter_user_id" TEXT NOT NULL,
  "invitee_user_id" TEXT NOT NULL,
  "triggered_at" TIMESTAMP(3),
  "reward_granted" BOOLEAN NOT NULL DEFAULT false,
  "inviter_granted" BOOLEAN NOT NULL DEFAULT false,
  "invitee_granted" BOOLEAN NOT NULL DEFAULT false,
  "inviter_ip" TEXT,
  "invitee_ip" TEXT,
  "invitee_device_id" TEXT,
  "utm_source" TEXT,
  "utm_medium" TEXT,
  "utm_campaign" TEXT,
  "utm_content" TEXT,
  "landing_url" TEXT,
  "captured_at" TIMESTAMP(3),
  "reject_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_redemptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "referral_programs"
  ADD COLUMN IF NOT EXISTS "tracking_only" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "referral_redemptions"
  ADD COLUMN IF NOT EXISTS "utm_source" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_medium" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT,
  ADD COLUMN IF NOT EXISTS "utm_content" TEXT,
  ADD COLUMN IF NOT EXISTS "landing_url" TEXT,
  ADD COLUMN IF NOT EXISTS "captured_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_code_key" ON "referral_codes"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_program_id_inviter_user_id_key" ON "referral_codes"("program_id", "inviter_user_id");
CREATE INDEX IF NOT EXISTS "referral_codes_inviter_user_id_idx" ON "referral_codes"("inviter_user_id");
CREATE INDEX IF NOT EXISTS "referral_programs_is_active_deleted_at_idx" ON "referral_programs"("is_active", "deleted_at");
CREATE UNIQUE INDEX IF NOT EXISTS "referral_redemptions_program_id_invitee_user_id_key" ON "referral_redemptions"("program_id", "invitee_user_id");
CREATE INDEX IF NOT EXISTS "referral_redemptions_program_id_triggered_at_idx" ON "referral_redemptions"("program_id", "triggered_at");
CREATE INDEX IF NOT EXISTS "referral_redemptions_inviter_user_id_idx" ON "referral_redemptions"("inviter_user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_codes_program_id_fkey') THEN
    ALTER TABLE "referral_codes"
      ADD CONSTRAINT "referral_codes_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_codes_inviter_user_id_fkey') THEN
    ALTER TABLE "referral_codes"
      ADD CONSTRAINT "referral_codes_inviter_user_id_fkey"
      FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_redemptions_program_id_fkey') THEN
    ALTER TABLE "referral_redemptions"
      ADD CONSTRAINT "referral_redemptions_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_redemptions_inviter_user_id_fkey') THEN
    ALTER TABLE "referral_redemptions"
      ADD CONSTRAINT "referral_redemptions_inviter_user_id_fkey"
      FOREIGN KEY ("inviter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_redemptions_invitee_user_id_fkey') THEN
    ALTER TABLE "referral_redemptions"
      ADD CONSTRAINT "referral_redemptions_invitee_user_id_fkey"
      FOREIGN KEY ("invitee_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

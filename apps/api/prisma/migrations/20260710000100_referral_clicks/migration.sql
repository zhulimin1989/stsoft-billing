-- 邀请链接点击明细表(落地即上报,去重按 program_id + visitor_key)。幂等建表。
CREATE TABLE IF NOT EXISTS "referral_clicks" (
  "id" TEXT NOT NULL,
  "program_id" TEXT NOT NULL,
  "code_id" TEXT,
  "inviter_user_id" TEXT,
  "visitor_key" TEXT NOT NULL,
  "ip" TEXT,
  "country" TEXT,
  "city" TEXT,
  "referrer" TEXT,
  "utm_source" TEXT,
  "utm_medium" TEXT,
  "utm_campaign" TEXT,
  "utm_content" TEXT,
  "click_count" INTEGER NOT NULL DEFAULT 1,
  "first_clicked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_clicked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_clicks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_clicks_program_id_visitor_key_key" ON "referral_clicks"("program_id", "visitor_key");
CREATE INDEX IF NOT EXISTS "referral_clicks_program_id_first_clicked_at_idx" ON "referral_clicks"("program_id", "first_clicked_at");
CREATE INDEX IF NOT EXISTS "referral_clicks_inviter_user_id_idx" ON "referral_clicks"("inviter_user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_clicks_program_id_fkey') THEN
    ALTER TABLE "referral_clicks"
      ADD CONSTRAINT "referral_clicks_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

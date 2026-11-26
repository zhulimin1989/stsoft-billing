-- Phase v2 P1 / PR4: PlanQuotaRule (套餐配额模板绑定)
CREATE TABLE "plan_quota_rules" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_quota_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_quota_rules_plan_id_template_id_key"
    ON "plan_quota_rules"("plan_id", "template_id");

CREATE INDEX "plan_quota_rules_plan_id_is_active_idx"
    ON "plan_quota_rules"("plan_id", "is_active");

CREATE INDEX "plan_quota_rules_template_id_is_active_idx"
    ON "plan_quota_rules"("template_id", "is_active");

ALTER TABLE "plan_quota_rules"
    ADD CONSTRAINT "plan_quota_rules_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_quota_rules"
    ADD CONSTRAINT "plan_quota_rules_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "plan_quota_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "model_route_policies" (
  "id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "route_key" TEXT NOT NULL,
  "primary_model" TEXT,
  "fallback_models" TEXT NOT NULL DEFAULT '[]',
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_route_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_route_policies_plan_id_route_key_key"
  ON "model_route_policies"("plan_id", "route_key");

DO $$
BEGIN
  ALTER TABLE "model_route_policies"
    ADD CONSTRAINT "model_route_policies_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

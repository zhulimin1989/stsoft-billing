-- Type CodingPlan fulfillment and provider/customer entitlement state machines.

UPDATE "coding_plan_provider_entitlements"
SET "status" = 'FAILED'
WHERE "status" NOT IN ('PENDING', 'ACTIVE', 'FAILED', 'EXPIRED', 'CANCELLED');

UPDATE "coding_plan_entitlements"
SET "status" = 'FAILED'
WHERE "status" NOT IN ('PENDING', 'ACTIVE', 'FAILED', 'EXPIRED', 'CANCELLED');

UPDATE "coding_plan_entitlements"
SET "fulfillment_mode" = 'platform_model_package'
WHERE "fulfillment_mode" NOT IN ('platform_model_package', 'provider_resale');

CREATE TYPE "CodingPlanProviderEntitlementStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE "CodingPlanEntitlementStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE "CodingPlanFulfillmentMode" AS ENUM (
  'platform_model_package',
  'provider_resale'
);

ALTER TABLE "coding_plan_provider_entitlements"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "CodingPlanProviderEntitlementStatus"
    USING "status"::"CodingPlanProviderEntitlementStatus",
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

ALTER TABLE "coding_plan_entitlements"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "CodingPlanEntitlementStatus"
    USING "status"::"CodingPlanEntitlementStatus",
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "fulfillment_mode" DROP DEFAULT,
  ALTER COLUMN "fulfillment_mode" TYPE "CodingPlanFulfillmentMode"
    USING "fulfillment_mode"::"CodingPlanFulfillmentMode",
  ALTER COLUMN "fulfillment_mode" SET DEFAULT 'platform_model_package';

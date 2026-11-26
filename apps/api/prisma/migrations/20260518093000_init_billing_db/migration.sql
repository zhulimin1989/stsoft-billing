-- Clean baseline for ruidong_billing
-- Generated from the current Prisma datamodel and filtered to tables owned by this database.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProductBillingMode" AS ENUM ('SUBSCRIPTION', 'PAY_AS_YOU_GO', 'CODING_PLAN');

-- CreateEnum
CREATE TYPE "BundleItemBillingType" AS ENUM ('SUBSCRIPTION', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'FULFILLED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('SUBSCRIPTION', 'BOOSTER_PACK', 'RECHARGE', 'BUNDLE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "PayChannel" AS ENUM ('WECHAT', 'ALIPAY', 'STRIPE', 'BALANCE');

-- CreateEnum
CREATE TYPE "CreditTxType" AS ENUM ('QUOTA_GRANT', 'QUOTA_RESET', 'BONUS_PURCHASE', 'CONSUME', 'REFUND', 'GRANT', 'EXPIRE');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('RECHARGE', 'CONSUME', 'ADJUST', 'REFUND');

-- CreateEnum
CREATE TYPE "UsagePricingPolicyScope" AS ENUM ('GLOBAL', 'SEGMENT', 'USER');

-- CreateEnum
CREATE TYPE "SegmentRuleType" AS ENUM ('STATIC', 'DYNAMIC');

-- CreateEnum
CREATE TYPE "RechargeBonusType" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "GrantTriggerType" AS ENUM ('DAILY_CRON', 'FIRST_LOGIN', 'DAILY_CHECKIN', 'TASK_COMPLETE', 'WEEKLY_CRON');

-- CreateEnum
CREATE TYPE "GrantRewardType" AS ENUM ('CREDIT', 'BALANCE', 'BOOSTER_PACK');

-- CreateEnum
CREATE TYPE "GrantExpirePolicy" AS ENUM ('PERMANENT', 'SAME_DAY_END', 'N_DAYS', 'NEXT_RESET');

-- CreateEnum
CREATE TYPE "GrantNotifyType" AS ENUM ('INAPP', 'EMAIL', 'SMS', 'NONE');

-- CreateEnum
CREATE TYPE "AlertEventCategory" AS ENUM ('PAYMENT', 'CHANNEL', 'USAGE', 'SECURITY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AlertEventSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AlertEventStatus" AS ENUM ('PENDING', 'READ', 'HANDLED');

-- CreateEnum
CREATE TYPE "CreditPolicyScope" AS ENUM ('GLOBAL', 'SEGMENT');

-- CreateEnum
CREATE TYPE "CreditPolicyTriggerAction" AS ENUM ('SUSPEND', 'ALERT', 'EMAIL');

-- CreateEnum
CREATE TYPE "CreditPolicyRecoveryCondition" AS ENUM ('ON_RECHARGE', 'AFTER_DAYS', 'MANUAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "external_id" TEXT,
    "last_login_at" TIMESTAMP(3),
    "current_tenant_id" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "type" TEXT NOT NULL DEFAULT 'personal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "owner_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_product_entitlements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'system',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_product_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "icon" TEXT,
    "webhook_url" TEXT,
    "default_plan_id" TEXT,
    "integration_token_hash" TEXT,
    "integration_token_prefix" TEXT,
    "integration_token_rotated_at" TIMESTAMP(3),
    "webhook_secret_encrypted" TEXT,
    "webhook_secret_prefix" TEXT,
    "webhook_secret_rotated_at" TIMESTAMP(3),
    "billing_mode" "ProductBillingMode" NOT NULL DEFAULT 'SUBSCRIPTION',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "plan_type" TEXT NOT NULL DEFAULT 'individual',
    "monthly_price" INTEGER NOT NULL DEFAULT 0,
    "quarterly_price" INTEGER NOT NULL DEFAULT 0,
    "yearly_price" INTEGER NOT NULL DEFAULT 0,
    "billing_period" TEXT NOT NULL DEFAULT 'monthly',
    "monthly_credits" INTEGER NOT NULL DEFAULT 0,
    "credits_rollover" BOOLEAN NOT NULL DEFAULT false,
    "rollover_max_months" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_rpm" INTEGER NOT NULL DEFAULT 60,
    "rate_limit_tpm" INTEGER NOT NULL DEFAULT 100000,
    "max_context_window" INTEGER NOT NULL DEFAULT 200000,
    "overage_enabled" BOOLEAN NOT NULL DEFAULT false,
    "usage_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "member_limit" INTEGER NOT NULL DEFAULT 1,
    "minimum_seats" INTEGER NOT NULL DEFAULT 1,
    "data_training" TEXT NOT NULL DEFAULT 'opt_out',
    "support_tier" TEXT NOT NULL DEFAULT 'community',
    "sso_enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority_access" BOOLEAN NOT NULL DEFAULT false,
    "badge" TEXT,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "validity_days" INTEGER NOT NULL DEFAULT 30,
    "features" TEXT NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_legacy" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_prices" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "monthly_price" INTEGER NOT NULL,
    "quarterly_price" INTEGER NOT NULL DEFAULT 0,
    "yearly_price" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booster_packs" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "credits_amount" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "expiry_days" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "booster_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_skus" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "billing_period" TEXT NOT NULL DEFAULT 'yearly',
    "amount_cents" INTEGER NOT NULL,
    "original_amount_cents" INTEGER,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "max_uses_per_user" INTEGER NOT NULL DEFAULT 0,
    "max_uses_total" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundle_skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_sku_items" (
    "id" TEXT NOT NULL,
    "bundle_sku_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "booster_pack_id" TEXT,
    "billing_type" "BundleItemBillingType" NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "unit_amount_cents" INTEGER NOT NULL,
    "original_unit_amount_cents" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "recurring_interval" TEXT,
    "validity_days" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundle_sku_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_period" TEXT NOT NULL DEFAULT 'monthly',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "order_type" "OrderType" NOT NULL DEFAULT 'SUBSCRIPTION',
    "bundle_sku_id" TEXT,
    "product_id" TEXT,
    "plan_id" TEXT,
    "booster_pack_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "PayChannel",
    "trade_no" TEXT,
    "payment_provider_instance_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "refund_reason" TEXT,
    "client_ip" TEXT,
    "expired_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "idempotency_key" TEXT,
    "refund_amount_cents" INTEGER,
    "campaign_id" TEXT,
    "discount_code_id" TEXT,
    "original_amount_cents" INTEGER,
    "discount_amount_cents" INTEGER,
    "billing_period" TEXT,
    "proration_credit_cents" INTEGER,
    "proration_source_plan_id" TEXT,
    "proration_remaining_credits" INTEGER,
    "proration_monthly_credits" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_audit_logs" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'system',
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "bundle_sku_id" TEXT,
    "bundle_sku_item_id" TEXT,
    "product_id" TEXT,
    "plan_id" TEXT,
    "booster_pack_id" TEXT,
    "billing_type" "BundleItemBillingType" NOT NULL,
    "name" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "original_amount_cents" INTEGER,
    "discount_amount_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "recurring_interval" TEXT,
    "validity_days" INTEGER,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "fulfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_provider_instances" (
    "id" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "supported_types" TEXT NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "daily_limit_cents" INTEGER NOT NULL DEFAULT 0,
    "strategy" TEXT NOT NULL DEFAULT 'round_robin',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "CreditTxType" NOT NULL,
    "credits_amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "subscription_id" TEXT,
    "tenant_id" TEXT,
    "product_id" TEXT,
    "model_name" TEXT,
    "input_tokens" INTEGER,
    "cached_input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "request_id" TEXT,
    "quota_after" INTEGER NOT NULL DEFAULT 0,
    "bonus_after" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "expires_at" TIMESTAMP(3),
    "grant_rule_id" TEXT,
    "is_expired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount_usd" DECIMAL(20,12) NOT NULL,
    "balance_after_usd" DECIMAL(20,12) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "order_id" TEXT,
    "product_id" TEXT,
    "token_usage_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_wallets" (
    "user_id" TEXT NOT NULL,
    "balance_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "tenant_wallets" (
    "tenant_id" TEXT NOT NULL,
    "balance_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_wallets_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "product_id" TEXT,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "allowed_models" TEXT,
    "budget_usd" DECIMAL(20,12),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "product_id" TEXT,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "cached_input_tokens" INTEGER,
    "cache_write_input_tokens" INTEGER,
    "completion_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "input_price_usd_per_m" DECIMAL(18,8) NOT NULL,
    "cached_input_price_usd_per_m" DECIMAL(18,8),
    "cache_write_price_usd_per_m" DECIMAL(18,8),
    "output_price_usd_per_m" DECIMAL(18,8) NOT NULL,
    "cost_usd" DECIMAL(20,12) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "models" TEXT NOT NULL DEFAULT '[]',
    "model_configs" TEXT,
    "sdk_type" TEXT NOT NULL DEFAULT 'openai_completions',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "max_rpm" INTEGER,
    "max_tpm" INTEGER,
    "success_rate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "total_errors" INTEGER NOT NULL DEFAULT 0,
    "avg_latency_ms" DOUBLE PRECISION,
    "remark" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '{}',
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_access" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "credit_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "model_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_pricing" (
    "id" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "input_price_per_m_token" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "output_price_per_m_token" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "provider" TEXT,
    "model_id" TEXT,
    "description" TEXT,
    "input_modalities" TEXT,
    "output_modalities" TEXT,
    "context_length" INTEGER,
    "max_output_tokens" INTEGER,
    "provider_logo" TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "release_at" TIMESTAMP(3),
    "tags" TEXT,
    "supported_features" TEXT,
    "cached_input_price_cents" DECIMAL(18,8),
    "batch_discount" DOUBLE PRECISION,
    "cache_write_5min_price_cents" DECIMAL(18,8),
    "cache_write_1h_price_cents" DECIMAL(18,8),
    "min_cache_tokens" INTEGER,
    "long_context_threshold" INTEGER,
    "long_context_input_price_cents" DECIMAL(18,8),
    "long_context_output_price_cents" DECIMAL(18,8),
    "audio_input_price_cents" DECIMAL(18,8),
    "image_input_price_cents" DECIMAL(18,8),
    "image_output_price_cents" DECIMAL(18,8),
    "reasoning_output_price_cents" DECIMAL(18,8),
    "fast_mode_multiplier" DOUBLE PRECISION,
    "region_residency_multiplier" DOUBLE PRECISION,
    "off_peak_discount_pct" DOUBLE PRECISION,
    "pricing_source" TEXT,
    "pricing_synced_at" TIMESTAMP(3),
    "pricing_frozen" BOOLEAN NOT NULL DEFAULT false,
    "batch_input_discount" DOUBLE PRECISION,
    "batch_output_discount" DOUBLE PRECISION,
    "default_thinking_mode" TEXT,
    "default_thinking_budget" INTEGER,

    CONSTRAINT "model_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payg_model_pricing_policies" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "price_multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "input_price_per_m_token" DECIMAL(18,8),
    "cached_input_price" DECIMAL(18,8),
    "cache_write_price" DECIMAL(18,8),
    "output_price_per_m_token" DECIMAL(18,8),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payg_model_pricing_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_pricing_policies" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "scope" "UsagePricingPolicyScope" NOT NULL,
    "user_id" TEXT,
    "segment_id" TEXT,
    "model_name" TEXT,
    "price_multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "credit_multiplier" DECIMAL(10,4),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_pricing_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "user_id" TEXT,
    "result" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMMITTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "gateway_billing_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "event_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "reason" TEXT,
    "api_key_id" TEXT,
    "tenant_id" TEXT,
    "user_id" TEXT,
    "product_id" TEXT,
    "product_slug" TEXT,
    "model_name" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "idempotency_key" TEXT,
    "billing_unit" TEXT,
    "raw_event" JSONB NOT NULL,
    "billing_result" JSONB,
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_sync_jobs" (
    "id" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "idempotency_key" TEXT NOT NULL,
    "request_id" TEXT,
    "source" TEXT,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "last_error" TEXT,
    "response" JSONB,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "plan_id" TEXT,
    "bundle_sku_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL,
    "first_time_only" BOOLEAN NOT NULL DEFAULT false,
    "billing_period" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "max_uses_per_user" INTEGER NOT NULL DEFAULT 1,
    "max_uses_total" INTEGER NOT NULL DEFAULT 0,
    "stripe_coupon_ids" TEXT NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_prices" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "monthly_price" INTEGER NOT NULL,
    "quarterly_price" INTEGER NOT NULL DEFAULT 0,
    "yearly_price" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_redemptions" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount_saved_cents" INTEGER NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "discount_type" TEXT NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "currency" TEXT,
    "duration" TEXT NOT NULL DEFAULT 'once',
    "duration_months" INTEGER,
    "plan_ids" TEXT NOT NULL DEFAULT '[]',
    "first_time_only" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "max_uses" INTEGER NOT NULL DEFAULT 0,
    "max_uses_per_user" INTEGER NOT NULL DEFAULT 1,
    "current_uses" INTEGER NOT NULL DEFAULT 0,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "stripe_coupon_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_code_redemptions" (
    "id" TEXT NOT NULL,
    "discount_code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount_saved_cents" INTEGER NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "payload" JSONB,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_segments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ruleType" "SegmentRuleType" NOT NULL,
    "rule_expr" TEXT,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_segment_members" (
    "id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_segment_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_quota_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "rules" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "plan_quota_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recharge_tiers" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "bonus_type" "RechargeBonusType" NOT NULL,
    "bonus_value" INTEGER NOT NULL,
    "badge" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "recharge_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_grant_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger_type" "GrantTriggerType" NOT NULL,
    "cron_expr" TEXT,
    "segment_id" TEXT,
    "reward_type" "GrantRewardType" NOT NULL,
    "reward_amount" INTEGER NOT NULL,
    "product_id" TEXT,
    "expire_policy" "GrantExpirePolicy" NOT NULL,
    "expire_days" INTEGER,
    "per_user_limit" INTEGER NOT NULL DEFAULT 1,
    "global_daily_cap" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "notify_type" "GrantNotifyType",
    "notify_template" TEXT,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "credit_grant_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_redemptions" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "used_amount" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "is_expired" BOOLEAN NOT NULL DEFAULT false,
    "is_used_up" BOOLEAN NOT NULL DEFAULT false,
    "tx_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "category" "AlertEventCategory" NOT NULL,
    "severity" "AlertEventSeverity" NOT NULL,
    "status" "AlertEventStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source_type" TEXT,
    "source_id" TEXT,
    "user_id" TEXT,
    "context" TEXT NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "handled_at" TIMESTAMP(3),
    "handled_by" TEXT,
    "handle_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_policies" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "scope" "CreditPolicyScope" NOT NULL,
    "segment_id" TEXT,
    "allow_overdraft" BOOLEAN NOT NULL DEFAULT false,
    "default_credit_limit_cents" INTEGER NOT NULL DEFAULT 0,
    "trigger_action" "CreditPolicyTriggerAction" NOT NULL DEFAULT 'SUSPEND',
    "recovery_condition" "CreditPolicyRecoveryCondition" NOT NULL DEFAULT 'ON_RECHARGE',
    "recovery_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_current_tenant_id_idx" ON "users"("current_tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_owner_user_id_idx" ON "tenants"("owner_user_id");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenant_members_user_id_idx" ON "tenant_members"("user_id");

-- CreateIndex
CREATE INDEX "tenant_members_tenant_id_role_idx" ON "tenant_members"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenant_id_user_id_key" ON "tenant_members"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "tenant_product_entitlements_product_id_status_idx" ON "tenant_product_entitlements"("product_id", "status");

-- CreateIndex
CREATE INDEX "tenant_product_entitlements_tenant_id_status_idx" ON "tenant_product_entitlements"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_product_entitlements_tenant_id_product_id_key" ON "tenant_product_entitlements"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_integration_token_hash_key" ON "products"("integration_token_hash");

-- CreateIndex
CREATE INDEX "products_billing_mode_is_active_deleted_at_idx" ON "products"("billing_mode", "is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "products_deleted_at_idx" ON "products"("deleted_at");

-- CreateIndex
CREATE INDEX "plans_product_id_idx" ON "plans"("product_id");

-- CreateIndex
CREATE INDEX "plans_plan_type_idx" ON "plans"("plan_type");

-- CreateIndex
CREATE INDEX "plan_prices_currency_idx" ON "plan_prices"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "plan_prices_plan_id_currency_key" ON "plan_prices"("plan_id", "currency");

-- CreateIndex
CREATE INDEX "booster_packs_is_active_deleted_at_idx" ON "booster_packs"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "booster_packs_deleted_at_idx" ON "booster_packs"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_skus_code_key" ON "bundle_skus"("code");

-- CreateIndex
CREATE INDEX "bundle_skus_is_active_start_at_end_at_idx" ON "bundle_skus"("is_active", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "bundle_sku_items_bundle_sku_id_sort_order_idx" ON "bundle_sku_items"("bundle_sku_id", "sort_order");

-- CreateIndex
CREATE INDEX "bundle_sku_items_product_id_idx" ON "bundle_sku_items"("product_id");

-- CreateIndex
CREATE INDEX "bundle_sku_items_plan_id_idx" ON "bundle_sku_items"("plan_id");

-- CreateIndex
CREATE INDEX "bundle_sku_items_booster_pack_id_idx" ON "bundle_sku_items"("booster_pack_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_tenant_id_idx" ON "user_subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "user_subscriptions_plan_id_idx" ON "user_subscriptions"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscriptions_user_id_product_id_key" ON "user_subscriptions"("user_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscriptions_tenant_id_product_id_key" ON "user_subscriptions"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_trade_no_key" ON "orders"("trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_idx" ON "orders"("tenant_id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_idx" ON "orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "orders_bundle_sku_id_idx" ON "orders"("bundle_sku_id");

-- CreateIndex
CREATE INDEX "orders_product_id_idx" ON "orders"("product_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_channel_idx" ON "orders"("channel");

-- CreateIndex
CREATE INDEX "orders_order_type_idx" ON "orders"("order_type");

-- CreateIndex
CREATE INDEX "orders_payment_provider_instance_id_idx" ON "orders"("payment_provider_instance_id");

-- CreateIndex
CREATE INDEX "order_audit_logs_order_id_idx" ON "order_audit_logs"("order_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_bundle_sku_id_idx" ON "order_items"("bundle_sku_id");

-- CreateIndex
CREATE INDEX "order_items_bundle_sku_item_id_idx" ON "order_items"("bundle_sku_item_id");

-- CreateIndex
CREATE INDEX "order_items_product_id_idx" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "order_items_plan_id_idx" ON "order_items"("plan_id");

-- CreateIndex
CREATE INDEX "order_items_booster_pack_id_idx" ON "order_items"("booster_pack_id");

-- CreateIndex
CREATE INDEX "order_items_billing_type_idx" ON "order_items"("billing_type");

-- CreateIndex
CREATE INDEX "payment_provider_instances_provider_key_idx" ON "payment_provider_instances"("provider_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_idempotency_key_key" ON "credit_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_transactions_user_id_idx" ON "credit_transactions"("user_id");

-- CreateIndex
CREATE INDEX "credit_transactions_tenant_id_idx" ON "credit_transactions"("tenant_id");

-- CreateIndex
CREATE INDEX "credit_transactions_product_id_idx" ON "credit_transactions"("product_id");

-- CreateIndex
CREATE INDEX "credit_transactions_subscription_id_idx" ON "credit_transactions"("subscription_id");

-- CreateIndex
CREATE INDEX "credit_transactions_type_idx" ON "credit_transactions"("type");

-- CreateIndex
CREATE INDEX "credit_transactions_created_at_idx" ON "credit_transactions"("created_at");

-- CreateIndex
CREATE INDEX "credit_transactions_product_id_created_at_idx" ON "credit_transactions"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_transactions_user_id_expires_at_is_expired_idx" ON "credit_transactions"("user_id", "expires_at", "is_expired");

-- CreateIndex
CREATE INDEX "credit_transactions_grant_rule_id_idx" ON "credit_transactions"("grant_rule_id");

-- CreateIndex
CREATE INDEX "credit_transactions_user_id_created_at_idx" ON "credit_transactions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "balance_transactions_token_usage_id_key" ON "balance_transactions"("token_usage_id");

-- CreateIndex
CREATE INDEX "balance_transactions_user_id_idx" ON "balance_transactions"("user_id");

-- CreateIndex
CREATE INDEX "balance_transactions_tenant_id_idx" ON "balance_transactions"("tenant_id");

-- CreateIndex
CREATE INDEX "balance_transactions_tenant_id_created_at_idx" ON "balance_transactions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "balance_transactions_product_id_idx" ON "balance_transactions"("product_id");

-- CreateIndex
CREATE INDEX "balance_transactions_type_idx" ON "balance_transactions"("type");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys"("tenant_id");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_product_id_idx" ON "api_keys"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "api_keys_product_id_idx" ON "api_keys"("product_id");

-- CreateIndex
CREATE INDEX "token_usage_api_key_id_idx" ON "token_usage"("api_key_id");

-- CreateIndex
CREATE INDEX "token_usage_tenant_id_idx" ON "token_usage"("tenant_id");

-- CreateIndex
CREATE INDEX "token_usage_product_id_idx" ON "token_usage"("product_id");

-- CreateIndex
CREATE INDEX "token_usage_model_idx" ON "token_usage"("model");

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_key_key" ON "system_configs"("key");

-- CreateIndex
CREATE UNIQUE INDEX "model_access_plan_id_model_name_key" ON "model_access"("plan_id", "model_name");

-- CreateIndex
CREATE UNIQUE INDEX "model_pricing_model_name_key" ON "model_pricing"("model_name");

-- CreateIndex
CREATE INDEX "model_pricing_provider_is_published_idx" ON "model_pricing"("provider", "is_published");

-- CreateIndex
CREATE INDEX "model_pricing_display_order_idx" ON "model_pricing"("display_order");

-- CreateIndex
CREATE INDEX "payg_model_pricing_policies_product_id_is_active_idx" ON "payg_model_pricing_policies"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "payg_model_pricing_policies_model_name_idx" ON "payg_model_pricing_policies"("model_name");

-- CreateIndex
CREATE UNIQUE INDEX "payg_model_pricing_policies_product_id_model_name_key" ON "payg_model_pricing_policies"("product_id", "model_name");

-- CreateIndex
CREATE INDEX "usage_pricing_policies_product_id_is_active_idx" ON "usage_pricing_policies"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "usage_pricing_policies_scope_user_id_idx" ON "usage_pricing_policies"("scope", "user_id");

-- CreateIndex
CREATE INDEX "usage_pricing_policies_scope_segment_id_idx" ON "usage_pricing_policies"("scope", "segment_id");

-- CreateIndex
CREATE INDEX "usage_pricing_policies_model_name_idx" ON "usage_pricing_policies"("model_name");

-- CreateIndex
CREATE INDEX "idempotency_keys_scope_created_at_idx" ON "idempotency_keys"("scope", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_billing_events_request_id_key" ON "gateway_billing_events"("request_id");

-- CreateIndex
CREATE INDEX "gateway_billing_events_status_created_at_idx" ON "gateway_billing_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "gateway_billing_events_api_key_id_created_at_idx" ON "gateway_billing_events"("api_key_id", "created_at");

-- CreateIndex
CREATE INDEX "gateway_billing_events_tenant_id_created_at_idx" ON "gateway_billing_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "gateway_billing_events_user_id_created_at_idx" ON "gateway_billing_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "gateway_billing_events_product_id_created_at_idx" ON "gateway_billing_events"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "gateway_billing_events_model_name_created_at_idx" ON "gateway_billing_events"("model_name", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_sync_jobs_idempotency_key_key" ON "publisher_sync_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "publisher_sync_jobs_status_next_run_at_idx" ON "publisher_sync_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "publisher_sync_jobs_namespace_status_idx" ON "publisher_sync_jobs"("namespace", "status");

-- CreateIndex
CREATE INDEX "publisher_sync_jobs_resource_type_resource_id_idx" ON "publisher_sync_jobs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "publisher_sync_jobs_created_at_idx" ON "publisher_sync_jobs"("created_at");

-- CreateIndex
CREATE INDEX "campaigns_plan_id_is_active_start_at_end_at_idx" ON "campaigns"("plan_id", "is_active", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "campaigns_bundle_sku_id_is_active_start_at_end_at_idx" ON "campaigns"("bundle_sku_id", "is_active", "start_at", "end_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_prices_campaign_id_currency_key" ON "campaign_prices"("campaign_id", "currency");

-- CreateIndex
CREATE INDEX "campaign_redemptions_campaign_id_user_id_idx" ON "campaign_redemptions"("campaign_id", "user_id");

-- CreateIndex
CREATE INDEX "campaign_redemptions_order_id_idx" ON "campaign_redemptions"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "discount_codes_code_key" ON "discount_codes"("code");

-- CreateIndex
CREATE INDEX "discount_codes_code_is_active_idx" ON "discount_codes"("code", "is_active");

-- CreateIndex
CREATE INDEX "discount_code_redemptions_discount_code_id_user_id_idx" ON "discount_code_redemptions"("discount_code_id", "user_id");

-- CreateIndex
CREATE INDEX "discount_code_redemptions_order_id_idx" ON "discount_code_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "stripe_events_type_received_at_idx" ON "stripe_events"("type", "received_at");

-- CreateIndex
CREATE INDEX "user_segments_is_active_deleted_at_idx" ON "user_segments"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "user_segment_members_segment_id_idx" ON "user_segment_members"("segment_id");

-- CreateIndex
CREATE INDEX "user_segment_members_user_id_idx" ON "user_segment_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_segment_members_segment_id_user_id_key" ON "user_segment_members"("segment_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_quota_templates_name_key" ON "plan_quota_templates"("name");

-- CreateIndex
CREATE INDEX "plan_quota_templates_is_active_deleted_at_idx" ON "plan_quota_templates"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "recharge_tiers_product_id_is_active_idx" ON "recharge_tiers"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "recharge_tiers_start_at_end_at_idx" ON "recharge_tiers"("start_at", "end_at");

-- CreateIndex
CREATE INDEX "recharge_tiers_deleted_at_idx" ON "recharge_tiers"("deleted_at");

-- CreateIndex
CREATE INDEX "credit_grant_rules_is_active_trigger_type_idx" ON "credit_grant_rules"("is_active", "trigger_type");

-- CreateIndex
CREATE INDEX "credit_grant_rules_deleted_at_idx" ON "credit_grant_rules"("deleted_at");

-- CreateIndex
CREATE INDEX "grant_redemptions_rule_id_created_at_idx" ON "grant_redemptions"("rule_id", "created_at");

-- CreateIndex
CREATE INDEX "grant_redemptions_user_id_expires_at_idx" ON "grant_redemptions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "grant_redemptions_user_id_is_expired_is_used_up_idx" ON "grant_redemptions"("user_id", "is_expired", "is_used_up");

-- CreateIndex
CREATE INDEX "alert_events_category_status_created_at_idx" ON "alert_events"("category", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alert_events_severity_status_created_at_idx" ON "alert_events"("severity", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alert_events_user_id_created_at_idx" ON "alert_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alert_events_status_created_at_idx" ON "alert_events"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "credit_policies_product_id_idx" ON "credit_policies"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_policies_product_id_scope_segment_id_key" ON "credit_policies"("product_id", "scope", "segment_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_current_tenant_id_fkey" FOREIGN KEY ("current_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_product_entitlements" ADD CONSTRAINT "tenant_product_entitlements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_product_entitlements" ADD CONSTRAINT "tenant_product_entitlements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_product_entitlements" ADD CONSTRAINT "tenant_product_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booster_packs" ADD CONSTRAINT "booster_packs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_sku_items" ADD CONSTRAINT "bundle_sku_items_bundle_sku_id_fkey" FOREIGN KEY ("bundle_sku_id") REFERENCES "bundle_skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_sku_items" ADD CONSTRAINT "bundle_sku_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_sku_items" ADD CONSTRAINT "bundle_sku_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_sku_items" ADD CONSTRAINT "bundle_sku_items_booster_pack_id_fkey" FOREIGN KEY ("booster_pack_id") REFERENCES "booster_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_bundle_sku_id_fkey" FOREIGN KEY ("bundle_sku_id") REFERENCES "bundle_skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_booster_pack_id_fkey" FOREIGN KEY ("booster_pack_id") REFERENCES "booster_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_code_id_fkey" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_audit_logs" ADD CONSTRAINT "order_audit_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_sku_id_fkey" FOREIGN KEY ("bundle_sku_id") REFERENCES "bundle_skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_sku_item_id_fkey" FOREIGN KEY ("bundle_sku_item_id") REFERENCES "bundle_sku_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_booster_pack_id_fkey" FOREIGN KEY ("booster_pack_id") REFERENCES "booster_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_token_usage_id_fkey" FOREIGN KEY ("token_usage_id") REFERENCES "token_usage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_wallets" ADD CONSTRAINT "tenant_wallets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_access" ADD CONSTRAINT "model_access_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payg_model_pricing_policies" ADD CONSTRAINT "payg_model_pricing_policies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_pricing_policies" ADD CONSTRAINT "usage_pricing_policies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_pricing_policies" ADD CONSTRAINT "usage_pricing_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_pricing_policies" ADD CONSTRAINT "usage_pricing_policies_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "user_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_bundle_sku_id_fkey" FOREIGN KEY ("bundle_sku_id") REFERENCES "bundle_skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prices" ADD CONSTRAINT "campaign_prices_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_discount_code_id_fkey" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_segment_members" ADD CONSTRAINT "user_segment_members_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "user_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_segment_members" ADD CONSTRAINT "user_segment_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recharge_tiers" ADD CONSTRAINT "recharge_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_grant_rules" ADD CONSTRAINT "credit_grant_rules_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "user_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_redemptions" ADD CONSTRAINT "grant_redemptions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "credit_grant_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_redemptions" ADD CONSTRAINT "grant_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_policies" ADD CONSTRAINT "credit_policies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_policies" ADD CONSTRAINT "credit_policies_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "user_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

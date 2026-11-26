-- 发票申请系统：抬头、申请、占用项、按月号段、状态日志
-- 事实源：Order + BalanceGrant + BalanceConsumptionAllocation；
-- 可开票 = min(订单本金, 已消费本金) - 已被 PENDING_REVIEW/APPROVED_ISSUING/ISSUED 占用的金额；
-- 发票号格式 102ISSHK + YYYY + MM + 3 位顺序号。

-- CreateEnum
CREATE TYPE "InvoiceApplicationStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED_ISSUING', 'ISSUED', 'REJECTED', 'CANCELLED', 'FAILED', 'VOIDED', 'RED_OFFSET');

-- CreateEnum
CREATE TYPE "InvoiceProfileKind" AS ENUM ('PERSONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('VAT_NORMAL', 'VAT_SPECIAL', 'COMMERCIAL_HK');

-- CreateEnum
CREATE TYPE "InvoiceLineDescription" AS ENUM ('RAYTONE_API', 'TOKEN_PLAN');

-- CreateEnum
CREATE TYPE "InvoiceActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateTable
CREATE TABLE "invoice_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "InvoiceProfileKind" NOT NULL,
    "invoice_type" "InvoiceType" NOT NULL,
    "title" TEXT NOT NULL,
    "tax_no" TEXT,
    "bank_name" TEXT,
    "bank_account" TEXT,
    "registered_address" TEXT,
    "registered_phone" TEXT,
    "recipient_name" TEXT,
    "recipient_email" TEXT,
    "recipient_phone" TEXT,
    "recipient_address" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "invoice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_applications" (
    "id" TEXT NOT NULL,
    "application_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "profile_id" TEXT,
    "profile_snapshot" JSONB NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "status" "InvoiceApplicationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "issuing_entity" TEXT,
    "invoice_number" TEXT,
    "issue_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "pdf_url" TEXT,
    "ofd_url" TEXT,
    "reject_reason" TEXT,
    "void_reason" TEXT,
    "failed_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_application_items" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "principal_cents" INTEGER NOT NULL,
    "description" "InvoiceLineDescription" NOT NULL,
    "service_start" TIMESTAMP(3),
    "service_end" TIMESTAMP(3),
    "po_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_application_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_number_sequences" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "next_seq" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_event_log" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "from_status" "InvoiceApplicationStatus",
    "to_status" "InvoiceApplicationStatus" NOT NULL,
    "actor_type" "InvoiceActorType" NOT NULL,
    "actor_id" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_profiles_user_id_deleted_at_idx" ON "invoice_profiles"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX "invoice_profiles_tenant_id_deleted_at_idx" ON "invoice_profiles"("tenant_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_applications_application_no_key" ON "invoice_applications"("application_no");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_applications_invoice_number_key" ON "invoice_applications"("invoice_number");

-- CreateIndex
CREATE INDEX "invoice_applications_user_id_status_idx" ON "invoice_applications"("user_id", "status");

-- CreateIndex
CREATE INDEX "invoice_applications_tenant_id_status_idx" ON "invoice_applications"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "invoice_applications_status_created_at_idx" ON "invoice_applications"("status", "created_at");

-- CreateIndex
CREATE INDEX "invoice_application_items_order_id_idx" ON "invoice_application_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_application_items_application_id_order_id_key" ON "invoice_application_items"("application_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_sequences_entity_year_month_key" ON "invoice_number_sequences"("entity", "year", "month");

-- CreateIndex
CREATE INDEX "invoice_event_log_application_id_occurred_at_idx" ON "invoice_event_log"("application_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "invoice_profiles" ADD CONSTRAINT "invoice_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_profiles" ADD CONSTRAINT "invoice_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_applications" ADD CONSTRAINT "invoice_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_applications" ADD CONSTRAINT "invoice_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_applications" ADD CONSTRAINT "invoice_applications_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "invoice_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_application_items" ADD CONSTRAINT "invoice_application_items_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "invoice_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_application_items" ADD CONSTRAINT "invoice_application_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_event_log" ADD CONSTRAINT "invoice_event_log_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "invoice_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

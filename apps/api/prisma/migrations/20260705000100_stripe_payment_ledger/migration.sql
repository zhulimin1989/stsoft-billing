-- CreateTable
CREATE TABLE "stripe_payment_ledgers" (
    "id" TEXT NOT NULL,
    "order_id" TEXT,
    "payment_provider_instance_id" TEXT,
    "transaction_type" TEXT NOT NULL DEFAULT 'payment',
    "checkout_session_id" TEXT,
    "subscription_id" TEXT,
    "invoice_id" TEXT,
    "payment_intent_id" TEXT,
    "charge_id" TEXT,
    "refund_id" TEXT,
    "balance_transaction_id" TEXT,
    "payout_id" TEXT,
    "stripe_event_id" TEXT,
    "amount_cents" INTEGER,
    "fee_cents" INTEGER,
    "net_cents" INTEGER,
    "currency" TEXT,
    "stripe_status" TEXT,
    "customer_email" TEXT,
    "stripe_created_at" TIMESTAMP(3),
    "available_on" TIMESTAMP(3),
    "bank_received_date" TIMESTAMP(3),
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stripe_payment_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_payment_ledgers_refund_id_key" ON "stripe_payment_ledgers"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_payment_ledgers_balance_transaction_id_key" ON "stripe_payment_ledgers"("balance_transaction_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_order_id_idx" ON "stripe_payment_ledgers"("order_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_payment_provider_instance_id_idx" ON "stripe_payment_ledgers"("payment_provider_instance_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_transaction_type_idx" ON "stripe_payment_ledgers"("transaction_type");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_checkout_session_id_idx" ON "stripe_payment_ledgers"("checkout_session_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_subscription_id_idx" ON "stripe_payment_ledgers"("subscription_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_invoice_id_idx" ON "stripe_payment_ledgers"("invoice_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_payment_intent_id_idx" ON "stripe_payment_ledgers"("payment_intent_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_charge_id_idx" ON "stripe_payment_ledgers"("charge_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_payout_id_idx" ON "stripe_payment_ledgers"("payout_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_stripe_event_id_idx" ON "stripe_payment_ledgers"("stripe_event_id");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_stripe_created_at_idx" ON "stripe_payment_ledgers"("stripe_created_at");

-- CreateIndex
CREATE INDEX "stripe_payment_ledgers_available_on_idx" ON "stripe_payment_ledgers"("available_on");

-- AddForeignKey
ALTER TABLE "stripe_payment_ledgers" ADD CONSTRAINT "stripe_payment_ledgers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

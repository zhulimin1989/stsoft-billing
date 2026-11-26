BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "invoice_application_items"
  ADD COLUMN "invoice_number" TEXT,
  ADD COLUMN "issuing_entity" TEXT,
  ADD COLUMN "issue_date" TIMESTAMP(3),
  ADD COLUMN "issued_at" TIMESTAMP(3),
  ADD COLUMN "pdf_url" TEXT,
  ADD COLUMN "ofd_url" TEXT,
  ADD COLUMN "psa_form_no" TEXT;

CREATE UNIQUE INDEX "invoice_application_items_invoice_number_key"
  ON "invoice_application_items"("invoice_number");

COMMIT;

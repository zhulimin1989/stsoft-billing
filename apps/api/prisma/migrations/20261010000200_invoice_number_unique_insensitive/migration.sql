BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_applications_invoice_number_lower_key"
  ON "invoice_applications" (lower(btrim("invoice_number")))
  WHERE "invoice_number" IS NOT NULL AND btrim("invoice_number") <> '';

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_application_items_invoice_number_lower_key"
  ON "invoice_application_items" (lower(btrim("invoice_number")))
  WHERE "invoice_number" IS NOT NULL AND btrim("invoice_number") <> '';

COMMIT;

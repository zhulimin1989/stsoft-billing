BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "invoice_applications"
  ADD COLUMN "psa_attachment_url" TEXT;

COMMIT;

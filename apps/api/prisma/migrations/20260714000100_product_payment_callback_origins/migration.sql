ALTER TABLE "products"
ADD COLUMN "allowed_payment_callback_origins" JSONB;

ALTER TABLE "products"
ADD CONSTRAINT "products_allowed_payment_callback_origins_json_array_check"
CHECK (
  "allowed_payment_callback_origins" IS NULL
  OR jsonb_typeof("allowed_payment_callback_origins") = 'array'
);

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'usd';

UPDATE "orders" o
SET "currency" = COALESCE(
  (
    SELECT LOWER(oi."currency")
    FROM "order_items" oi
    WHERE oi."order_id" = o."id"
      AND oi."currency" IS NOT NULL
    ORDER BY oi."created_at" ASC
    LIMIT 1
  ),
  CASE
    WHEN o."channel" IN ('WECHAT', 'ALIPAY') THEN 'cny'
    ELSE 'usd'
  END
)
WHERE o."currency" IS NULL
   OR o."currency" = 'usd';

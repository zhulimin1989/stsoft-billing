-- This gate intentionally follows the additive checkout expansion migration.
-- If it hard-stops, the new receipt columns remain available so operators can
-- prove and backfill exact historical effect ownership before resolving this
-- failed migration as rolled back and retrying migrate deploy.
DO $$
BEGIN
  -- Historical bundle fulfillment did not always persist a reversible link
  -- from an OrderItem to the exact SubscriptionPeriod/CodingPlanEntitlement it
  -- changed. Both effect families are accepted only with an exact tuple match.
  IF EXISTS (
    SELECT 1
    FROM "order_items" oi
    INNER JOIN "orders" o ON o."id" = oi."order_id"
    WHERE o."order_type" = 'BUNDLE'
      AND oi."plan_id" IS NOT NULL
      AND oi."product_id" IS NOT NULL
      AND oi."status" IN (
        'FULFILLED',
        'FULFILLING',
        'COMPENSATING',
        'COMPENSATION_FAILED'
      )
      AND o."status" <> 'REFUNDED'
      AND NOT EXISTS (
        SELECT 1
        FROM "subscription_periods" sp
        WHERE sp."activation_idempotency_key" =
          'bundle:' || o."id" || ':item:' || oi."id" || ':activation'
          AND sp."user_id" = o."user_id"
          AND sp."tenant_id" = o."tenant_id"
          AND sp."product_id" = oi."product_id"
          AND sp."plan_id" = oi."plan_id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "coding_plan_entitlements" cpe
        WHERE cpe."order_id" = oi."id"
          AND cpe."user_id" = o."user_id"
          AND cpe."tenant_id" = o."tenant_id"
          AND cpe."product_id" = oi."product_id"
          AND cpe."plan_id" = oi."plan_id"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE =
        'partner OpenAPI hardening blocked: unresolved historical bundle plan effects; run the documented zero-row preflight and reconcile before retrying',
      HINT =
        'After reconciliation, mark this preflight migration rolled back and retry migrate deploy; the preceding expansion migration remains committed.';
  END IF;

  -- Only states that can durably contain a fulfilled effect participate.
  -- PENDING/FAILED/CANCELLED/EXPIRED orders must not be associated with an
  -- unrelated active period merely because tenant/product/plan happen to match.
  IF EXISTS (
    SELECT 1
    FROM "subscription_periods" sp
    WHERE sp."status" = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM "orders" candidate
        WHERE candidate."order_type" = 'SUBSCRIPTION'
          AND candidate."user_id" = sp."user_id"
          AND candidate."tenant_id" = sp."tenant_id"
          AND candidate."product_id" = sp."product_id"
          AND candidate."plan_id" = sp."plan_id"
          AND candidate."status" IN (
            'PAID',
            'FULFILLING',
            'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
            'COMPLETED',
            'REFUNDING',
            'REFUND_FAILED',
            'REFUND_COMPENSATION_FAILED'
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "orders" owner_order
        WHERE owner_order."order_type" = 'SUBSCRIPTION'
          AND owner_order."user_id" = sp."user_id"
          AND owner_order."tenant_id" = sp."tenant_id"
          AND owner_order."product_id" = sp."product_id"
          AND owner_order."plan_id" = sp."plan_id"
          AND owner_order."status" IN (
            'PAID',
            'FULFILLING',
            'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
            'COMPLETED',
            'REFUNDING',
            'REFUND_FAILED',
            'REFUND_COMPENSATION_FAILED'
          )
          AND (
            sp."activation_idempotency_key" =
              'checkout:' || owner_order."id" || ':activation'
            OR (
              LEFT(
                sp."activation_idempotency_key",
                CHAR_LENGTH(
                  'stripe-renewal:' || owner_order."id" || ':invoice:'
                )
              ) = 'stripe-renewal:' || owner_order."id" || ':invoice:'
              AND SUBSTRING(
                sp."activation_idempotency_key"
                FROM CHAR_LENGTH(
                  'stripe-renewal:' || owner_order."id" || ':invoice:'
                ) + 1
              ) ~ '^in_[A-Za-z0-9]+:order$'
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE =
        'partner OpenAPI hardening blocked: active historical subscription orders lack exact checkout activation receipts; prove and backfill exact order-period ownership or reconcile before retrying',
      HINT =
        'After reconciliation, mark this preflight migration rolled back and retry migrate deploy; the preceding expansion migration remains committed.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "refund_compensation_tasks" rct
    INNER JOIN "orders" o ON o."id" = rct."order_id"
    WHERE (
        (
          rct."action" = 'CANCEL_SUBSCRIPTION'
          AND COALESCE(
            rct."payload" ->> 'activationIdempotencyKey',
            rct."payload" ->> 'initialActivationIdempotencyKey',
            ''
          ) = ''
        )
        OR (
          rct."action" = 'CREDIT_DEDUCT'
          AND (
            COALESCE(rct."payload" ->> 'subscriptionId', '') = ''
            OR COALESCE(rct."payload" ->> 'bucket', '') = ''
            OR COALESCE(
              rct."payload" ->> 'originalGrantIdempotencyKey',
              ''
            ) = ''
          )
        )
      )
      AND rct."status" <> 'SUCCEEDED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE =
        'partner OpenAPI hardening blocked: legacy refund compensation tasks lack exact effect anchors; reconcile or retire them before retrying',
      HINT =
        'After reconciliation, mark this preflight migration rolled back and retry migrate deploy; the preceding expansion migration remains committed.';
  END IF;
END
$$;

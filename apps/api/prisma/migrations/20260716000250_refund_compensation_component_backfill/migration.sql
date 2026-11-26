-- Classify the component of recharge refund-compensation tasks created before
-- refundComponent became mandatory. Historical writers used either
-- {description} or {description,billingAccountId}; both are accepted only when
-- the task columns and optional account snapshot agree with the immutable order.
--
-- Deploy with synchronous refund entry points and refund-compensation workers
-- drained. The table lock gives the classifier one atomic evidence boundary.
-- Ambiguous active rows are quarantined in MANUAL_REVIEW without rewriting the
-- conflicting payload. SUCCEEDED rows remain immutable audit evidence.
BEGIN;

LOCK TABLE "refund_compensation_tasks" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  running_recharge_refund_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO running_recharge_refund_count
  FROM "refund_compensation_tasks" task
  JOIN "orders" ord ON ord."id" = task."order_id"
  WHERE task."action" = 'REFUND_BALANCE'
    AND task."status" = 'RUNNING'
    AND ord."order_type" = 'RECHARGE';

  IF running_recharge_refund_count <> 0 THEN
    RAISE EXCEPTION
      'refund component migration blocked: % recharge refund tasks are RUNNING; drain workers first',
      running_recharge_refund_count;
  END IF;
END
$$;

DO $$
DECLARE
  exact_active_count BIGINT;
  ambiguous_active_count BIGINT;
  exact_succeeded_count BIGINT;
  ambiguous_succeeded_count BIGINT;
BEGIN
  SELECT
    COUNT(*) FILTER (
      WHERE classified."component" IS NOT NULL
        AND classified."status" <> 'SUCCEEDED'
    ),
    COUNT(*) FILTER (
      WHERE classified."component" IS NULL
        AND classified."status" <> 'SUCCEEDED'
    ),
    COUNT(*) FILTER (
      WHERE classified."component" IS NOT NULL
        AND classified."status" = 'SUCCEEDED'
    ),
    COUNT(*) FILTER (
      WHERE classified."component" IS NULL
        AND classified."status" = 'SUCCEEDED'
    )
  INTO
    exact_active_count,
    ambiguous_active_count,
    exact_succeeded_count,
    ambiguous_succeeded_count
  FROM (
    SELECT
      task."status",
      CASE
        WHEN task."user_id" = ord."user_id"
          AND task."tenant_id" IS NOT DISTINCT FROM ord."tenant_id"
          AND task."product_id" IS NOT DISTINCT FROM ord."product_id"
          AND ord."billing_account_id" IS NOT NULL
          AND task."amount_cents" > 0
          AND task."task_key" = ('refund:' || task."order_id" || ':recharge:principal')
          AND (
            task."payload" = jsonb_build_object(
              'description',
              'refund:recharge:order:' || task."order_id" || ':principal'
            )
            OR task."payload" = jsonb_build_object(
              'description',
              'refund:recharge:order:' || task."order_id" || ':principal',
              'billingAccountId',
              ord."billing_account_id"
            )
          )
          THEN 'PAID'
        WHEN task."user_id" = ord."user_id"
          AND task."tenant_id" IS NOT DISTINCT FROM ord."tenant_id"
          AND task."product_id" IS NOT DISTINCT FROM ord."product_id"
          AND ord."billing_account_id" IS NOT NULL
          AND task."amount_cents" > 0
          AND task."task_key" = ('refund:' || task."order_id" || ':recharge:bonus')
          AND (
            task."payload" = jsonb_build_object(
              'description',
              'refund:recharge:order:' || task."order_id" || ':bonus'
            )
            OR task."payload" = jsonb_build_object(
              'description',
              'refund:recharge:order:' || task."order_id" || ':bonus',
              'billingAccountId',
              ord."billing_account_id"
            )
          )
          THEN 'BONUS'
        ELSE NULL
      END AS "component"
    FROM "refund_compensation_tasks" task
    JOIN "orders" ord ON ord."id" = task."order_id"
    WHERE task."action" = 'REFUND_BALANCE'
      AND ord."order_type" = 'RECHARGE'
      AND NOT (COALESCE(task."payload", '{}'::jsonb) ? 'refundComponent')
  ) classified;

  RAISE NOTICE
    'refund component preflight exact_active=%, ambiguous_active=%, exact_succeeded_audit_only=%, ambiguous_succeeded_audit_only=%',
    exact_active_count,
    ambiguous_active_count,
    exact_succeeded_count,
    ambiguous_succeeded_count;
END
$$;

WITH exact_legacy AS (
  SELECT
    task."id",
    CASE
      WHEN task."user_id" = ord."user_id"
        AND task."tenant_id" IS NOT DISTINCT FROM ord."tenant_id"
        AND task."product_id" IS NOT DISTINCT FROM ord."product_id"
        AND ord."billing_account_id" IS NOT NULL
        AND task."amount_cents" > 0
        AND task."task_key" = ('refund:' || task."order_id" || ':recharge:principal')
        AND (
          task."payload" = jsonb_build_object(
            'description',
            'refund:recharge:order:' || task."order_id" || ':principal'
          )
          OR task."payload" = jsonb_build_object(
            'description',
            'refund:recharge:order:' || task."order_id" || ':principal',
            'billingAccountId',
            ord."billing_account_id"
          )
        )
        THEN 'PAID'
      WHEN task."user_id" = ord."user_id"
        AND task."tenant_id" IS NOT DISTINCT FROM ord."tenant_id"
        AND task."product_id" IS NOT DISTINCT FROM ord."product_id"
        AND ord."billing_account_id" IS NOT NULL
        AND task."amount_cents" > 0
        AND task."task_key" = ('refund:' || task."order_id" || ':recharge:bonus')
        AND (
          task."payload" = jsonb_build_object(
            'description',
            'refund:recharge:order:' || task."order_id" || ':bonus'
          )
          OR task."payload" = jsonb_build_object(
            'description',
            'refund:recharge:order:' || task."order_id" || ':bonus',
            'billingAccountId',
            ord."billing_account_id"
          )
        )
        THEN 'BONUS'
      ELSE NULL
    END AS "component"
  FROM "refund_compensation_tasks" task
  JOIN "orders" ord ON ord."id" = task."order_id"
  WHERE task."action" = 'REFUND_BALANCE'
    AND ord."order_type" = 'RECHARGE'
    AND NOT (COALESCE(task."payload", '{}'::jsonb) ? 'refundComponent')
)
UPDATE "refund_compensation_tasks" task
SET
  "payload" = task."payload" || jsonb_build_object(
    'refundComponent',
    exact_legacy."component"
  ),
  "updated_at" = CURRENT_TIMESTAMP
FROM exact_legacy
WHERE exact_legacy."id" = task."id"
  AND exact_legacy."component" IS NOT NULL
  AND task."status" <> 'SUCCEEDED';

-- Runtime and migration intentionally use the same evidence contract:
-- deterministic key+description, explicit component, no unknown payload keys,
-- task/order subject equality, and an optional account snapshot that must equal
-- the order's immutable billing account.
UPDATE "refund_compensation_tasks" task
SET
  "status" = 'MANUAL_REVIEW',
  "locked_at" = NULL,
  "locked_by" = NULL,
  "last_error" = 'REFUND_BALANCE_COMPONENT_AMBIGUOUS:migration_preflight',
  "updated_at" = CURRENT_TIMESTAMP
FROM "orders" ord
WHERE ord."id" = task."order_id"
  AND ord."order_type" = 'RECHARGE'
  AND task."action" = 'REFUND_BALANCE'
  AND task."status" IN ('PENDING', 'FAILED', 'MANUAL_REVIEW')
  AND NOT (
    task."user_id" = ord."user_id"
    AND task."tenant_id" IS NOT DISTINCT FROM ord."tenant_id"
    AND task."product_id" IS NOT DISTINCT FROM ord."product_id"
    AND ord."billing_account_id" IS NOT NULL
    AND task."amount_cents" > 0
    AND jsonb_typeof(task."payload") = 'object'
    AND task."payload" - ARRAY[
      'description',
      'billingAccountId',
      'refundComponent'
    ]::TEXT[] = '{}'::jsonb
    AND (
      NOT (task."payload" ? 'billingAccountId')
      OR (
        jsonb_typeof(task."payload" -> 'billingAccountId') = 'string'
        AND task."payload" ->> 'billingAccountId' = ord."billing_account_id"
      )
    )
    AND (
      (
        task."task_key" = ('refund:' || task."order_id" || ':recharge:principal')
        AND task."payload" ->> 'description'
          = ('refund:recharge:order:' || task."order_id" || ':principal')
        AND task."payload" ->> 'refundComponent' = 'PAID'
      )
      OR
      (
        task."task_key" = ('refund:' || task."order_id" || ':recharge:bonus')
        AND task."payload" ->> 'description'
          = ('refund:recharge:order:' || task."order_id" || ':bonus')
        AND task."payload" ->> 'refundComponent' = 'BONUS'
      )
    )
  );

COMMIT;

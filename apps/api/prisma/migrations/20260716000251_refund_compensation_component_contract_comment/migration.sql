-- Keep catalog metadata in its own migration so the potentially long
-- historical backfill transaction never retains this lock.
COMMENT ON COLUMN "refund_compensation_tasks"."payload" IS
  'REFUND_BALANCE tasks must carry an explicit refundComponent; exact legacy recharge identities are backfilled, ambiguous rows remain quarantined.';

-- quota-v2 §4.2: 滚动窗口配额聚合 hot path 复合索引
-- windowUsage 按 (subscription_id, type='CONSUME', created_at >= since) 做 SUM/COUNT，
-- 逐请求 authorize 调用，需复合索引避免全表扫描。纯加索引，可独立回滚。
CREATE INDEX "credit_transactions_subscription_id_type_created_at_idx" ON "credit_transactions"("subscription_id", "type", "created_at");

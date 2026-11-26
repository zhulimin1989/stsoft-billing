-- OFF_PEAK 时段价格档的高峰窗口（me/time-based-pricing.md v13.4）。
-- 低频小表加可空列：即时完成，无需 NOT VALID/VALIDATE 两步；JSON 结构校验在应用层。
ALTER TABLE "model_pricing_tiers" ADD COLUMN "band_schedule" JSONB;

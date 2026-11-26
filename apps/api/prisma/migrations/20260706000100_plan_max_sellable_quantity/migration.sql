-- 自营套餐限量售卖：新增最大可售份数（可空=不限量；仅自营 platform_model_package 执行，无需 backfill）
ALTER TABLE "plans" ADD COLUMN "max_sellable_quantity" INTEGER;

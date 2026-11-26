-- 自营套餐换档抵扣：记录定价所依据的源 entitlement，履约时锚定同一性，
-- 防并发/重复下单或「切走再切回同档」导致同一份旧套餐剩余价值被重复抵扣。
-- 可空：仅自营 platform_model_package 换档订单写入；历史订单/非换档订单为 NULL。
ALTER TABLE "orders"
  ADD COLUMN "proration_source_entitlement_id" TEXT;

-- 发票明细快照产品/套餐名（对账 + PDF 展示），历史行为 NULL → 回退枚举文案
ALTER TABLE "invoice_application_items" ADD COLUMN "product_name" TEXT;

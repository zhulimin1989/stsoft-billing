/**
 * PSA 开票：国内 / 海外区域策略 + IPS 主数据目录。
 *
 * 为什么不是原型模式：
 * - 这里没有“创建成本高、靠克隆出实例”的对象，只是两份不可变主数据。
 * - 国内外差异是策略（Strategy），共享的映射步骤是模板方法（Template Method）。
 * - Token / URL / client 等接口配置由 PsaInvoiceClient 走同一套环境变量，不按区域分叉。
 */
export const PSA_APPLY_REASONS = [
  '预收款',
  '合同待关联',
  'TS转移待完成',
  '客户确认待上传',
] as const;

export const PSA_DEFAULT_APPLY_REASON = '预收款';
export const PSA_DEFAULT_APPLY_REASON_DETAIL = 'SaaS服务费用开票';
/** 货物单位不传，固定空字符串，不走环境变量。 */
export const PSA_DEFAULT_UNIT_NAME = '';
export const PSA_DEFAULT_GOODS_CONTENT = '技术服务费';
export const PSA_DEFAULT_TAX_CLASSIFICATION_CODE = '3040203';

export const PSA_VAT_SPECIAL_KIND_NAME =
  '全电-增税专票-服务销售-6%<电子发票(增值税专用发票)>';
export const PSA_VAT_NORMAL_KIND_NAME =
  '全电-增税普票-服务销售-6%<电子发票(普通发票)>';
export const PSA_FOREIGN_KIND_NAME = '纸质-形式发票-服务销售-免税<INVOICE>';

export type PsaRegion = 'DOMESTIC' | 'FOREIGN';
export type PsaProjectSlot = 'TOKEN_PLAN' | 'SELF_PLAN' | 'API';
export type OverseasInvoiceTemplateKind = 'PERSONAL' | 'ENTERPRISE';

export const PSA_OVERSEAS_TEMPLATE_FILE = 'Invoice模板.xlsx';

export interface PsaRegionProfile {
  region: PsaRegion;
  currencyName: string;
  sdAreaId: number;
  taxClassificationCode: string;
  goodsContent: string;
  goodsUnitName: string;
  applyReason: string;
  applyReasonDetail: string;
  invoiceKindByType: {
    VAT_SPECIAL?: string;
    VAT_NORMAL?: string;
    COMMERCIAL_HK?: string;
  };
  projectNos: Partial<Record<PsaProjectSlot, string>>;
}

export const PSA_DOMESTIC_PROFILE: Readonly<PsaRegionProfile> = Object.freeze({
  region: 'DOMESTIC',
  currencyName: '中国人民币',
  sdAreaId: 2141,
  taxClassificationCode: PSA_DEFAULT_TAX_CLASSIFICATION_CODE,
  goodsContent: PSA_DEFAULT_GOODS_CONTENT,
  goodsUnitName: PSA_DEFAULT_UNIT_NAME,
  applyReason: PSA_DEFAULT_APPLY_REASON,
  applyReasonDetail: PSA_DEFAULT_APPLY_REASON_DETAIL,
  invoiceKindByType: Object.freeze({
    VAT_SPECIAL: PSA_VAT_SPECIAL_KIND_NAME,
    VAT_NORMAL: PSA_VAT_NORMAL_KIND_NAME,
  }),
  projectNos: Object.freeze({
    TOKEN_PLAN: 'IM26062792F9',
    // 自营套餐服务月：订单月 1 日（与 Token Plan 相同）。
    SELF_PLAN: 'IM26080060F9',
    API: 'IM26063338F9',
  }),
});

export const PSA_FOREIGN_PROFILE: Readonly<PsaRegionProfile> = Object.freeze({
  region: 'FOREIGN',
  currencyName: '美元',
  sdAreaId: 2142,
  taxClassificationCode: '',
  goodsContent: PSA_DEFAULT_GOODS_CONTENT,
  goodsUnitName: PSA_DEFAULT_UNIT_NAME,
  applyReason: PSA_DEFAULT_APPLY_REASON,
  applyReasonDetail: PSA_DEFAULT_APPLY_REASON_DETAIL,
  invoiceKindByType: Object.freeze({
    COMMERCIAL_HK: PSA_FOREIGN_KIND_NAME,
  }),
  projectNos: Object.freeze({
    TOKEN_PLAN: 'IM26063347B9',
    API: 'IM26062093B9',
  }),
});

export const PSA_PROJECT_NO_ENV: Record<PsaRegion, Partial<Record<PsaProjectSlot, string>>> = {
  DOMESTIC: {
    TOKEN_PLAN: 'PSA_DOMESTIC_TOKEN_PLAN_PRJ_NO',
    SELF_PLAN: 'PSA_DOMESTIC_SELF_PLAN_PRJ_NO',
    API: 'PSA_DOMESTIC_API_PRJ_NO',
  },
  FOREIGN: {
    TOKEN_PLAN: 'PSA_FOREIGN_TOKEN_PLAN_PRJ_NO',
    API: 'PSA_FOREIGN_API_PRJ_NO',
  },
};

export function psaProfileFor(region: PsaRegion): Readonly<PsaRegionProfile> {
  return region === 'FOREIGN' ? PSA_FOREIGN_PROFILE : PSA_DOMESTIC_PROFILE;
}

/** Authing / 国内部署 → DOMESTIC；Auth0 / 海外部署 → FOREIGN */
export function psaRegionFromDeployment(deployment: 'domestic' | 'international'): PsaRegion {
  return deployment === 'international' ? 'FOREIGN' : 'DOMESTIC';
}

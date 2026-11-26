/**
 * 企业账单钱包端口。V2【账单核销】【账单调整】不调用 applyMovement（ADR-0019）。
 * 补偿发券走 issuePaygVoucher，只发券、不改钱包余额。
 */
export type EnterpriseBillWalletMovement = {
  billingAccountId: string;
  /** 正数加余额（核销/调减），负数减余额（调增） */
  amountCents: number;
  reasonCode: 'OTHER';
  description: string;
  performedBy: string;
  idempotencyKey: string;
};

/** 补偿发券：只发券资产，不改钱包余额。 */
export type EnterpriseBillIssuePaygVoucher = {
  billingAccountId: string;
  amountCents: number;
  reason: string;
  productId: string | null;
  /** 指定 tenant；缺省时由 adapter 解析 funding anchor 上的默认 tenant */
  tenantId?: string | null;
  performedBy: string;
  idempotencyKey: string;
};

export interface EnterpriseBillWalletPort {
  applyMovement(input: EnterpriseBillWalletMovement): Promise<void>;
  issuePaygVoucher(input: EnterpriseBillIssuePaygVoucher): Promise<void>;
}

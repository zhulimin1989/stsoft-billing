import { Injectable } from '@nestjs/common';
import { BillingService } from './billing.service';
import { EnterpriseAccountService } from './enterprise-account.service';
import type {
  EnterpriseBillIssuePaygVoucher,
  EnterpriseBillWalletMovement,
  EnterpriseBillWalletPort,
} from './enterprise-bills-wallet.port';

@Injectable()
export class EnterpriseBillWalletAdapter implements EnterpriseBillWalletPort {
  constructor(
    private readonly billing: BillingService,
    private readonly enterpriseAccounts: EnterpriseAccountService,
  ) {}

  async applyMovement(input: EnterpriseBillWalletMovement): Promise<void> {
    if (input.amountCents === 0) {
      return;
    }
    const anchor = await this.enterpriseAccounts.resolveFundingAnchor(input.billingAccountId);
    await this.billing.applyClassifiedBalanceAdjustment(anchor.ownerUserId, {
      amountCents: input.amountCents,
      reasonCode: input.reasonCode,
      description: input.description,
      performedBy: input.performedBy,
      idempotencyKey: input.idempotencyKey,
      tenantId: anchor.tenantId,
      billingAccountId: anchor.billingAccountId,
      allowWalletOverdraft: input.amountCents < 0,
    });
    await this.enterpriseAccounts.syncEnterpriseAccountKeyBalances(input.billingAccountId);
  }

  async issuePaygVoucher(input: EnterpriseBillIssuePaygVoucher): Promise<void> {
    if (input.amountCents === 0) {
      return;
    }
    const anchor = await this.enterpriseAccounts.resolveFundingAnchor(input.billingAccountId);
    const tenantId = input.tenantId?.trim() || anchor.tenantId;
    await this.billing.issueVoucher(anchor.ownerUserId, input.amountCents, input.reason, {
      tenantId,
      productId: input.productId,
      performedBy: input.performedBy,
      idempotencyKey: input.idempotencyKey,
    });
    await this.enterpriseAccounts.syncEnterpriseAccountKeyBalances(input.billingAccountId);
  }
}

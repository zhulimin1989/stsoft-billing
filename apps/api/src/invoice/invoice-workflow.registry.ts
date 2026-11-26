import { BadRequestException, Injectable } from '@nestjs/common';
import { InvoiceApplication } from '@prisma/client';
import { InvoiceDeploymentService } from './invoice-deployment.service';
import {
  InvoiceablePeriod,
  InvoiceDomesticService,
  ListInvoiceablePeriodsInput,
  SubmitPeriodApplicationInput,
} from './invoice-domestic.service';
import {
  InvoiceablePurchase,
  InvoiceInternationalService,
  SubmitApplicationInput,
} from './invoice-international.service';

export interface InvoiceWorkflow {
  listInvoiceablePurchases(userId: string, tenantId: string): Promise<InvoiceablePurchase[]>;
  listInvoiceablePeriods(input: ListInvoiceablePeriodsInput): Promise<InvoiceablePeriod[]>;
  submitApplication(input: SubmitApplicationInput): Promise<InvoiceApplication>;
  submitPeriodApplication(input: SubmitPeriodApplicationInput): Promise<InvoiceApplication>;
  repairRechargeInvoices(input: {
    adminId: string;
    dryRun: boolean;
    applicationIds?: string[];
    limit?: number;
  }): Promise<unknown>;
}

@Injectable()
export class DomesticInvoiceWorkflow implements InvoiceWorkflow {
  constructor(private readonly domestic: InvoiceDomesticService) {}

  listInvoiceablePurchases(userId: string, tenantId: string): Promise<InvoiceablePurchase[]> {
    return this.domestic.listInvoiceablePurchases(userId, tenantId);
  }

  listInvoiceablePeriods(input: ListInvoiceablePeriodsInput): Promise<InvoiceablePeriod[]> {
    return this.domestic.listInvoiceablePeriods(input);
  }

  submitApplication(input: SubmitApplicationInput): Promise<InvoiceApplication> {
    return this.domestic.submitApplication(input);
  }

  submitPeriodApplication(input: SubmitPeriodApplicationInput): Promise<InvoiceApplication> {
    return this.domestic.submitPeriodApplication(input);
  }

  async repairRechargeInvoices(): Promise<unknown> {
    throw new BadRequestException('国内版充值开票按消耗账期计算，不支持国际版充值发票修复');
  }
}

@Injectable()
export class InternationalInvoiceWorkflow implements InvoiceWorkflow {
  constructor(private readonly international: InvoiceInternationalService) {}

  listInvoiceablePurchases(userId: string, tenantId: string): Promise<InvoiceablePurchase[]> {
    return this.international.listInvoiceablePurchases(userId, tenantId);
  }

  async listInvoiceablePeriods(): Promise<InvoiceablePeriod[]> {
    return [];
  }

  submitApplication(input: SubmitApplicationInput): Promise<InvoiceApplication> {
    return this.international.submitApplication(input);
  }

  async submitPeriodApplication(): Promise<InvoiceApplication> {
    throw new BadRequestException('国际版请按订单申请开票');
  }

  repairRechargeInvoices(input: {
    adminId: string;
    dryRun: boolean;
    applicationIds?: string[];
    limit?: number;
  }): Promise<unknown> {
    return this.international.repairRechargeInvoices(input);
  }
}

@Injectable()
export class InvoiceWorkflowRegistry {
  constructor(
    private readonly deployment: InvoiceDeploymentService,
    private readonly domestic: DomesticInvoiceWorkflow,
    private readonly international: InternationalInvoiceWorkflow,
  ) {}

  async current(): Promise<InvoiceWorkflow> {
    const deployment = await this.deployment.resolve();
    return deployment === 'domestic' ? this.domestic : this.international;
  }

  resolveDeployment() {
    return this.deployment.resolve();
  }
}

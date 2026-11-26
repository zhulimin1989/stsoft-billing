import { Injectable } from '@nestjs/common';
import { InvoiceApplicationStatus, InvoiceLineDescription } from '@prisma/client';
import {
  InvoiceApplicationService,
  IssueUploadedApplicationInput,
} from './invoice-application.service';
import {
  InvoiceablePeriod,
  ListInvoiceablePeriodsInput,
  SubmitPeriodApplicationInput,
} from './invoice-domestic.service';
import {
  InvoiceablePurchase,
  SubmitApplicationInput,
} from './invoice-international.service';
import { InvoiceWorkflowRegistry } from './invoice-workflow.registry';

export type {
  InvoiceablePeriod,
  ListInvoiceablePeriodsInput,
  SubmitPeriodApplicationInput,
} from './invoice-domestic.service';
export type {
  InvoiceablePurchase,
  SubmitApplicationInput,
} from './invoice-international.service';
export type {
  IssueUploadedApplicationInput,
} from './invoice-application.service';

@Injectable()
export class InvoiceService {
  constructor(
    private readonly workflows: InvoiceWorkflowRegistry,
    private readonly applications: InvoiceApplicationService,
  ) {}

  async listInvoiceablePurchases(userId: string, tenantId: string): Promise<InvoiceablePurchase[]> {
    return (await this.workflows.current()).listInvoiceablePurchases(userId, tenantId);
  }

  async listInvoiceablePeriods(input: ListInvoiceablePeriodsInput): Promise<InvoiceablePeriod[]> {
    return (await this.workflows.current()).listInvoiceablePeriods(input);
  }

  resolveDeployment() {
    return this.workflows.resolveDeployment();
  }

  async submitApplication(input: SubmitApplicationInput) {
    return (await this.workflows.current()).submitApplication(input);
  }

  async submitPeriodApplication(input: SubmitPeriodApplicationInput) {
    return (await this.workflows.current()).submitPeriodApplication(input);
  }

  listApplications(
    userId: string,
    tenantId: string,
    filter: {
      status?: InvoiceApplicationStatus;
      description?: InvoiceLineDescription;
      page?: number;
      pageSize?: number;
    },
  ) {
    return this.applications.listApplications(userId, tenantId, filter);
  }

  getApplication(userId: string, tenantId: string, applicationId: string) {
    return this.applications.getApplication(userId, tenantId, applicationId);
  }

  cancelApplication(userId: string, tenantId: string, applicationId: string) {
    return this.applications.cancelApplication(userId, tenantId, applicationId);
  }

  adminListApplications(filter: Parameters<InvoiceApplicationService['adminListApplications']>[0]) {
    return this.applications.adminListApplications(filter);
  }

  buildInvoicesZip(ids: string[]) {
    return this.applications.buildInvoicesZip(ids);
  }

  adminGetApplication(applicationId: string) {
    return this.applications.adminGetApplication(applicationId);
  }

  async repairInternationalRechargeInvoices(input: {
    adminId: string;
    dryRun: boolean;
    applicationIds?: string[];
    limit?: number;
  }) {
    return (await this.workflows.current()).repairRechargeInvoices(input);
  }

  approveApplication(applicationId: string, adminId: string, remark?: string | null) {
    return this.applications.approveApplication(applicationId, adminId, remark);
  }

  retryPsaSubmission(applicationId: string, adminId: string) {
    return this.applications.retryPsaSubmission(applicationId, adminId);
  }

  readOverseasInvoiceAttachment(applicationId: string) {
    return this.applications.readOverseasInvoiceAttachment(applicationId);
  }

  rejectApplication(applicationId: string, adminId: string, reason: string) {
    return this.applications.rejectApplication(applicationId, adminId, reason);
  }

  issueUploadedApplication(input: IssueUploadedApplicationInput) {
    return this.applications.issueUploadedApplication(input);
  }

  readUserInvoiceDownload(userId: string, tenantId: string, applicationId: string) {
    return this.applications.readUserInvoiceDownload(userId, tenantId, applicationId);
  }

  voidApplication(applicationId: string, adminId: string, reason: string) {
    return this.applications.voidApplication(applicationId, adminId, reason);
  }

  redOffsetApplication(applicationId: string, adminId: string, reason: string) {
    return this.applications.redOffsetApplication(applicationId, adminId, reason);
  }

  failApplication(applicationId: string, adminId: string, reason: string) {
    return this.applications.failApplication(applicationId, adminId, reason);
  }
}

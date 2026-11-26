import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  InvoiceActorType,
  InvoiceApplicationStatus,
  InvoiceLineDescription,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceEventService } from './invoice-event.service';
import {
  InvoiceAccessDeniedError,
  InvoiceApplicationNotFoundError,
  InvoiceInvalidUploadedFileError,
  InvoiceInvalidStateTransitionError,
  InvoiceItemAlreadyIssuedError,
  InvoiceItemNotFoundError,
  InvoiceItemUploadRequiredError,
  InvoiceMissingIssueDataError,
  InvoiceNumberAlreadyUsedError,
  InvoicePsaAttachmentNotFoundError,
  InvoicePsaNotEnabledError,
  InvoicePsaRetryNotAllowedError,
} from './invoice.errors';
import { InvoiceStorageService } from './invoice-storage.service';
import { InvoiceDeploymentService } from './invoice-deployment.service';
import { PsaInvoiceClient, buildPsaXlsxAttachment, psaXlsxFileName, type PsaInvoiceRequest } from './psa-invoice.client';
import { PSA_SUBMIT_INCLUDE, buildPsaInvoiceRequests, type PsaMappableInvoiceApplication } from './psa-invoice.mapper';
import { OverseasInvoiceTemplateService } from './overseas-invoice-template.service';
import { psaRegionFromDeployment } from './psa-invoice.profile';

const PSA_XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface UploadedInvoiceFileInput {
  buffer: Buffer;
  filename: string;
  contentType?: string | null;
}

export interface IssueUploadedApplicationInput {
  applicationId: string;
  adminId: string;
  invoiceNumber: string;
  issuingEntity: string;
  issueDate: Date;
  pdfFile: UploadedInvoiceFileInput;
  ofdFile?: UploadedInvoiceFileInput | null;
  taxAmountCents?: number | null;
  itemId?: string | null;
}

@Injectable()
export class InvoiceApplicationService {
  private readonly logger = new Logger(InvoiceApplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventService: InvoiceEventService,
    private readonly storageService: InvoiceStorageService,
    private readonly deployment: InvoiceDeploymentService,
    @Optional() private readonly psaClient?: PsaInvoiceClient,
    @Optional() private readonly overseasTemplate?: OverseasInvoiceTemplateService,
  ) {}

  async listApplications(
    userId: string,
    tenantId: string,
    filter: {
      status?: InvoiceApplicationStatus;
      description?: InvoiceLineDescription;
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = filter.page ?? 1;
    const pageSize = Math.min(filter.pageSize ?? 20, 100);
    const where: Prisma.InvoiceApplicationWhereInput = {
      userId,
      tenantId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.description ? { items: { some: { description: filter.description } } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoiceApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { items: true },
      }),
      this.prisma.invoiceApplication.count({ where }),
    ]);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getApplication(userId: string, tenantId: string, applicationId: string) {
    const application = await this.prisma.invoiceApplication.findUnique({
      where: { id: applicationId },
      include: { items: true, events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!application) throw new InvoiceApplicationNotFoundError();
    if (application.userId !== userId || application.tenantId !== tenantId) {
      throw new InvoiceAccessDeniedError();
    }
    return application;
  }

  async cancelApplication(userId: string, tenantId: string, applicationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const application = await tx.invoiceApplication.findUnique({
        where: { id: applicationId },
      });
      if (!application) throw new InvoiceApplicationNotFoundError();
      if (application.userId !== userId || application.tenantId !== tenantId) {
        throw new InvoiceAccessDeniedError();
      }
      if (application.status !== 'PENDING_REVIEW') {
        throw new InvoiceInvalidStateTransitionError(application.status, 'CANCELLED');
      }
      const updated = await tx.invoiceApplication.update({
        where: { id: applicationId },
        data: { status: 'CANCELLED' },
        include: { items: true },
      });
      await this.eventService.record(
        {
          applicationId,
          fromStatus: 'PENDING_REVIEW',
          toStatus: 'CANCELLED',
          actorType: 'USER',
          actorId: userId,
        },
        tx,
      );
      return updated;
    });
  }

  async adminListApplications(filter: {
    status?: InvoiceApplicationStatus;
    userId?: string;
    tenantId?: string;
    email?: string;
    username?: string;
    orderId?: string;
    productName?: string;
    description?: InvoiceLineDescription;
    applicationNo?: string;
    invoiceNumber?: string;
    issuedFrom?: Date;
    issuedTo?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const page = filter.page ?? 1;
    const pageSize = Math.min(filter.pageSize ?? 50, 200);

    const userWhere: Prisma.UserWhereInput = {};
    if (filter.email) userWhere.email = { contains: filter.email, mode: 'insensitive' };
    if (filter.username) userWhere.nickname = { contains: filter.username, mode: 'insensitive' };

    const itemWhere: Prisma.InvoiceApplicationItemWhereInput = {};
    if (filter.orderId) itemWhere.orderId = filter.orderId;
    if (filter.productName) {
      itemWhere.productName = { contains: filter.productName, mode: 'insensitive' };
    }
    if (filter.description) itemWhere.description = filter.description;

    const issueDateFilter: Prisma.DateTimeNullableFilter = {};
    if (filter.issuedFrom) issueDateFilter.gte = filter.issuedFrom;
    if (filter.issuedTo) issueDateFilter.lte = filter.issuedTo;

    const where: Prisma.InvoiceApplicationWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      ...(Object.keys(userWhere).length ? { user: userWhere } : {}),
      ...(Object.keys(itemWhere).length ? { items: { some: itemWhere } } : {}),
      ...(filter.applicationNo
        ? { applicationNo: { contains: filter.applicationNo, mode: 'insensitive' } }
        : {}),
      ...(filter.invoiceNumber
        ? { invoiceNumber: { contains: filter.invoiceNumber, mode: 'insensitive' } }
        : {}),
      ...(Object.keys(issueDateFilter).length ? { issueDate: issueDateFilter } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoiceApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: true,
          user: { select: { id: true, email: true, nickname: true } },
        },
      }),
      this.prisma.invoiceApplication.count({ where }),
    ]);
    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async buildInvoicesZip(ids: string[]): Promise<{ zip: Buffer; included: number; skipped: string[] }> {
    const apps = await this.prisma.invoiceApplication.findMany({
      where: { id: { in: ids }, status: 'ISSUED' },
      select: {
        id: true,
        invoiceNumber: true,
        applicationNo: true,
        pdfUrl: true,
        items: {
          select: { orderId: true, invoiceNumber: true, pdfUrl: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const found = new Map(apps.map((a) => [a.id, a]));
    const skipped = ids.filter((id) => !found.has(id));

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    let included = 0;
    const usedNames = new Set<string>();
    for (const app of apps) {
      const files = collectIssuedPdfFiles(app);
      if (files.length === 0) {
        skipped.push(app.id);
        continue;
      }
      for (const file of files) {
        try {
          const buf = await this.storageService.readToBuffer(file.pdfUrl);
          let name = `${file.name}.pdf`;
          let i = 1;
          while (usedNames.has(name)) {
            name = `${file.name}-${i++}.pdf`;
          }
          usedNames.add(name);
          zip.file(name, buf);
          included += 1;
        } catch (err) {
          this.logger.error(
            `buildInvoicesZip: read pdf failed for ${app.id}: ${(err as Error).message}`,
          );
          skipped.push(app.id);
        }
      }
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    return { zip: zipBuffer, included, skipped };
  }

  async readUserInvoiceDownload(userId: string, tenantId: string, applicationId: string) {
    const application = await this.getApplication(userId, tenantId, applicationId);
    const files = collectIssuedPdfFiles(application);
    if (files.length === 0) {
      return null;
    }
    if (files.length === 1) {
      const buffer = await this.storageService.readToBuffer(files[0].pdfUrl);
      return {
        buffer,
        contentType: 'application/pdf',
        filename: `${files[0].name}.pdf`,
      };
    }
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const usedNames = new Set<string>();
    for (const file of files) {
      const buf = await this.storageService.readToBuffer(file.pdfUrl);
      let name = `${file.name}.pdf`;
      let i = 1;
      while (usedNames.has(name)) {
        name = `${file.name}-${i++}.pdf`;
      }
      usedNames.add(name);
      zip.file(name, buf);
    }
    return {
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
      contentType: 'application/zip',
      filename: `${application.applicationNo}-invoices.zip`,
    };
  }

  async adminGetApplication(applicationId: string) {
    const application = await this.prisma.invoiceApplication.findUnique({
      where: { id: applicationId },
      include: {
        items: true,
        events: { orderBy: { occurredAt: 'asc' } },
        user: { select: { id: true, email: true, nickname: true } },
      },
    });
    if (!application) throw new InvoiceApplicationNotFoundError();
    return application;
  }

  async approveApplication(applicationId: string, adminId: string, remark?: string | null) {
    const updated = await this.transitionStatus({
      applicationId,
      from: ['PENDING_REVIEW'],
      to: 'APPROVED_ISSUING',
      actorId: adminId,
      reason: remark ?? null,
      updateData: { reviewedBy: adminId, reviewedAt: new Date() },
    });
    await this.submitToPsa(updated.id, {
      actorType: 'ADMIN',
      actorId: adminId,
    });
    return this.adminGetApplication(updated.id);
  }

  async retryPsaSubmission(applicationId: string, adminId: string) {
    if (!this.psaClient?.isEnabled()) {
      throw new InvoicePsaNotEnabledError();
    }
    const application = await this.adminGetApplication(applicationId);
    if (application.status !== 'APPROVED_ISSUING') {
      throw new InvoiceInvalidStateTransitionError(application.status, 'APPROVED_ISSUING');
    }
    if (application.psaStatus === 'SUBMITTED') {
      throw new InvoicePsaRetryNotAllowedError('PSA 已提交成功，无需重试');
    }
    if (!['NOT_SUBMITTED', 'FAILED', 'SUBMITTING'].includes(application.psaStatus)) {
      throw new InvoicePsaRetryNotAllowedError();
    }
    await this.submitToPsa(applicationId, {
      retry: true,
      actorType: 'ADMIN',
      actorId: adminId,
    });
    return this.adminGetApplication(applicationId);
  }

  private async submitToPsa(
    applicationId: string,
    options?: {
      retry?: boolean;
      actorType?: InvoiceActorType;
      actorId?: string;
    },
  ): Promise<void> {
    const psaClient = this.psaClient;
    if (!psaClient?.isEnabled()) return;
    const claimed = await this.prisma.invoiceApplication.updateMany({
      where: options?.retry
        ? {
            id: applicationId,
            status: 'APPROVED_ISSUING',
            OR: [
              { psaStatus: { in: ['NOT_SUBMITTED', 'FAILED'] } },
              { psaStatus: 'SUBMITTING', psaLastAttemptAt: { lt: psaRetryStaleBefore() } },
              { psaStatus: 'SUBMITTING', psaLastAttemptAt: null },
            ],
          }
        : { id: applicationId, status: 'APPROVED_ISSUING', psaStatus: 'NOT_SUBMITTED' },
      data: {
        psaStatus: 'SUBMITTING',
        psaLastAttemptAt: new Date(),
        psaAttemptCount: { increment: 1 },
        psaLastError: null,
      },
    });
    if (claimed.count !== 1) {
      if (options?.retry) {
        throw new InvoicePsaRetryNotAllowedError('当前 PSA 状态不可重试或正在提交');
      }
      return;
    }
    const actorType = options?.actorType ?? 'SYSTEM';
    const actorId = options?.actorId ?? null;
    try {
      const application = await this.prisma.invoiceApplication.findUnique({
        where: { id: applicationId },
        include: PSA_SUBMIT_INCLUDE,
      });
      if (!application) throw new Error('开票申请不存在');
      const loginRegion = await this.deployment.resolveLoginRegion();
      const region = psaRegionFromDeployment(loginRegion);
      const requests = buildPsaInvoiceRequests(application, { region });
      let psaAttachmentUrl = application.psaAttachmentUrl ?? null;
      let fullXlsxBuffer: Buffer | null = null;
      const submittedOrders = collectSubmittedPsaOrderNos(application.events);
      const formNos = collectSubmittedPsaFormNos(application.events);
      const pending = requests.filter((request) => !submittedOrders.has(request.orderNo));

      if (region === 'FOREIGN' && pending.length > 0) {
        const generated = await this.generateAndStoreOverseasInvoice(application);
        psaAttachmentUrl = generated.psaAttachmentUrl;
        fullXlsxBuffer = generated.buffer;
      }

      if (pending.length === 0) {
        await this.prisma.invoiceApplication.update({
          where: { id: applicationId },
          data: {
            psaStatus: 'SUBMITTED',
            psaFormNo: joinPsaFormNos(formNos),
            psaSubmittedAt: new Date(),
            psaLastError: null,
            ...(psaAttachmentUrl ? { psaAttachmentUrl } : {}),
          },
        });
        await this.eventService.record({
          applicationId,
          fromStatus: 'APPROVED_ISSUING',
          toStatus: 'APPROVED_ISSUING',
          actorType,
          actorId,
          metadata: { psaStatus: 'SUBMITTED', psaFormNo: joinPsaFormNos(formNos) },
        });
        return;
      }

      const failures: string[] = [];
      for (const request of pending) {
        try {
          if (region === 'FOREIGN') {
            request.attachments = await this.buildOverseasPsaAttachments({
              application,
              request,
              fullBuffer: fullXlsxBuffer,
              totalRequestCount: requests.length,
            });
          }
          const result = await psaClient.apply(request);
          formNos.push(result.formNo);
          await this.prisma.invoiceApplicationItem.updateMany({
            where: { applicationId, orderId: request.orderNo },
            data: { psaFormNo: result.formNo },
          });
          await this.prisma.invoiceApplication.update({
            where: { id: applicationId },
            data: {
              psaFormNo: joinPsaFormNos(formNos),
              psaLastError: null,
              ...(psaAttachmentUrl ? { psaAttachmentUrl } : {}),
            },
          });
          await this.eventService.record({
            applicationId,
            fromStatus: 'APPROVED_ISSUING',
            toStatus: 'APPROVED_ISSUING',
            actorType,
            actorId,
            metadata: {
              psaStatus: 'SUBMITTED',
              psaFormNo: result.formNo,
              psaOrderNo: request.orderNo,
            },
          });
        } catch (err) {
          const message = (err as Error)?.message?.slice(0, 1000) || 'PSA 提交失败';
          this.logger.error(
            `PSA invoice submission failed application=${applicationId} orderNo=${request.orderNo}: ${message}`,
          );
          failures.push(`订单 ${request.orderNo} ${message}`);
          await this.eventService.record({
            applicationId,
            fromStatus: 'APPROVED_ISSUING',
            toStatus: 'APPROVED_ISSUING',
            actorType,
            actorId,
            reason: message,
            metadata: { psaStatus: 'FAILED', psaOrderNo: request.orderNo },
          }).catch(() => undefined);
        }
      }

      if (failures.length === 0) {
        await this.prisma.invoiceApplication.update({
          where: { id: applicationId },
          data: {
            psaStatus: 'SUBMITTED',
            psaFormNo: joinPsaFormNos(formNos),
            psaSubmittedAt: new Date(),
            psaLastError: null,
            ...(psaAttachmentUrl ? { psaAttachmentUrl } : {}),
          },
        });
      } else {
        const message = failures.join('；').slice(0, 1000);
        await this.prisma.invoiceApplication.update({
          where: { id: applicationId },
          data: {
            psaStatus: 'FAILED',
            psaFormNo: joinPsaFormNos(formNos),
            psaLastError: message,
            ...(psaAttachmentUrl ? { psaAttachmentUrl } : {}),
          },
        });
      }
    } catch (err) {
      const message = (err as Error)?.message?.slice(0, 1000) || 'PSA 提交失败';
      this.logger.error(`PSA invoice submission failed application=${applicationId}: ${message}`);
      await this.prisma.invoiceApplication.update({
        where: { id: applicationId },
        data: { psaStatus: 'FAILED', psaLastError: message },
      }).catch((updateErr) => this.logger.error(`PSA failure state update failed: ${(updateErr as Error).message}`));
      await this.eventService.record({
        applicationId,
        fromStatus: 'APPROVED_ISSUING',
        toStatus: 'APPROVED_ISSUING',
        actorType,
        actorId,
        reason: message,
        metadata: { psaStatus: 'FAILED' },
      }).catch(() => undefined);
    }
  }


  async readOverseasInvoiceAttachment(applicationId: string): Promise<{
    buffer: Buffer;
    fileName: string;
    contentType: string;
  }> {
    const application = await this.prisma.invoiceApplication.findUnique({
      where: { id: applicationId },
      include: PSA_SUBMIT_INCLUDE,
    });
    if (!application) throw new InvoiceApplicationNotFoundError();

    const existing = application.psaAttachmentUrl?.trim() || '';
    if (existing) {
      try {
        const stored = await this.storageService.readToBuffer(existing);
        if (stored?.length) {
          return {
            buffer: stored,
            fileName: psaXlsxFileName(application.applicationNo),
            contentType: PSA_XLSX_CONTENT_TYPE,
          };
        }
      } catch (err) {
        this.logger.warn(
          `read overseas psa xlsx failed application=${application.id}: ${(err as Error).message}`,
        );
      }
    }

    const loginRegion = await this.deployment.resolveLoginRegion();
    if (psaRegionFromDeployment(loginRegion) !== 'FOREIGN') {
      throw new InvoicePsaAttachmentNotFoundError();
    }
    const generated = await this.generateAndStoreOverseasInvoice(application);
    return {
      buffer: generated.buffer,
      fileName: generated.fileName,
      contentType: generated.contentType,
    };
  }

  private async buildOverseasPsaAttachments(input: {
    application: PsaMappableInvoiceApplication & {
      id: string;
      userId: string;
    };
    request: PsaInvoiceRequest;
    fullBuffer: Buffer | null;
    totalRequestCount: number;
  }): Promise<PsaInvoiceRequest['attachments']> {
    if (input.totalRequestCount === 1 && input.fullBuffer?.length) {
      return [buildPsaXlsxAttachment(input.application.applicationNo, input.fullBuffer)];
    }
    if (!this.overseasTemplate) {
      throw new Error('海外 Invoice 模板服务未配置');
    }
    const subset: PsaMappableInvoiceApplication = {
      ...input.application,
      items: input.application.items.filter((item) => itemOrderId(item) === input.request.orderNo),
    };
    const filled = await this.overseasTemplate.fill(subset);
    return [buildPsaXlsxAttachment(input.application.applicationNo, filled.buffer)];
  }

  private async generateAndStoreOverseasInvoice(
    application: PsaMappableInvoiceApplication & {
      id: string;
      userId: string;
    },
  ): Promise<{
    buffer: Buffer;
    fileName: string;
    contentType: string;
    psaAttachmentUrl: string;
  }> {
    if (!this.overseasTemplate) {
      throw new Error('海外 Invoice 模板服务未配置');
    }
    const filled = await this.overseasTemplate.fill(application);
    const psaAttachmentUrl = await this.storageService.persist({
      userId: application.userId,
      invoiceNumber: application.applicationNo,
      applicationId: application.id,
      buffer: filled.buffer,
      extension: 'xlsx',
      contentType: filled.contentType,
      keyHint: `${application.applicationNo}-psa`,
    });
    await this.prisma.invoiceApplication.update({
      where: { id: application.id },
      data: { psaAttachmentUrl },
    });
    return {
      buffer: filled.buffer,
      fileName: filled.fileName,
      contentType: filled.contentType,
      psaAttachmentUrl,
    };
  }

  rejectApplication(applicationId: string, adminId: string, reason: string) {
    return this.transitionStatus({
      applicationId,
      from: ['PENDING_REVIEW'],
      to: 'REJECTED',
      actorId: adminId,
      reason,
      updateData: {
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectReason: reason,
      },
    });
  }

  async issueUploadedApplication(input: IssueUploadedApplicationInput) {
    if (
      !input.invoiceNumber ||
      !input.issuingEntity ||
      !input.issueDate ||
      !input.pdfFile?.buffer?.length
    ) {
      throw new InvoiceMissingIssueDataError();
    }
    const invoiceNumber = normalizeInvoiceNumber(input.invoiceNumber);
    if (!invoiceNumber) {
      throw new InvoiceMissingIssueDataError();
    }

    const application = await this.prisma.invoiceApplication.findUnique({
      where: { id: input.applicationId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!application) throw new InvoiceApplicationNotFoundError();
    if (application.status !== 'APPROVED_ISSUING') {
      throw new InvoiceInvalidStateTransitionError(application.status, 'ISSUED');
    }
    const targetItem = resolveIssueTargetItem(application.items, input.itemId);
    if (targetItem.pdfUrl) throw new InvoiceItemAlreadyIssuedError();
    assertUploadedInvoiceFile(input.pdfFile, 'pdf');
    if (input.ofdFile?.buffer?.length) {
      assertUploadedInvoiceFile(input.ofdFile, 'ofd');
    }

    const numberOwner = await this.findInvoiceNumberOwner(invoiceNumber, {
      applicationId: application.id,
      itemId: targetItem.id,
    });
    if (numberOwner) {
      throw new InvoiceNumberAlreadyUsedError(invoiceNumber, numberOwner);
    }

    const keyBase = `manual-${input.applicationId}-${targetItem.id}-${randomUUID()}`;
    const pdfUrl = await this.storageService.persist({
      userId: application.userId,
      invoiceNumber: invoiceNumber,
      applicationId: input.applicationId,
      buffer: input.pdfFile.buffer,
      extension: 'pdf',
      contentType: input.pdfFile.contentType || 'application/pdf',
      keyHint: `${keyBase}-pdf`,
    });
    let ofdUrl: string | null = null;
    try {
      ofdUrl = input.ofdFile?.buffer?.length
        ? await this.storageService.persist({
            userId: application.userId,
            invoiceNumber: `${invoiceNumber}-ofd`,
            applicationId: input.applicationId,
            buffer: input.ofdFile.buffer,
            extension: 'ofd',
            contentType: input.ofdFile.contentType || 'application/octet-stream',
            keyHint: `${keyBase}-ofd`,
          })
        : null;

      return await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.invoiceApplication.findUnique({
            where: { id: input.applicationId },
            include: { items: { orderBy: { createdAt: 'asc' } } },
          });
          if (!current) throw new InvoiceApplicationNotFoundError();
          if (current.status !== 'APPROVED_ISSUING') {
            throw new InvoiceInvalidStateTransitionError(current.status, 'ISSUED');
          }
          const currentItem = current.items.find((item) => item.id === targetItem.id);
          if (!currentItem) throw new InvoiceItemNotFoundError();
          if (currentItem.pdfUrl) throw new InvoiceItemAlreadyIssuedError();

          await tx.invoiceApplicationItem.update({
            where: { id: targetItem.id },
            data: {
              invoiceNumber: invoiceNumber,
              issuingEntity: input.issuingEntity,
              issueDate: input.issueDate,
              issuedAt: new Date(),
              pdfUrl,
              ofdUrl,
            },
          });

          const items = await tx.invoiceApplicationItem.findMany({
            where: { applicationId: input.applicationId },
            orderBy: { createdAt: 'asc' },
          });
          const allIssued = items.length > 0 && items.every((item) => Boolean(item.pdfUrl));
          const firstIssued = items.find((item) => item.pdfUrl) ?? currentItem;
          const taxAmountCents = input.taxAmountCents ?? current.taxAmountCents;
          const updated = await tx.invoiceApplication.update({
            where: { id: input.applicationId },
            data: allIssued
              ? {
                  status: 'ISSUED',
                  issuingEntity: input.issuingEntity,
                  invoiceNumber: items.length === 1 ? invoiceNumber : current.invoiceNumber,
                  issueDate: input.issueDate,
                  dueDate: null,
                  issuedAt: new Date(),
                  pdfUrl: firstIssued.pdfUrl ?? pdfUrl,
                  ofdUrl: firstIssued.ofdUrl ?? ofdUrl,
                  taxAmountCents,
                  totalCents: current.subtotalCents + taxAmountCents,
                }
              : {
                  taxAmountCents,
                  totalCents: current.subtotalCents + taxAmountCents,
                },
            include: { items: { orderBy: { createdAt: 'asc' } } },
          });

          await this.eventService.record(
            {
              applicationId: input.applicationId,
              fromStatus: 'APPROVED_ISSUING',
              toStatus: allIssued ? 'ISSUED' : 'APPROVED_ISSUING',
              actorType: 'ADMIN',
              actorId: input.adminId,
              metadata: {
                invoiceNumber: invoiceNumber,
                itemId: targetItem.id,
                orderId: targetItem.orderId,
                pdfUrl,
                ofdUrl,
                pdfFilename: input.pdfFile.filename,
                ofdFilename: input.ofdFile?.filename ?? null,
                manualUpload: true,
              },
            },
            tx,
          );
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      await this.cleanupUploadedInvoiceObjects([pdfUrl, ofdUrl]);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new InvoiceNumberAlreadyUsedError(invoiceNumber);
      }
      throw err;
    }
  }

  private async findInvoiceNumberOwner(
    invoiceNumber: string,
    except: { applicationId: string; itemId: string },
  ) {
    const match = { equals: invoiceNumber, mode: 'insensitive' as const };
    const appOwner = await this.prisma.invoiceApplication.findFirst({
      where: { invoiceNumber: match },
      select: { id: true, applicationNo: true, status: true, items: { select: { id: true } } },
    });
    if (appOwner && appOwner.id !== except.applicationId) {
      return { applicationNo: appOwner.applicationNo, status: appOwner.status };
    }
    const itemOwner = await this.prisma.invoiceApplicationItem.findFirst({
      where: { invoiceNumber: match, id: { not: except.itemId } },
      select: {
        application: { select: { applicationNo: true, status: true } },
      },
    });
    if (itemOwner?.application) return itemOwner.application;
    if (appOwner?.id === except.applicationId && appOwner.items.some((item) => item.id !== except.itemId)) {
      return { applicationNo: appOwner.applicationNo, status: appOwner.status };
    }
    return null;
  }

  private async cleanupUploadedInvoiceObjects(urls: Array<string | null | undefined>) {
    const targets = urls.filter((url): url is string => Boolean(url));
    await Promise.all(targets.map(async (url) => {
      try {
        await this.storageService.deleteObject(url);
      } catch (err) {
        this.logger.warn(
          `cleanup uploaded invoice object failed url=${url}: ${(err as Error).message}`,
        );
      }
    }));
  }

  voidApplication(applicationId: string, adminId: string, reason: string) {
    return this.transitionStatus({
      applicationId,
      from: ['ISSUED'],
      to: 'VOIDED',
      actorId: adminId,
      reason,
      updateData: { voidReason: reason },
    });
  }

  redOffsetApplication(applicationId: string, adminId: string, reason: string) {
    return this.transitionStatus({
      applicationId,
      from: ['ISSUED'],
      to: 'RED_OFFSET',
      actorId: adminId,
      reason,
      updateData: { voidReason: reason },
    });
  }

  failApplication(applicationId: string, adminId: string, reason: string) {
    return this.transitionStatus({
      applicationId,
      from: ['APPROVED_ISSUING'],
      to: 'FAILED',
      actorId: adminId,
      reason,
      updateData: { failedReason: reason },
    });
  }

  private async transitionStatus(input: {
    applicationId: string;
    from: InvoiceApplicationStatus[];
    to: InvoiceApplicationStatus;
    actorId: string;
    actorType?: InvoiceActorType;
    reason?: string | null;
    updateData?: Prisma.InvoiceApplicationUpdateInput;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const application = await tx.invoiceApplication.findUnique({
        where: { id: input.applicationId },
      });
      if (!application) throw new InvoiceApplicationNotFoundError();
      if (!input.from.includes(application.status)) {
        throw new InvoiceInvalidStateTransitionError(application.status, input.to);
      }
      const updated = await tx.invoiceApplication.update({
        where: { id: input.applicationId },
        data: { status: input.to, ...(input.updateData ?? {}) },
        include: { items: true },
      });
      await this.eventService.record(
        {
          applicationId: input.applicationId,
          fromStatus: application.status,
          toStatus: input.to,
          actorType: input.actorType ?? 'ADMIN',
          actorId: input.actorId,
          reason: input.reason ?? null,
        },
        tx,
      );
      return updated;
    });
  }
}

function psaRetryStaleBefore(): Date {
  return new Date(Date.now() - 60_000);
}

function itemOrderId(item: PsaMappableInvoiceApplication['items'][number]): string {
  return item.orderId?.trim() || item.order?.id?.trim() || '';
}

function asEventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function collectSubmittedPsaOrderNos(
  events: Array<{ metadata?: unknown }> | undefined,
): Set<string> {
  const submitted = new Set<string>();
  for (const event of events ?? []) {
    const metadata = asEventRecord(event.metadata);
    if (String(metadata.psaStatus ?? '') !== 'SUBMITTED') continue;
    const orderNo = typeof metadata.psaOrderNo === 'string' ? metadata.psaOrderNo.trim() : '';
    if (orderNo) submitted.add(orderNo);
  }
  return submitted;
}

function collectSubmittedPsaFormNos(
  events: Array<{ metadata?: unknown }> | undefined,
): string[] {
  const formNos: string[] = [];
  const seen = new Set<string>();
  for (const event of events ?? []) {
    const metadata = asEventRecord(event.metadata);
    if (String(metadata.psaStatus ?? '') !== 'SUBMITTED') continue;
    const formNo = typeof metadata.psaFormNo === 'string' ? metadata.psaFormNo.trim() : '';
    if (!formNo || seen.has(formNo)) continue;
    seen.add(formNo);
    formNos.push(formNo);
  }
  return formNos;
}

function joinPsaFormNos(formNos: string[]): string | null {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const formNo of formNos) {
    const value = formNo.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values.length > 0 ? values.join(', ') : null;
}



function normalizeInvoiceNumber(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function collectIssuedPdfFiles(application: {
  applicationNo: string;
  invoiceNumber?: string | null;
  pdfUrl?: string | null;
  items?: Array<{ orderId: string; invoiceNumber?: string | null; pdfUrl?: string | null }>;
}): Array<{ name: string; pdfUrl: string }> {
  const itemFiles = (application.items ?? [])
    .filter((item) => Boolean(item.pdfUrl))
    .map((item) => ({
      name: String(item.invoiceNumber || item.orderId || application.applicationNo).replace(/[^a-zA-Z0-9._-]/g, '_'),
      pdfUrl: item.pdfUrl as string,
    }));
  if (itemFiles.length > 0) return itemFiles;
  if (application.pdfUrl) {
    return [{
      name: String(application.invoiceNumber || application.applicationNo).replace(/[^a-zA-Z0-9._-]/g, '_'),
      pdfUrl: application.pdfUrl,
    }];
  }
  return [];
}

function resolveIssueTargetItem<T extends { id: string; pdfUrl?: string | null }>(
  items: T[],
  itemId?: string | null,
): T {
  if (itemId) {
    const matched = items.find((item) => item.id === itemId);
    if (!matched) throw new InvoiceItemNotFoundError();
    return matched;
  }
  if (items.length > 1) throw new InvoiceItemUploadRequiredError();
  if (items.length === 0) throw new InvoiceItemNotFoundError();
  return items[0];
}

function assertUploadedInvoiceFile(
  file: UploadedInvoiceFileInput,
  expected: 'pdf' | 'ofd',
) {
  const buffer = file.buffer;
  if (!buffer?.length) throw new InvoiceInvalidUploadedFileError('上传票据文件不能为空');
  if (expected === 'pdf') {
    const header = buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      throw new InvoiceInvalidUploadedFileError('发票 PDF 文件格式不正确');
    }
    return;
  }
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (
      (buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08)
    );
  if (!isZip) {
    throw new InvoiceInvalidUploadedFileError('OFD 文件格式不正确');
  }
}

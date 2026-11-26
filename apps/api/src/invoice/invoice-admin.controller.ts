import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { ApiResponse, PaginatedResult } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from '../billing-runtime/billing-internal.guard';
import {
  AdminDownloadInvoicesDto,
  AdminListApplicationsQuery,
  ApproveApplicationDto,
  IssueUploadedApplicationDto,
  RepairInternationalRechargeInvoicesDto,
  RejectApplicationDto,
  VoidOrRedOffsetDto,
  adminDownloadInvoicesDtoSchema,
  adminListApplicationsQuerySchema,
  approveApplicationDtoSchema,
  issueUploadedApplicationDtoSchema,
  repairInternationalRechargeInvoicesDtoSchema,
  rejectApplicationDtoSchema,
  voidOrRedOffsetDtoSchema,
} from './invoice.dto';
import { InvoiceService } from './invoice.service';

function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, message: 'ok', data };
}

function requireAdminId(adminId: string | undefined): string {
  const trimmed = adminId?.trim();
  if (!trimmed) {
    throw new BadRequestException({ code: 40021, message: '缺少管理员上下文' });
  }
  return trimmed;
}

function decodeUploadedFile(file: IssueUploadedApplicationDto['pdfFile']) {
  return {
    filename: file.filename,
    contentType: file.contentType ?? null,
    buffer: Buffer.from(file.base64, 'base64'),
  };
}

@ApiTags('Invoice Admin')
@Controller('internal/billing/admin/invoices')
@Public()
@UseGuards(BillingInternalGuard)
export class InvoiceAdminController {
  constructor(private readonly service: InvoiceService) {}

  @Get()
  async list(
    @Query() query: Record<string, string>,
  ): Promise<ApiResponse<PaginatedResult<unknown>>> {
    const parsed = adminListApplicationsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const filter = parsed.data as AdminListApplicationsQuery;
    const result = await this.service.adminListApplications(filter);
    return ok(result);
  }

  /**
   * 批量下载已开票 PDF（zip）。单选/多选统一传 ids 数组，返回 application/zip 二进制。
   * 注意：放在 :id 路由之前以免被参数路由吞掉（download 是固定段）。
   * 这是税票 PDF 打包，不要把 PSA Invoice xlsx 混进这个 zip。
   */
  @Post('download')
  async downloadZip(
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = adminDownloadInvoicesDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const { ids } = parsed.data as AdminDownloadInvoicesDto;
    const { zip, included, skipped } = await this.service.buildInvoicesZip(ids);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="invoices-${stamp}.zip"`)
      .header('X-Invoices-Included', String(included))
      .header('X-Invoices-Skipped', String(skipped.length));
    await reply.send(zip);
  }

  @Get('deployment')
  async deployment(): Promise<ApiResponse<{ deployment: 'domestic' | 'international' }>> {
    return ok({ deployment: await this.service.resolveDeployment() });
  }

  @Post('repair-international-recharge-amounts')
  async repairInternationalRechargeAmounts(
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = repairInternationalRechargeInvoicesDtoSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as RepairInternationalRechargeInvoicesDto;
    const result = await this.service.repairInternationalRechargeInvoices({
      adminId: aid,
      dryRun: data.dryRun,
      applicationIds: data.applicationIds,
      limit: data.limit,
    });
    return ok(result);
  }

  /**
   * 海外 PSA Invoice xlsx 字节流。AWS 中国区禁止 presigned URL，由 billing 读对象存储后下发。
   * 已落盘则直接读 S3；国际区缺失时现场生成并写入对象存储，方便详情页展示地址。
   */
  @Get(':id/psa-attachment')
  async downloadPsaAttachment(
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.service.readOverseasInvoiceAttachment(id);
    reply
      .header('Content-Type', file.contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      )
      .header('Content-Length', String(file.buffer.length))
      .header('Cache-Control', 'private, no-store');
    await reply.send(file.buffer);
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const app = await this.service.adminGetApplication(id);
    return ok(app);
  }

  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = approveApplicationDtoSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as ApproveApplicationDto;
    const app = await this.service.approveApplication(id, aid, data.remark ?? null);
    return ok(app);
  }

  @Post(':id/psa-retry')
  // 重试仍走 submitToPsa；海外每次重生 xlsx 并覆盖对象存储，不改此路由契约。
  async retryPsa(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const aid = requireAdminId(adminId);
    const app = await this.service.retryPsaSubmission(id, aid);
    return ok(app);
  }

  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = rejectApplicationDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as RejectApplicationDto;
    const app = await this.service.rejectApplication(id, aid, data.reason);
    return ok(app);
  }

  @Post(':id/issue-upload')
  async issueUpload(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = issueUploadedApplicationDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as IssueUploadedApplicationDto;
    const app = await this.service.issueUploadedApplication({
      applicationId: id,
      adminId: aid,
      invoiceNumber: data.invoiceNumber,
      issuingEntity: data.issuingEntity,
      issueDate: data.issueDate,
      taxAmountCents: data.taxAmountCents ?? null,
      itemId: data.itemId ?? null,
      pdfFile: decodeUploadedFile(data.pdfFile),
      ofdFile: data.ofdFile ? decodeUploadedFile(data.ofdFile) : null,
    });
    return ok(app);
  }

  @Post(':id/items/:itemId/issue-upload')
  async issueItemUpload(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = issueUploadedApplicationDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as IssueUploadedApplicationDto;
    const app = await this.service.issueUploadedApplication({
      applicationId: id,
      adminId: aid,
      invoiceNumber: data.invoiceNumber,
      issuingEntity: data.issuingEntity,
      issueDate: data.issueDate,
      taxAmountCents: data.taxAmountCents ?? null,
      itemId,
      pdfFile: decodeUploadedFile(data.pdfFile),
      ofdFile: data.ofdFile ? decodeUploadedFile(data.ofdFile) : null,
    });
    return ok(app);
  }

  @Post(':id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = voidOrRedOffsetDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as VoidOrRedOffsetDto;
    const app = await this.service.voidApplication(id, aid, data.reason);
    return ok(app);
  }

  @Post(':id/red-offset')
  async redOffset(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = voidOrRedOffsetDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as VoidOrRedOffsetDto;
    const app = await this.service.redOffsetApplication(id, aid, data.reason);
    return ok(app);
  }

  @Post(':id/fail')
  async fail(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser('id') adminId: string | undefined,
  ): Promise<ApiResponse<unknown>> {
    const parsed = voidOrRedOffsetDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const aid = requireAdminId(adminId);
    const data = parsed.data as VoidOrRedOffsetDto;
    const app = await this.service.failApplication(id, aid, data.reason);
    return ok(app);
  }

}

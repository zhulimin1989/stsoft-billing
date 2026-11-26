import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { ApiResponse, PaginatedResult } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { InvoiceStorageService } from './invoice-storage.service';
import {
  CreateProfileDto,
  ListInvoiceablePeriodsQuery,
  ListApplicationsQuery,
  SubmitApplicationDto,
  SubmitPeriodApplicationDto,
  UpdateProfileDto,
  createProfileDtoSchema,
  listInvoiceablePeriodsQuerySchema,
  listApplicationsQuerySchema,
  submitApplicationDtoSchema,
  submitPeriodApplicationDtoSchema,
  updateProfileDtoSchema,
} from './invoice.dto';
import { InvoiceService, InvoiceablePeriod, InvoiceablePurchase } from './invoice.service';
import { InvoiceProfileService } from './invoice-profile.service';

const TENANT_HEADER = 'x-tenant-id';

function requireTenant(tenantId: string | undefined): string {
  const trimmed = tenantId?.trim();
  if (!trimmed) {
    throw new BadRequestException({ code: 40020, message: '缺少租户上下文（X-Tenant-Id）' });
  }
  return trimmed;
}

function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, message: 'ok', data };
}

@ApiTags('Invoice')
@Controller('billing/invoices')
export class InvoiceController {
  constructor(
    private readonly service: InvoiceService,
    private readonly profiles: InvoiceProfileService,
    private readonly storage: InvoiceStorageService,
  ) {}

  // ============================
  // Profiles 抬头
  // ============================

  @Get('profiles')
  async listProfiles(
    @CurrentUser('id') userId: string,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown[]>> {
    const tid = requireTenant(tenantId);
    const profiles = await this.profiles.list(userId, tid);
    return ok(profiles);
  }

  @Post('profiles')
  async createProfile(
    @CurrentUser('id') userId: string,
    @Body() body: unknown,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const parsed = createProfileDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const profile = await this.profiles.create({
      userId,
      tenantId: tid,
      ...(parsed.data as CreateProfileDto),
    });
    return ok(profile);
  }

  @Put('profiles/:id')
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const parsed = updateProfileDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const updated = await this.profiles.update(userId, tid, id, parsed.data as UpdateProfileDto);
    return ok(updated);
  }

  @Delete('profiles/:id')
  async deleteProfile(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<{ ok: true }>> {
    const tid = requireTenant(tenantId);
    await this.profiles.softDelete(userId, tid, id);
    return ok({ ok: true } as const);
  }

  // ============================
  // 可开票订单
  // ============================

  @Get('invoiceable-purchases')
  async listInvoiceable(
    @CurrentUser('id') userId: string,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<InvoiceablePurchase[]>> {
    const tid = requireTenant(tenantId);
    const purchases = await this.service.listInvoiceablePurchases(userId, tid);
    return ok(purchases);
  }

  @Get('invoiceable-periods')
  async listInvoiceablePeriods(
    @CurrentUser('id') userId: string,
    @Query() query: Record<string, string>,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<InvoiceablePeriod[]>> {
    const parsed = listInvoiceablePeriodsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const data = parsed.data as ListInvoiceablePeriodsQuery;
    const periods = await this.service.listInvoiceablePeriods({
      userId,
      tenantId: tid,
      year: data.year,
      month: data.month,
      description: data.description,
    });
    return ok(periods);
  }

  // ============================
  // 申请
  // ============================

  @Post()
  async submit(
    @CurrentUser('id') userId: string,
    @Body() body: unknown,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const parsed = submitApplicationDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const data = parsed.data as SubmitApplicationDto;
    const app = await this.service.submitApplication({
      userId,
      tenantId: tid,
      profileId: data.profileId,
      idempotencyKey: data.idempotencyKey,
      items: data.items.map((i) => ({
        orderId: i.orderId,
        description: i.description,
        poNumber: i.poNumber ?? null,
        serviceStart: i.serviceStart ?? null,
        serviceEnd: i.serviceEnd ?? null,
      })),
    });
    return ok(app);
  }

  @Post('periods')
  async submitPeriod(
    @CurrentUser('id') userId: string,
    @Body() body: unknown,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const parsed = submitPeriodApplicationDtoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const data = parsed.data as SubmitPeriodApplicationDto;
    const app = await this.service.submitPeriodApplication({
      userId,
      tenantId: tid,
      profileId: data.profileId,
      period: data.period,
      idempotencyKey: data.idempotencyKey,
      description: data.description,
      poNumber: data.poNumber ?? null,
    });
    return ok(app);
  }

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: Record<string, string>,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<PaginatedResult<unknown>>> {
    const parsed = listApplicationsQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const tid = requireTenant(tenantId);
    const filter = parsed.data as ListApplicationsQuery;
    const result = await this.service.listApplications(userId, tid, filter);
    return ok(result);
  }

  @Get(':id')
  async detail(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const tid = requireTenant(tenantId);
    const app = await this.service.getApplication(userId, tid, id);
    return ok(app);
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<ApiResponse<unknown>> {
    const tid = requireTenant(tenantId);
    const app = await this.service.cancelApplication(userId, tid, id);
    return ok(app);
  }

  /**
   * 直接以字节流返回发票 PDF（校验归属后，服务端 header 鉴权读对象再代理下发）。
   *
   * 背景：AWS 中国区 S3 拒绝 presigned（query-string 鉴权）URL，浏览器直连会收到
   * HTTP 401 `UnauthorizedAccess`（与 IAM 权限无关，是平台行为）。故发票下载一律
   * 由服务端用 IRSA 凭证 header 鉴权读出字节再下发，浏览器不直连对象存储。
   * （旧的返回 presigned URL 的 `/pdf` 端点已下线。）
   */
  @Get(':id/pdf/content')
  async downloadPdf(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
    @Headers(TENANT_HEADER) tenantId?: string,
  ): Promise<void> {
    const tid = requireTenant(tenantId);
    const file = await this.service.readUserInvoiceDownload(userId, tid, id);
    if (!file) {
      throw new NotFoundException({ code: 40430, message: '发票 PDF 尚未生成' });
    }
    reply
      .header('Content-Type', file.contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .header('Content-Length', String(file.buffer.length))
      .header('Cache-Control', 'private, no-store')
      .send(file.buffer);
  }
}

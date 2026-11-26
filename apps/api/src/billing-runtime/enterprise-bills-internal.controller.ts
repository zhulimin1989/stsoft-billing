import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from './billing-internal.guard';
import { EnterpriseBillsService } from '../billing/enterprise-bills.service';
import { normalizeAdjustReason } from '../billing/enterprise-bills.policy';

@ApiTags('Enterprise Bills V2 (internal)')
@Controller('internal/billing/admin/v2/enterprise-accounts')
@Public()
@UseGuards(BillingInternalGuard)
export class EnterpriseBillsInternalController {
  constructor(
    private readonly bills: EnterpriseBillsService,
  ) {}

  @Get('/')
  async summarize(
    @Req() req: FastifyRequest,
    @Query('ids') ids?: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const accountIds = (ids ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    const data = await this.bills.summarizeAccounts(accountIds, new Date());
    return { code: 0, message: 'ok', data: { items: data } };
  }

  @Get('/:id/bills')
  async listBills(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('canManage') canManage?: string,
    @Query('button_visible') buttonVisibleRaw?: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const buttonVisible = parseButtonVisible(buttonVisibleRaw);
    const data = await this.bills.listBills(id, {
      now: new Date(),
      canManage: canManage !== 'false',
    });
    return {
      code: 0,
      message: 'ok',
      data: {
        items: applyBillActionButtonGate(data, buttonVisible),
        buttonVisible,
      },
    };
  }

  @Post('/:id/bills/:yearMonth/write-off')
  async writeOff(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('yearMonth') yearMonth: string,
    @Body() body: { amountCents?: number; note?: string | null; canManage?: boolean; idempotencyKey?: string },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.bills.writeOff(id, yearMonth, {
      amountCents: requirePositiveCents(body?.amountCents, '核销金额'),
      note: body?.note,
      actorId: adminId(req),
      canManage: body?.canManage !== false,
      now: new Date(),
      idempotencyKey: requireIdempotencyKey(body?.idempotencyKey),
    });
    return { code: 0, message: 'ok', data };
  }

  @Post('/:id/bills/:yearMonth/adjust')
  async adjust(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('yearMonth') yearMonth: string,
    @Body() body: {
      direction?: 'increase' | 'decrease';
      amountCents?: number;
      note?: string | null;
      canManage?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const direction = body?.direction;
    if (direction !== 'increase' && direction !== 'decrease') {
      throw new BadRequestException('direction 必须是 increase 或 decrease');
    }
    const normalized = normalizeAdjustReason(body?.note);
    if (!normalized.ok) {
      throw new BadRequestException(normalized.message);
    }
    const data = await this.bills.adjust(id, yearMonth, {
      direction,
      amountCents: requirePositiveCents(body?.amountCents, '调整金额'),
      note: normalized.reason,
      actorId: adminId(req),
      canManage: body?.canManage !== false,
      now: new Date(),
      idempotencyKey: requireIdempotencyKey(body?.idempotencyKey),
    });
    return { code: 0, message: 'ok', data };
  }

  @Post('/:id/bills/:yearMonth/compensate-voucher')
  async compensateVoucher(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('yearMonth') yearMonth: string,
    @Body() body: {
      amountCents?: number;
      note?: string | null;
      productId?: string;
      tenantId?: string | null;
      idempotencyKey?: string;
      canManage?: boolean;
    },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const productId = typeof body?.productId === 'string' ? body.productId.trim() : '';
    if (!productId) {
      throw new BadRequestException('productId 不能为空');
    }
    const data = await this.bills.compensateVoucher(id, yearMonth, {
      amountCents: requirePositiveCents(body?.amountCents, '补偿金额'),
      note: body?.note,
      productId,
      tenantId: body?.tenantId ?? null,
      actorId: adminId(req),
      canManage: body?.canManage !== false,
      now: new Date(),
      idempotencyKey: requireIdempotencyKey(body?.idempotencyKey),
    });
    return { code: 0, message: 'ok', data };
  }

  @Post('/:id/bills/:yearMonth/extend')
  async extend(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Param('yearMonth') yearMonth: string,
    @Body() body: { dueAt?: string; canManage?: boolean; idempotencyKey?: string },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const dueAt = body?.dueAt ? new Date(body.dueAt) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) {
      throw new BadRequestException('新的账期截止时间无效');
    }
    const data = await this.bills.extend(id, yearMonth, {
      newDueAt: dueAt,
      actorId: adminId(req),
      canManage: body?.canManage !== false,
      now: new Date(),
      idempotencyKey: requireIdempotencyKey(body?.idempotencyKey),
    });
    return { code: 0, message: 'ok', data };
  }

  @Get('/:id/bills/:yearMonth/download')
  async download(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
    @Param('yearMonth') yearMonth: string,
  ): Promise<void> {
    this.requireAdminCaller(req);
    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.raw.once('close', onClose);
    const file = await this.bills.download(id, yearMonth, {
      now: new Date(),
      signal: abort.signal,
    });
    const asciiFallback = file.filename.replace(/[^\x20-\x7E]/g, '_');
    const disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`;
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', disposition);
    // 先 send 再 flushHeaders：Node 默认要等第一个 body 字节才发响应头，
    // 而 xlsx 首字节要等聚合，浏览器这段时间看不到任何下载条目。
    const sent = reply.send(file.stream);
    if (!reply.raw.headersSent) {
      reply.raw.flushHeaders();
    }
    await sent;
  }

  private requireAdminCaller(req: FastifyRequest): void {
    const caller = (req as unknown as { internalCaller?: string }).internalCaller;
    if (caller !== 'admin-api') {
      throw new BadRequestException('无权访问该企业账单资源');
    }
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw new BadRequestException('idempotencyKey 不能为空');
  }
  return key;
}

function requirePositiveCents(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`${label}必须大于 0`);
  }
  return value;
}

function adminId(req: FastifyRequest): string {
  const user = (req as unknown as { user?: { id?: string } }).user;
  return user?.id || 'admin';
}

/** 缺省 false；仅显式 true/1 为 true。 */
function parseButtonVisible(raw?: string): boolean {
  if (raw == null || raw.trim() === '') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

const BILL_ACTIONS_CLOSED_REASON = '账单操作已关闭';

type BillActionGateRow = {
  writeOffDisabledReason: string | null;
  adjustDisabledReason: string | null;
  extendDisabledReason: string | null;
  compensateDisabledReason: string | null;
};

/** button_visible=false 时强制置灰核销/调整/延期/补偿发券（保留已有 reason）。 */
function applyBillActionButtonGate<T extends BillActionGateRow>(
  bills: T[],
  buttonVisible: boolean,
): T[] {
  if (buttonVisible) return bills;
  return bills.map((bill) => ({
    ...bill,
    writeOffDisabledReason: bill.writeOffDisabledReason ?? BILL_ACTIONS_CLOSED_REASON,
    adjustDisabledReason: bill.adjustDisabledReason ?? BILL_ACTIONS_CLOSED_REASON,
    extendDisabledReason: bill.extendDisabledReason ?? BILL_ACTIONS_CLOSED_REASON,
    compensateDisabledReason: bill.compensateDisabledReason ?? BILL_ACTIONS_CLOSED_REASON,
  }));
}

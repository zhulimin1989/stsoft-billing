import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { FastifyRequest } from 'fastify';
import { Public } from '../common/decorators/public.decorator';
import {
  AttachTenantInput,
  CreateEnterpriseAccountInput,
  EnterpriseAccountService,
  TransferEnterpriseOwnerInput,
  UpdateEnterpriseCreditInput,
  UpdateEnterpriseSnapshotInput,
  UpsertOwnerMemberInput,
} from '../billing/enterprise-account.service';
import {
  BALANCE_ADJUSTMENT_REASON_CODES,
  BillingService,
  type BalanceAdjustmentReasonCode,
} from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingInternalGuard } from './billing-internal.guard';

type InternalCaller = 'admin-api' | 'user-api';
const MAX_ENTERPRISE_RECHARGE_CENTS = 25_000 * 100;

/**
 * 企业账户 internal controller（M0，见方案 §10.2.4）。
 *
 * 鉴权模型（§10.2.4 修正版 / §10.7-①）：
 * - 本 controller 是内部 token 入口（@Public() + BillingInternalGuard），由 admin-api / user-api
 *   服务端到服务端调用；调用方不携带 admin 浏览器 JWT，因此本层不挂 @RequireAdminPermission。
 * - admin 权限点校验统一放在 admin-api proxy 层（§10.2.6），不在这里。
 * - 本 controller 只做两件事：① guard 校验 caller+token（已由 BillingInternalGuard 完成，
 *   user-api 白名单在 §10.2.5）；② 对 user-api caller 在 service 层做 tenant owner / verificationId
 *   归属校验（本文件内联实现）。
 */
@ApiTags('Enterprise Accounts (internal)')
@Controller('internal/billing/admin/enterprise-accounts')
@Public()
@UseGuards(BillingInternalGuard)
export class EnterpriseAccountInternalController {
  constructor(
    private readonly enterpriseAccounts: EnterpriseAccountService,
    private readonly billingService: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  // Minimal read-only contract for user-api preflight and historical auditing.
  @Post('/subject-check')
  async subjectCheck(@Req() req: FastifyRequest, @Body() body: { uscc?: unknown }): Promise<ApiResponse<unknown>> {
    this.caller(req);
    if (!body || Object.keys(body).some((key) => key !== 'uscc')) {
      throw new BadRequestException({ code: 'enterprise_uscc_invalid', message: '仅接受规范信用代码', data: null });
    }
    const data = await this.enterpriseAccounts.checkEnterpriseSubject(body.uscc);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Get('/')
  async list(
    @Req() req: FastifyRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('ownerUserId') ownerUserId?: string,
    @Query('uscc') uscc?: string,
    @Query('search') search?: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const parsedPage = page ? Number.parseInt(page, 10) : undefined;
    const parsedPageSize = pageSize ? Number.parseInt(pageSize, 10) : undefined;
    const data = await this.enterpriseAccounts.listEnterpriseAccounts({
      page: Number.isFinite(parsedPage as number) ? parsedPage : undefined,
      pageSize: Number.isFinite(parsedPageSize as number) ? parsedPageSize : undefined,
      status: status ?? null,
      ownerUserId: ownerUserId ?? null,
      uscc: uscc ?? null,
      search: search ?? null,
    });
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api：用户详情页「可用金额」卡片（个人账户 + 每个企业账户）
  @Get('/owners/:userId/available-amounts')
  async getOwnerAvailableAmounts(
    @Req() req: FastifyRequest,
    @Param('userId') userId: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.getOwnerAvailableAmounts(userId);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Get('/:id')
  async detail(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.getEnterpriseAccount(id);
    return { code: 0, message: 'ok', data };
  }

  @Post('/provisioning-proof')
  async provisioningProof(@Req() req: FastifyRequest, @Body() body: { verificationId: string; accountId: string; tenantId: string; ownerUserId: string }): Promise<ApiResponse<unknown>> {
    this.caller(req);
    const keys = ['verificationId', 'accountId', 'tenantId', 'ownerUserId'];
    if (!body || Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key))) {
      throw new BadRequestException({ code: 'enterprise_proof_invalid', message: '仅接受开通资源引用', data: null });
    }
    return { code: 0, message: 'ok', data: await this.enterpriseAccounts.provisioningProof(body) };
  }

  // 仅 admin-api
  @Get('/:id/credit')
  async getCredit(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.getEnterpriseCredit(id);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Put('/:id/credit')
  async updateCredit(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: UpdateEnterpriseCreditInput,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.updateEnterpriseCredit(id, body);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Get('/:id/credit-events')
  async listCreditEvents(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const data = await this.enterpriseAccounts.listEnterpriseCreditEvents(id, {
      limit: Number.isFinite(parsedLimit as number) ? parsedLimit : undefined,
      cursor: cursor ?? null,
    });
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Post('/:id/recharge')
  async recharge(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body()
    body: {
      amountCents?: number;
      productId?: string | null;
      description?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const amountCents = assertEnterpriseRechargeAmount(body?.amountCents);
    const productId = requireString(body?.productId, 'productId');
    await this.assertRechargeProduct(productId);
    const idempotencyKey = requireString(body?.idempotencyKey, 'idempotencyKey');
    const description = normalizeDescription(body?.description) || '企业账户管理员充值';
    const anchor = await this.enterpriseAccounts.resolveFundingAnchor(id);
    const data = await this.billingService.adminRecharge(
      anchor.ownerUserId,
      amountCents,
      description,
      productId,
      {
        tenantId: anchor.tenantId,
        billingAccountId: anchor.billingAccountId,
        idempotencyKey,
      },
    );
    await this.enterpriseAccounts.syncEnterpriseAccountKeyBalances(id);
    return { code: 0, message: '充值成功', data };
  }

  // 仅 admin-api。正向调整作为非现金补偿额度，负向调整作为当前账期消费。
  @Post('/:id/balance-adjustment')
  async applyBalanceAdjustment(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body()
    body: {
      amountCents?: number;
      reasonCode?: string | null;
      description?: string | null;
      performedBy?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const amountCents = assertEnterpriseBalanceAdjustmentAmount(body?.amountCents);
    const reasonCode = requireString(body?.reasonCode, 'reasonCode');
    if (!BALANCE_ADJUSTMENT_REASON_CODES.includes(reasonCode as BalanceAdjustmentReasonCode)) {
      throw new BadRequestException('reasonCode 无效');
    }
    const description = requireString(body?.description, 'description');
    const idempotencyKey = requireString(body?.idempotencyKey, 'idempotencyKey');
    const anchor = await this.enterpriseAccounts.resolveFundingAnchor(id);
    const data = await this.billingService.applyClassifiedBalanceAdjustment(
      anchor.ownerUserId,
      {
        amountCents,
        reasonCode: reasonCode as BalanceAdjustmentReasonCode,
        description,
        performedBy: body?.performedBy,
        idempotencyKey,
        tenantId: anchor.tenantId,
        billingAccountId: anchor.billingAccountId,
      },
    );
    await this.enterpriseAccounts.syncEnterpriseAccountKeyBalances(id);
    return { code: 0, message: '账单调额成功', data };
  }

  // admin-api / user-api
  @Post('/')
  async create(
    @Req() req: FastifyRequest,
    @Body() body: CreateEnterpriseAccountInput,
  ): Promise<ApiResponse<unknown>> {
    const caller = this.caller(req);
    if (caller === 'user-api') {
      // user-api 自助开通:必须带 tenantId,且该 tenant 归属人 === body.userId
      // (即将成为 account owner 的人)。owner 与 tenant 归属一致性由 service 层在 attach 时
      // 再断言一次(纵深防御)。
      if (!body.tenantId) {
        throw this.forbidden();
      }
      await this.assertUserOwnsTenant(body.userId, body.tenantId);
      // 受信边界:billing 无 verification 权威表,verificationId 与 user 的归属校验
      // 由上游 user-api 负责;billing 信任 user-api 已完成该校验,此处不再重复。
      // (仅在冲突/幂等场景下,通过既有账户上的 verification+ownerUserId 快照做一致性兜底。)
    }
    // admin-api:两步开通流程,允许不带 tenantId 先建账户、后 attach;不做 tenant 归属断言。
    const data = await this.enterpriseAccounts.createEnterpriseAccount(body);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Put('/:id')
  async update(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: UpdateEnterpriseSnapshotInput,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.updateEnterpriseSnapshot(id, body);
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Get('/:id/owner-members')
  async listOwnerMembers(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.listOwnerMembers(id);
    return { code: 0, message: 'ok', data: { items: data } };
  }

  // admin-api / user-api
  @Post('/:id/owner-members')
  async upsertOwnerMember(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: UpsertOwnerMemberInput,
  ): Promise<ApiResponse<unknown>> {
    const caller = this.caller(req);
    if (caller === 'user-api') {
      // user-api：仅允许 owner 初始化——成员必须是账户 owner 本人。
      await this.assertUserIsAccountOwner(id, body.userId);
    }
    const data = await this.enterpriseAccounts.upsertOwnerMember(id, body);
    return { code: 0, message: 'ok', data };
  }

  // admin-api / user-api。user-api 已在权威 user 库校验交接资格；billing
  // 仍在同一事务内重验 account + tenant 的旧 owner，防止陈旧请求覆盖新归属。
  @Post('/:id/transfer-owner')
  async transferOwner(
    @Param('id') id: string,
    @Body() body: TransferEnterpriseOwnerInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.enterpriseAccounts.transferEnterpriseOwner(id, body);
    return { code: 0, message: 'ok', data };
  }

  // admin-api / user-api
  @Post('/:id/attach-tenant')
  async attachTenant(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: AttachTenantInput & { userId?: string },
  ): Promise<ApiResponse<unknown>> {
    const caller = this.caller(req);
    if (caller === 'user-api') {
      // 纵深防御(attach 绑定账务主体):owner 一律从账户取,不用 body.userId 做授权判断。
      const ownerUserId = await this.accountOwnerUserId(id);
      // body.userId 仅用于交叉核对,不作为授权依据;不一致直接拒绝。
      if (body.userId && ownerUserId && body.userId !== ownerUserId) {
        throw this.forbidden();
      }
      // 该 tenant 必须归属账户 owner(service.attachTenant 会用 account.ownerUserId 再断言一次)。
      await this.assertUserOwnsTenant(ownerUserId, body.tenantId);
      // Pin the observed Owner through the service's account-row lock, including
      // older callers that omit userId. A concurrent transfer must reject this request.
      body = { ...body, userId: ownerUserId ?? undefined };
    }
    const data = await this.enterpriseAccounts.attachTenant(id, body);
    return { code: 0, message: 'ok', data };
  }

  // ── 议题二批一：企业开通回收（admin-api + user-api 均放行；见 billing-internal.guard 白名单）──
  // 设计依据：me/payg-multiplier-verify-timeout-v2.md §2.2b（唯一真源）
  @Post('/void-provisioning')
  async voidProvisioning(
    @Req() req: FastifyRequest,
    @Body() body: { verificationId: string; reason: string },
  ): Promise<ApiResponse<unknown>> {
    // 回收是**单调收缩**操作（只回收、永不激活/绑定），误调的最坏后果是"多回收一次"而非越权开通；
    // reason 必填以保证审计可追（沿用 detach-tenant 的强制 reason 惯例）。
    const caller = this.caller(req);
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? undefined;
    const data = await this.enterpriseAccounts.voidProvisioning({
      ...body,
      audit: { caller, requestId },
    });
    return { code: 0, message: 'ok', data };
  }

  // 只读核账（供 user 侧重提守卫）。只读端点不要求 reason。
  @Get('/reconcile')
  async reconcile(
    @Req() req: FastifyRequest,
    @Query('verificationId') verificationId: string,
  ): Promise<ApiResponse<unknown>> {
    this.caller(req);
    const data = await this.enterpriseAccounts.reconcileByVerification(verificationId);
    return { code: 0, message: 'ok', data };
  }

  // 只读危害候选集（供 R3-lite 巡检）。nextCursor === null 是唯一终止条件。
  @Get('/hazards')
  async hazards(
    @Req() req: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ApiResponse<unknown>> {
    this.caller(req);
    // 严格校验：`10junk` 之类不得被 parseInt 静默接受。
    let parsed: number | undefined;
    if (limit !== undefined && limit !== '') {
      if (!/^\d+$/.test(limit)) {
        throw new BadRequestException({ code: 'invalid_limit', message: 'limit 必须是正整数', data: null });
      }
      parsed = Number.parseInt(limit, 10);
    }
    const data = await this.enterpriseAccounts.listProvisioningHazards({
      cursor: cursor ?? null,
      limit: parsed,
    });
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api（proxy 层要求 admin.system.manage + 强制 reason）
  @Post('/:id/detach-tenant')
  async detachTenant(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { tenantId: string; reason: string },
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.detachTenantForRecovery(
      id,
      body.tenantId,
      body.reason,
    );
    return { code: 0, message: 'ok', data };
  }

  // 仅 admin-api
  @Get('/:id/tenants')
  async listTenants(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    this.requireAdminCaller(req);
    const data = await this.enterpriseAccounts.listTenants(id);
    return { code: 0, message: 'ok', data: { items: data } };
  }

  // ---------------------------------------------------------------------------
  // caller / ownership helpers
  // ---------------------------------------------------------------------------

  private caller(req: FastifyRequest): InternalCaller {
    const caller = (req as unknown as { internalCaller?: InternalCaller }).internalCaller;
    // guard 已保证 caller 存在且路由允许；这里只是取值。
    return caller === 'user-api' ? 'user-api' : 'admin-api';
  }

  private requireAdminCaller(req: FastifyRequest): void {
    if (this.caller(req) !== 'admin-api') {
      // 与 guard 白名单一致：user-api 不应到达这些端点；防御性再拒一次。
      throw this.forbidden();
    }
  }

  private async assertUserOwnsTenant(
    userId: string | null | undefined,
    tenantId: string | null | undefined,
  ): Promise<void> {
    if (!userId || !tenantId) {
      throw this.forbidden();
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { ownerUserId: true },
    });
    if (!tenant || tenant.ownerUserId !== userId) {
      throw this.forbidden();
    }
  }

  private async assertUserIsAccountOwner(
    accountId: string,
    userId: string | null | undefined,
  ): Promise<void> {
    if (!userId) {
      throw this.forbidden();
    }
    const account = await this.prisma.billingAccount.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { ownerUserId: true },
    });
    if (!account || account.ownerUserId !== userId) {
      throw this.forbidden();
    }
  }

  private async accountOwnerUserId(accountId: string): Promise<string | null> {
    const account = await this.prisma.billingAccount.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { ownerUserId: true },
    });
    return account?.ownerUserId ?? null;
  }

  private async assertRechargeProduct(productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, billingMode: true, isActive: true },
    });
    if (!product) {
      throw new BadRequestException('充值产品不存在');
    }
    if (!product.isActive || product.billingMode !== 'PAY_AS_YOU_GO') {
      throw new BadRequestException('充值产品必须是启用中的按量产品');
    }
  }

  private forbidden(): HttpException {
    return new HttpException(
      { code: 'internal_caller_forbidden', message: '无权访问该企业账户资源' },
      403,
    );
  }
}

function assertEnterpriseRechargeAmount(amountCents: unknown): number {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    throw new BadRequestException('amountCents 必须为整数分值');
  }
  if (amountCents <= 0) {
    throw new BadRequestException('充值金额必须大于 0');
  }
  if (amountCents > MAX_ENTERPRISE_RECHARGE_CENTS) {
    throw new BadRequestException('单次充值不能超过 25,000.00');
  }
  return amountCents;
}

function assertEnterpriseBalanceAdjustmentAmount(amountCents: unknown): number {
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    throw new BadRequestException('amountCents 必须为整数分值');
  }
  if (amountCents === 0) {
    throw new BadRequestException('调额金额不能为 0');
  }
  if (Math.abs(amountCents) > MAX_ENTERPRISE_RECHARGE_CENTS) {
    throw new BadRequestException('单次调额不能超过 25,000.00');
  }
  return amountCents;
}

function requireString(value: unknown, fieldName: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new BadRequestException(`${fieldName} 不能为空`);
  }
  return text;
}

function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

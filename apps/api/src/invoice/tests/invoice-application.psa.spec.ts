import { InvoiceApplicationService } from '../invoice-application.service';
import { InvoicePsaNotEnabledError, InvoicePsaRetryNotAllowedError, InvoiceInvalidStateTransitionError, InvoicePsaAttachmentNotFoundError } from '../invoice.errors';
import { PsaInvoiceClient } from '../psa-invoice.client';
import { PSA_DOMESTIC_PROFILE, PSA_FOREIGN_PROFILE } from '../psa-invoice.profile';

const ORIGINAL_ENV = { ...process.env };

function applyData(row: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as { increment?: unknown })) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if (where.id && row.id !== where.id) return false;
  if (typeof where.status === 'string' && row.status !== where.status) return false;
  if (typeof where.psaStatus === 'string' && row.psaStatus !== where.psaStatus) return false;
  const psaStatus = where.psaStatus as { in?: string[] } | undefined;
  if (psaStatus?.in && !psaStatus.in.includes(String(row.psaStatus))) return false;
  if (Array.isArray(where.OR)) {
    const ok = (where.OR as Array<Record<string, unknown>>).some((clause) => matchesWhere(row, clause));
    if (!ok) return false;
  }
  const lastAttempt = where.psaLastAttemptAt as { lt?: Date } | undefined;
  if (lastAttempt?.lt) {
    const actual = row.psaLastAttemptAt as Date | null;
    if (!actual || !(actual < lastAttempt.lt)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(where, 'psaLastAttemptAt') && where.psaLastAttemptAt === null) {
    if (row.psaLastAttemptAt !== null) return false;
  }
  return true;
}

type InvoiceEventHarness = {
  metadata?: Record<string, unknown> | null;
  reason?: string | null;
};

type InvoiceAppHarness = {
  id: string;
  applicationNo: string;
  userId: string;
  tenantId: string;
  status: string;
  currency: string;
  subtotalCents: number;
  totalCents: number;
  profileSnapshot: Record<string, unknown>;
  psaStatus: string;
  psaFormNo: string | null;
  psaSubmittedAt: Date | null;
  psaLastAttemptAt: Date | null;
  psaAttemptCount: number;
  psaLastError: string | null;
  psaAttachmentUrl: string | null;
  items: Array<Record<string, unknown>>;
  events: InvoiceEventHarness[];
  user: { id: string; email: string; nickname: string };
};

function makeApp(overrides: Partial<InvoiceAppHarness> = {}): InvoiceAppHarness {
  return {
    id: 'app-1',
    applicationNo: 'INV-1',
    userId: 'u1',
    tenantId: 't1',
    status: 'APPROVED_ISSUING',
    currency: 'CNY',
    subtotalCents: 1000,
    totalCents: 1000,
    profileSnapshot: { invoiceType: 'VAT_SPECIAL', title: '测试公司' },
    psaStatus: 'NOT_SUBMITTED',
    psaFormNo: null,
    psaSubmittedAt: null,
    psaLastAttemptAt: null,
    psaAttemptCount: 0,
    psaLastError: null,
    psaAttachmentUrl: null,
    items: [{
      principalCents: 1000,
      description: 'RAYTONE_API',
      productName: '技术服务费',
      serviceStart: new Date('2026-08-01T00:00:00.000Z'),
      serviceEnd: new Date('2026-08-31T15:59:59.999Z'),
      orderId: 'order-1',
      order: { id: 'order-1', amountCents: 1000 },
    }],
    events: [],
    user: { id: 'u1', email: 'u1@example.com', nickname: 'u1' },
    ...overrides,
  };
}

type PsaClientHarness = {
  isEnabled: jest.Mock<boolean, []>;
  apply: jest.Mock;
};

function buildHarness(
  app = makeApp(),
  psaClient?: Partial<PsaClientHarness>,
  loginRegion: 'domestic' | 'international' | Error = 'domestic',
) {
  const applications = [app];
  const prisma: {
    invoiceApplication: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  } = {
    invoiceApplication: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = applications.find((item) => item.id === where.id);
        return row ? { ...row, items: row.items, events: row.events, user: row.user } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = applications.find((item) => item.id === where.id);
        if (!row) throw new Error('not found');
        applyData(row as Record<string, unknown>, data);
        return { ...row, items: row.items };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matched = applications.filter((item) => matchesWhere(item as Record<string, unknown>, where));
        for (const row of matched) applyData(row as Record<string, unknown>, data);
        return { count: matched.length };
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(prisma));
  const eventService = {
    record: jest.fn(async (input: { applicationId: string; metadata?: Record<string, unknown> | null; reason?: string | null }) => {
      const row = applications.find((item) => item.id === input.applicationId);
      if (!row) return;
      row.events.push({
        metadata: input.metadata ?? null,
        reason: input.reason ?? null,
      });
    }),
  };
  const storageService = {
    persist: jest.fn(async (input: { userId: string; keyHint?: string; invoiceNumber: string; extension?: string }) =>
      `invoices/${input.userId}/${input.keyHint ?? input.invoiceNumber}.${input.extension ?? 'pdf'}`),
    readToBuffer: jest.fn(async () => Buffer.from('reused-xlsx')),
  };
  const client: PsaClientHarness = {
    isEnabled: jest.fn(() => true),
    apply: jest.fn(async () => ({ formNo: 'BM26090001' })),
    ...psaClient,
  };
  const overseasTemplate = {
    fill: jest.fn(async (_application?: { items: Array<{ orderId?: string }> }) => ({
      buffer: Buffer.from('generated-xlsx'),
      fileName: 'INV-1.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'PERSONAL' as const,
    })),
  };
  const deployment = {
    resolve: jest.fn(async () => (loginRegion instanceof Error ? 'international' : loginRegion)),
    resolveLoginRegion: jest.fn(async () => {
      if (loginRegion instanceof Error) throw loginRegion;
      return loginRegion;
    }),
  };
  const service = new InvoiceApplicationService(
    prisma as never,
    eventService as never,
    storageService as never,
    deployment as never,
    client as unknown as PsaInvoiceClient,
    overseasTemplate as never,
  );
  return { service, prisma, eventService, client, applications, deployment, storageService, overseasTemplate };
}

describe('InvoiceApplicationService PSA submission', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.PSA_APPLY_EMP_NO = '343546';
    process.env.PSA_ISOFTSTONE_EMAIL = 'wangzhangk@isoftstone.com';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('approve submits to PSA after PENDING_REVIEW → APPROVED_ISSUING', async () => {
    const { service, client, applications } = buildHarness(makeApp({ status: 'PENDING_REVIEW' }));
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.status).toBe('APPROVED_ISSUING');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(updated.psaFormNo).toBe('BM26090001');
    expect(client.apply).toHaveBeenCalledTimes(1);
    expect(client.apply).toHaveBeenCalledWith(expect.objectContaining({
      prjNo: PSA_DOMESTIC_PROFILE.projectNos.API,
      currencyName: '中国人民币',
      sdAreaId: 2141,
    }));
    expect(applications[0].status).toBe('APPROVED_ISSUING');
  });

  it('uses overseas PSA catalog when login provider is auth0', async () => {
    const { service, client } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW', currency: 'CNY' }),
      undefined,
      'international',
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(client.apply).toHaveBeenCalledWith(expect.objectContaining({
      prjNo: PSA_FOREIGN_PROFILE.projectNos.API,
      currencyName: '美元',
      sdAreaId: 2142,
      invoiceKindName: '纸质-形式发票-服务销售-免税<INVOICE>',
    }));
  });

  it('records FAILED when login region cannot be resolved', async () => {
    const { service } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW' }),
      undefined,
      new Error('无法判定国内/海外环境：缺少登录方式（authing=国内，auth0=海外）'),
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.status).toBe('APPROVED_ISSUING');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('缺少登录方式');
  });

  it('keeps APPROVED_ISSUING when PSA apply fails', async () => {
    const { service, applications } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW' }),
      { apply: jest.fn(async () => { throw new Error('项目号XXX不存在'); }) },
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.status).toBe('APPROVED_ISSUING');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('项目号XXX不存在');
    expect(applications[0].status).toBe('APPROVED_ISSUING');
  });

  it('records FAILED when required PSA employee config is missing', async () => {
    delete process.env.PSA_APPLY_EMP_NO;
    const { service } = buildHarness(makeApp({ status: 'PENDING_REVIEW' }));
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('PSA_APPLY_EMP_NO 未配置');
  });

  it('records FAILED when one application mixes token-plan and API lines', async () => {
    const { service } = buildHarness(makeApp({
      status: 'PENDING_REVIEW',
      items: [
        {
          principalCents: 400,
          description: 'TOKEN_PLAN',
          productName: 'Token',
          order: { paidAt: new Date('2026-07-01T00:00:00.000Z'), product: { codingPlanFulfillmentMode: 'provider_resale' } },
        },
        {
          principalCents: 600,
          description: 'RAYTONE_API',
          productName: 'API',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    }));
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('同一开票申请不能混合');
  });

  it('does not call PSA when the client is disabled', async () => {
    const { service, client } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW' }),
      { isEnabled: jest.fn(() => false) },
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('NOT_SUBMITTED');
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('clears psaLastError when claiming SUBMITTING', async () => {
    const { service, applications, client } = buildHarness(
      makeApp({
        psaStatus: 'FAILED',
        psaLastError: '上一次失败',
        psaAttemptCount: 1,
      }),
      {
        apply: jest.fn(async () => {
          expect(applications[0].psaStatus).toBe('SUBMITTING');
          expect(applications[0].psaLastError).toBeNull();
          throw new Error('仍然失败');
        }),
      },
    );
    const updated = await service.retryPsaSubmission('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('仍然失败');
    expect(client.apply).toHaveBeenCalledTimes(1);
  });

  it('records the approving admin as the PSA actor', async () => {
    const { service, eventService } = buildHarness(makeApp({ status: 'PENDING_REVIEW' }));
    await service.approveApplication('app-1', 'admin-1');
    expect(eventService.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'ADMIN',
      actorId: 'admin-1',
      metadata: expect.objectContaining({ psaStatus: 'SUBMITTED' }),
    }));
  });

  it('retries FAILED submissions without changing invoice status', async () => {
    const { service } = buildHarness(makeApp({
      psaStatus: 'FAILED',
      psaLastError: '上一次失败',
      psaAttemptCount: 1,
    }));
    const updated = await service.retryPsaSubmission('app-1', 'admin-1');
    expect(updated.status).toBe('APPROVED_ISSUING');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(updated.psaFormNo).toBe('BM26090001');
    expect(updated.psaLastError).toBeNull();
    expect(updated.psaAttemptCount).toBe(2);
  });

  it('retries stale SUBMITTING claims after a crash', async () => {
    const { service } = buildHarness(makeApp({
      psaStatus: 'SUBMITTING',
      psaLastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
      psaAttemptCount: 1,
    }));
    const updated = await service.retryPsaSubmission('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(updated.psaAttemptCount).toBe(2);
  });

  it('does not retry a fresh SUBMITTING claim', async () => {
    const { service, client } = buildHarness(makeApp({
      psaStatus: 'SUBMITTING',
      psaLastAttemptAt: new Date(),
    }));
    await expect(service.retryPsaSubmission('app-1', 'admin-1'))
      .rejects.toBeInstanceOf(InvoicePsaRetryNotAllowedError);
    expect(client.apply).not.toHaveBeenCalled();
  });

  it('does not retry SUBMITTED invoices', async () => {
    const { service } = buildHarness(makeApp({ psaStatus: 'SUBMITTED', psaFormNo: 'BM1' }));
    await expect(service.retryPsaSubmission('app-1', 'admin-1'))
      .rejects.toBeInstanceOf(InvoicePsaRetryNotAllowedError);
  });

  it('rejects retry when the invoice is not waiting to be issued', async () => {
    const { service } = buildHarness(makeApp({ status: 'ISSUED' }));
    await expect(service.retryPsaSubmission('app-1', 'admin-1'))
      .rejects.toBeInstanceOf(InvoiceInvalidStateTransitionError);
  });

  it('rejects retry when PSA is disabled', async () => {
    const { service } = buildHarness(makeApp(), { isEnabled: jest.fn(() => false) });
    await expect(service.retryPsaSubmission('app-1', 'admin-1'))
      .rejects.toBeInstanceOf(InvoicePsaNotEnabledError);
  });

  it('submits one PSA apply per business order', async () => {
    const { service, client } = buildHarness(makeApp({
      status: 'PENDING_REVIEW',
      subtotalCents: 3000,
      totalCents: 3000,
      items: [
        {
          principalCents: 1000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-1',
          order: { id: 'order-1', amountCents: 1000 },
        },
        {
          principalCents: 2000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-2',
          order: { id: 'order-2', amountCents: 2000 },
        },
      ],
    }), {
      apply: jest.fn(async (request: { orderNo: string }) => ({
        formNo: request.orderNo === 'order-1' ? 'BM-A' : 'BM-B',
      })),
    });
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(client.apply).toHaveBeenCalledTimes(2);
    expect(client.apply).toHaveBeenNthCalledWith(1, expect.objectContaining({ orderNo: 'order-1', orderMoney: 10 }));
    expect(client.apply).toHaveBeenNthCalledWith(2, expect.objectContaining({ orderNo: 'order-2', orderMoney: 20 }));
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(updated.psaFormNo).toBe('BM-A, BM-B');
  });

  it('continues remaining orders when one PSA apply fails', async () => {
    const { service, client, applications } = buildHarness(makeApp({
      status: 'PENDING_REVIEW',
      subtotalCents: 3000,
      totalCents: 3000,
      items: [
        {
          principalCents: 1000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-1',
          order: { id: 'order-1', amountCents: 1000 },
        },
        {
          principalCents: 2000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-2',
          order: { id: 'order-2', amountCents: 2000 },
        },
      ],
    }), {
      apply: jest.fn(async (request: { orderNo: string }) => {
        if (request.orderNo === 'order-1') {
          throw new Error('PSA 业务失败: 系统错误，请稍后再试');
        }
        return { formNo: 'BM-B' };
      }),
    });
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(client.apply).toHaveBeenCalledTimes(2);
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaFormNo).toBe('BM-B');
    expect(updated.psaLastError).toContain('订单 order-1');
    expect(updated.psaLastError).toContain('系统错误，请稍后再试');
    expect(applications[0].events).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ psaStatus: 'FAILED', psaOrderNo: 'order-1' }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ psaStatus: 'SUBMITTED', psaOrderNo: 'order-2', psaFormNo: 'BM-B' }) }),
    ]));
  });

  it('retries only orders that have not been submitted to PSA', async () => {
    const { service, client } = buildHarness(makeApp({
      psaStatus: 'FAILED',
      psaFormNo: 'BM-A',
      psaLastError: '订单 order-2 PSA 业务失败: 系统错误，请稍后再试',
      psaAttemptCount: 1,
      subtotalCents: 3000,
      totalCents: 3000,
      items: [
        {
          principalCents: 1000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-1',
          order: { id: 'order-1', amountCents: 1000 },
        },
        {
          principalCents: 2000,
          description: 'RAYTONE_API',
          productName: 'PAYG',
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          orderId: 'order-2',
          order: { id: 'order-2', amountCents: 2000 },
        },
      ],
      events: [{
        metadata: { psaStatus: 'SUBMITTED', psaFormNo: 'BM-A', psaOrderNo: 'order-1' },
      }],
    }), {
      apply: jest.fn(async () => ({ formNo: 'BM-B' })),
    });
    const updated = await service.retryPsaSubmission('app-1', 'admin-1');
    expect(client.apply).toHaveBeenCalledTimes(1);
    expect(client.apply).toHaveBeenCalledWith(expect.objectContaining({ orderNo: 'order-2' }));
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(updated.psaFormNo).toBe('BM-A, BM-B');
    expect(updated.psaLastError).toBeNull();
  });

  it('fills per-order overseas attachments while storing the full invoice once', async () => {
    const { service, client, overseasTemplate, storageService } = buildHarness(
      makeApp({
        status: 'PENDING_REVIEW',
        applicationNo: 'IA-20260921-m1',
        subtotalCents: 3000,
        totalCents: 3000,
        profileSnapshot: { kind: 'PERSONAL', invoiceType: 'COMMERCIAL_HK', title: 'Alice' },
        items: [
          {
            principalCents: 1000,
            description: 'RAYTONE_API',
            productName: 'PAYG',
            serviceStart: new Date('2026-08-01T00:00:00.000Z'),
            orderId: 'order-1',
            order: { id: 'order-1', amountCents: 1000 },
          },
          {
            principalCents: 2000,
            description: 'RAYTONE_API',
            productName: 'PAYG',
            serviceStart: new Date('2026-08-01T00:00:00.000Z'),
            orderId: 'order-2',
            order: { id: 'order-2', amountCents: 2000 },
          },
        ],
      }),
      {
        apply: jest.fn(async (request: { orderNo: string }) => ({
          formNo: request.orderNo === 'order-1' ? 'BM-A' : 'BM-B',
        })),
      },
      'international',
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(storageService.persist).toHaveBeenCalledTimes(1);
    expect(overseasTemplate.fill).toHaveBeenCalledTimes(3);
    expect(overseasTemplate.fill).toHaveBeenNthCalledWith(1, expect.objectContaining({
      items: [expect.objectContaining({ orderId: 'order-1' }), expect.objectContaining({ orderId: 'order-2' })],
    }));
    expect(overseasTemplate.fill).toHaveBeenNthCalledWith(2, expect.objectContaining({
      items: [expect.objectContaining({ orderId: 'order-1' })],
    }));
    expect(overseasTemplate.fill).toHaveBeenNthCalledWith(3, expect.objectContaining({
      items: [expect.objectContaining({ orderId: 'order-2' })],
    }));
    expect(client.apply).toHaveBeenCalledTimes(2);
    expect(client.apply).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderNo: 'order-1',
      attachments: [expect.objectContaining({ fileName: 'IA-20260921-m1.xlsx' })],
    }));
    expect(client.apply).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderNo: 'order-2',
      attachments: [expect.objectContaining({ fileName: 'IA-20260921-m1.xlsx' })],
    }));
    expect(updated.psaFormNo).toBe('BM-A, BM-B');
  });

  it('does not generate an excel attachment for domestic PSA submissions', async () => {
    const { service, client, overseasTemplate, storageService } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW' }),
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(overseasTemplate.fill).not.toHaveBeenCalled();
    expect(storageService.persist).not.toHaveBeenCalled();
    expect(client.apply.mock.calls[0][0]).not.toHaveProperty('attachments');
  });

  it('attaches the shared overseas invoice xlsx when login provider is auth0', async () => {
    const { service, client, overseasTemplate, storageService, applications } = buildHarness(
      makeApp({
        status: 'PENDING_REVIEW',
        applicationNo: 'IA-20260920-p1',
        profileSnapshot: { kind: 'PERSONAL', invoiceType: 'COMMERCIAL_HK', title: 'Alice' },
      }),
      undefined,
      'international',
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('SUBMITTED');
    expect(overseasTemplate.fill).toHaveBeenCalledTimes(1);
    expect(storageService.persist).toHaveBeenCalledWith(expect.objectContaining({
      extension: 'xlsx',
      invoiceNumber: 'IA-20260920-p1',
      keyHint: 'IA-20260920-p1-psa',
    }));
    expect(client.apply).toHaveBeenCalledWith(expect.objectContaining({
      invoiceKindName: '纸质-形式发票-服务销售-免税<INVOICE>',
      attachments: [expect.objectContaining({
        fileName: 'IA-20260920-p1.xlsx',
        fileRemark: '形式发票',
        fileBase64: Buffer.from('generated-xlsx').toString('base64'),
      })],
    }));
    expect(applications[0].psaAttachmentUrl).toBe('invoices/u1/IA-20260920-p1-psa.xlsx');
  });

  it('still fills the shared overseas template when profile kind is ENTERPRISE', async () => {
    const { service, overseasTemplate } = buildHarness(
      makeApp({
        status: 'PENDING_REVIEW',
        profileSnapshot: { kind: 'ENTERPRISE', title: 'Acme HK' },
      }),
      undefined,
      'international',
    );
    await service.approveApplication('app-1', 'admin-1');
    expect(overseasTemplate.fill).toHaveBeenCalledWith(expect.objectContaining({
      profileSnapshot: expect.objectContaining({ kind: 'ENTERPRISE' }),
    }));
  });

  it('regenerates and overwrites the overseas xlsx on PSA retry', async () => {
    const { service, client, overseasTemplate, storageService, applications } = buildHarness(
      makeApp({
        applicationNo: 'IA-20260920-r1',
        psaStatus: 'FAILED',
        psaAttachmentUrl: 'invoices/u1/IA-20260920-r1-psa.xlsx',
        psaAttemptCount: 1,
      }),
      undefined,
      'international',
    );
    await service.retryPsaSubmission('app-1', 'admin-1');
    expect(overseasTemplate.fill).toHaveBeenCalledTimes(1);
    expect(storageService.persist).toHaveBeenCalledWith(expect.objectContaining({
      extension: 'xlsx',
      invoiceNumber: 'IA-20260920-r1',
      keyHint: 'IA-20260920-r1-psa',
    }));
    expect(storageService.readToBuffer).not.toHaveBeenCalled();
    expect(client.apply).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        fileName: 'IA-20260920-r1.xlsx',
        fileBase64: Buffer.from('generated-xlsx').toString('base64'),
      })],
    }));
    expect(applications[0].psaAttachmentUrl).toBe('invoices/u1/IA-20260920-r1-psa.xlsx');
  });

  it('reads the stored overseas xlsx for admin download', async () => {
    const { service, overseasTemplate, storageService } = buildHarness(
      makeApp({
        applicationNo: 'IA-20260920-d1',
        psaAttachmentUrl: 'invoices/u1/IA-20260920-d1-psa.xlsx',
      }),
      undefined,
      'international',
    );
    const file = await service.readOverseasInvoiceAttachment('app-1');
    expect(storageService.readToBuffer).toHaveBeenCalledWith('invoices/u1/IA-20260920-d1-psa.xlsx');
    expect(overseasTemplate.fill).not.toHaveBeenCalled();
    expect(file.fileName).toBe('IA-20260920-d1.xlsx');
    expect(file.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.buffer.equals(Buffer.from('reused-xlsx'))).toBe(true);
  });

  it('generates and stores the overseas xlsx when admin download cannot read the stored file', async () => {
    const { service, overseasTemplate, storageService, applications } = buildHarness(
      makeApp({
        applicationNo: 'IA-20260920-d2',
        psaAttachmentUrl: 'invoices/u1/missing.xlsx',
      }),
      undefined,
      'international',
    );
    storageService.readToBuffer.mockRejectedValueOnce(new Error('not found'));
    const file = await service.readOverseasInvoiceAttachment('app-1');
    expect(overseasTemplate.fill).toHaveBeenCalledTimes(1);
    expect(storageService.persist).toHaveBeenCalledTimes(1);
    expect(applications[0].psaAttachmentUrl).toBe('invoices/u1/IA-20260920-d2-psa.xlsx');
    expect(file.buffer.equals(Buffer.from('generated-xlsx'))).toBe(true);
  });

  it('returns 404 when a domestic invoice has no stored PSA attachment', async () => {
    const { service, overseasTemplate, storageService } = buildHarness(
      makeApp({ psaAttachmentUrl: null }),
    );
    await expect(service.readOverseasInvoiceAttachment('app-1'))
      .rejects.toBeInstanceOf(InvoicePsaAttachmentNotFoundError);
    expect(overseasTemplate.fill).not.toHaveBeenCalled();
    expect(storageService.persist).not.toHaveBeenCalled();
  });

  it('keeps APPROVED_ISSUING and the persisted xlsx when overseas PSA apply fails', async () => {
    const { service, applications, storageService } = buildHarness(
      makeApp({ status: 'PENDING_REVIEW', applicationNo: 'IA-20260920-f1' }),
      { apply: jest.fn(async () => { throw new Error('项目号XXX不存在'); }) },
      'international',
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.status).toBe('APPROVED_ISSUING');
    expect(updated.psaStatus).toBe('FAILED');
    expect(storageService.persist).toHaveBeenCalledTimes(1);
    expect(applications[0].psaAttachmentUrl).toBe('invoices/u1/IA-20260920-f1-psa.xlsx');
  });

  it('does not generate an attachment when mapper fail-closes mixed API and Token Plan lines', async () => {
    const { service, overseasTemplate, storageService } = buildHarness(
      makeApp({
        status: 'PENDING_REVIEW',
        items: [
          {
            principalCents: 400,
            description: 'TOKEN_PLAN',
            productName: 'Token',
            order: { paidAt: new Date('2026-07-01T00:00:00.000Z'), product: { codingPlanFulfillmentMode: 'provider_resale' } },
          },
          {
            principalCents: 600,
            description: 'RAYTONE_API',
            productName: 'API',
            serviceStart: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      }),
      undefined,
      'international',
    );
    const updated = await service.approveApplication('app-1', 'admin-1');
    expect(updated.psaStatus).toBe('FAILED');
    expect(updated.psaLastError).toContain('同一开票申请不能混合');
    expect(overseasTemplate.fill).not.toHaveBeenCalled();
    expect(storageService.persist).not.toHaveBeenCalled();
  });
});

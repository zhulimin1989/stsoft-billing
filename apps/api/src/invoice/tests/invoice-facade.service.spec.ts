import { BadRequestException } from '@nestjs/common';
import { InvoiceService } from '../invoice.service';
import {
  DomesticInvoiceWorkflow,
  InternationalInvoiceWorkflow,
  InvoiceWorkflowRegistry,
} from '../invoice-workflow.registry';

function buildService(provider: 'authing' | 'auth0') {
  const deployment = {
    resolve: jest.fn(async () => (provider === 'authing' ? 'domestic' : 'international')),
  };
  const domestic = {
    listInvoiceablePurchases: jest.fn(async () => [{ orderId: 'domestic-tokenplan-order' }]),
    listInvoiceablePeriods: jest.fn(async () => [{ period: '2026-05' }]),
    submitApplication: jest.fn(async () => ({ id: 'domestic-tokenplan-app' })),
    submitPeriodApplication: jest.fn(async () => ({ id: 'domestic-app' })),
  };
  const international = {
    listInvoiceablePurchases: jest.fn(async () => [{ orderId: 'order-1' }]),
    submitApplication: jest.fn(async () => ({ id: 'international-app' })),
  };
  const applications = {
    listApplications: jest.fn(),
    getApplication: jest.fn(),
    cancelApplication: jest.fn(),
    adminListApplications: jest.fn(),
    buildInvoicesZip: jest.fn(),
    adminGetApplication: jest.fn(),
    approveApplication: jest.fn(async () => undefined),
    retryPsaSubmission: jest.fn(async () => undefined),
    readOverseasInvoiceAttachment: jest.fn(async () => undefined),
    rejectApplication: jest.fn(),
    issueUploadedApplication: jest.fn(async () => undefined),
    voidApplication: jest.fn(),
    redOffsetApplication: jest.fn(),
    failApplication: jest.fn(async () => undefined),
  };
  const registry = new InvoiceWorkflowRegistry(
    deployment as never,
    new DomesticInvoiceWorkflow(domestic as never),
    new InternationalInvoiceWorkflow(international as never),
  );
  const service = new InvoiceService(registry as never, applications as never);
  return { service, registry, deployment, domestic, international, applications };
}

describe('InvoiceService facade — provider 路由', () => {
  it('authing/domestic 同时支持 TokenPlan 订单级开票和 API 月账期开票', async () => {
    const { service, domestic, international } = buildService('authing');

    await expect(service.listInvoiceablePurchases('u1', 't1')).resolves.toEqual([
      { orderId: 'domestic-tokenplan-order' },
    ]);
    expect(domestic.listInvoiceablePurchases).toHaveBeenCalledWith('u1', 't1');
    expect(international.listInvoiceablePurchases).not.toHaveBeenCalled();

    await expect(
      service.submitApplication({
        userId: 'u1',
        tenantId: 't1',
        profileId: 'p1',
        idempotencyKey: 'idem-old',
        items: [{ orderId: 'o1' }],
      }),
    ).resolves.toMatchObject({ id: 'domestic-tokenplan-app' });
    expect(domestic.submitApplication).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ orderId: 'o1' }] }),
    );
    expect(international.submitApplication).not.toHaveBeenCalled();

    await expect(
      service.submitPeriodApplication({
        userId: 'u1',
        tenantId: 't1',
        profileId: 'p1',
        idempotencyKey: 'idem-period',
        period: '2026-05',
      }),
    ).resolves.toMatchObject({ id: 'domestic-app' });
    expect(domestic.submitPeriodApplication).toHaveBeenCalledWith(
      expect.objectContaining({ period: '2026-05' }),
    );
  });

  it('auth0/international 使用订单开票，拒绝月账期提交', async () => {
    const { service, domestic, international } = buildService('auth0');

    await expect(
      service.submitApplication({
        userId: 'u1',
        tenantId: 't1',
        profileId: 'p1',
        idempotencyKey: 'idem-old',
        items: [{ orderId: 'o1' }],
      }),
    ).resolves.toMatchObject({ id: 'international-app' });
    expect(international.submitApplication).toHaveBeenCalled();

    await expect(
      service.submitPeriodApplication({
        userId: 'u1',
        tenantId: 't1',
        profileId: 'p1',
        idempotencyKey: 'idem-period',
        period: '2026-05',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(domestic.submitPeriodApplication).not.toHaveBeenCalled();
  });

  it.each(['authing', 'auth0'] as const)('%s 部署都只开放人工审核和上传票据', async (provider) => {
    const { service, applications } = buildService(provider);

    await expect(service.approveApplication('app-1', 'admin-1', 'ok')).resolves.toBeUndefined();
    expect(applications.approveApplication).toHaveBeenCalledWith('app-1', 'admin-1', 'ok');

    await expect(service.retryPsaSubmission('app-1', 'admin-1')).resolves.toBeUndefined();
    expect(applications.retryPsaSubmission).toHaveBeenCalledWith('app-1', 'admin-1');

    await expect(
      service.issueUploadedApplication({
        applicationId: 'app-1',
        adminId: 'admin-1',
        invoiceNumber: 'MANUAL-202606-001',
        issuingEntity: provider === 'authing' ? '国内主体' : '102ISSHK',
        issueDate: new Date(Date.UTC(2026, 5, 23)),
        pdfFile: {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 test'),
        },
      }),
    ).resolves.toBeUndefined();
    expect(applications.issueUploadedApplication).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', invoiceNumber: 'MANUAL-202606-001' }),
    );

    await expect(service.failApplication('app-1', 'admin-1', '线下开票失败'))
      .resolves.toBeUndefined();
    expect(applications.failApplication).toHaveBeenCalledWith(
      'app-1',
      'admin-1',
      '线下开票失败',
    );
  });
});

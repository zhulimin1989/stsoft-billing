import { PsaInvoiceClient, PsaInvoiceRequest, buildPsaXlsxAttachment, psaXlsxFileName } from '../psa-invoice.client';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function request(): PsaInvoiceRequest {
  return {
    orderNo: 'INV-1',
    orderMoney: 10,
    prjNo: 'DOM-1',
    invoiceKindName: '全电-增税专票-服务销售-6%<电子发票(增值税专用发票)>',
    standbyAccountName: '测试公司',
    accountTaxNo: '123',
    address: '北京',
    bankText: '工行 1',
    currencyName: '中国人民币',
    sdAreaId: 2141,
    applyEmpNo: 'E1',
    applyPhoneNo: '',
    isoftstoneEmail: 'wangzhangk@isoftstone.com',
    customerEmail: '',
    isEmailClient: '否',
    clientLinkman: '张三',
    clientPhone: '',
    clientAddress: '',
    clientPostalCode: '',
    applyReason: '预收款',
    applyReasonDetail: 'SaaS服务费用开票',
    invoiceAmount: 10,
    invoiceAmountLocal: 10,
    serviceMonth: '2026-09-01',
    planPaymentDate: '2026-09-16',
    invoiceRemark: '',
    goodsLines: [{
      content: '技术服务费',
      taxClassificationCode: '3040203',
      specModel: '',
      unitName: '',
      quantity: 1,
      unitPrice: 10,
      money: 10,
    }],
  };
}

describe('PsaInvoiceClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.PSA_INVOICE_ENABLED = 'true';
    process.env.PSA_TOKEN_URL = 'http://psa.test/token';
    process.env.PSA_INVOICE_URL = 'https://psa.test/invoice';
    process.env.PSA_CLIENT_ID = 'client-id';
    process.env.PSA_CLIENT_SECRET = 'client-secret';
    process.env.PSA_SCOPE = 'InvoiceAPI';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  it('isEnabled only when PSA_INVOICE_ENABLED=true', () => {
    const client = new PsaInvoiceClient();
    expect(client.isEnabled()).toBe(true);
    process.env.PSA_INVOICE_ENABLED = 'false';
    expect(client.isEnabled()).toBe(false);
  });

  it('fetches a token then posts the invoice request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: '0', message: 'ok', data: { formNo: 'BM26090001', syncResult: '成功' } }));

    const result = await new PsaInvoiceClient().apply(request());
    expect(result).toEqual({ formNo: 'BM26090001', message: 'ok' });

    const tokenCall = fetchMock.mock.calls[0];
    expect(tokenCall[0]).toBe('http://psa.test/token');
    expect(tokenCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(tokenCall[1].body)).toContain('grant_type=client_credentials');
    expect(String(tokenCall[1].body)).toContain('client_secret=client-secret');

    const invoiceCall = fetchMock.mock.calls[1];
    expect(invoiceCall[0]).toBe('https://psa.test/invoice');
    expect(invoiceCall[1].headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse(invoiceCall[1].body).orderNo).toBe('INV-1');
    expect(JSON.parse(invoiceCall[1].body)).not.toHaveProperty('client_secret');
  });

  it('reuses a cached token within its expiry window', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValue(jsonResponse(200, { code: '0', data: { formNo: 'BM1' } }));

    const client = new PsaInvoiceClient();
    await client.apply(request());
    await client.apply(request());
    const tokenCalls = fetchMock.mock.calls.filter((call) => call[0] === 'http://psa.test/token');
    expect(tokenCalls).toHaveLength(1);
  });

  it('refreshes the token after HTTP 401', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-old', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-new', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: '0', data: { formNo: 'BM2' } }));

    const result = await new PsaInvoiceClient().apply(request());
    expect(result.formNo).toBe('BM2');
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer tok-new');
  });

  it('surfaces PSA business failures without leaking the client secret', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: '-1', message: '项目号XXX不存在' }));

    await expect(new PsaInvoiceClient().apply(request())).rejects.toThrow('PSA 业务失败: 项目号XXX不存在');
  });

  it('throws when OAuth config is incomplete', async () => {
    delete process.env.PSA_CLIENT_SECRET;
    await expect(new PsaInvoiceClient().apply(request())).rejects.toThrow('PSA OAuth 配置不完整');
  });

  it('posts form-invoice attachments without a contentType or client secret', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: '0', data: { formNo: 'BM3' } }));

    const payload: PsaInvoiceRequest = {
      ...request(),
      invoiceKindName: '纸质-形式发票-服务销售-免税<INVOICE>',
      attachments: [buildPsaXlsxAttachment('IA-20260920-001', Buffer.from('xlsx-bytes'))],
    };
    await new PsaInvoiceClient().apply(payload);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.attachments).toEqual([{
      fileName: 'IA-20260920-001.xlsx',
      fileRemark: '形式发票',
      fileBase64: Buffer.from('xlsx-bytes').toString('base64'),
    }]);
    expect(body.attachments[0]).not.toHaveProperty('contentType');
    expect(JSON.stringify(body)).not.toContain('client-secret');
  });

  it('keeps the xlsx fileName within 50 characters', () => {
    expect(psaXlsxFileName('IA-20260920-abc123')).toBe('IA-20260920-abc123.xlsx');
    expect(psaXlsxFileName(`IA-${'x'.repeat(80)}`).length).toBe(50);
    expect(psaXlsxFileName(`IA-${'x'.repeat(80)}`).endsWith('.xlsx')).toBe(true);
  });
});

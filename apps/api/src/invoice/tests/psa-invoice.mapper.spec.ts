import {
  PSA_DEFAULT_GOODS_CONTENT,
  PSA_DEFAULT_TAX_CLASSIFICATION_CODE,
  PSA_FOREIGN_KIND_NAME,
  PSA_VAT_NORMAL_KIND_NAME,
  PSA_VAT_SPECIAL_KIND_NAME,
  buildPsaInvoiceRequest,
  buildPsaInvoiceRequests,
  centsToYuan,
  shanghaiMonthEnd,
  shanghaiMonthStart,
  shanghaiYmd,
  resolveOverseasBillTo,
  resolveOverseasInvoiceKind,
} from '../psa-invoice.mapper';
import type { PsaMappableInvoiceApplication, PsaMappableOrder } from '../psa-invoice.mapper';
import { PSA_DOMESTIC_PROFILE, PSA_FOREIGN_PROFILE } from '../psa-invoice.profile';

const ORIGINAL_ENV = { ...process.env };

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resaleOrder(paidAt: Date, overrides: Partial<PsaMappableOrder> = {}): PsaMappableOrder {
  return {
    id: 'order-resale-1',
    amountCents: 70005,
    paidAt,
    product: { codingPlanFulfillmentMode: 'provider_resale' },
    ...overrides,
  };
}

function selfPlanOrder(paidAt: Date, overrides: Partial<PsaMappableOrder> = {}): PsaMappableOrder {
  return {
    id: 'order-self-1',
    amountCents: 70005,
    paidAt,
    product: { codingPlanFulfillmentMode: 'platform_model_package' },
    ...overrides,
  };
}

function apiOrder(overrides: Partial<PsaMappableOrder> = {}): PsaMappableOrder {
  return {
    id: 'order-api-1',
    amountCents: 70005,
    ...overrides,
  };
}


function mapPsa(
  application: PsaMappableInvoiceApplication,
  region: 'DOMESTIC' | 'FOREIGN',
  now?: Date,
) {
  return buildPsaInvoiceRequest(application, { region, now });
}

function baseApp(overrides: Partial<PsaMappableInvoiceApplication> = {}): PsaMappableInvoiceApplication {
  return {
    applicationNo: 'INV20260916001',
    subtotalCents: 70005,
    totalCents: 70005,
    currency: 'CNY',
    profileSnapshot: {
      invoiceType: 'VAT_SPECIAL',
      title: '北京测试科技有限公司',
      taxNo: '91110000MA0000001X',
      bankName: '中国工商银行北京海淀支行',
      bankAccount: '343242319068124358',
      registeredAddress: '北京市海淀区清河小营东路18号',
      registeredPhone: '01069617854',
      recipientName: '张三',
      recipientEmail: 'finance@example.com',
      recipientPhone: '13800000000',
      recipientAddress: '北京市海淀区清河小营东路18号',
    },
    items: [{
      principalCents: 70005,
      description: 'RAYTONE_API',
      productName: null,
      serviceStart: new Date('2026-08-31T16:00:00.000Z'),
      serviceEnd: new Date('2026-09-30T15:59:59.999Z'),
      orderId: 'order-api-1',
      order: apiOrder(),
    }],
    ...overrides,
  };
}

describe('psa-invoice.mapper', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setEnv({
      PSA_APPLY_EMP_NO: '343546',
      PSA_ISOFTSTONE_EMAIL: 'wangzhangk@isoftstone.com',
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('maps domestic VAT special invoice from the domestic strategy', () => {
    const now = new Date('2026-09-16T16:30:00.000Z');
    const request = mapPsa(baseApp(), 'DOMESTIC', now);
    expect(request).toMatchObject({
      orderNo: 'order-api-1',
      orderMoney: 700.05,
      prjNo: PSA_DOMESTIC_PROFILE.projectNos.API,
      invoiceKindName: PSA_VAT_SPECIAL_KIND_NAME,
      standbyAccountName: '北京测试科技有限公司',
      accountTaxNo: '91110000MA0000001X',
      address: '北京市海淀区清河小营东路18号 01069617854',
      bankText: '中国工商银行北京海淀支行 343242319068124358',
      currencyName: '中国人民币',
      sdAreaId: 2141,
      applyEmpNo: '343546',
      isoftstoneEmail: 'wangzhangk@isoftstone.com',
      customerEmail: '',
      isEmailClient: '否',
      applyReason: '预收款',
      applyReasonDetail: 'SaaS服务费用开票',
      invoiceAmount: 700.05,
      invoiceAmountLocal: 700.05,
      serviceMonth: '2026-09-01',
      planPaymentDate: '2026-09-17',
    });
    expect(request.goodsLines).toEqual([{
      content: PSA_DEFAULT_GOODS_CONTENT,
      taxClassificationCode: PSA_DEFAULT_TAX_CLASSIFICATION_CODE,
      specModel: '',
      unitName: '',
      quantity: 1,
      unitPrice: 700.05,
      money: 700.05,
    }]);
  });

  it('maps PSA orderNo/orderMoney from the business order, not the invoice application number', () => {
    const request = mapPsa(baseApp({
      subtotalCents: 90,
      totalCents: 90,
      items: [{
        principalCents: 90,
        description: 'RAYTONE_API',
        productName: 'PAYG',
        serviceStart: new Date('2026-06-30T16:00:00.000Z'),
        serviceEnd: new Date('2026-07-31T15:59:59.999Z'),
        orderId: 'de02d662-25da-4c76-8ef1-6c34020caf0c',
        order: apiOrder({ id: 'de02d662-25da-4c76-8ef1-6c34020caf0c', amountCents: 10000 }),
      }],
    }), 'DOMESTIC');
    expect(request.orderNo).toBe('de02d662-25da-4c76-8ef1-6c34020caf0c');
    expect(request.orderMoney).toBe(100);
    expect(request.invoiceAmount).toBe(0.9);
  });

  it('builds one PSA request per business order instead of joining orderNos', () => {
    const application = baseApp({
      subtotalCents: 30000,
      totalCents: 30000,
      items: [
        {
          principalCents: 10000,
          description: 'TOKEN_PLAN',
          productName: 'A',
          orderId: 'order-a',
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z'), { id: 'order-a', amountCents: 10000 }),
        },
        {
          principalCents: 20000,
          description: 'TOKEN_PLAN',
          productName: 'B',
          orderId: 'order-b',
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z'), { id: 'order-b', amountCents: 20000 }),
        },
      ],
    });
    const requests = buildPsaInvoiceRequests(application, { region: 'DOMESTIC' });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      orderNo: 'order-a',
      orderMoney: 100,
      invoiceAmount: 100,
      goodsLines: [expect.objectContaining({ money: 100 })],
    });
    expect(requests[1]).toMatchObject({
      orderNo: 'order-b',
      orderMoney: 200,
      invoiceAmount: 200,
      goodsLines: [expect.objectContaining({ money: 200 })],
    });
    expect(() => mapPsa(application, 'DOMESTIC')).toThrow('开票申请包含多个订单，PSA 需按订单分别提交');
  });

  it('lets the last order absorb the application subtotal remainder', () => {
    const requests = buildPsaInvoiceRequests(baseApp({
      subtotalCents: 30001,
      totalCents: 30001,
      items: [
        {
          principalCents: 10000,
          description: 'TOKEN_PLAN',
          productName: 'A',
          orderId: 'order-a',
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z'), { id: 'order-a', amountCents: 10000 }),
        },
        {
          principalCents: 20000,
          description: 'TOKEN_PLAN',
          productName: 'B',
          orderId: 'order-b',
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z'), { id: 'order-b', amountCents: 30000 }),
        },
      ],
    }), { region: 'DOMESTIC' });
    expect(requests[0].invoiceAmount).toBe(100);
    expect(requests[1].invoiceAmount).toBe(200.01);
    expect(requests[1].orderMoney).toBe(300);
  });

  it('rejects an order whose invoice amount exceeds the business order amount', () => {
    expect(() => buildPsaInvoiceRequests(baseApp({
      subtotalCents: 15000,
      totalCents: 15000,
      items: [{
        principalCents: 15000,
        description: 'RAYTONE_API',
        productName: 'PAYG',
        serviceStart: new Date('2026-08-01T00:00:00.000Z'),
        orderId: 'order-api-1',
        order: apiOrder({ amountCents: 10000 }),
      }],
    }), { region: 'DOMESTIC' })).toThrow('订单 order-api-1 本次开票金额超过订单金额');
  });

  it('rejects missing order id instead of falling back to applicationNo', () => {
    expect(() => mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: null,
        serviceStart: new Date('2026-08-01T00:00:00.000Z'),
      }],
    }), 'DOMESTIC')).toThrow('开票申请缺少订单号');
  });

  it('maps domestic VAT normal invoice kind independently of special invoice', () => {
    const request = mapPsa(baseApp({
      profileSnapshot: {
        invoiceType: 'VAT_NORMAL',
        title: '北京测试科技有限公司',
      },
    }), 'DOMESTIC');
    expect(request.invoiceKindName).toBe(PSA_VAT_NORMAL_KIND_NAME);
    expect(request.prjNo).toBe(PSA_DOMESTIC_PROFILE.projectNos.API);
  });

  it('uses domestic zhipu token-plan project and order-month service date', () => {
    const request = mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'TOKEN_PLAN',
        productName: '智谱 Token 卡',
        order: resaleOrder(new Date('2026-07-15T16:00:00.000Z')),
      }],
    }), 'DOMESTIC', new Date('2026-09-16T00:00:00.000Z'));
    expect(request.prjNo).toBe(PSA_DOMESTIC_PROFILE.projectNos.TOKEN_PLAN);
    expect(request.serviceMonth).toBe('2026-07-01');
    expect(request.goodsLines[0].content).toBe('技术服务费');
  });

  it('uses domestic self-plan project and order-month service date', () => {
    const request = mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'TOKEN_PLAN',
        productName: '自营套餐',
        order: selfPlanOrder(new Date('2026-07-15T16:00:00.000Z')),
      }],
    }), 'DOMESTIC');
    expect(request.prjNo).toBe(PSA_DOMESTIC_PROFILE.projectNos.SELF_PLAN);
    expect(request.serviceMonth).toBe('2026-07-01');
  });

  it('uses foreign strategy when login region is overseas, independent of invoice currency', () => {
    const request = mapPsa(baseApp({
      currency: 'CNY',
      profileSnapshot: { invoiceType: 'VAT_SPECIAL', title: 'Acme HK' },
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: 'API',
        serviceStart: new Date('2026-08-01T00:00:00.000Z'),
        serviceEnd: new Date('2026-08-31T15:59:59.999Z'),
        orderId: 'order-api-1',
        order: apiOrder(),
      }],
    }), 'FOREIGN');
    expect(request.prjNo).toBe(PSA_FOREIGN_PROFILE.projectNos.API);
    expect(request.sdAreaId).toBe(2142);
    expect(request.currencyName).toBe('美元');
    expect(request.invoiceKindName).toBe(PSA_FOREIGN_KIND_NAME);
    expect(request.goodsLines[0].taxClassificationCode).toBe('');
    expect(request.goodsLines[0].content).toBe('技术服务费');
  });

  it('uses foreign token-plan project even if fulfillment mode is self-plan', () => {
    const request = mapPsa(baseApp({
      currency: 'USD',
      profileSnapshot: { invoiceType: 'COMMERCIAL_HK', title: 'Acme HK' },
      items: [{
        principalCents: 70005,
        description: 'TOKEN_PLAN',
        productName: 'Token Plan',
        order: selfPlanOrder(new Date('2026-05-20T00:00:00.000Z')),
      }],
    }), 'FOREIGN');
    expect(request.prjNo).toBe(PSA_FOREIGN_PROFILE.projectNos.TOKEN_PLAN);
    expect(request.serviceMonth).toBe('2026-05-01');
  });

  it('uses Asia/Shanghai calendar date rather than UTC toISOString', () => {
    const utcEvening = new Date('2026-09-16T16:00:00.000Z');
    expect(shanghaiYmd(utcEvening)).toBe('2026-09-17');
    expect(shanghaiMonthStart(utcEvening)).toBe('2026-09-01');
    expect(shanghaiMonthEnd(utcEvening)).toBe('2026-09-30');
    expect(utcEvening.toISOString().slice(0, 10)).toBe('2026-09-16');
  });

  it('formats API cross-month service coverage as start-month-day to end-month-last-day', () => {
    const request = mapPsa(baseApp({
      items: [
        {
          principalCents: 30000,
          description: 'RAYTONE_API',
          productName: null,
          serviceStart: new Date('2026-06-30T16:00:00.000Z'),
          serviceEnd: new Date('2026-07-31T15:59:59.999Z'),
          orderId: 'order-api-1',
          order: apiOrder({ amountCents: 70005 }),
        },
        {
          principalCents: 40005,
          description: 'RAYTONE_API',
          productName: null,
          serviceStart: new Date('2026-07-31T16:00:00.000Z'),
          serviceEnd: new Date('2026-08-31T15:59:59.999Z'),
          orderId: 'order-api-1',
          order: apiOrder({ amountCents: 70005 }),
        },
      ],
    }), 'DOMESTIC');
    expect(request.serviceMonth).toBe('2026-07-01-2026-08-31');
  });

  it('adjusts the last goods line so amounts still equal invoiceAmount', () => {
    const request = mapPsa(baseApp({
      subtotalCents: 100,
      totalCents: 100,
      items: [
        { principalCents: 10, description: 'RAYTONE_API', productName: 'A', serviceStart: new Date('2026-08-01T00:00:00.000Z'), orderId: 'order-api-1', order: apiOrder({ amountCents: 100 }) },
        { principalCents: 10, description: 'RAYTONE_API', productName: 'B', serviceStart: new Date('2026-08-01T00:00:00.000Z'), orderId: 'order-api-1', order: apiOrder({ amountCents: 100 }) },
        { principalCents: 10, description: 'RAYTONE_API', productName: 'C', serviceStart: new Date('2026-08-01T00:00:00.000Z'), orderId: 'order-api-1', order: apiOrder({ amountCents: 100 }) },
      ],
    }), 'DOMESTIC');
    expect(request.invoiceAmount).toBe(1);
    expect(request.goodsLines.map((line) => line.money)).toEqual([0.1, 0.1, 0.8]);
    const sum = Number(request.goodsLines.reduce((acc, line) => acc + line.money, 0).toFixed(2));
    expect(sum).toBe(request.invoiceAmount);
    expect(request.goodsLines.every((line) => line.content === '技术服务费')).toBe(true);
  });

  it('always uses 技术服务费 as goods content even when productName exists', () => {
    const named = mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'TOKEN_PLAN',
        productName: '企业版',
        order: resaleOrder(new Date('2026-07-01T00:00:00.000Z')),
      }],
    }), 'DOMESTIC');
    expect(named.goodsLines[0].content).toBe('技术服务费');
  });

  it('rejects mixed invoice line types because one application can only have one project number', () => {
    expect(() => mapPsa(baseApp({
      items: [
        {
          principalCents: 30000,
          description: 'TOKEN_PLAN',
          productName: null,
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z')),
        },
        {
          principalCents: 40005,
          description: 'RAYTONE_API',
          productName: null,
          serviceStart: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    }), 'DOMESTIC')).toThrow('同一开票申请不能混合 TOKEN_PLAN / RAYTONE_API');
  });

  it('rejects mixed domestic token-plan fulfillment modes', () => {
    expect(() => mapPsa(baseApp({
      items: [
        {
          principalCents: 30000,
          description: 'TOKEN_PLAN',
          productName: null,
          order: resaleOrder(new Date('2026-07-01T00:00:00.000Z')),
        },
        {
          principalCents: 40005,
          description: 'TOKEN_PLAN',
          productName: null,
          order: selfPlanOrder(new Date('2026-07-01T00:00:00.000Z')),
        },
      ],
    }), 'DOMESTIC')).toThrow('同一开票申请不能混合自营套餐与供应商转售 Token Plan');
  });

  it('rejects domestic token-plan without fulfillment mode instead of guessing the project', () => {
    expect(() => mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'TOKEN_PLAN',
        productName: '企业版',
        order: { paidAt: new Date('2026-07-01T00:00:00.000Z') },
      }],
    }), 'DOMESTIC')).toThrow('国内 Token Plan 缺少履约模式');
  });

  it('rejects missing employee / email config instead of using docs examples', () => {
    setEnv({ PSA_APPLY_EMP_NO: undefined });
    expect(() => mapPsa(baseApp(), 'DOMESTIC')).toThrow('PSA_APPLY_EMP_NO 未配置');

    setEnv({ PSA_APPLY_EMP_NO: '343546', PSA_ISOFTSTONE_EMAIL: '' });
    expect(() => mapPsa(baseApp(), 'DOMESTIC')).toThrow('PSA_ISOFTSTONE_EMAIL 未配置');
  });

  it('allows optional env override of a single project number without affecting the other region', () => {
    setEnv({ PSA_DOMESTIC_API_PRJ_NO: 'IM-OVERRIDE-API' });
    const domestic = mapPsa(baseApp(), 'DOMESTIC');
    const foreign = mapPsa(baseApp({
      currency: 'USD',
      profileSnapshot: { invoiceType: 'COMMERCIAL_HK', title: 'Acme HK' },
    }), 'FOREIGN');
    expect(domestic.prjNo).toBe('IM-OVERRIDE-API');
    expect(foreign.prjNo).toBe(PSA_FOREIGN_PROFILE.projectNos.API);
  });

  it('rejects missing isoftstone email and invalid applyReason', () => {
    setEnv({ PSA_ISOFTSTONE_EMAIL: '' });
    expect(() => mapPsa(baseApp(), 'DOMESTIC')).toThrow('PSA_ISOFTSTONE_EMAIL 未配置');

    setEnv({ PSA_ISOFTSTONE_EMAIL: 'wangzhangk@isoftstone.com', PSA_APPLY_REASON: '客户开票申请' });
    expect(() => mapPsa(baseApp(), 'DOMESTIC')).toThrow('PSA_APPLY_REASON 不合法');
  });

  it('uses serviceStart for API service month when present', () => {
    const request = mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: null,
        serviceStart: new Date('2026-07-15T16:00:00.000Z'),
        orderId: 'order-api-1',
        order: apiOrder({ paidAt: new Date('2026-09-08T08:32:11.632Z') }),
      }],
    }), 'DOMESTIC', new Date('2026-09-16T00:00:00.000Z'));
    expect(request.serviceMonth).toBe('2026-07-01');
  });

  it('falls back to order month for PAYG API invoices without serviceStart', () => {
    const request = mapPsa(baseApp({
      currency: 'USD',
      profileSnapshot: { kind: 'PERSONAL', invoiceType: 'COMMERCIAL_HK', title: 'Alice' },
      subtotalCents: 500,
      totalCents: 500,
      items: [{
        principalCents: 500,
        description: 'RAYTONE_API',
        productName: 'PAYG',
        serviceStart: null,
        serviceEnd: null,
        orderId: '8623bc83-dc29-4ad2-a9b4-21895be8246e',
        order: apiOrder({
          id: '8623bc83-dc29-4ad2-a9b4-21895be8246e',
          amountCents: 500,
          paidAt: new Date('2026-09-08T08:32:11.632Z'),
          createdAt: new Date('2026-09-08T08:31:43.459Z'),
        }),
      }],
    }), 'FOREIGN');
    expect(request.serviceMonth).toBe('2026-09-01');
  });

  it('falls back to order createdAt month when PAYG API has no paidAt or serviceStart', () => {
    const request = mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: 'PAYG',
        serviceStart: null,
        orderId: 'order-api-1',
        order: apiOrder({ createdAt: new Date('2026-08-20T02:00:00.000Z') }),
      }],
    }), 'DOMESTIC');
    expect(request.serviceMonth).toBe('2026-08-01');
  });

  it('rejects API invoices that have neither service period nor order dates', () => {
    expect(() => mapPsa(baseApp({
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: 'PAYG',
        serviceStart: null,
        orderId: 'order-api-1',
        order: apiOrder(),
      }],
    }), 'DOMESTIC')).toThrow('API 开票缺少服务账期，无法确定服务月份');
  });

  it('rejects an application with no items instead of inventing a project number', () => {
    expect(() => mapPsa(baseApp({ items: [], subtotalCents: 2000, totalCents: 2000 }), 'DOMESTIC'))
      .toThrow('开票申请缺少明细，无法映射 PSA 项目号');
  });

  it('uses domestic strategy for authing even if the invoice currency is USD', () => {
    const request = mapPsa(baseApp({ currency: 'USD' }), 'DOMESTIC');
    expect(request.prjNo).toBe(PSA_DOMESTIC_PROFILE.projectNos.API);
    expect(request.currencyName).toBe('中国人民币');
    expect(request.sdAreaId).toBe(2141);
    expect(request.invoiceKindName).toBe(PSA_VAT_SPECIAL_KIND_NAME);
  });

  it('rejects commercial invoice type in the authing/domestic region instead of switching catalog', () => {
    expect(() => mapPsa(baseApp({
      profileSnapshot: { invoiceType: 'COMMERCIAL_HK', title: 'Acme HK' },
    }), 'DOMESTIC')).toThrow('国内开票类型无法映射 PSA 开票类型');
  });

  it('converts integer cents to 2-decimal yuan', () => {
    expect(centsToYuan(1)).toBe(0.01);
    expect(centsToYuan(70005)).toBe(700.05);
  });

  it('uses recipientAddress for overseas bill-to instead of registeredAddress', () => {
    expect(resolveOverseasInvoiceKind({})).toBe('PERSONAL');
    expect(resolveOverseasInvoiceKind({ kind: 'enterprise' })).toBe('ENTERPRISE');
    expect(resolveOverseasBillTo({
      kind: 'ENTERPRISE',
      title: 'Acme HK',
      recipientEmail: 'a@b.c',
      recipientAddress: 'Kowloon',
      registeredAddress: 'Beijing',
    })).toEqual({
      kind: 'ENTERPRISE',
      title: 'Acme HK',
      email: 'a@b.c',
      address: 'Kowloon',
    });
  });

  it('does not send customerEmail to PSA because operations email the invoice later', () => {
    const request = mapPsa(baseApp(), 'DOMESTIC');
    expect(request.customerEmail).toBe('');
    expect(request.isEmailClient).toBe('否');
    expect(request.isoftstoneEmail).toBe('wangzhangk@isoftstone.com');
  });

  it('does not take goods unitName from env; PSA always receives empty string', () => {
    setEnv({ PSA_GOODS_UNIT_NAME: '套' });
    const domestic = mapPsa(baseApp(), 'DOMESTIC');
    const foreign = mapPsa(baseApp({
      currency: 'USD',
      profileSnapshot: { kind: 'PERSONAL', invoiceType: 'COMMERCIAL_HK', title: 'Alice' },
    }), 'FOREIGN');
    expect(domestic.goodsLines.every((line) => line.unitName === '')).toBe(true);
    expect(foreign.goodsLines.every((line) => line.unitName === '')).toBe(true);
  });

  it('keeps item poNumber on the application and does not attach files in the PSA JSON', () => {
    const app = baseApp({
      items: [{
        principalCents: 70005,
        description: 'RAYTONE_API',
        productName: null,
        serviceStart: new Date('2026-07-15T16:00:00.000Z'),
        poNumber: 'PO-88',
        orderId: 'order-api-1',
        order: apiOrder(),
      }],
    });
    expect(app.items[0].poNumber).toBe('PO-88');
    const request = mapPsa(app, 'FOREIGN');
    expect(request).not.toHaveProperty('attachments');
    expect(request.invoiceKindName).toBe(PSA_FOREIGN_KIND_NAME);
  });
});

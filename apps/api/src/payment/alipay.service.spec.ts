import { AlipayService } from './alipay.service';
import { ConfigService } from '@nestjs/config';

const mockCheckNotifySign = jest.fn();
const mockExec = jest.fn();
const mockPageExec = jest.fn();
const mockAlipaySdk = jest.fn();
jest.mock('alipay-sdk', () => {
  const MockSdk = mockAlipaySdk.mockImplementation(() => ({
    checkNotifySign: mockCheckNotifySign,
    exec: mockExec,
    pageExec: mockPageExec,
  }));
  return { AlipaySdk: MockSdk };
});

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    ALIPAY_APP_ID: 'alipay-app',
    ALIPAY_PRIVATE_KEY: 'private-key-stub',
    ALIPAY_ALIPAY_PUBLIC_KEY: 'alipay-public-stub',
    ALIPAY_NOTIFY_URL: 'https://x.example.com/alipay',
    ...overrides,
  };
  return {
    get: jest.fn((k: string) => defaults[k]),
  } as unknown as ConfigService;
}

describe('AlipayService.verifyNotifySign', () => {
  beforeEach(() => {
    mockCheckNotifySign.mockReset();
    mockAlipaySdk.mockClear();
  });

  it('returns true when SDK validates signature', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig());
    expect(
      service.verifyNotifySign({
        out_trade_no: 'X',
        trade_no: 'Y',
        trade_status: 'TRADE_SUCCESS',
        notify_id: 'nid-1',
        sign: 'sig',
        sign_type: 'RSA2',
      }),
    ).toBe(true);
    expect(mockCheckNotifySign).toHaveBeenCalledTimes(1);
  });

  it('returns false when SDK returns false (invalid signature)', () => {
    mockCheckNotifySign.mockReturnValue(false);
    const service = new AlipayService(makeConfig());
    expect(service.verifyNotifySign({ sign: 'bad' })).toBe(false);
  });

  it('returns false when SDK throws (malformed params)', () => {
    mockCheckNotifySign.mockImplementation(() => {
      throw new Error('invalid sign_type');
    });
    const service = new AlipayService(makeConfig());
    expect(service.verifyNotifySign({ weird: 'shape' })).toBe(false);
  });

  it('passes the complete params object (not a subset) to the SDK', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig());
    const params = {
      out_trade_no: 'X',
      trade_no: 'Y',
      trade_status: 'TRADE_SUCCESS',
      notify_id: 'nid-1',
      total_amount: '100.00',
      sign: 'sig-xyz',
      sign_type: 'RSA2',
    };
    service.verifyNotifySign(params);
    expect(mockCheckNotifySign).toHaveBeenCalledWith(params);
  });

  it('throws ServiceUnavailable when config missing', () => {
    const service = new AlipayService(
      makeConfig({ ALIPAY_APP_ID: '' }),
    );
    expect(() => service.verifyNotifySign({ sign: 'x' })).toThrow(/未配置/);
  });

  it('rejects empty params object (SDK should say no)', () => {
    mockCheckNotifySign.mockReturnValue(false);
    const service = new AlipayService(makeConfig());
    expect(service.verifyNotifySign({})).toBe(false);
  });

  it('passes configured gateway to SDK for sandbox/runtime selection', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig({
      ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    }));

    service.verifyNotifySign({ sign: 'sig' });

    expect(mockAlipaySdk).toHaveBeenCalledWith(expect.objectContaining({
      gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    }));
  });

  it('passes configured keyType to SDK for PKCS8 private keys', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig({
      ALIPAY_KEY_TYPE: 'pkcs8',
    }));

    service.verifyNotifySign({ sign: 'sig' });

    expect(mockAlipaySdk).toHaveBeenCalledWith(expect.objectContaining({
      keyType: 'PKCS8',
    }));
  });

  it('uses a 15 second SDK timeout by default', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig());

    service.verifyNotifySign({ sign: 'sig' });

    expect(mockAlipaySdk).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 15_000,
    }));
  });

  it('passes configured SDK timeout with bounds', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig({
      ALIPAY_TIMEOUT_MS: '90000',
    }));

    service.verifyNotifySign({ sign: 'sig' });

    expect(mockAlipaySdk).toHaveBeenCalledWith(expect.objectContaining({
      timeout: 60_000,
    }));
  });

  it('does not inherit env gateway/keyType when explicit credentials are provided', () => {
    mockCheckNotifySign.mockReturnValue(true);
    const service = new AlipayService(makeConfig({
      ALIPAY_GATEWAY: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
      ALIPAY_KEY_TYPE: 'PKCS8',
    }));

    service.verifyNotifySign(
      { sign: 'sig' },
      {
        appId: 'explicit-app',
        privateKey: 'explicit-private-key',
        alipayPublicKey: 'explicit-alipay-public-key',
      },
    );

    const sdkConfig = mockAlipaySdk.mock.calls[0][0];
    expect(sdkConfig.gateway).toBeUndefined();
    expect(sdkConfig.keyType).toBeUndefined();
  });
});

// ============================================================
// AlipayService.createPagePay
// ============================================================
describe('AlipayService.createPagePay', () => {
  beforeEach(() => {
    mockPageExec.mockReset();
    mockAlipaySdk.mockClear();
  });

  it('returns a page pay redirect URL', async () => {
    mockPageExec.mockReturnValue('https://openapi-sandbox.dl.alipaydev.com/gateway.do?method=alipay.trade.page.pay');
    const service = new AlipayService(makeConfig());

    const result = await service.createPagePay('order-1', 9900, '购买套餐', undefined, 'https://app.example.com/payment/success');

    expect(result.url).toContain('alipay.trade.page.pay');
    expect(mockPageExec).toHaveBeenCalledWith(
      'alipay.trade.page.pay',
      'GET',
      expect.objectContaining({
        bizContent: expect.objectContaining({
          out_trade_no: 'order-1',
          product_code: 'FAST_INSTANT_TRADE_PAY',
          total_amount: '99.00',
          subject: '购买套餐',
        }),
        notifyUrl: 'https://x.example.com/alipay',
        returnUrl: 'https://app.example.com/payment/success',
      }),
    );
  });

  it('uses configured returnUrl when explicit returnUrl is absent', async () => {
    mockPageExec.mockReturnValue('https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay');
    const service = new AlipayService(makeConfig({
      ALIPAY_RETURN_URL: 'https://app.example.com/alipay/return',
    }));

    await service.createPagePay('order-1', 100, 'desc');

    expect(mockPageExec).toHaveBeenCalledWith(
      'alipay.trade.page.pay',
      'GET',
      expect.objectContaining({
        returnUrl: 'https://app.example.com/alipay/return',
      }),
    );
  });
});

// ============================================================
// AlipayService.queryOrder
// ============================================================
describe('AlipayService.queryOrder', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('returns tradeStatus and tradeNo on success', async () => {
    mockExec.mockResolvedValue({ tradeStatus: 'TRADE_SUCCESS', tradeNo: 'ALI-TX-1' });
    const service = new AlipayService(makeConfig());
    const result = await service.queryOrder('ORDER-1');
    expect(result).toEqual({ tradeStatus: 'TRADE_SUCCESS', tradeNo: 'ALI-TX-1' });
    expect(mockExec).toHaveBeenCalledWith(
      'alipay.trade.query',
      expect.objectContaining({ bizContent: { out_trade_no: 'ORDER-1' } }),
    );
  });

  it('returns UNKNOWN tradeStatus when result has no tradeStatus', async () => {
    mockExec.mockResolvedValue({});
    const service = new AlipayService(makeConfig());
    const result = await service.queryOrder('ORDER-1');
    expect(result.tradeStatus).toBe('UNKNOWN');
    expect(result.tradeNo).toBe('');
  });

  it('throws ServiceUnavailableException when config missing', async () => {
    const service = new AlipayService(makeConfig({ ALIPAY_PRIVATE_KEY: '' }));
    await expect(service.queryOrder('ORDER-1')).rejects.toThrow(/未配置/);
  });
});

// ============================================================
// AlipayService.refund
// ============================================================
describe('AlipayService.refund', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('returns success=true when code is 10000', async () => {
    mockExec.mockResolvedValue({
      alipay_trade_refund_response: { code: '10000', msg: 'Success' },
    });
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 9900, '退款');
    expect(result.success).toBe(true);
  });

  it('returns success=false when code is not 10000', async () => {
    mockExec.mockResolvedValue({
      alipay_trade_refund_response: { code: '40004', msg: 'Business Failed' },
    });
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 9900, '退款');
    expect(result.success).toBe(false);
  });

  it('passes refund_amount in yuan string to SDK', async () => {
    mockExec.mockResolvedValue({ alipay_trade_refund_response: { code: '10000' } });
    const service = new AlipayService(makeConfig());
    await service.refund('ALI-TX-1', 1000, '退款原因');
    const call = mockExec.mock.calls[0][1];
    expect(call.bizContent.refund_amount).toBe('10.00');
    expect(call.bizContent.trade_no).toBe('ALI-TX-1');
    expect(call.bizContent.refund_reason).toBe('退款原因');
  });

  it('handles JSON string response (parses it)', async () => {
    const jsonStr = JSON.stringify({ alipay_trade_refund_response: { code: '10000' } });
    mockExec.mockResolvedValue(jsonStr);
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 100, '退款');
    expect(result.success).toBe(true);
  });

  it('returns success=false with error on SDK exception', async () => {
    mockExec.mockRejectedValue(new Error('network error'));
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 100, '退款');
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
  });

  it('returns Unknown error when non-Error is thrown', async () => {
    mockExec.mockRejectedValue('plain string');
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 100, '退款');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown');
  });

  it('uses 管理员退款 as default reason when reason is empty string', async () => {
    mockExec.mockResolvedValue({ alipay_trade_refund_response: { code: '10000' } });
    const service = new AlipayService(makeConfig());
    await service.refund('ALI-TX-1', 100, '');
    const call = mockExec.mock.calls[0][1];
    expect(call.bizContent.refund_reason).toBe('管理员退款');
  });

  it('passes out_request_no when a refund request number is provided', async () => {
    mockExec.mockResolvedValue({ alipay_trade_refund_response: { code: '10000' } });
    const service = new AlipayService(makeConfig());
    await service.refund('ALI-TX-1', 100, '退款', undefined, 'refund_order-1_100');
    const call = mockExec.mock.calls[0][1];
    expect(call.bizContent.out_request_no).toBe('refund_order-1_100');
  });

  it('handles result without alipay_trade_refund_response wrapper', async () => {
    mockExec.mockResolvedValue({ code: '10000' });
    const service = new AlipayService(makeConfig());
    const result = await service.refund('ALI-TX-1', 100, '退款');
    expect(result.success).toBe(true);
  });
});

describe('AlipayService.queryRefund', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('uses SDK camelCase fields to confirm terminal success', async () => {
    mockExec.mockResolvedValue({
      code: '10000',
      outRequestNo: 'refund_order-1_9900',
      refundStatus: 'REFUND_SUCCESS',
      gmtRefundPay: '2026-07-24 10:00:00',
    });
    const service = new AlipayService(makeConfig());
    await expect(
      service.queryRefund(
        'ALI-TX-1',
        'refund_order-1_9900',
      ),
    ).resolves.toMatchObject({
      state: 'SUCCEEDED',
      providerStatus: 'REFUND_SUCCESS',
    });
    expect(mockExec).toHaveBeenCalledWith(
      'alipay.trade.fastpay.refund.query',
      {
        bizContent: {
          trade_no: 'ALI-TX-1',
          out_request_no: 'refund_order-1_9900',
        },
      },
    );
  });

  it('keeps a successful query without refund proof pending', async () => {
    mockExec.mockResolvedValue({
      code: '10000',
      outRequestNo: 'refund_order-1_9900',
    });
    const service = new AlipayService(makeConfig());
    await expect(
      service.queryRefund(
        'ALI-TX-1',
        'refund_order-1_9900',
      ),
    ).resolves.toMatchObject({
      state: 'PENDING',
      providerStatus: 'QUERY_ACCEPTED_NOT_CONFIRMED',
    });
  });

  it('reads camelCase subCode/subMsg for a missing refund', async () => {
    mockExec.mockResolvedValue({
      code: '40004',
      subCode: 'ACQ.REFUND_NOT_EXIST',
      subMsg: 'refund not found',
    });
    const service = new AlipayService(makeConfig());
    await expect(
      service.queryRefund(
        'ALI-TX-1',
        'refund_order-1_9900',
      ),
    ).resolves.toMatchObject({
      state: 'NOT_FOUND',
      providerStatus: '40004:ACQ.REFUND_NOT_EXIST',
    });
  });
});

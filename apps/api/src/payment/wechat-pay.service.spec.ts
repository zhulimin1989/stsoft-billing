import {
  WechatPayOrderOutcomeUnknownError,
  WechatPayService,
} from './wechat-pay.service';
import { ConfigService } from '@nestjs/config';

// Stub filesystem so the service can "read" a private key in tests.
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----'),
}));

// Mock the SDK entirely to assert call ordering without real crypto.
// Method names match real wechatpay-node-v3 v2.x: `refunds` (NOT `refunds_v3`).
// Successful payloads are wrapped in `result.data`, not flat on the response.
const mockVerifySign = jest.fn();
const mockDecipherGcm = jest.fn();
const mockTransactionsNative = jest.fn();
const mockQuery = jest.fn();
const mockRefunds = jest.fn();
const mockFindRefunds = jest.fn();
jest.mock('wechatpay-node-v3', () => {
  return jest.fn().mockImplementation(() => ({
    verifySign: mockVerifySign,
    decipher_gcm: mockDecipherGcm,
    transactions_native: mockTransactionsNative,
    query: mockQuery,
    refunds: mockRefunds,
    find_refunds: mockFindRefunds,
  }));
});

function makeConfig(values: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    WECHAT_APP_ID: 'wx-app',
    WECHAT_MCH_ID: 'mch-1',
    WECHAT_API_V3_KEY: 'v3-key-32-chars-long-xxxxxxxxxxxx',
    WECHAT_SERIAL_NO: 'serial-abc',
    WECHAT_PRIVATE_KEY_PATH: '/tmp/fake.pem',
    WECHAT_NOTIFY_URL: 'https://x.example.com/notify',
    ...values,
  };
  return {
    get: jest.fn((k: string) => defaults[k]),
  } as unknown as ConfigService;
}

describe('WechatPayService.verifyNotifySign', () => {
  beforeEach(() => {
    mockVerifySign.mockReset();
    mockDecipherGcm.mockReset();
  });

  function validHeaders() {
    return {
      'wechatpay-signature': 'sig-abc',
      'wechatpay-timestamp': '1800000000',
      'wechatpay-nonce': 'n-1',
      'wechatpay-serial': 'serial-cert-1',
    };
  }

  function validBody() {
    return {
      id: 'notify-1',
      resource: {
        ciphertext: 'cipher',
        nonce: 'gcm-nonce',
        associated_data: 'ad',
      },
    };
  }

  it('verifies signature, decrypts, and returns payload on success', async () => {
    mockVerifySign.mockResolvedValue(true);
    mockDecipherGcm.mockReturnValue({
      out_trade_no: 'ORDER-1',
      transaction_id: 'TX-1',
      trade_state: 'SUCCESS',
    });

    const service = new WechatPayService(makeConfig());
    const result = await service.verifyNotifySign(
      validHeaders(),
      '{"id":"notify-1",...}',
      validBody() as any,
    );

    expect(mockVerifySign).toHaveBeenCalledTimes(1);
    expect(mockDecipherGcm).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ out_trade_no: 'ORDER-1', trade_state: 'SUCCESS' });
  });

  it('throws when signature verification returns false (no decryption)', async () => {
    mockVerifySign.mockResolvedValue(false);

    const service = new WechatPayService(makeConfig());
    await expect(
      service.verifyNotifySign(validHeaders(), 'raw', validBody() as any),
    ).rejects.toThrow(/签名验证失败/);
    expect(mockDecipherGcm).not.toHaveBeenCalled();
  });

  it.each([
    ['wechatpay-signature'],
    ['wechatpay-timestamp'],
    ['wechatpay-nonce'],
    ['wechatpay-serial'],
  ])('throws when missing header: %s', async (missing) => {
    const headers = validHeaders() as Record<string, string>;
    delete headers[missing];

    const service = new WechatPayService(makeConfig());
    await expect(
      service.verifyNotifySign(headers, 'raw', validBody() as any),
    ).rejects.toThrow(/缺少必需 header/);
    expect(mockVerifySign).not.toHaveBeenCalled();
  });

  it('passes raw body string (not JSON-reserialized) to verifySign', async () => {
    mockVerifySign.mockResolvedValue(true);
    mockDecipherGcm.mockReturnValue({
      out_trade_no: 'X',
      transaction_id: 'Y',
      trade_state: 'SUCCESS',
    });

    const service = new WechatPayService(makeConfig());
    const exactRaw = '{"id":"notify-1","resource":{"ciphertext":"c","nonce":"n","associated_data":"a"}}';
    await service.verifyNotifySign(validHeaders(), exactRaw, validBody() as any);

    const [call] = mockVerifySign.mock.calls;
    expect(call[0].body).toBe(exactRaw);
    expect(call[0].signature).toBe('sig-abc');
    expect(call[0].serial).toBe('serial-cert-1');
    expect(call[0].timestamp).toBe('1800000000');
    expect(call[0].nonce).toBe('n-1');
  });

  it('throws ServiceUnavailableException when config missing', async () => {
    // The guard is inside assertConfigured; simulate missing APP_ID.
    const cfg = makeConfig({ WECHAT_APP_ID: '' });
    const service = new WechatPayService(cfg);
    await expect(
      service.verifyNotifySign(validHeaders(), 'raw', validBody() as any),
    ).rejects.toThrow(/未配置/);
  });

  it('propagates SDK exceptions from verifySign', async () => {
    mockVerifySign.mockRejectedValue(new Error('network error'));

    const service = new WechatPayService(makeConfig());
    await expect(
      service.verifyNotifySign(validHeaders(), 'raw', validBody() as any),
    ).rejects.toThrow(/network error/);
  });

  it('propagates SDK exceptions from decipher_gcm (e.g. wrong key)', async () => {
    mockVerifySign.mockResolvedValue(true);
    mockDecipherGcm.mockImplementation(() => {
      throw new Error('auth tag verification failed');
    });

    const service = new WechatPayService(makeConfig());
    await expect(
      service.verifyNotifySign(validHeaders(), 'raw', validBody() as any),
    ).rejects.toThrow(/auth tag/);
  });
});

// ============================================================
// WechatPayService.createNativePay
// ============================================================
describe('WechatPayService.createNativePay', () => {
  beforeEach(() => {
    mockTransactionsNative.mockReset();
  });

  it('returns codeUrl on success (reads from data.code_url)', async () => {
    mockTransactionsNative.mockResolvedValue({
      status: 200,
      data: { code_url: 'weixin://wxpay/bizpayurl?pr=abc' },
    });
    const service = new WechatPayService(makeConfig());
    const result = await service.createNativePay('order-1', 9900, '购买套餐');
    expect(result.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=abc');
    expect(mockTransactionsNative).toHaveBeenCalledWith(
      expect.objectContaining({
        out_trade_no: 'order-1',
        amount: { total: 9900, currency: 'CNY' },
        description: '购买套餐',
      }),
    );
  });

  it('sets the provider expiry to the durable local recovery deadline', async () => {
    mockTransactionsNative.mockResolvedValue({
      status: 200,
      data: { code_url: 'weixin://wxpay/bizpayurl?pr=expiring' },
    });
    const service = new WechatPayService(makeConfig());
    const expiresAt = new Date('2026-07-24T01:02:03.000Z');

    await service.createNativePay('order-1', 9900, '购买套餐', expiresAt);

    expect(mockTransactionsNative).toHaveBeenCalledWith(
      expect.objectContaining({
        time_expire: '2026-07-24T01:02:03.000Z',
      }),
    );
  });

  it('throws when SDK response status is not 200', async () => {
    mockTransactionsNative.mockResolvedValue({
      status: 400,
      error: 'invalid signature',
    });
    const service = new WechatPayService(makeConfig());
    await expect(service.createNativePay('order-1', 100, 'desc')).rejects.toThrow(
      /微信下单失败/,
    );
  });

  it('throws when SDK response has no data.code_url', async () => {
    mockTransactionsNative.mockResolvedValue({ status: 200, data: {} });
    const service = new WechatPayService(makeConfig());
    await expect(service.createNativePay('order-1', 100, 'desc')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it.each([
    [{ status: 500, data: { code: 'SYSTEM_ERROR' } }],
    [{ status: 403, data: { code: 'OUT_TRADE_NO_USED' } }],
  ])('marks ambiguous provider responses as outcome-unknown', async (response) => {
    mockTransactionsNative.mockResolvedValue(response);
    const service = new WechatPayService(makeConfig());

    await expect(service.createNativePay('order-1', 100, 'desc')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it('marks transport failures as outcome-unknown', async () => {
    mockTransactionsNative.mockRejectedValue(new Error('socket timed out'));
    const service = new WechatPayService(makeConfig());

    await expect(service.createNativePay('order-1', 100, 'desc')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it('throws ServiceUnavailableException when config is missing', async () => {
    const service = new WechatPayService(makeConfig({ WECHAT_APP_ID: '' }));
    await expect(service.createNativePay('order-1', 100, 'desc')).rejects.toThrow(
      /未配置/,
    );
  });

  it('forwards notify_url from config', async () => {
    mockTransactionsNative.mockResolvedValue({
      status: 200,
      data: { code_url: 'weixin://test' },
    });
    const service = new WechatPayService(makeConfig());
    await service.createNativePay('order-1', 100, 'desc');
    const call = mockTransactionsNative.mock.calls[0][0];
    expect(call.notify_url).toBe('https://x.example.com/notify');
  });
});

// ============================================================
// WechatPayService.queryOrder
// ============================================================
describe('WechatPayService.queryOrder', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns trade_state and transaction_id on success (reads data.*)', async () => {
    mockQuery.mockResolvedValue({
      status: 200,
      data: { trade_state: 'SUCCESS', transaction_id: 'TX-123' },
    });
    const service = new WechatPayService(makeConfig());
    const result = await service.queryOrder('ORDER-1');
    expect(result).toEqual({
      trade_state: 'SUCCESS',
      transaction_id: 'TX-123',
      amount: undefined,
    });
    expect(mockQuery).toHaveBeenCalledWith({ out_trade_no: 'ORDER-1' });
  });

  it('throws when query returns non-200 status', async () => {
    mockQuery.mockResolvedValue({ status: 500, error: 'server error' });
    const service = new WechatPayService(makeConfig());
    await expect(service.queryOrder('ORDER-1')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it('throws when status 200 but data is missing', async () => {
    mockQuery.mockResolvedValue({ status: 200 }); // no data
    const service = new WechatPayService(makeConfig());
    await expect(service.queryOrder('ORDER-1')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it('treats missing query configuration as outcome-unknown', async () => {
    const service = new WechatPayService(makeConfig({ WECHAT_MCH_ID: '' }));
    await expect(service.queryOrder('ORDER-1')).rejects.toThrow(
      WechatPayOrderOutcomeUnknownError,
    );
  });

  it('uses the HTTP status fallback when result has no error/message', async () => {
    mockQuery.mockResolvedValue({ status: 500 });
    const service = new WechatPayService(makeConfig());
    await expect(service.queryOrder('ORDER-1')).rejects.toThrow(/HTTP 500/);
  });

  it('returns a stable NOT_FOUND state for a definite missing provider order', async () => {
    mockQuery.mockResolvedValue({
      status: 404,
      data: { code: 'ORDER_NOT_EXIST', message: 'order does not exist' },
    });
    const service = new WechatPayService(makeConfig());

    await expect(service.queryOrder('ORDER-1')).resolves.toEqual({
      trade_state: 'NOT_FOUND',
    });
  });
});

// ============================================================
// WechatPayService.refund
// ============================================================
describe('WechatPayService.refund', () => {
  beforeEach(() => {
    mockRefunds.mockReset();
  });

  it('returns success=true when refund data.status is SUCCESS', async () => {
    mockRefunds.mockResolvedValue({
      status: 200,
      data: { status: 'SUCCESS', refund_id: 'ref-1' },
    });
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 9900, 9900);
    expect(result.success).toBe(true);
    expect(result.refundId).toBe('ref-1');
  });

  it('keeps PROCESSING pending and does not report terminal success', async () => {
    mockRefunds.mockResolvedValue({
      status: 200,
      data: { status: 'PROCESSING', refund_id: 'ref-2' },
    });
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 9900, 5000);
    expect(result.success).toBe(false);
    expect(result.state).toBe('PENDING');
  });

  it('returns success=false when refund data.status is ABNORMAL/CLOSED', async () => {
    mockRefunds.mockResolvedValue({
      status: 200,
      data: { status: 'ABNORMAL', refund_id: 'ref-x' },
    });
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 9900, 9900);
    expect(result.success).toBe(false);
    expect(result.refundId).toBe('ref-x');
  });

  it('returns success=false when HTTP status is non-200', async () => {
    mockRefunds.mockResolvedValue({ status: 500, error: 'server busy' });
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 9900, 9900);
    expect(result.success).toBe(false);
    expect(result.error).toContain('server busy');
  });

  it('returns success=false with error string when SDK throws', async () => {
    mockRefunds.mockRejectedValue(new Error('refund API error'));
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 9900, 9900);
    expect(result.success).toBe(false);
    expect(result.error).toContain('refund API error');
  });

  it('passes correct transaction_id and refund/total amounts to refunds method', async () => {
    mockRefunds.mockResolvedValue({
      status: 200,
      data: { status: 'SUCCESS', refund_id: 'r-x' },
    });
    const service = new WechatPayService(makeConfig());
    await service.refund('TX-abc', 'ORDER-abc', 20000, 10000);
    const call = mockRefunds.mock.calls[0][0];
    expect(call.transaction_id).toBe('TX-abc');
    expect(call.out_refund_no).toBe('refund_ORDER-abc_10000');
    expect(call.amount.total).toBe(20000);
    expect(call.amount.refund).toBe(10000);
    expect(call.amount.currency).toBe('CNY');
  });

  it('returns non-Error exception message as "Unknown"', async () => {
    mockRefunds.mockRejectedValue('plain string error');
    const service = new WechatPayService(makeConfig());
    const result = await service.refund('TX-1', 'ORDER-1', 100, 100);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown');
  });
});

describe('WechatPayService.queryRefund', () => {
  beforeEach(() => {
    mockFindRefunds.mockReset();
  });

  it('confirms only SUCCESS as terminal success', async () => {
    mockFindRefunds.mockResolvedValue({
      status: 200,
      data: {
        out_refund_no: 'refund_ORDER-1_9900',
        status: 'SUCCESS',
        refund_id: 'refund-wx-1',
      },
    });
    const service = new WechatPayService(makeConfig());
    await expect(
      service.queryRefund('refund_ORDER-1_9900'),
    ).resolves.toMatchObject({
      state: 'SUCCEEDED',
      providerStatus: 'SUCCESS',
      refundId: 'refund-wx-1',
    });
  });

  it('keeps PROCESSING pending so compensation cannot start', async () => {
    mockFindRefunds.mockResolvedValue({
      status: 200,
      data: {
        out_refund_no: 'refund_ORDER-1_9900',
        status: 'PROCESSING',
        refund_id: 'refund-wx-1',
      },
    });
    const service = new WechatPayService(makeConfig());
    await expect(
      service.queryRefund('refund_ORDER-1_9900'),
    ).resolves.toMatchObject({ state: 'PENDING' });
  });

  it('fails closed on a mismatched merchant refund number', async () => {
    mockFindRefunds.mockResolvedValue({
      status: 200,
      data: {
        out_refund_no: 'refund_OTHER_9900',
        status: 'SUCCESS',
        refund_id: 'refund-wx-other',
      },
    });
    const service = new WechatPayService(makeConfig());
    await expect(
      service.queryRefund('refund_ORDER-1_9900'),
    ).resolves.toMatchObject({
      state: 'UNKNOWN',
      providerStatus: 'IDENTITY_MISMATCH',
    });
  });
});

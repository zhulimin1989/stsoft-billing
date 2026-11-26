import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRefundOutcome } from './provider-refund.types';

/**
 * The request may have reached WeChat even though no usable response reached us.
 * Callers must keep the local order retryable and reconcile with the same
 * out_trade_no instead of declaring a definitive failure.
 */
export class WechatPayOrderOutcomeUnknownError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WechatPayOrderOutcomeUnknownError';
    this.cause = cause;
  }
}

@Injectable()
export class WechatPayService {
  private readonly logger = new Logger(WechatPayService.name);

  private readonly appId: string | undefined;
  private readonly mchId: string | undefined;
  private readonly apiV3Key: string | undefined;
  private readonly serialNo: string | undefined;
  private readonly privateKeyPath: string | undefined;
  private readonly notifyUrl: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('WECHAT_APP_ID');
    this.mchId = this.config.get<string>('WECHAT_MCH_ID');
    this.apiV3Key = this.config.get<string>('WECHAT_API_V3_KEY');
    this.serialNo = this.config.get<string>('WECHAT_SERIAL_NO');
    this.privateKeyPath = this.config.get<string>('WECHAT_PRIVATE_KEY_PATH');
    this.notifyUrl = this.config.get<string>('WECHAT_NOTIFY_URL');
  }

  /** 检查微信支付凭证是否配置 */
  private assertConfigured(): void {
    if (
      !this.appId ||
      !this.mchId ||
      !this.apiV3Key ||
      !this.serialNo ||
      !this.privateKeyPath
    ) {
      throw new ServiceUnavailableException('微信支付未配置');
    }
  }

  /** 获取 wechatpay-node-v3 实例（懒加载） */
  private async getInstance() {
    this.assertConfigured();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WxPay = require('wechatpay-node-v3');
    const fs = await import('fs');
    const privateKey = fs.readFileSync(this.privateKeyPath!, 'utf-8');

    // SDK 构造器形状：{ appid, mchid, privateKey, serial_no, key }
    // publicKey 对于 merchant 调用是可选的（验签时内部拉取平台证书），
    // 不要传 null（SDK 内部会 fail fast）。
    return new WxPay({
      appid: this.appId,
      mchid: this.mchId,
      privateKey,
      serial_no: this.serialNo,
      key: this.apiV3Key,
    });
  }

  /**
   * Native 支付下单 — 返回二维码 URL
   * @param orderId   系统订单号
   * @param amountCents 金额（分）
   * @param description 商品描述
   */
  async createNativePay(
    orderId: string,
    amountCents: number,
    description: string,
    expiresAt?: Date,
  ): Promise<{ codeUrl: string }> {
    const pay = await this.getInstance();

    const params = {
      description,
      out_trade_no: orderId,
      notify_url: this.notifyUrl,
      ...(expiresAt ? { time_expire: expiresAt.toISOString() } : {}),
      amount: {
        total: amountCents,
        currency: 'CNY',
      },
    };

    this.logger.log(`微信 Native 下单: orderId=${orderId}, amount=${amountCents}`);

    let result: {
      status?: number;
      data?: { code_url?: string; code?: string; message?: string };
      error?: string;
    };
    try {
      result = await pay.transactions_native(params);
    } catch (error) {
      throw new WechatPayOrderOutcomeUnknownError(
        '微信下单请求结果未知，请使用相同商户订单号重试或查单',
        error,
      );
    }

    // SDK 返回形状：{ status, data?, error? }
    // 成功时 code_url 在 result.data.code_url 下，不在顶层
    const codeUrl = result?.data?.code_url;
    if (result?.status === 200 && codeUrl) {
      return { codeUrl };
    }

    this.logger.error(`微信下单失败: ${JSON.stringify(result)}`);
    const providerCode = [
      result?.error,
      result?.data?.code,
      result?.data?.message,
    ].filter(Boolean).join(' ');
    if (
      result?.status === 200
      || result?.status === 429
      || (typeof result?.status === 'number' && result.status >= 500)
      || /\b(SYSTEM_ERROR|OUT_TRADE_NO_USED|FREQUENCY_LIMITED)\b/i.test(providerCode)
    ) {
      throw new WechatPayOrderOutcomeUnknownError(
        `微信下单结果未知: ${providerCode || `HTTP ${result?.status ?? 'unknown'}`}`,
      );
    }
    throw new Error(
      `微信下单失败: ${result?.error || result?.data?.message || '未知错误'}`,
    );
  }

  /**
   * 验证微信 V3 回调签名并解密通知体。
   *
   * 完整校验链：
   *   1. 检查必需的 Wechatpay-* headers 齐全
   *   2. 调 SDK verifySign() — 用微信平台证书公钥验 RSA 签名（防伪造）
   *   3. 调 decipher_gcm() — 用 APIv3 密钥做 AES-GCM 解密（防篡改）
   *
   * @throws Error 签名验证失败 / 解密失败时抛错，controller 返回 401
   */
  async verifyNotifySign(
    headers: Record<string, string>,
    rawBody: string,
    body: {
      id: string;
      resource: { ciphertext: string; nonce: string; associated_data: string };
    },
  ): Promise<{
    out_trade_no: string;
    transaction_id: string;
    trade_state: string;
    amount?: { total?: number; currency?: string };
  }> {
    this.assertConfigured();

    const signature = headers['wechatpay-signature'];
    const timestamp = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const serial = headers['wechatpay-serial'];
    if (!signature || !timestamp || !nonce || !serial) {
      throw new Error(
        '微信回调缺少必需 header (wechatpay-signature/timestamp/nonce/serial)',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WxPay = require('wechatpay-node-v3');
    const fs = await import('fs');
    const privateKey = fs.readFileSync(this.privateKeyPath!, 'utf-8');

    const pay = new WxPay({
      appid: this.appId,
      mchid: this.mchId,
      privateKey,
      serial_no: this.serialNo,
      key: this.apiV3Key,
    });

    // Step 1: verify RSA signature (platform cert) — requires raw body string
    const sigOk = await pay.verifySign({
      timestamp,
      nonce,
      body: rawBody,
      serial,
      signature,
      apiSecret: this.apiV3Key,
    });
    if (!sigOk) {
      throw new Error('微信回调签名验证失败 (V3 RSA verifySign 返回 false)');
    }

    // Step 2: AES-GCM decrypt resource
    const decrypted = pay.decipher_gcm(
      body.resource.ciphertext,
      body.resource.associated_data,
      body.resource.nonce,
      this.apiV3Key,
    );

    this.logger.log(`微信回调解密成功: trade_no=${decrypted?.out_trade_no}`);
    return decrypted;
  }

  /**
   * 主动查询微信订单状态
   */
  async queryOrder(
    tradeNo: string,
  ): Promise<{
    trade_state: string;
    transaction_id?: string;
    amount?: { total?: number; currency?: string };
  }> {
    let result: {
      status?: number;
      data?: {
        trade_state?: string;
        transaction_id?: string;
        amount?: { total?: number; currency?: string };
        code?: string;
        message?: string;
      };
      error?: string;
    };
    try {
      const pay = await this.getInstance();
      result = await pay.query({ out_trade_no: tradeNo });
    } catch (error) {
      throw new WechatPayOrderOutcomeUnknownError(
        `微信查单结果未知: order=${tradeNo}`,
        error,
      );
    }

    // 业务字段在 result.data 下
    if (
      result?.status === 200
      && result?.data
      && typeof result.data.trade_state === 'string'
    ) {
      return {
        trade_state: result.data.trade_state,
        transaction_id: result.data.transaction_id,
        amount: result.data.amount,
      };
    }

    const providerCode = [
      result?.error,
      result?.data?.code,
      result?.data?.message,
    ].filter(Boolean).join(' ');
    if (
      result?.status === 404
      && /\bORDER_NOT_EXIST(?:S)?\b/i.test(providerCode)
    ) {
      return { trade_state: 'NOT_FOUND' };
    }

    this.logger.error(`微信查单失败: ${JSON.stringify(result)}`);
    throw new WechatPayOrderOutcomeUnknownError(
      `微信查单结果未知: ${providerCode || `HTTP ${result?.status ?? 'unknown'}`}`,
    );
  }

  async refund(
    transactionId: string,
    orderId: string,
    totalCents: number,
    refundCents: number,
    outRefundNo?: string,
  ): Promise<ProviderRefundOutcome & { success: boolean }> {
    try {
      const pay = await this.getInstance();
      // SDK 方法名是 refunds（v3 是另一个非公开 API，历史写错了）
      const result = await pay.refunds({
        transaction_id: transactionId,
        out_refund_no: outRefundNo ?? `refund_${orderId}_${refundCents}`,
        reason: '管理员退款',
        amount: { refund: refundCents, total: totalCents, currency: 'CNY' },
      });

      // HTTP 成功 + 业务字段在 data 下
      if (result?.status !== 200 || !result?.data) {
        const providerCode = [
          result?.error,
          result?.data?.code,
          result?.data?.message,
        ].filter(Boolean).join(' ');
        const outcomeUnknown =
          result?.status === 200
          || result?.status === 429
          || (typeof result?.status === 'number' && result.status >= 500)
          || /\b(SYSTEM_ERROR|FREQUENCY_LIMITED)\b/i.test(providerCode);
        return {
          success: false,
          state: outcomeUnknown ? 'UNKNOWN' : 'FAILED',
          providerStatus: providerCode || `HTTP_${result?.status ?? 'UNKNOWN'}`,
          error:
            typeof result?.error === 'string'
              ? result.error
              : JSON.stringify(result?.error || result?.data || 'unknown'),
        };
      }
      const refundData = result.data;
      // 微信退款 status：SUCCESS / PROCESSING / ABNORMAL / CLOSED
      const providerStatus =
        typeof refundData.status === 'string'
          ? refundData.status.toUpperCase()
          : 'UNKNOWN';
      const state =
        providerStatus === 'SUCCESS'
          ? 'SUCCEEDED'
          : providerStatus === 'PROCESSING'
            ? 'PENDING'
            : providerStatus === 'ABNORMAL' || providerStatus === 'CLOSED'
              ? 'FAILED'
              : 'UNKNOWN';
      return {
        success: state === 'SUCCEEDED',
        state,
        providerStatus,
        refundId: refundData.refund_id,
      };
    } catch (err) {
      return {
        success: false,
        state: 'UNKNOWN',
        providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
        error: err instanceof Error ? err.message : 'Unknown',
      };
    }
  }

  /**
   * Reconcile a refund by the immutable merchant refund number. Only SUCCESS
   * is terminal success; PROCESSING must never trigger local compensation.
   */
  async queryRefund(outRefundNo: string): Promise<ProviderRefundOutcome> {
    try {
      const pay = await this.getInstance();
      const result = await pay.find_refunds(outRefundNo);
      if (result?.status === 200 && result?.data) {
        const data = result.data;
        if (data.out_refund_no !== outRefundNo) {
          return {
            state: 'UNKNOWN',
            providerStatus: 'IDENTITY_MISMATCH',
            error: '微信退款查询返回的商户退款单号不匹配',
          };
        }
        const providerStatus =
          typeof data.status === 'string' ? data.status.toUpperCase() : 'UNKNOWN';
        const state =
          providerStatus === 'SUCCESS'
            ? 'SUCCEEDED'
            : providerStatus === 'PROCESSING'
              ? 'PENDING'
              : providerStatus === 'ABNORMAL' || providerStatus === 'CLOSED'
                ? 'FAILED'
                : 'UNKNOWN';
        return {
          state,
          providerStatus,
          refundId: data.refund_id,
        };
      }

      const providerCode = [
        result?.error,
        result?.data?.code,
        result?.data?.message,
      ].filter(Boolean).join(' ');
      if (
        result?.status === 404
        && /\b(RESOURCE_NOT_EXISTS|REFUND_NOT_EXIST(?:S)?)\b/i.test(providerCode)
      ) {
        return {
          state: 'NOT_FOUND',
          providerStatus: providerCode || 'NOT_FOUND',
        };
      }
      return {
        state: 'UNKNOWN',
        providerStatus: providerCode || `HTTP_${result?.status ?? 'UNKNOWN'}`,
        error: providerCode || '微信退款查询结果未知',
      };
    } catch (err) {
      return {
        state: 'UNKNOWN',
        providerStatus: 'QUERY_OUTCOME_UNKNOWN',
        error: err instanceof Error ? err.message : 'Unknown',
      };
    }
  }
}

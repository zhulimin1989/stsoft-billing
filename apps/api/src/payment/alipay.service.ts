import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRefundOutcome } from './provider-refund.types';

export type AlipayKeyType = 'PKCS1' | 'PKCS8';

export interface AlipayCredentials {
  appId?: string;
  privateKey?: string;
  alipayPublicKey?: string;
  notifyUrl?: string;
  returnUrl?: string;
  gateway?: string;
  keyType?: string;
  timeoutMs?: number;
}

type RequiredAlipayCredentials = AlipayCredentials & {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  keyType?: AlipayKeyType;
};

@Injectable()
export class AlipayService {
  private readonly logger = new Logger(AlipayService.name);

  private readonly appId: string | undefined;
  private readonly privateKey: string | undefined;
  private readonly alipayPublicKey: string | undefined;
  private readonly notifyUrl: string | undefined;
  private readonly returnUrl: string | undefined;
  private readonly gateway: string | undefined;
  private readonly keyType: AlipayKeyType | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('ALIPAY_APP_ID');
    this.privateKey = this.config.get<string>('ALIPAY_PRIVATE_KEY');
    this.alipayPublicKey = this.config.get<string>('ALIPAY_ALIPAY_PUBLIC_KEY');
    this.notifyUrl = this.config.get<string>('ALIPAY_NOTIFY_URL');
    this.returnUrl = this.config.get<string>('ALIPAY_RETURN_URL');
    this.gateway = this.config.get<string>('ALIPAY_GATEWAY');
    this.keyType = this.normalizeKeyType(this.config.get<string>('ALIPAY_KEY_TYPE'));
    this.timeoutMs = this.normalizeTimeoutMs(this.config.get<string>('ALIPAY_TIMEOUT_MS'));
  }

  /** 检查支付宝凭证是否配置 */
  private assertConfigured(credentials?: AlipayCredentials): RequiredAlipayCredentials {
    const resolved = this.resolveCredentials(credentials);
    if (!resolved.appId || !resolved.privateKey || !resolved.alipayPublicKey) {
      throw new ServiceUnavailableException('支付宝支付未配置');
    }
    return resolved as RequiredAlipayCredentials;
  }

  /** 获取 alipay-sdk 实例（懒加载） */
  private getInstance(credentials?: AlipayCredentials) {
    const resolved = this.assertConfigured(credentials);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const alipaySdkModule = require('alipay-sdk');
    const AlipaySdk = alipaySdkModule.AlipaySdk || alipaySdkModule.default || alipaySdkModule;
    if (typeof AlipaySdk !== 'function') {
      throw new ServiceUnavailableException('支付宝 SDK 加载失败');
    }
    return new AlipaySdk({
      appId: resolved.appId,
      privateKey: resolved.privateKey,
      alipayPublicKey: resolved.alipayPublicKey,
      timeout: resolved.timeoutMs ?? 15_000,
      ...(resolved.gateway ? { gateway: resolved.gateway } : {}),
      ...(resolved.keyType ? { keyType: resolved.keyType } : {}),
    });
  }

  private resolveCredentials(credentials?: AlipayCredentials): AlipayCredentials {
    if (credentials) {
      return {
        appId: this.firstNonEmpty(credentials.appId),
        privateKey: this.firstNonEmpty(credentials.privateKey),
        alipayPublicKey: this.firstNonEmpty(credentials.alipayPublicKey),
        notifyUrl: this.firstNonEmpty(credentials.notifyUrl),
        returnUrl: this.firstNonEmpty(credentials.returnUrl),
        gateway: this.firstNonEmpty(credentials.gateway),
        keyType: this.normalizeKeyType(this.firstNonEmpty(credentials.keyType)),
        timeoutMs: this.normalizeTimeoutMs(credentials.timeoutMs),
      };
    }

    return {
      appId: this.firstNonEmpty(this.appId),
      privateKey: this.firstNonEmpty(this.privateKey),
      alipayPublicKey: this.firstNonEmpty(this.alipayPublicKey),
      notifyUrl: this.firstNonEmpty(this.notifyUrl),
      returnUrl: this.firstNonEmpty(this.returnUrl),
      gateway: this.firstNonEmpty(this.gateway),
      keyType: this.normalizeKeyType(this.firstNonEmpty(this.keyType)),
      timeoutMs: this.timeoutMs,
    };
  }

  private firstNonEmpty(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  }

  private normalizeKeyType(value: string | undefined): AlipayKeyType | undefined {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'PKCS1' || normalized === 'PKCS8') {
      return normalized;
    }
    return undefined;
  }

  private normalizeTimeoutMs(value: string | number | undefined): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(Math.max(parsed, 1_000), 60_000);
  }

  /**
   * 电脑网站支付 — 返回支付宝收银台跳转 URL。
   */
  async createPagePay(
    orderId: string,
    amountCents: number,
    description: string,
    credentials?: AlipayCredentials,
    returnUrl?: string,
  ): Promise<{ url: string }> {
    const resolved = this.assertConfigured(credentials);
    const sdk = this.getInstance(resolved);
    const totalAmount = (amountCents / 100).toFixed(2);

    this.logger.log(
      `支付宝网页支付下单: orderId=${orderId}, amount=${totalAmount}`,
    );

    const pageParams: Record<string, unknown> = {
      bizContent: {
        out_trade_no: orderId,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: totalAmount,
        subject: description,
      },
    };
    if (resolved.notifyUrl) pageParams.notifyUrl = resolved.notifyUrl;
    const resolvedReturnUrl = this.firstNonEmpty(returnUrl, resolved.returnUrl);
    if (resolvedReturnUrl) pageParams.returnUrl = resolvedReturnUrl;

    const url = sdk.pageExec('alipay.trade.page.pay', 'GET', pageParams);

    if (typeof url === 'string' && url.trim()) {
      return { url };
    }

    this.logger.error(`支付宝网页支付链接生成失败: ${String(url)}`);
    throw new BadGatewayException('支付宝网页支付链接生成失败');
  }

  /**
   * 验证支付宝异步通知签名
   * @param params POST form 参数（含 sign / sign_type）
   */
  verifyNotifySign(params: Record<string, string>, credentials?: AlipayCredentials): boolean {
    const sdk = this.getInstance(credentials);

    try {
      return sdk.checkNotifySign(params);
    } catch (err) {
      this.logger.error(`支付宝验签失败: ${err}`);
      return false;
    }
  }

  /**
   * 主动查询支付宝订单状态
   */
  async queryOrder(
    tradeNo: string,
    credentials?: AlipayCredentials,
  ): Promise<{ tradeStatus: string; tradeNo: string }> {
    const sdk = this.getInstance(credentials);

    const result = await sdk.exec('alipay.trade.query', {
      bizContent: {
        out_trade_no: tradeNo,
      },
    });

    return {
      tradeStatus: result?.tradeStatus || 'UNKNOWN',
      tradeNo: result?.tradeNo || '',
    };
  }

  async refund(
    tradeNo: string,
    refundCents: number,
    reason: string,
    credentials?: AlipayCredentials,
    outRequestNo?: string,
  ): Promise<ProviderRefundOutcome & { success: boolean }> {
    try {
      const sdk = this.getInstance(credentials);
      const result = await sdk.exec('alipay.trade.refund', {
        bizContent: {
          trade_no: tradeNo,
          refund_amount: (refundCents / 100).toFixed(2),
          refund_reason: reason || '管理员退款',
          ...(outRequestNo ? { out_request_no: outRequestNo } : {}),
        },
      });

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      const resp = parsed.alipay_trade_refund_response || parsed;
      const providerStatus =
        typeof resp.code === 'string' ? resp.code : 'UNKNOWN';
      const subCode = resp.subCode ?? resp.sub_code;
      const subMessage = resp.subMsg ?? resp.sub_msg;
      if (providerStatus === '10000') {
        return {
          success: true,
          state: 'SUCCEEDED',
          providerStatus,
        };
      }
      const retryable =
        providerStatus === '20000'
        || /\b(SYSTEM_ERROR|UNKNOWN_ERROR|ACQ.SYSTEM_ERROR)\b/i.test(
          `${subCode ?? ''} ${subMessage ?? ''}`,
        );
      return {
        success: false,
        state: retryable ? 'UNKNOWN' : 'FAILED',
        providerStatus:
          [providerStatus, subCode].filter(Boolean).join(':') || 'UNKNOWN',
        error: subMessage || resp.msg || '支付宝退款失败',
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
   * Query the immutable out_request_no used by alipay.trade.refund. A query
   * transport success alone is not enough: require explicit refund success
   * evidence before local compensation.
   */
  async queryRefund(
    tradeNo: string,
    outRequestNo: string,
    credentials?: AlipayCredentials,
  ): Promise<ProviderRefundOutcome> {
    try {
      const sdk = this.getInstance(credentials);
      const result = await sdk.exec('alipay.trade.fastpay.refund.query', {
        bizContent: {
          trade_no: tradeNo,
          out_request_no: outRequestNo,
        },
      });
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      const resp = parsed.alipay_trade_fastpay_refund_query_response || parsed;
      const code = typeof resp.code === 'string' ? resp.code : 'UNKNOWN';
      const subCode = resp.subCode ?? resp.sub_code;
      const subMessage = resp.subMsg ?? resp.sub_msg;
      if (code !== '10000') {
        const providerStatus =
          [code, subCode].filter(Boolean).join(':') || 'UNKNOWN';
        if (
          /\b(TRADE_NOT_EXIST|REFUND_NOT_EXIST|RECORD_NOT_EXIST)\b/i.test(
            `${subCode ?? ''} ${subMessage ?? ''}`,
          )
        ) {
          return { state: 'NOT_FOUND', providerStatus };
        }
        return {
          state: 'UNKNOWN',
          providerStatus,
          error: subMessage || resp.msg || '支付宝退款查询失败',
        };
      }

      const returnedRequestNo =
        resp.outRequestNo ?? resp.out_request_no;
      if (
        returnedRequestNo
        && String(returnedRequestNo) !== outRequestNo
      ) {
        return {
          state: 'UNKNOWN',
          providerStatus: 'IDENTITY_MISMATCH',
          error: '支付宝退款查询返回的退款请求号不匹配',
        };
      }
      const refundStatus =
        typeof (resp.refundStatus ?? resp.refund_status) === 'string'
          ? String(resp.refundStatus ?? resp.refund_status).toUpperCase()
          : '';
      if (
        refundStatus === 'REFUND_SUCCESS'
        || resp.gmtRefundPay
        || resp.gmt_refund_pay
      ) {
        return {
          state: 'SUCCEEDED',
          providerStatus: refundStatus || 'GMT_REFUND_PAY_CONFIRMED',
        };
      }
      if (
        refundStatus === 'REFUND_FAIL'
        || refundStatus === 'REFUND_CLOSED'
      ) {
        return { state: 'FAILED', providerStatus: refundStatus };
      }
      return {
        state: 'PENDING',
        providerStatus: refundStatus || 'QUERY_ACCEPTED_NOT_CONFIRMED',
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

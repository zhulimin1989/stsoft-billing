import { Injectable, Logger } from '@nestjs/common';

// PSA 接口配置（Token URL / Invoice URL / client credentials）国内外共用。
// 业务字段（项目号、票种、税编、币种）见 psa-invoice.profile.ts。

export interface PsaGoodsLine {
  content: string;
  taxClassificationCode: string;
  specModel: string;
  unitName: string;
  quantity: number;
  unitPrice: number;
  money: number;
}

export interface PsaInvoiceAttachment {
  fileName: string;
  fileRemark?: string;
  fileBase64: string;
}

export interface PsaInvoiceRequest {
  orderNo: string;
  orderMoney: number;
  prjNo: string;
  invoiceKindName: string;
  standbyAccountName: string;
  accountTaxNo: string;
  address: string;
  bankText: string;
  currencyName: string;
  sdAreaId: number;
  applyEmpNo: string;
  applyPhoneNo: string;
  isoftstoneEmail: string;
  customerEmail: string;
  isEmailClient: string;
  clientLinkman: string;
  clientPhone: string;
  clientAddress: string;
  clientPostalCode: string;
  applyReason: string;
  applyReasonDetail: string;
  invoiceAmount: number;
  invoiceAmountLocal: number;
  serviceMonth: string;
  planPaymentDate: string;
  invoiceRemark: string;
  goodsLines: PsaGoodsLine[];
  attachments?: PsaInvoiceAttachment[];
}

export function psaXlsxFileName(applicationNo: string): string {
  const ext = '.xlsx';
  const raw = String(applicationNo || 'invoice').replace(/[^A-Za-z0-9._-]/g, '_');
  const base = (raw.slice(0, 50 - ext.length) || 'invoice');
  return `${base}${ext}`;
}

export function buildPsaXlsxAttachment(applicationNo: string, buffer: Buffer): PsaInvoiceAttachment {
  if (!buffer?.length) {
    throw new Error('海外形式发票附件不能为空');
  }
  return {
    fileName: psaXlsxFileName(applicationNo),
    fileRemark: '形式发票',
    fileBase64: buffer.toString('base64'),
  };
}

export interface PsaInvoiceResult {
  formNo: string;
  message?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface InvoiceResponse {
  code?: string | number;
  message?: string;
  data?: { syncResult?: string; formNo?: string };
}

@Injectable()
export class PsaInvoiceClient {
  private readonly logger = new Logger(PsaInvoiceClient.name);
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;

  isEnabled(): boolean {
    return process.env.PSA_INVOICE_ENABLED?.toLowerCase() === 'true';
  }

  async apply(request: PsaInvoiceRequest): Promise<PsaInvoiceResult> {
    const url = process.env.PSA_INVOICE_URL?.trim();
    if (!url) throw new Error('PSA_INVOICE_URL 未配置');
    let token = await this.getToken();
    let response = await this.postInvoice(url, token, request);
    if (response.status === 401) {
      this.token = null;
      token = await this.getToken();
      response = await this.postInvoice(url, token, request);
    }
    const body = await parseJson<InvoiceResponse>(response);
    if (!response.ok) {
      this.logger.error(
        `PSA HTTP ${response.status} message=${safeMessage(body?.message)} orderNo=${request.orderNo}`,
      );
      throw new Error(`PSA HTTP ${response.status}: ${safeMessage(body?.message)}`);
    }
    if (!body || String(body.code) !== '0' || !body.data?.formNo) {
      this.logger.error(
        `PSA 业务失败 code=${body?.code ?? ''} message=${safeMessage(body?.message)} syncResult=${body?.data?.syncResult ?? ''} orderNo=${request.orderNo}`,
      );
      throw new Error(`PSA 业务失败: ${safeMessage(body?.message)}`);
    }
    return { formNo: body.data.formNo, message: body.message };
  }

  private async postInvoice(url: string, token: string, request: PsaInvoiceRequest): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.fetchToken().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const url = process.env.PSA_TOKEN_URL?.trim();
    const clientId = process.env.PSA_CLIENT_ID?.trim();
    const clientSecret = process.env.PSA_CLIENT_SECRET?.trim();
    const scope = process.env.PSA_SCOPE?.trim() || 'InvoiceAPI';
    if (!url || !clientId || !clientSecret) throw new Error('PSA OAuth 配置不完整');
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs()),
    });
    const body = await parseJson<TokenResponse & { error?: string; error_description?: string }>(response);
    if (!response.ok || !body?.access_token) {
      throw new Error(`PSA Token HTTP ${response.status}: ${safeMessage(body?.error_description || body?.error)}`);
    }
    const expiresIn = Number(body.expires_in) || 300;
    this.token = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    this.logger.debug('PSA access token refreshed');
    return body.access_token;
  }
}

async function parseJson<T>(response: Response): Promise<T | null> {
  try { return (await response.json()) as T; } catch { return null; }
}

function timeoutMs(): number {
  const value = Number(process.env.PSA_HTTP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 120_000) : 15_000;
}

function safeMessage(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.slice(0, 500) : '未知错误';
}

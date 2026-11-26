import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  CodingPlanProviderAdapter,
  ProviderCreateOrderInput,
  ProviderCreateOrderResult,
  ProviderLineRuntimeConfig,
  ProviderProduct,
  ProviderUsageResult,
  ProviderUsageSummary,
  ProviderUsageSummaryBucket,
  QueryCustomerUsageInput,
} from './coding-plan-provider.types';

@Injectable()
export class ZhipuPartnerAdapter implements CodingPlanProviderAdapter {
  readonly adapterType = 'zhipu_partner';

  constructor(private readonly config: ConfigService) {}

  async listProducts(line: ProviderLineRuntimeConfig): Promise<ProviderProduct[]> {
    const payload = await this.signedRequest(line, 'GET', '/api/biz/partner/products');
    return this.productList(payload).map((item) => this.toProviderProduct(item));
  }

  async createOrder(
    line: ProviderLineRuntimeConfig,
    input: ProviderCreateOrderInput,
  ): Promise<ProviderCreateOrderResult> {
    const orderPayload = {
      partnerUserId: input.partnerUserId,
      partnerOrderNo: input.partnerOrderNo,
      productId: input.upstreamProductId,
      ...(input.partnerUserName
        ? { partnerUserName: input.partnerUserName.slice(0, 30) }
        : {}),
    };
    const payload = await this.signedRequest(line, 'POST', '/api/biz/partner/createOrder', orderPayload);
    return this.toCreateOrderResult(line, payload);
  }

  private toCreateOrderResult(
    line: ProviderLineRuntimeConfig,
    payload: Record<string, unknown>,
  ): ProviderCreateOrderResult {
    const data = this.objectValue(payload.data);
    const apiKey = this.stringValue(data.apiKey);
    const secretKey = this.stringValue(data.secretKey);
    if (!apiKey || !secretKey) {
      throw new BadRequestException(`${line.code} createOrder 响应缺少 apiKey 或 secretKey`);
    }
    return {
      upstreamOrderId: this.stringValue(data.orderId),
      apiKey,
      secretKey,
      credentialFormat: 'apiKey.secretKey',
      productStartTime: this.stringValue(data.productStartTime),
      productEndTime: this.stringValue(data.productEndTime),
      raw: payload,
    };
  }

  async queryCustomerUsage(
    line: ProviderLineRuntimeConfig,
    input: QueryCustomerUsageInput,
  ): Promise<ProviderUsageResult> {
    const query = this.usageQueryConfig(line);
    const payload = await this.signedRequest(
      line,
      'GET',
      query.path,
      this.usageQueryPayload(input),
    );
    const data = this.objectValue(payload.data);
    return {
      level: this.stringValue(data.level),
      quotaProgress: this.toUsageQuotaProgress(payload),
      usageSummary: this.toUsageSummary(data.usageSummary),
      updatedAt: this.stringValue(data.updatedAt),
      raw: payload,
    };
  }

  private async signedRequest(
    line: ProviderLineRuntimeConfig,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!line.partnerCode || !line.partnerSecretKey || !line.apiBaseUrl) {
      throw new ServiceUnavailableException(`${line.code} 供应商凭证未启用或未配置完整`);
    }

    const url = new URL(path, line.apiBaseUrl);
    if (method === 'GET') {
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await fetch(url, {
      method,
      headers: this.buildSignedHeaders(line),
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(this.requestTimeoutMs()),
    });
    const text = await response.text();
    const payload = this.parseJsonObject(text);
    if (!response.ok) {
      throw new BadRequestException(`${line.code} ${path} HTTP ${response.status}: ${this.providerMessage(payload, text)}`);
    }
    const code = payload.code;
    if (code !== undefined && code !== 200 && code !== '200' && code !== 0 && code !== '0') {
      throw new BadRequestException(`${line.code} ${path} 失败: ${this.providerMessage(payload, text)}`);
    }
    return payload;
  }

  private usageQueryConfig(line: ProviderLineRuntimeConfig): {
    path: string;
  } {
    const usageQuery = this.objectValue(
      this.objectValue(line.capabilities).usageQuery
        ?? this.objectValue(line.metadata).usageQuery,
    );
    return {
      path: this.stringValue(usageQuery.path)
        ?? this.configText('ZHIPU_CODING_PLAN_USAGE_PATH')
        ?? '/api/biz/partner/queryCustomerUsage',
    };
  }

  private usageQueryPayload(
    input: QueryCustomerUsageInput,
  ): Record<string, unknown> {
    return this.withDefinedValues({ partnerUserId: input.partnerUserId });
  }

  private toUsageQuotaProgress(payload: Record<string, unknown>): ProviderUsageResult['quotaProgress'] {
    const data = this.objectValue(payload.data);
    const quotaProgress = this.objectValue(data.quotaProgress ?? payload.quotaProgress);
    const models = this.objectValue(quotaProgress.models);
    const tools = this.objectValue(quotaProgress.tools);
    const fiveHour = this.toUsageWindow(models.fiveHour);
    const weekly = this.toUsageWindow(models.weekly);
    const monthly = this.toUsageWindow(tools.monthly);
    if (!fiveHour && !weekly && !monthly) return null;
    return {
      models: {
        fiveHour,
        weekly,
      },
      tools: {
        monthly,
      },
    };
  }

  private toUsageWindow(value: unknown) {
    const object = this.objectValue(value);
    const progressPercent = this.percentValue(object.progressPercent);
    const resetAt = this.stringValue(object.resetAt);
    if (progressPercent === null && !resetAt) return null;
    return { progressPercent, resetAt };
  }

  private toUsageSummary(value: unknown): ProviderUsageSummary | null {
    const object = this.objectValue(value);
    const day = this.toUsageSummaryBucket(object.day);
    const last7Days = this.toUsageSummaryBucket(object.last7Days);
    const last30Days = this.toUsageSummaryBucket(object.last30Days);
    if (!day && !last7Days && !last30Days) return null;
    return { day, last7Days, last30Days };
  }

  private toUsageSummaryBucket(value: unknown): ProviderUsageSummaryBucket | null {
    const object = this.objectValue(value);
    const models = this.objectValue(object.models);
    const tools = this.objectValue(object.tools);
    const modelItems = this.arrayValue(models.items).map((item) => {
      const row = this.objectValue(item);
      return {
        modelCode: this.stringValue(row.modelCode),
        usage: this.numberValue(row.usage),
      };
    });
    const toolItems = this.arrayValue(tools.items).map((item) => {
      const row = this.objectValue(item);
      return {
        toolCode: this.stringValue(row.toolCode),
        toolName: this.stringValue(row.toolName),
        usage: this.numberValue(row.usage),
      };
    });
    const modelTotal = this.numberValue(models.total);
    const toolTotal = this.numberValue(tools.total);
    if (modelTotal === null && toolTotal === null && modelItems.length === 0 && toolItems.length === 0) {
      return null;
    }
    return {
      models: modelTotal !== null || modelItems.length > 0
        ? { total: modelTotal, items: modelItems }
        : null,
      tools: toolTotal !== null || toolItems.length > 0
        ? { total: toolTotal, items: toolItems }
        : null,
    };
  }

  private buildSignedHeaders(line: ProviderLineRuntimeConfig): Record<string, string> {
    const timestamp = Date.now().toString();
    const sign = createHash('md5')
      .update(`${line.partnerCode}${line.partnerSecretKey}${timestamp}`, 'utf8')
      .digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Partner-Code': line.partnerCode ?? '',
      'X-Timestamp': timestamp,
      'X-Sign': sign,
    };
  }

  private productList(payload: Record<string, unknown>): Record<string, unknown>[] {
    const data = payload.data;
    if (Array.isArray(data)) return data.map((item) => this.objectValue(item));
    const object = this.objectValue(data);
    for (const key of ['list', 'records', 'items', 'products']) {
      const value = object[key];
      if (Array.isArray(value)) return value.map((item) => this.objectValue(item));
    }
    return [];
  }

  private toProviderProduct(item: Record<string, unknown>): ProviderProduct {
    const productId = this.stringValue(item.productId)
      ?? this.stringValue(item.id)
      ?? this.stringValue(item.product_id);
    if (!productId) {
      throw new BadRequestException('供应商产品目录响应缺少 productId');
    }
    return {
      upstreamProductId: productId,
      productName: this.stringValue(item.productName)
        ?? this.stringValue(item.name)
        ?? this.stringValue(item.product_name)
        ?? productId,
      salePrice: this.stringValue(item.salePrice)
        ?? this.numberValue(item.salePrice)
        ?? this.stringValue(item.price)
        ?? this.numberValue(item.price),
      currency: this.stringValue(item.currency),
      productCycle: this.stringValue(item.productCycle),
      productType: this.stringValue(item.productType),
      productBigTitle: this.stringValue(item.productBigTitle),
      productSmallTitle: this.stringValue(item.productSmallTitle),
      description: this.stringValue(item.description),
      productIntroduction: this.stringValue(item.productIntroduction),
      salesVolume: this.numberValue(item.salesVolume),
      dailySalesLimit: this.numberValue(item.dailySalesLimit),
      monthlySalesLimit: this.numberValue(item.monthlySalesLimit),
      yearlySalesLimit: this.numberValue(item.yearlySalesLimit),
      maxSalesLimit: this.numberValue(item.maxSalesLimit),
      status: this.stringValue(item.status) ?? 'ACTIVE',
      raw: item,
    };
  }

  private parseJsonObject(text: string): Record<string, unknown> {
    if (!text) return {};
    try {
      return this.objectValue(JSON.parse(text));
    } catch {
      return {};
    }
  }

  private providerMessage(payload: Record<string, unknown>, fallback: string): string {
    return this.stringValue(payload.message)
      ?? this.stringValue(payload.msg)
      ?? fallback
      ?? 'unknown provider error';
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private stringValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private numberValue(value: unknown): number | null {
    const n = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }

  private percentValue(value: unknown): number | null {
    const n = this.numberValue(value);
    if (n === null) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private withDefinedValues(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
    );
  }

  private configText(key: string): string | null {
    return this.stringValue(this.config.get<string>(key));
  }

  private requestTimeoutMs(): number {
    const timeout = Number.parseInt(this.config.get<string>('ZHIPU_CODING_PLAN_TIMEOUT_MS') ?? '', 10);
    return Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000;
  }
}

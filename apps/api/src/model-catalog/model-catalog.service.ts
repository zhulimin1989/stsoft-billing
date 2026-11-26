import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { usdNumber } from '../billing/money';

/**
 * User-facing model catalog DTO. Sanitized — internal admin-only flags
 * (isActive, raw modelName uniqueness, etc.) are not exposed; pricing is
 * surfaced because users need it to make a model selection.
 */
export interface ModelCatalogItem {
  id: string;
  modelName: string;
  displayName: string;
  provider: string | null;
  modelId: string | null;
  description: string | null;
  inputModalities: string[];
  outputModalities: string[];
  contextLength: number | null;
  maxOutputTokens: number | null;
  providerLogo: string | null;
  displayOrder: number;
  releaseAt: Date | null;
  tags: string[];
  supportedFeatures: string[];
  modelType: string | null;
  pricingUnit: string | null;
  unitPriceUsd: number | null;
  pricingMetadata: unknown | null;
  inputPricePerMToken: number;
  outputPricePerMToken: number;
  cachedInputPrice: number | null;
  cacheWritePrice: number | null;
  cacheWrite5minPrice: number | null;
  cacheWrite1hPrice: number | null;
  batchDiscount: number | null;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

@Injectable()
export class ModelCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Public list. With a productId, product model availability decides which
   * models are visible; without product context, return the active platform
   * model directory.
   */
  async list(filter?: { provider?: string; tag?: string; productId?: string }): Promise<ModelCatalogItem[]> {
    const productId = filter?.productId?.trim();
    const rows = productId
      ? await this.listProductVisibleRows(productId, filter?.provider)
      : await this.prisma.modelPricing.findMany({
          where: {
            isActive: true,
            ...(filter?.provider ? { provider: filter.provider } : {}),
          },
          orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
        });

    let items = rows.map((row) => this.toDto(row));

    if (filter?.tag) {
      const needle = filter.tag;
      items = items.filter((it) => it.tags.includes(needle));
    }

    return items;
  }

  /**
   * Public get-one. Product-scoped requests require an active, visible product
   * model availability row. Lookup by primary id OR modelName.
   */
  async getOne(idOrName: string, options?: { productId?: string }): Promise<ModelCatalogItem> {
    const productId = options?.productId?.trim();
    const row = productId
      ? await this.getProductVisibleRow(productId, idOrName)
      : await this.prisma.modelPricing.findFirst({
          where: {
            isActive: true,
            OR: [{ id: idOrName }, { modelName: idOrName }],
          },
        });
    if (!row) {
      throw new NotFoundException(`模型 "${idOrName}" 未找到或未对当前产品可见`);
    }
    return this.toDto(row);
  }

  private async listProductVisibleRows(productId: string, provider?: string) {
    const now = new Date();
    const rows = await this.prisma.productModelAvailability.findMany({
      where: {
        productId,
        status: 'ACTIVE',
        visible: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
        modelPricing: {
          isActive: true,
          ...(provider ? { provider } : {}),
        },
      },
      orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
      include: { modelPricing: true },
    });
    return rows.map((row) => row.modelPricing);
  }

  private async getProductVisibleRow(productId: string, idOrName: string) {
    const now = new Date();
    const row = await this.prisma.productModelAvailability.findFirst({
      where: {
        productId,
        status: 'ACTIVE',
        visible: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
        modelPricing: {
          isActive: true,
          OR: [{ id: idOrName }, { modelName: idOrName }],
        },
      },
      include: { modelPricing: true },
    });
    return row?.modelPricing ?? null;
  }

  private toDto(row: {
    id: string;
    modelName: string;
    inputPricePerMToken: Prisma.Decimal;
    outputPricePerMToken: Prisma.Decimal;
    provider: string | null;
    modelId: string | null;
    description: string | null;
    inputModalities: string | null;
    outputModalities: string | null;
    contextLength: number | null;
    maxOutputTokens: number | null;
    providerLogo: string | null;
    displayOrder: number;
    releaseAt: Date | null;
    tags: string | null;
    supportedFeatures: string | null;
    modelType?: string | null;
    pricingUnit?: string | null;
    unitPriceUsd?: Prisma.Decimal | null;
    pricingMetadata?: Prisma.JsonValue | null;
    cachedInputPrice: Prisma.Decimal | null;
    cacheWrite5minPrice: Prisma.Decimal | null;
    cacheWrite1hPrice: Prisma.Decimal | null;
    batchDiscount: number | null;
  }): ModelCatalogItem {
    const cacheWrite5minPrice = row.cacheWrite5minPrice == null ? null : usdNumber(row.cacheWrite5minPrice);
    const cacheWrite1hPrice = row.cacheWrite1hPrice == null ? null : usdNumber(row.cacheWrite1hPrice);
    return {
      id: row.id,
      modelName: row.modelName,
      displayName: row.modelId?.trim() || row.modelName,
      provider: row.provider,
      modelId: row.modelId,
      description: row.description,
      inputModalities: parseJsonArray(row.inputModalities),
      outputModalities: parseJsonArray(row.outputModalities),
      contextLength: row.contextLength,
      maxOutputTokens: row.maxOutputTokens,
      providerLogo: row.providerLogo,
      displayOrder: row.displayOrder,
      releaseAt: row.releaseAt,
      tags: parseJsonArray(row.tags),
      supportedFeatures: parseJsonArray(row.supportedFeatures),
      modelType: row.modelType ?? null,
      pricingUnit: row.pricingUnit ?? null,
      unitPriceUsd: row.unitPriceUsd == null ? null : usdNumber(row.unitPriceUsd),
      pricingMetadata: row.pricingMetadata ?? null,
      inputPricePerMToken: usdNumber(row.inputPricePerMToken),
      outputPricePerMToken: usdNumber(row.outputPricePerMToken),
      cachedInputPrice: row.cachedInputPrice == null ? null : usdNumber(row.cachedInputPrice),
      cacheWritePrice: cacheWrite5minPrice ?? cacheWrite1hPrice,
      cacheWrite5minPrice,
      cacheWrite1hPrice,
      batchDiscount: row.batchDiscount,
    };
  }
}

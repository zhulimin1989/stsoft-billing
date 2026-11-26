/**
 * ModelCatalogService unit tests
 *
 * Coverage targets:
 *   - list() filters platform catalog by isActive=true
 *   - product-scoped list() filters by ProductModelAvailability visibility
 *   - list() returns sanitized DTOs (no isActive / no isPublished leak)
 *   - list() supports provider + tag filtering
 *   - getOne() rejects missing or product-hidden rows with NotFoundException
 *   - JSON-array fields (modalities, tags, supportedFeatures) parse safely
 *   - Malformed JSON in DB → empty array (graceful degradation)
 */

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ModelCatalogService } from './model-catalog.service';
import { PrismaService } from '../prisma/prisma.service';

const baseRow = {
  id: 'mp_1',
  modelName: 'gpt-4o',
  inputPricePerMToken: 2.5,
  outputPricePerMToken: 10,
  isActive: true,
  isPublished: true,
  provider: 'openai',
  modelId: 'GPT-4o 用户版',
  description: '## GPT-4o',
  inputModalities: JSON.stringify(['text', 'image']),
  outputModalities: JSON.stringify(['text']),
  contextLength: 128_000,
  maxOutputTokens: 16_384,
  providerLogo: 'https://example.com/openai.png',
  displayOrder: 10,
  releaseAt: new Date('2024-05-13T00:00:00Z'),
  tags: JSON.stringify(['推理', '快速']),
  supportedFeatures: JSON.stringify(['function_call', 'streaming']),
  cachedInputPrice: 1.25,
  cacheWrite5minPrice: 3.75,
  cacheWrite1hPrice: null,
  batchDiscount: 0.5,
};

describe('ModelCatalogService', () => {
  let service: ModelCatalogService;
  let prisma: {
    modelPricing: { findMany: jest.Mock; findFirst: jest.Mock };
    productModelAvailability: { findMany: jest.Mock; findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      modelPricing: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      productModelAvailability: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelCatalogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(ModelCatalogService);
  });

  // ─── list ────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('queries active platform catalog without using isPublished as a gate', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.modelPricing.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
      });
    });

    it('passes provider filter into where clause when set', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([]);
      await service.list({ provider: 'anthropic' });
      expect(prisma.modelPricing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, provider: 'anthropic' },
        }),
      );
    });

    it('uses product model availability when productId is provided', async () => {
      prisma.productModelAvailability.findMany.mockResolvedValue([
        { modelName: 'gpt-4o', modelPricing: baseRow },
      ]);

      const result = await service.list({ productId: 'prod-payg' });

      expect(prisma.productModelAvailability.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            productId: 'prod-payg',
            status: 'ACTIVE',
            visible: true,
            modelPricing: { isActive: true },
          }),
          include: { modelPricing: true },
        }),
      );
      expect(result.map((item) => item.modelName)).toEqual(['gpt-4o']);
    });

    it('returns sanitized DTOs (no isActive / isPublished leak)', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([baseRow]);
      const result = await service.list();
      expect(result).toHaveLength(1);
      const dto = result[0] as unknown as Record<string, unknown>;
      expect(dto.isActive).toBeUndefined();
      expect(dto.isPublished).toBeUndefined();
      // sanity check: pricing IS exposed
      expect(dto.inputPricePerMToken).toBe(2.5);
      expect(dto.outputPricePerMToken).toBe(10);
      expect(dto.displayName).toBe('GPT-4o 用户版');
      expect(dto.cachedInputPrice).toBe(1.25);
      expect(dto.cacheWritePrice).toBe(3.75);
      // JSON fields parsed
      expect(dto.inputModalities).toEqual(['text', 'image']);
      expect(dto.tags).toEqual(['推理', '快速']);
      expect(dto.supportedFeatures).toEqual(['function_call', 'streaming']);
    });

    it('falls back to modelName when modelId is blank', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([
        { ...baseRow, modelId: '   ' },
      ]);

      const result = await service.list();

      expect(result[0].displayName).toBe('gpt-4o');
    });

    it('parses null JSON array fields as empty arrays', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([
        { ...baseRow, inputModalities: null, tags: null, supportedFeatures: null, outputModalities: null },
      ]);
      const result = await service.list();
      expect(result[0].inputModalities).toEqual([]);
      expect(result[0].outputModalities).toEqual([]);
      expect(result[0].tags).toEqual([]);
      expect(result[0].supportedFeatures).toEqual([]);
    });

    it('handles malformed JSON gracefully (returns empty array)', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([
        { ...baseRow, tags: 'not-valid-json{{', inputModalities: '{notarray:true}' },
      ]);
      const result = await service.list();
      expect(result[0].tags).toEqual([]);
      expect(result[0].inputModalities).toEqual([]);
    });

    it('applies tag filter post-query (in-memory)', async () => {
      prisma.modelPricing.findMany.mockResolvedValue([
        baseRow, // tags ['推理', '快速']
        { ...baseRow, id: 'mp_2', modelName: 'gpt-3.5', tags: JSON.stringify(['编码']) },
      ]);
      const result = await service.list({ tag: '推理' });
      expect(result).toHaveLength(1);
      expect(result[0].modelName).toBe('gpt-4o');
    });
  });

  // ─── getOne ──────────────────────────────────────────────────────────────

  describe('getOne', () => {
    it('returns DTO for active platform model', async () => {
      prisma.modelPricing.findFirst.mockResolvedValue(baseRow);
      const result = await service.getOne('gpt-4o');
      expect(result.modelName).toBe('gpt-4o');
      expect(prisma.modelPricing.findFirst).toHaveBeenCalledWith({
        where: {
          isActive: true,
          OR: [{ id: 'gpt-4o' }, { modelName: 'gpt-4o' }],
        },
      });
    });

    it('throws NotFoundException when row not found', async () => {
      prisma.modelPricing.findFirst.mockResolvedValue(null);
      await expect(service.getOne('unknown')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when product-scoped row is not visible for that product', async () => {
      prisma.productModelAvailability.findFirst.mockResolvedValue(null);
      await expect(service.getOne('gpt-4o', { productId: 'prod-payg' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('looks up by both id and modelName (OR)', async () => {
      prisma.modelPricing.findFirst.mockResolvedValue(baseRow);
      await service.getOne('mp_1');
      const call = prisma.modelPricing.findFirst.mock.calls[0][0];
      expect(call.where.OR).toEqual([{ id: 'mp_1' }, { modelName: 'mp_1' }]);
    });
  });
});

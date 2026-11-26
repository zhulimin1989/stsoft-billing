import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BoosterPackService } from './booster-pack.service';
import { PrismaService } from '../prisma/prisma.service';

function makePack(overrides: Partial<{
  id: string;
  productId: string | null;
  name: string;
  description: string | null;
  creditsAmount: number;
  priceCents: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  product: { name: string; slug: string } | null;
}> = {}) {
  return {
    id: 'pack-1',
    productId: 'prod-1',
    name: 'Starter Pack',
    description: 'Get started',
    creditsAmount: 100,
    priceCents: 999,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    product: { name: 'RDClaw', slug: 'rdclaw' },
    ...overrides,
  };
}

function makePrisma() {
  return {
    boosterPack: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

async function buildService(prismaOverrides = {}) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const m = await Test.createTestingModule({
    providers: [
      BoosterPackService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { service: m.get(BoosterPackService) as BoosterPackService, prisma };
}

// ============================================================
// BoosterPackService.findAll
// ============================================================
describe('BoosterPackService.findAll', () => {
  it('returns all packs with no filters (default)', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([makePack(), makePack({ id: 'pack-2' })]);

    const result = await service.findAll();

    expect(result).toHaveLength(2);
    expect(prisma.boosterPack.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { product: { select: { name: true, slug: true } } },
    });
  });

  it('filters by isActive=true when onlyActive=true', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([makePack()]);

    await service.findAll(true);

    expect(prisma.boosterPack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, isActive: true } }),
    );
  });

  it('filters by productId when provided', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([makePack()]);

    await service.findAll(false, 'prod-1');

    expect(prisma.boosterPack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, productId: 'prod-1' } }),
    );
  });

  it('combines onlyActive and productId filters', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([makePack()]);

    await service.findAll(true, 'prod-2');

    expect(prisma.boosterPack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, isActive: true, productId: 'prod-2' } }),
    );
  });

  it('includes product name and slug', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([makePack({ product: { name: 'Chat', slug: 'chat' } })]);

    const result = await service.findAll();
    expect(result[0].product?.name).toBe('Chat');
    expect(result[0].product?.slug).toBe('chat');
  });

  it('returns empty array when no packs exist', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([]);

    const result = await service.findAll();
    expect(result).toEqual([]);
  });

  it('orders results by sortOrder asc', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(prisma.boosterPack.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { sortOrder: 'asc' } }),
    );
  });
});

// ============================================================
// BoosterPackService.findById
// ============================================================
describe('BoosterPackService.findById', () => {
  it('returns pack when found', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue(makePack({ id: 'pack-1' }));

    const result = await service.findById('pack-1');

    expect(result?.id).toBe('pack-1');
    expect(prisma.boosterPack.findFirst).toHaveBeenCalledWith({ where: { id: 'pack-1', deletedAt: null } });
  });

  it('returns null when pack not found', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue(null);

    const result = await service.findById('nonexistent');
    expect(result).toBeNull();
  });
});

// ============================================================
// BoosterPackService.create
// ============================================================
describe('BoosterPackService.create', () => {
  it('creates pack with required fields only', async () => {
    const { service, prisma } = await buildService();
    const created = makePack({ name: 'Mini Pack', creditsAmount: 50, priceCents: 499 });
    prisma.boosterPack.create.mockResolvedValue(created);

    const result = await service.create({ name: 'Mini Pack', creditsAmount: 50, priceCents: 499 });

    expect(result.name).toBe('Mini Pack');
    expect(prisma.boosterPack.create).toHaveBeenCalledWith({
      data: { name: 'Mini Pack', creditsAmount: 50, priceCents: 499 },
    });
  });

  it('creates pack with all optional fields', async () => {
    const { service, prisma } = await buildService();
    const data = {
      productId: 'prod-1',
      name: 'Full Pack',
      description: 'Full description',
      creditsAmount: 500,
      priceCents: 4999,
      isActive: false,
      sortOrder: 3,
    };
    prisma.boosterPack.create.mockResolvedValue(makePack(data));

    await service.create(data);

    expect(prisma.boosterPack.create).toHaveBeenCalledWith({ data });
  });

  it('returns the created pack with correct creditsAmount', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.create.mockResolvedValue(makePack({ creditsAmount: 200, priceCents: 1999 }));

    const result = await service.create({ name: 'Pack', creditsAmount: 200, priceCents: 1999 });
    expect(result.creditsAmount).toBe(200);
    expect(result.priceCents).toBe(1999);
  });
});

// ============================================================
// BoosterPackService.update
// ============================================================
describe('BoosterPackService.update', () => {
  it('updates pack name and returns updated record', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-1' });
    prisma.boosterPack.update.mockResolvedValue(makePack({ name: 'Updated Pack' }));

    const result = await service.update('pack-1', { name: 'Updated Pack' });

    expect(result.name).toBe('Updated Pack');
    expect(prisma.boosterPack.update).toHaveBeenCalledWith({
      where: { id: 'pack-1' },
      data: { name: 'Updated Pack' },
    });
  });

  it('updates price and credits', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-1' });
    prisma.boosterPack.update.mockResolvedValue(makePack({ creditsAmount: 300, priceCents: 2999 }));

    await service.update('pack-1', { creditsAmount: 300, priceCents: 2999 });

    expect(prisma.boosterPack.update).toHaveBeenCalledWith({
      where: { id: 'pack-1' },
      data: { creditsAmount: 300, priceCents: 2999 },
    });
  });

  it('deactivates a pack', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-1' });
    prisma.boosterPack.update.mockResolvedValue(makePack({ isActive: false }));

    const result = await service.update('pack-1', { isActive: false });
    expect(result.isActive).toBe(false);
  });

  it('passes empty update object when no fields provided', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-1' });
    prisma.boosterPack.update.mockResolvedValue(makePack());

    await service.update('pack-1', {});

    expect(prisma.boosterPack.update).toHaveBeenCalledWith({
      where: { id: 'pack-1' },
      data: {},
    });
  });
});

// ============================================================
// BoosterPackService.delete
// ============================================================
describe('BoosterPackService.delete', () => {
  it('soft deletes pack by id', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-1' });
    prisma.boosterPack.update.mockResolvedValue(makePack({ isActive: false }));

    await service.delete('pack-1');

    expect(prisma.boosterPack.update).toHaveBeenCalledWith({
      where: { id: 'pack-1' },
      data: { deletedAt: expect.any(Date), isActive: false },
    });
    expect(prisma.boosterPack.delete).not.toHaveBeenCalled();
  });

  it('returns the soft deleted pack record', async () => {
    const { service, prisma } = await buildService();
    const deleted = makePack({ id: 'pack-del', name: 'Deleted Pack' });
    prisma.boosterPack.findFirst.mockResolvedValue({ id: 'pack-del' });
    prisma.boosterPack.update.mockResolvedValue(deleted);

    const result = await service.delete('pack-del');
    expect(result.id).toBe('pack-del');
  });

  it('throws when pack is missing or already deleted', async () => {
    const { service, prisma } = await buildService();
    prisma.boosterPack.findFirst.mockResolvedValue(null);

    await expect(service.delete('pack-del')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.boosterPack.update).not.toHaveBeenCalled();
  });
});

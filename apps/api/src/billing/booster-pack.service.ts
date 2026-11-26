import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BoosterPackService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(onlyActive = false, productId?: string) {
    const where: Record<string, unknown> = { deletedAt: null };
    if (onlyActive) where.isActive = true;
    if (productId) where.productId = productId;
    return this.prisma.boosterPack.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      include: { product: { select: { name: true, slug: true } } },
    });
  }

  async findById(id: string) {
    return this.prisma.boosterPack.findFirst({ where: { id, deletedAt: null } });
  }

  async create(data: {
    productId?: string;
    name: string;
    description?: string;
    creditsAmount: number;
    priceCents: number;
    isActive?: boolean;
    sortOrder?: number;
  }) {
    return this.prisma.boosterPack.create({ data });
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string;
      creditsAmount?: number;
      priceCents?: number;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    await this.requirePack(id);
    return this.prisma.boosterPack.update({ where: { id }, data });
  }

  async delete(id: string) {
    await this.requirePack(id);
    return this.prisma.boosterPack.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async requirePack(id: string) {
    const pack = await this.prisma.boosterPack.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!pack) throw new NotFoundException('加油包不存在');
    return pack;
  }
}

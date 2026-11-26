import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, Prisma } from '@prisma/client';

const DISCOUNT_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];

@Injectable()
export class DiscountCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.DiscountCodeCreateInput) {
    return this.prisma.discountCode.create({ data });
  }

  async update(id: string, data: Prisma.DiscountCodeUpdateInput) {
    return this.prisma.discountCode.update({ where: { id }, data });
  }

  async findById(id: string) {
    return this.prisma.discountCode.findUnique({ where: { id } });
  }

  async findByCode(code: string) {
    return this.prisma.discountCode.findUnique({
      where: { code: code.toUpperCase() },
    });
  }

  async findAll(filters: { isActive?: boolean; planId?: string }) {
    const where: any = {};
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    return this.prisma.discountCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async countUserRedemptions(discountCodeId: string, userId: string) {
    return this.prisma.discountCodeRedemption.count({
      where: { discountCodeId, userId },
    });
  }

  async countReservedOrders(discountCodeId: string, userId?: string) {
    return this.prisma.order.count({
      where: {
        discountCodeId,
        ...(userId ? { userId } : {}),
        status: { in: DISCOUNT_RESERVED_ORDER_STATUSES },
      },
    });
  }

  async countCompletedOrders(discountCodeId: string, userId?: string) {
    return this.prisma.order.count({
      where: {
        discountCodeId,
        ...(userId ? { userId } : {}),
        status: OrderStatus.COMPLETED,
      },
    });
  }

  async sumSaved(discountCodeId: string): Promise<number> {
    const agg = await this.prisma.discountCodeRedemption.aggregate({
      where: { discountCodeId },
      _sum: { amountSavedCents: true },
    });
    return agg._sum.amountSavedCents ?? 0;
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, ProviderAccountIdentity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ProviderAccountIdentityListFilter = {
  providerCode?: string;
  status?: 'active' | 'inactive';
};

@Injectable()
export class ProviderAccountIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(filter: ProviderAccountIdentityListFilter): Promise<ProviderAccountIdentity[]> {
    const where: Prisma.ProviderAccountIdentityWhereInput = {
      ...(filter.providerCode ? { providerCode: filter.providerCode } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };
    return this.prisma.providerAccountIdentity.findMany({
      where,
      orderBy: [
        { providerCode: 'asc' },
        { displayName: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  findById(id: string): Promise<ProviderAccountIdentity | null> {
    return this.prisma.providerAccountIdentity.findUnique({ where: { id } });
  }

  create(data: Prisma.ProviderAccountIdentityCreateInput): Promise<ProviderAccountIdentity> {
    return this.prisma.providerAccountIdentity.create({ data });
  }

  async countBlockingReferences(id: string): Promise<{
    channels: number;
    providerLines: number;
    activeProviderEntitlements: number;
  }> {
    const [channels, providerLines, activeProviderEntitlements] = await Promise.all([
      this.prisma.channel.count({
        where: { providerAccountIdentityId: id, deletedAt: null },
      }),
      this.prisma.codingPlanProviderLine.count({
        where: { providerAccountIdentityId: id },
      }),
      this.prisma.codingPlanProviderEntitlement.count({
        where: { providerAccountIdentityId: id, status: 'ACTIVE' },
      }),
    ]);
    return { channels, providerLines, activeProviderEntitlements };
  }

  deactivate(id: string): Promise<ProviderAccountIdentity> {
    return this.prisma.providerAccountIdentity.update({
      where: { id },
      data: { status: 'inactive' },
    });
  }
}

import { PrismaService } from '../prisma/prisma.service';
import { ProviderAccountIdentityRepository } from './provider-account-identity.repository';

describe('ProviderAccountIdentityRepository', () => {
  it('counts undeleted channels, all bound provider lines, and ACTIVE entitlements as blockers', async () => {
    const prisma = {
      channel: { count: jest.fn().mockResolvedValue(2) },
      codingPlanProviderLine: { count: jest.fn().mockResolvedValue(3) },
      codingPlanProviderEntitlement: { count: jest.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;
    const repository = new ProviderAccountIdentityRepository(prisma);

    await expect(repository.countBlockingReferences('pai-1')).resolves.toEqual({
      channels: 2,
      providerLines: 3,
      activeProviderEntitlements: 1,
    });
    expect(prisma.channel.count).toHaveBeenCalledWith({
      where: { providerAccountIdentityId: 'pai-1', deletedAt: null },
    });
    expect(prisma.codingPlanProviderEntitlement.count).toHaveBeenCalledWith({
      where: { providerAccountIdentityId: 'pai-1', status: 'ACTIVE' },
    });
    expect(prisma.codingPlanProviderLine.count).toHaveBeenCalledWith({
      where: { providerAccountIdentityId: 'pai-1' },
    });
  });
});

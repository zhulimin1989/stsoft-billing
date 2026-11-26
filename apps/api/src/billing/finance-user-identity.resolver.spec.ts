import { FinanceUserIdentityResolver } from './finance-user-identity.resolver';

describe('FinanceUserIdentityResolver', () => {
  function build() {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'local-user' }]) },
      billingAccount: { findMany: jest.fn().mockResolvedValue([{ id: 'enterprise-account' }]) },
      apiKey: { findMany: jest.fn().mockResolvedValue([{ id: 'api-key-1' }]) },
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: 'tenant-1' }]) },
    };
    const userClient = {
      findFinanceUserIdsByContact: jest.fn().mockResolvedValue(['authority-user']),
      getFinanceUserContactsByIds: jest.fn().mockResolvedValue([
        { id: 'authority-user', phone: '13800138000', email: null, nickname: 'name' },
      ]),
    };
    return {
      prisma,
      userClient,
      resolver: new FinanceUserIdentityResolver(prisma as never, userClient as never),
    };
  }

  it('resolves the raw id, authoritative contacts and enterprise name before fact queries', async () => {
    const { resolver, prisma } = build();

    await expect(resolver.resolveSearch('13800138000')).resolves.toEqual({
      userIds: ['13800138000', 'authority-user', 'local-user'],
      apiKeyIds: ['api-key-1'],
      billingAccountIds: ['enterprise-account'],
      tenantIds: ['tenant-1'],
    });
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        enterpriseName: { contains: '13800138000', mode: 'insensitive' },
      }),
    }));
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['13800138000', 'authority-user', 'local-user'] } },
      select: { id: true },
    });
  });

  it('returns authoritative contacts keyed by user id', async () => {
    const { resolver } = build();

    const contacts = await resolver.getContactsByIds(['authority-user', 'authority-user']);
    expect(contacts.get('authority-user')?.phone).toBe('13800138000');
  });
});

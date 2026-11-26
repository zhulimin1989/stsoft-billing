import { ProviderAccountIdentityController } from './provider-account-identity.controller';
import { ProviderAccountIdentityService } from './provider-account-identity.service';

describe('ProviderAccountIdentityController', () => {
  const identities = {
    list: jest.fn(),
    create: jest.fn(),
    deactivate: jest.fn(),
  } as unknown as jest.Mocked<ProviderAccountIdentityService>;
  const controller = new ProviderAccountIdentityController(identities);

  beforeEach(() => jest.clearAllMocks());

  it('exposes list/create/deactivate without an update or delete path', async () => {
    (identities.list as jest.Mock).mockResolvedValue([]);
    (identities.create as jest.Mock).mockResolvedValue({ id: 'pai-1' });
    (identities.deactivate as jest.Mock).mockResolvedValue({ id: 'pai-1', status: 'inactive' });

    await expect(controller.list({ providerCode: 'kimi', status: 'active' })).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: [],
    });
    await expect(controller.create({ providerCode: 'kimi', displayName: 'Kimi' })).resolves.toEqual({
      code: 0,
      message: '创建成功',
      data: { id: 'pai-1' },
    });
    await expect(controller.deactivate('pai-1')).resolves.toEqual({
      code: 0,
      message: '已停用',
      data: { id: 'pai-1', status: 'inactive' },
    });
  });
});

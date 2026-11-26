import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProviderAccountIdentityRepository } from './provider-account-identity.repository';
import { PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR } from './provider-account-identity.policy';
import { ProviderAccountIdentityService } from './provider-account-identity.service';

describe('ProviderAccountIdentityService', () => {
  const repository = {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    countBlockingReferences: jest.fn(),
    deactivate: jest.fn(),
  } as unknown as jest.Mocked<ProviderAccountIdentityRepository>;
  const service = new ProviderAccountIdentityService(repository);

  beforeEach(() => {
    jest.clearAllMocks();
    (repository.countBlockingReferences as jest.Mock).mockResolvedValue({
      channels: 0,
      providerLines: 0,
      activeProviderEntitlements: 0,
    });
  });

  it('creates an active identity with a server-generated immutable ref', async () => {
    (repository.create as jest.Mock).mockImplementation(async (input) => ({
      id: 'pai-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    }));

    const created = await service.create({
      providerCode: ' MoonShot ',
      displayName: '  Kimi 国内主账户  ',
    });

    expect(repository.create).toHaveBeenCalledWith({
      ref: expect.stringMatching(/^pa_[0-9a-f-]{36}$/),
      providerCode: 'kimi',
      displayName: 'Kimi 国内主账户',
      status: 'active',
    });
    expect(created.ref).toMatch(/^pa_/);
  });

  it('normalizes list filters and rejects unsupported statuses', async () => {
    (repository.findAll as jest.Mock).mockResolvedValue([]);

    await service.list({ providerCode: 'moonshot', status: 'active' });

    expect(repository.findAll).toHaveBeenCalledWith({
      providerCode: 'kimi',
      status: 'active',
    });
    expect(() => service.list({ status: 'deleted' })).toThrow(BadRequestException);
  });

  it('deactivates an existing identity and is idempotent when already inactive', async () => {
    const active = {
      id: 'pai-1',
      ref: 'pa_test',
      providerCode: 'kimi',
      displayName: 'Kimi',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (repository.findById as jest.Mock).mockResolvedValueOnce(active);
    (repository.deactivate as jest.Mock).mockResolvedValue({ ...active, status: 'inactive' });

    await expect(service.deactivate('pai-1')).resolves.toMatchObject({ status: 'inactive' });
    expect(repository.deactivate).toHaveBeenCalledWith('pai-1');

    (repository.findById as jest.Mock).mockResolvedValueOnce({ ...active, status: 'inactive' });
    await expect(service.deactivate('pai-1')).resolves.toMatchObject({ status: 'inactive' });
    expect(repository.deactivate).toHaveBeenCalledTimes(1);
  });

  it('rejects deactivation while a live channel references the identity', async () => {
    (repository.findById as jest.Mock).mockResolvedValue({
      id: 'pai-1',
      ref: 'pa_test',
      providerCode: 'kimi',
      displayName: 'Kimi',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (repository.countBlockingReferences as jest.Mock).mockResolvedValue({
      channels: 1,
      providerLines: 0,
      activeProviderEntitlements: 0,
    });

    await expect(service.deactivate('pai-1')).rejects.toThrow(ConflictException);
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('rejects deactivation while an ACTIVE provider entitlement references the identity', async () => {
    (repository.findById as jest.Mock).mockResolvedValue({
      id: 'pai-1',
      ref: 'pa_test',
      providerCode: 'zhipu',
      displayName: 'Zhipu dedicated',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (repository.countBlockingReferences as jest.Mock).mockResolvedValue({
      channels: 0,
      providerLines: 0,
      activeProviderEntitlements: 2,
    });

    await expect(service.deactivate('pai-1')).rejects.toThrow('不能停用');
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('rejects deactivation while any provider line remains bound to the identity', async () => {
    (repository.findById as jest.Mock).mockResolvedValue({
      id: 'pai-1',
      ref: 'pa_test',
      providerCode: 'zhipu',
      displayName: 'Zhipu dedicated',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (repository.countBlockingReferences as jest.Mock).mockResolvedValue({
      channels: 0,
      providerLines: 1,
      activeProviderEntitlements: 0,
    });

    await expect(service.deactivate('pai-1')).rejects.toThrow('Provider Line');
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('maps the database final-reference guard to a conflict during a concurrent bind', async () => {
    (repository.findById as jest.Mock).mockResolvedValue({
      id: 'pai-1',
      ref: 'pa_test',
      providerCode: 'kimi',
      displayName: 'Kimi',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    (repository.deactivate as jest.Mock).mockRejectedValue(
      new Error(`database trigger: ${PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR}`),
    );

    const result = service.deactivate('pai-1');
    await expect(result).rejects.toThrow(ConflictException);
    await expect(result).rejects.toThrow('停用期间新增了引用');
  });

  it('returns not found when deactivating a missing identity', async () => {
    (repository.findById as jest.Mock).mockResolvedValue(null);
    await expect(service.deactivate('missing')).rejects.toThrow(NotFoundException);
  });

  it('requires an active identity owned by the expected provider', async () => {
    (repository.findById as jest.Mock).mockResolvedValue({
      id: 'pai-1',
      ref: 'pa_kimi',
      providerCode: 'kimi',
      displayName: 'Kimi',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.requireActiveForProvider('pai-1', 'moonshot')).resolves.toMatchObject({
      id: 'pai-1',
    });
    await expect(service.requireActiveForProvider('pai-1', 'openai')).rejects.toThrow(
      BadRequestException,
    );
  });
});

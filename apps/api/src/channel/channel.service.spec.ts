import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChannelService } from './channel.service';
import { ChannelRepository } from './channel.repository';
import { AlertEventService } from '../alert-events/alert-events.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { ProviderAccountIdentityService } from '../provider-account-identity/provider-account-identity.service';
import { decryptGatewayLocalSecret } from '../common/utils/gateway-secret';

const mockKmsSend = jest.fn();
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({ send: mockKmsSend })),
  DecryptCommand: jest.fn().mockImplementation((input) => ({ input })),
  EncryptCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// Mock DNS so hostname-based tests are deterministic.
jest.mock('node:dns', () => ({
  promises: { lookup: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsMock = require('node:dns').promises.lookup as jest.Mock;

// Spy global fetch so we can assert it is (or is not) called.
const fetchSpy = jest.fn();
(global as any).fetch = fetchSpy;
const providerAccountIdentities = {
  requireActiveForProvider: jest.fn().mockResolvedValue({
    id: 'pai-1',
    ref: 'pa_test',
    providerCode: 'openai',
    status: 'active',
  }),
};

describe('ChannelService.test() — SSRF guard', () => {
  let service: ChannelService;
  const channelRepository = {
    findById: jest.fn(),
    findByIdWithSecret: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKmsSend.mockReset();
    dnsMock.mockReset();
    const m = await Test.createTestingModule({
      providers: [
        ChannelService,
        { provide: ChannelRepository, useValue: channelRepository },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('') } },
        { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
      ],
    }).compile();
    service = m.get(ChannelService);
  });

  function mockChannel(baseUrl: string, overrides: Record<string, unknown> = {}) {
    // findByIdInternal uses ChannelRepository. We return a minimal Channel shape.
    channelRepository.findById.mockResolvedValue({
      id: 'c1',
      name: 'test',
      provider: 'openai',
      baseUrl,
      apiKey: 'sk-test',
      status: 'ACTIVE',
      priority: 1,
      weight: 1,
      stats: {},
      models: [],
      ...overrides,
    });
    channelRepository.findByIdWithSecret.mockResolvedValue({
      id: 'c1',
      baseUrl,
      apiKey: 'sk-test',
    });
  }

  it('rejects loopback literal baseUrl without calling fetch', async () => {
    mockChannel('http://127.0.0.1:6379');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/internal|loopback/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects RFC1918 baseUrl (10.x)', async () => {
    mockChannel('http://10.0.0.5:80');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/internal/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects RFC1918 baseUrl (192.168.x)', async () => {
    mockChannel('http://192.168.1.1');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects cloud metadata service', async () => {
    mockChannel('http://169.254.169.254/latest/meta-data/');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/internal/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback', async () => {
    mockChannel('http://[::1]:80');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects hostname that resolves to internal IP (DNS rebinding)', async () => {
    mockChannel('http://trusted.example.com/v1');
    dnsMock.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }, // attacker rebinding
    ]);
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/internal/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects localhost hostname', async () => {
    mockChannel('http://localhost:3000');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects file:// protocol', async () => {
    mockChannel('file:///etc/passwd');
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/protocol/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects embedded credentials in baseUrl', async () => {
    mockChannel('http://user:secret@api.example.com');
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/credential/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows public hostname that resolves to public IP, then calls fetch', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    const r = await service.test('c1');
    expect(r.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/models');
  });

  it('uses Anthropic messages endpoint for anthropic sdkType', async () => {
    mockChannel('https://api.anthropic.com', {
      provider: 'anthropic',
      sdkType: 'anthropic',
      models: JSON.stringify(['deepseek-v3.2', 'deepseek-v3.1']),
    });
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await service.test('c1');

    expect(r.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
      }),
    }));
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      model: 'deepseek-v3.2',
    }));
  });

  it('uses the first enabled Anthropic model upstream id', async () => {
    mockChannel('https://tokenhub.tencentmaas.com/v1/messages', {
      provider: 'anthropic',
      sdkType: 'anthropic',
      models: JSON.stringify(['disabled-logical-model', 'deepseek-logical-model']),
      modelConfigs: JSON.stringify({
        'disabled-logical-model': { enabled: false, upstreamModelId: 'disabled-upstream-model' },
        'deepseek-logical-model': { upstreamModelId: 'deepseek-v3.2' },
      }),
    });
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await service.test('c1');

    expect(r.success).toBe(true);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      model: 'deepseek-v3.2',
    }));
  });

  it('falls back to the default Anthropic test model without configured models', async () => {
    mockChannel('https://api.anthropic.com', {
      provider: 'anthropic',
      sdkType: 'anthropic',
      models: JSON.stringify(['*']),
    });
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await service.test('c1');

    expect(r.success).toBe(true);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      model: 'claude-haiku-4-5-20251001',
    }));
  });

  it('uses Gemini models endpoint and API-key header for gemini sdkType', async () => {
    mockChannel('https://generativelanguage.googleapis.com', {
      provider: 'google',
      sdkType: 'gemini',
    });
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await service.test('c1');

    expect(r.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({ 'x-goog-api-key': 'sk-test' });
  });

  it('returns static MiniMax Hailuo video models without calling upstream /models', async () => {
    mockChannel('https://api.minimax.io', {
      provider: 'minimax',
      sdkType: 'minimax_video',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'MiniMax-Hailuo-2.3',
      'MiniMax-Hailuo-2.3-Fast',
      'MiniMax-Hailuo-02',
      'S2V-01',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static Seedance video models without calling upstream /models', async () => {
    mockChannel('https://ark.cn-beijing.volces.com', {
      provider: 'seedance',
      sdkType: 'seedance_video',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'doubao-seedance-2-5-260628',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-1-5-pro-251215',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static Runway video models without calling upstream /models', async () => {
    mockChannel('https://api.dev.runwayml.com', {
      provider: 'runway',
      sdkType: 'runway_video',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'gen4.5',
      'gen4_turbo',
      'gen3a_turbo',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static image models for provider-specific image SDKs', async () => {
    mockChannel('https://api.openai.com/v1', {
      provider: 'openai',
      sdkType: 'openai_image',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static MiniMax image models without calling upstream /models', async () => {
    mockChannel('https://api.minimax.io', {
      provider: 'minimax',
      sdkType: 'minimax_image',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(['image-01']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static audio models for provider-specific audio SDKs', async () => {
    mockChannel('https://api.elevenlabs.io', {
      provider: 'elevenlabs',
      sdkType: 'elevenlabs_audio',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'eleven_v3',
      'eleven_multilingual_v2',
      'scribe_v2',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns static MiniMax music models without calling upstream /models', async () => {
    mockChannel('https://api.minimax.io', {
      provider: 'minimax',
      sdkType: 'minimax_music',
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(expect.arrayContaining([
      'music-2.6',
      'music-cover',
      'music-2.6-free',
    ]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('decrypts KMS ciphertext before calling upstream /models', async () => {
    const kmsCiphertext = Buffer.from('kms-ciphertext');
    mockKmsSend.mockResolvedValue({ Plaintext: Buffer.from('sk-kms-plain') });
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'ENCRYPTION_KEY') return 'a'.repeat(64);
        if (key === 'CHANNEL_SECRET_ENCRYPTION_MODE') return 'kms';
        if (key === 'CHANNEL_KMS_KEY_ID') {
          return 'arn:aws:kms:ap-southeast-1:123456789012:key/channel-key';
        }
        if (key === 'AWS_REGION') return 'ap-southeast-1';
        return undefined;
      }),
    };
    const m = await Test.createTestingModule({
      providers: [
        ChannelService,
        { provide: ChannelRepository, useValue: channelRepository },
        { provide: ConfigService, useValue: config },
        { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
      ],
    }).compile();
    const kmsService = m.get(ChannelService);
    channelRepository.findById.mockResolvedValue({
      id: 'c1',
      name: 'KMS Channel',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: `enc:${kmsCiphertext.toString('base64')}`,
      status: 'ACTIVE',
      priority: 1,
      weight: 1,
      stats: {},
      models: [],
    });
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await kmsService.test('c1');

    expect(r.success).toBe(true);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    expect(
      Buffer.from(mockKmsSend.mock.calls[0][0].input.CiphertextBlob).toString('utf8'),
    ).toBe('kms-ciphertext');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-kms-plain');
  });

  it('propagates upstream HTTP error status', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 401');
  });

  it('handles network errors gracefully', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await service.test('c1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('measures latency even for failed validations', async () => {
    mockChannel('http://127.0.0.1');
    const r = await service.test('c1');
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── CRUD operations ──────────────────────────────────────────────────────────

describe('ChannelService — CRUD', () => {
  let service: ChannelService;

  // Use a valid 32-byte hex key so AES-256 encryption works in tests
  const ENCRYPTION_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
  const channelRepository = {
    findAll: jest.fn(),
    count: jest.fn(),
    findById: jest.fn(),
    findDuplicate: jest.fn(),
    findProductChannelBindings: jest.fn(),
    countByProviders: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
    findActiveChannels: jest.fn(),
    resetStats: jest.fn(),
    updateStats: jest.fn(),
  };
  const productSync = {
    notifyAllProductSaas: jest.fn().mockResolvedValue(undefined),
  };
  const publisherSync = {
    syncOpsTopologyFresh: jest.fn().mockResolvedValue(undefined),
    syncOpsTopologyFreshDetailed: jest.fn().mockResolvedValue({
      ok: true,
      status: 'ACCEPTED',
    }),
    deleteProvider: jest.fn().mockResolvedValue(undefined),
    cleanupRuntimeProviderIfUnused: jest.fn().mockResolvedValue(undefined),
    previewProviderCompile: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKmsSend.mockReset();
    channelRepository.findDuplicate.mockResolvedValue(null);
    channelRepository.countByProviders.mockResolvedValue(1);
    channelRepository.findProductChannelBindings.mockResolvedValue([]);
    const m = await Test.createTestingModule({
      providers: [
        ChannelService,
        { provide: ChannelRepository, useValue: channelRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(ENCRYPTION_KEY) },
        },
        { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
        { provide: ProductSyncNotifier, useValue: productSync },
        { provide: PublisherSyncService, useValue: publisherSync },
      ],
    }).compile();
    service = m.get(ChannelService);
  });

  function makeChannel(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'c1',
      name: 'Test Channel',
      provider: 'openai',
      providerAccountIdentityId: null,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-raw',
      models: '["gpt-4o"]',
      sdkType: 'openai',
      providerProfile: null,
      clientCompatibility: null,
      servedInboundProtocols: null,
      tokenCountStrategy: null,
      ownedBy: null,
      dedicatedClientProtocol: null,
      dedicatedProtocolStrategy: null,
      priority: 1,
      weight: 1,
      maxRpm: null,
      maxTpm: null,
      remark: null,
      isActive: true,
      status: 'active',
      totalReqs: 0,
      totalErrs: 0,
      successRate: 1.0,
      avgLatencyMs: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  // ─── protocolTemplates ─────────────────────────────────────────────────────

  describe('getProtocolTemplates', () => {
    it('returns Publisher contract-backed protocol templates', () => {
      const result = service.getProtocolTemplates();
      const profiles = result.items.map((item) => item.providerProfile);

      expect(result.contractVersion).toBeTruthy();
      expect(result.defaultTemplate).toBe('openai_compatible');
      expect(result.contract.providerProfiles).toContain('openai_compatible');
      expect(result.contract.providerProfiles).toContain('openai_native');
      expect(profiles).toEqual(expect.arrayContaining(result.contract.providerProfiles));
      expect(result.items.find((item) => item.value === 'openai_native')).toMatchObject({
        provider: 'openai',
        sdkType: 'openai_completions',
        providerProfile: 'openai_native',
      });
      expect(result.items.find((item) => item.value === 'openai_compatible')).toMatchObject({
        tokenCountStrategy: 'unsupported',
      });
      expect(result.items.find((item) => item.value === 'anthropic_native')).toMatchObject({
        tokenCountStrategy: 'native',
      });
      expect(result.items.find((item) => item.value === 'glm_coding')).not.toHaveProperty('tokenCountStrategy');
    });
  });

  describe('previewPublisherCompile', () => {
    it('keeps forwarding channel preview input to the publisher compiler path', async () => {
      const preview = {
        providerId: 'openai',
        publisherRequest: { id: 'openai', provider_profile: 'openai_compatible' },
        publisherCompiled: { binding_names: ['openai_chat'] },
        mode: 'publisher_compiler',
      };
      publisherSync.previewProviderCompile.mockResolvedValueOnce(preview);

      await expect(service.previewPublisherCompile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        providerProfile: 'openai_compatible',
      })).resolves.toBe(preview);

      expect(publisherSync.previewProviderCompile).toHaveBeenCalledWith(expect.objectContaining({
        name: 'openai',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        providerProfile: 'openai_compatible',
      }));
    });
  });

  // ─── findAll ───────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns paginated result with masked apiKeys', async () => {
      channelRepository.findAll.mockResolvedValue([makeChannel()]);
      channelRepository.count.mockResolvedValue(1);

      const result = await service.findAll(1, 10);

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(1);
      expect(result.items).toHaveLength(1);
      // apiKey should be masked, not raw
      expect(result.items[0].apiKey).not.toBe('sk-test-raw');
    });

    it('calculates correct offset: (page - 1) * pageSize', async () => {
      channelRepository.findAll.mockResolvedValue([]);
      channelRepository.count.mockResolvedValue(0);

      await service.findAll(3, 10);

      expect(channelRepository.findAll).toHaveBeenCalledWith(20, 10);
    });

    it('computes totalPages correctly', async () => {
      channelRepository.findAll.mockResolvedValue([]);
      channelRepository.count.mockResolvedValue(25);

      const result = await service.findAll(1, 10);

      expect(result.totalPages).toBe(3);
    });

    it('returns empty items when repository returns empty array', async () => {
      channelRepository.findAll.mockResolvedValue([]);
      channelRepository.count.mockResolvedValue(0);

      const result = await service.findAll(1, 10);

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ─── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns channel with masked apiKey', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());

      const result = await service.findById('c1');

      expect(result.id).toBe('c1');
      expect(result.apiKeyMasked).toBeDefined();
      expect(result.apiKey).toBe(result.apiKeyMasked);
      expect(result.apiKey).not.toBe('sk-test-raw');
    });

    it('throws NotFoundException if channel does not exist', async () => {
      channelRepository.findById.mockResolvedValue(null);

      const { NotFoundException } = require('@nestjs/common');
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('passes data to repository.create', async () => {
      const created = makeChannel({ id: 'new-id' });
      channelRepository.create.mockResolvedValue(created);

      const data = {
        name: 'New Channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new-raw',
        models: '["gpt-4o"]',
      };
      const result = await service.create(data);

      expect(channelRepository.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('new-id');
    });

    it('validates and stores an explicitly selected provider account identity', async () => {
      channelRepository.create.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));

      await service.create({
        name: 'Identity-bound Channel',
        provider: 'openai',
        providerAccountIdentityId: '  pai-openai  ',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new-raw',
      });

      expect(providerAccountIdentities.requireActiveForProvider).toHaveBeenCalledWith(
        'pai-openai',
        'openai',
      );
      expect(channelRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        providerAccountIdentityId: 'pai-openai',
      }));
    });

    it('does not persist a channel when its account identity does not match the provider', async () => {
      providerAccountIdentities.requireActiveForProvider.mockRejectedValueOnce(
        new Error('供应商账户身份属于 kimi，与供应商 openai 不匹配'),
      );

      await expect(service.create({
        name: 'Mismatched Channel',
        provider: 'openai',
        providerAccountIdentityId: 'pai-kimi',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new-raw',
      })).rejects.toThrow('不匹配');

      expect(channelRepository.create).not.toHaveBeenCalled();
    });

    it('notifies SaaS when a channel is created', async () => {
      channelRepository.create.mockResolvedValue(makeChannel({ id: 'new-id' }));

      await service.create({
        name: 'New Channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new-raw',
      });

      expect(productSync.notifyAllProductSaas).toHaveBeenCalledWith('channels_changed');
      expect(publisherSync.syncOpsTopologyFreshDetailed).toHaveBeenCalledTimes(1);
    });

    it('encrypts apiKey before storing (when ENCRYPTION_KEY is set)', async () => {
      const created = makeChannel();
      channelRepository.create.mockResolvedValue(created);

      const plainApiKey = 'sk-plaintext-key';
      await service.create({
        name: 'Enc Channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: plainApiKey,
      });

      const storedApiKey = (channelRepository.create as jest.Mock).mock.calls[0][0].apiKey;
      // Encrypted value should differ from plaintext
      expect(storedApiKey).not.toBe(plainApiKey);
      expect(storedApiKey).toMatch(/^enc:local:/);
      expect(decryptGatewayLocalSecret(storedApiKey, ENCRYPTION_KEY)).toBe(plainApiKey);
    });

    it('preserves gateway KMS payloads instead of wrapping them with local AES', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'KMS Channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'enc:CiCexampleCiphertext',
      });

      const storedApiKey = (channelRepository.create as jest.Mock).mock.calls[0][0].apiKey;
      expect(storedApiKey).toBe('enc:CiCexampleCiphertext');
    });

    it('defaults sdkType from provider when sdkType is omitted', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'Claude Channel',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-plain',
      });

      expect((channelRepository.create as jest.Mock).mock.calls[0][0].sdkType).toBe('anthropic');
    });

    it('normalizes sdkType aliases before storing', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'Gemini Channel',
        provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'sk-plain',
        sdkType: 'google',
      });

      expect((channelRepository.create as jest.Mock).mock.calls[0][0].sdkType).toBe('gemini');
    });

    it('preserves OpenAI-compatible sdkType before storing', async () => {
      channelRepository.create.mockResolvedValue(makeChannel({ sdkType: 'openai_compatible' }));

      await service.create({
        name: 'OpenAI Compatible Channel',
        provider: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: 'sk-plain',
        sdkType: 'openai_compatible',
      });

      expect((channelRepository.create as jest.Mock).mock.calls[0][0].sdkType).toBe('openai_compatible');
    });

    it('accepts every protocol template sdkType on create', async () => {
      const templates = service.getProtocolTemplates().items;

      for (const template of templates) {
        channelRepository.create.mockResolvedValueOnce(makeChannel({
          provider: template.provider,
          sdkType: template.sdkType,
          providerProfile: template.providerProfile,
        }));

        await service.create({
          name: `${template.label} Channel`,
          provider: template.provider,
          baseUrl: template.baseUrlPlaceholder,
          apiKey: 'sk-plain',
          sdkType: template.sdkType,
          providerProfile: template.providerProfile,
        });

        const payload = (channelRepository.create as jest.Mock).mock.calls.at(-1)?.[0];
        expect(payload.sdkType).toBe(template.sdkType);
        expect(payload.providerProfile).toBe(template.providerProfile);
      }
    });

    it('normalizes runtime intent fields before storing', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'Anthropic Native Channel',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-plain',
        providerProfile: 'claude',
        clientCompatibility: 'claude_code',
        tokenCountStrategy: 'native',
      });

      const payload = (channelRepository.create as jest.Mock).mock.calls[0][0];
      expect(payload.providerProfile).toBe('anthropic_native');
      expect(payload.clientCompatibility).toBe(JSON.stringify(['claude_code']));
      expect(payload.servedInboundProtocols).toBe(JSON.stringify(['anthropic']));
      expect(payload.tokenCountStrategy).toBe('native');
    });

    it('stores explicit served inbound protocols on create', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'DeepSeek Anthropic',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-plain',
        providerProfile: 'anthropic_native',
        servedInboundProtocols: ['anthropic'],
      });

      const payload = (channelRepository.create as jest.Mock).mock.calls[0][0];
      expect(payload.servedInboundProtocols).toBe(JSON.stringify(['anthropic']));
      expect(payload).not.toHaveProperty('served_inbound_protocols');
    });

    it('normalizes dedicated endpoint fields before storing', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await service.create({
        name: 'GLM Anthropic Dedicated Channel',
        provider: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-plain',
        ownedBy: '  zhipu-overseas-line  ',
        dedicatedClientProtocol: 'Anthropic',
        dedicatedProtocolStrategy: 'responses-to-chat',
      });

      const payload = (channelRepository.create as jest.Mock).mock.calls[0][0];
      expect(payload.ownedBy).toBe('zhipu-overseas-line');
      expect(payload.dedicatedClientProtocol).toBe('anthropic');
      expect(payload.dedicatedProtocolStrategy).toBe('responses_to_chat');
    });

    it('rejects unsupported dedicated endpoint protocol values', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await expect(service.create({
        name: 'Bad Dedicated Channel',
        provider: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'sk-plain',
        dedicatedClientProtocol: 'claude',
      })).rejects.toThrow('dedicatedClientProtocol 只支持 anthropic / openai / responses');

      expect(channelRepository.create).not.toHaveBeenCalled();
    });

    it('rejects client compatibility unsupported by the provider profile', async () => {
      channelRepository.create.mockResolvedValue(makeChannel());

      await expect(service.create({
        name: 'Anthropic Native Channel',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-plain',
        providerProfile: 'claude',
        clientCompatibility: 'claude_code,openai_sdk',
      })).rejects.toThrow('客户端兼容类型不适用于 anthropic_native: openai_sdk');

      expect(channelRepository.create).not.toHaveBeenCalled();
    });

    it('accepts catalog-only MiniMax Hailuo video sdkType on create', async () => {
      channelRepository.create.mockResolvedValue(makeChannel({ sdkType: 'minimax_video' }));

      await service.create({
        name: 'Hailuo Channel',
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io',
        apiKey: 'sk-plain',
        sdkType: 'minimax_video',
      });

      expect((channelRepository.create as jest.Mock).mock.calls[0][0].sdkType).toBe('minimax_video');
    });

    it('rejects unsupported sdkType values on create', async () => {
      await expect(service.create({
        name: 'Bad Channel',
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-plain',
        sdkType: 'unknown-native',
      })).rejects.toThrow('不支持的端点协议');
    });

    it('stores apiKey as-is when ENCRYPTION_KEY is empty', async () => {
      // Create a service without encryption key
      const m = await Test.createTestingModule({
        providers: [
          ChannelService,
          { provide: ChannelRepository, useValue: channelRepository },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue('') },
          },
          { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
        ],
      }).compile();
      const noEncService = m.get(ChannelService);
      channelRepository.create.mockResolvedValue(makeChannel());

      await noEncService.create({
        name: 'No Enc',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-plain',
      });

      const storedApiKey = (channelRepository.create as jest.Mock).mock.calls[0][0].apiKey;
      expect(storedApiKey).toBe('sk-plain');
    });
  });

  // ─── update ────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates channel when found', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel({ name: 'Updated' }));

      const result = await service.update('c1', { name: 'Updated' });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });

    it('validates an account identity before binding it to a channel', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));

      await service.update('c1', { providerAccountIdentityId: ' pai-openai ' });

      expect(providerAccountIdentities.requireActiveForProvider).toHaveBeenCalledWith(
        'pai-openai',
        'openai',
      );
      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        providerAccountIdentityId: 'pai-openai',
      });
    });

    it('revalidates the existing account identity when the provider changes', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));
      providerAccountIdentities.requireActiveForProvider.mockRejectedValueOnce(
        new Error('供应商账户身份属于 openai，与供应商 kimi 不匹配'),
      );

      await expect(service.update('c1', { provider: 'kimi' })).rejects.toThrow('不匹配');

      expect(providerAccountIdentities.requireActiveForProvider).toHaveBeenCalledWith(
        'pai-openai',
        'kimi',
      );
      expect(channelRepository.update).not.toHaveBeenCalled();
    });

    it('keeps the account identity unchanged when rotating only the API key', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));
      channelRepository.update.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));

      await service.update('c1', { apiKey: 'sk-rotated' });

      expect(providerAccountIdentities.requireActiveForProvider).not.toHaveBeenCalled();
      expect(channelRepository.update).toHaveBeenCalledWith(
        'c1',
        expect.not.objectContaining({ providerAccountIdentityId: expect.anything() }),
      );
    });

    it('allows a draft channel identity association to be cleared', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));
      channelRepository.update.mockResolvedValue(makeChannel({
        providerAccountIdentityId: null,
      }));

      await service.update('c1', { providerAccountIdentityId: null });

      expect(providerAccountIdentities.requireActiveForProvider).not.toHaveBeenCalled();
      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        providerAccountIdentityId: null,
      });
    });

    it('rejects clearing an identity while the channel backs a runtime ProductChannel', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));
      channelRepository.findProductChannelBindings.mockResolvedValueOnce([
        { id: 'pc-runtime', metadata: null },
      ]);

      await expect(service.update('c1', { providerAccountIdentityId: null }))
        .rejects.toThrow('不能以空身份保存');

      expect(channelRepository.update).not.toHaveBeenCalled();
    });

    it('rejects key rotation on a legacy runtime Channel until an identity is supplied', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: null,
      }));
      channelRepository.findProductChannelBindings.mockResolvedValueOnce([
        { id: 'pc-runtime', metadata: null },
      ]);

      await expect(service.update('c1', { apiKey: 'sk-rotated' }))
        .rejects.toThrow('必须先绑定供应商账户身份');

      expect(channelRepository.update).not.toHaveBeenCalled();
      expect(publisherSync.syncOpsTopologyFreshDetailed).not.toHaveBeenCalled();
    });

    it('allows clearing an identity when every binding is strict dedicated-upstream', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerAccountIdentityId: 'pai-openai',
      }));
      channelRepository.findProductChannelBindings.mockResolvedValueOnce([
        {
          id: 'pc-dedicated',
          metadata: {
            provider_isolation: {
              visibility: 'dedicated_only',
              credential_source: 'dedicated_upstream',
              allowed_route_kinds: ['dedicated_route'],
            },
          },
        },
      ]);
      channelRepository.update.mockResolvedValue(makeChannel({
        providerAccountIdentityId: null,
      }));

      await expect(service.update('c1', { providerAccountIdentityId: null }))
        .resolves.toBeDefined();
    });

    it('notifies SaaS when a channel is updated', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel({ name: 'Updated' }));

      await service.update('c1', { name: 'Updated' });

      expect(productSync.notifyAllProductSaas).toHaveBeenCalledWith('channels_changed');
      expect(publisherSync.syncOpsTopologyFreshDetailed).toHaveBeenCalledTimes(1);
    });

    it('replays publisher topology when channel models change', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({ models: JSON.stringify(['old-model']) }));
      channelRepository.update.mockResolvedValue(makeChannel({ models: JSON.stringify(['new-model']) }));

      await service.update('c1', { models: JSON.stringify(['new-model']) });

      expect(publisherSync.syncOpsTopologyFreshDetailed).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when channel not found', async () => {
      channelRepository.findById.mockResolvedValue(null);

      const { NotFoundException } = require('@nestjs/common');
      await expect(service.update('missing', { name: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('encrypts apiKey in update payload when apiKey is provided', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', { apiKey: 'sk-new-plain' });

      const updatePayload = (channelRepository.update as jest.Mock).mock.calls[0][1];
      expect(updatePayload.apiKey).not.toBe('sk-new-plain');
    });

    it('preserves gateway KMS payloads when updating apiKey', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', { apiKey: 'enc:CiCexampleCiphertext' });

      const updatePayload = (channelRepository.update as jest.Mock).mock.calls[0][1];
      expect(updatePayload.apiKey).toBe('enc:CiCexampleCiphertext');
    });

    it('does not touch apiKey field when update payload contains a masked key', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', { name: 'Updated', apiKey: 'sk-t***-raw' });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', { name: 'Updated' });
    });

    it('does not touch apiKey field when not provided in update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', { name: 'NewName' });

      const updatePayload = (channelRepository.update as jest.Mock).mock.calls[0][1];
      expect(updatePayload.apiKey).toBeUndefined();
    });

    it('normalizes sdkType aliases on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel({ sdkType: 'anthropic' }));

      await service.update('c1', { sdkType: 'claude' });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', expect.objectContaining({
        sdkType: 'anthropic',
        providerProfile: 'anthropic_native',
        clientCompatibility: JSON.stringify(['all']),
        tokenCountStrategy: 'native',
      }));
    });

    it('preserves OpenAI-compatible sdkType on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel({ sdkType: 'openai_compatible' }));

      await service.update('c1', { sdkType: 'openai_compatible' });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', expect.objectContaining({
        sdkType: 'openai_compatible',
        providerProfile: 'openai_compatible',
        clientCompatibility: JSON.stringify(['all']),
        tokenCountStrategy: 'unsupported',
      }));
    });

    it('normalizes runtime intent fields on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', {
        providerProfile: 'openai_compat',
        clientCompatibility: JSON.stringify(['all', 'dify', 'dify']),
        tokenCountStrategy: 'unsupported',
      });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        providerProfile: 'openai_compatible',
        clientCompatibility: JSON.stringify(['all', 'dify']),
        servedInboundProtocols: JSON.stringify(['openai', 'responses', 'anthropic']),
        protocolPaths: [
          { inbound_protocol: 'openai', channel: 'passthrough' },
          { inbound_protocol: 'responses', channel: 'responses_to_chat' },
          { inbound_protocol: 'anthropic', channel: 'anthropic_to_chat' },
        ],
        tokenCountStrategy: 'unsupported',
      });
    });

    it('does not derive served inbound protocols from legacy client compatibility on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        providerProfile: 'openai_compatible',
      }));
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', {
        clientCompatibility: JSON.stringify(['codex']),
      });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        clientCompatibility: JSON.stringify(['codex']),
      });
    });

    it('normalizes served inbound protocols on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        sdkType: 'anthropic',
        providerProfile: 'anthropic_native',
      }));
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', {
        providerProfile: 'anthropic_native',
        servedInboundProtocols: ['anthropic'],
      });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        providerProfile: 'anthropic_native',
        clientCompatibility: JSON.stringify(['all']),
        servedInboundProtocols: JSON.stringify(['anthropic']),
        protocolPaths: [
          { inbound_protocol: 'anthropic', channel: 'passthrough' },
        ],
        tokenCountStrategy: 'native',
      });
    });

    it('accepts snake_case served inbound protocols on update', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', {
        served_inbound_protocols: ['openai', 'responses'],
      });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        servedInboundProtocols: JSON.stringify(['openai', 'responses']),
        protocolPaths: [
          { inbound_protocol: 'openai', channel: 'passthrough' },
          { inbound_protocol: 'responses', channel: 'responses_to_chat' },
        ],
      });
    });

    it('stores served inbound protocols even when the upstream profile cannot physically bridge them', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({
        sdkType: 'anthropic',
        providerProfile: 'anthropic_native',
      }));
      channelRepository.update.mockResolvedValue(makeChannel());

      await service.update('c1', {
        servedInboundProtocols: ['responses'],
      });

      expect(channelRepository.update).toHaveBeenCalledWith('c1', {
        servedInboundProtocols: JSON.stringify(['responses']),
        protocolPaths: [
          { inbound_protocol: 'responses', channel: 'passthrough' },
        ],
      });
    });

    it('rejects masked apiKey on create', async () => {
      await expect(service.create({
        name: 'Masked',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-t***-raw',
      })).rejects.toThrow('API Key 不能为空或脱敏值');
    });
  });

  // ─── remove ────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes channel when found', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.deleteById.mockResolvedValue(makeChannel());

      await service.remove('c1');

      expect(channelRepository.deleteById).toHaveBeenCalledWith('c1');
    });

    it('notifies SaaS when a channel is deleted', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.deleteById.mockResolvedValue(makeChannel());

      await service.remove('c1');

      expect(productSync.notifyAllProductSaas).toHaveBeenCalledWith('channels_changed');
      expect(publisherSync.syncOpsTopologyFreshDetailed).toHaveBeenCalledTimes(1);
    });

    it('replays publisher topology when a channel is deleted', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel({ models: JSON.stringify(['deleted-model']) }));
      channelRepository.deleteById.mockResolvedValue(makeChannel({ models: JSON.stringify(['deleted-model']) }));

      await service.remove('c1');

      expect(publisherSync.syncOpsTopologyFreshDetailed).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when channel not found', async () => {
      channelRepository.findById.mockResolvedValue(null);

      const { NotFoundException } = require('@nestjs/common');
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── resetStats ────────────────────────────────────────────────────────────

  describe('resetStats', () => {
    it('resets stats for existing channel', async () => {
      channelRepository.findById.mockResolvedValue(makeChannel());
      channelRepository.resetStats.mockResolvedValue(
        makeChannel({ totalReqs: 0, totalErrs: 0, successRate: 1.0, avgLatencyMs: null }),
      );

      const result = await service.resetStats('c1');

      expect(channelRepository.resetStats).toHaveBeenCalledWith('c1');
      expect(result.totalReqs).toBe(0);
    });

    it('throws NotFoundException when channel not found', async () => {
      channelRepository.findById.mockResolvedValue(null);

      const { NotFoundException } = require('@nestjs/common');
      await expect(service.resetStats('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── recordRequest ─────────────────────────────────────────────────────────

  describe('recordRequest', () => {
    it('updates stats after successful request', async () => {
      channelRepository.findById.mockResolvedValue(
        makeChannel({ totalReqs: 10, totalErrs: 1, avgLatencyMs: 100 }),
      );
      channelRepository.updateStats.mockResolvedValue({});

      await service.recordRequest('c1', true, 80);

      const statsCall = (channelRepository.updateStats as jest.Mock).mock.calls[0][1];
      expect(statsCall.totalReqs).toBe(11);
      expect(statsCall.totalErrs).toBe(1); // success=true, no new error
    });

    it('increments totalErrs on failure', async () => {
      channelRepository.findById.mockResolvedValue(
        makeChannel({ totalReqs: 5, totalErrs: 0, avgLatencyMs: 50 }),
      );
      channelRepository.updateStats.mockResolvedValue({});

      await service.recordRequest('c1', false, 200);

      const statsCall = (channelRepository.updateStats as jest.Mock).mock.calls[0][1];
      expect(statsCall.totalErrs).toBe(1);
    });

    it('does nothing if channel not found', async () => {
      channelRepository.findById.mockResolvedValue(null);

      await service.recordRequest('missing', true, 100);

      expect(channelRepository.updateStats).not.toHaveBeenCalled();
    });

    it('computes correct success rate', async () => {
      channelRepository.findById.mockResolvedValue(
        makeChannel({ totalReqs: 9, totalErrs: 3, avgLatencyMs: 100 }),
      );
      channelRepository.updateStats.mockResolvedValue({});

      await service.recordRequest('c1', false, 100);

      const statsCall = (channelRepository.updateStats as jest.Mock).mock.calls[0][1];
      // 10 total, 4 errors → 60% success
      expect(statsCall.successRate).toBeCloseTo(0.6);
    });

    it('initializes avgLatency from first request if null', async () => {
      channelRepository.findById.mockResolvedValue(
        makeChannel({ totalReqs: 0, totalErrs: 0, avgLatencyMs: null }),
      );
      channelRepository.updateStats.mockResolvedValue({});

      await service.recordRequest('c1', true, 150);

      const statsCall = (channelRepository.updateStats as jest.Mock).mock.calls[0][1];
      expect(statsCall.avgLatencyMs).toBe(150);
    });
  });

});

// ─── P2-A2: AlertEvent emission on channel.test() failure (spec §7.2.c) ─────
describe('ChannelService.test() — P2-A2 AlertEvent hook', () => {
  let service: ChannelService;
  let alertEvents: { createAlert: jest.Mock };
  const channelRepository = {
    findById: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    dnsMock.mockReset();
    alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const m = await Test.createTestingModule({
      providers: [
        ChannelService,
        { provide: ChannelRepository, useValue: channelRepository },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('') },
        },
        { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
        { provide: AlertEventService, useValue: alertEvents },
      ],
    }).compile();
    service = m.get(ChannelService);
  });

  function mockChannel(baseUrl: string) {
    channelRepository.findById.mockResolvedValue({
      id: 'ch-1',
      name: 'OpenAI Primary',
      provider: 'openai',
      baseUrl,
      apiKey: 'sk-test',
      status: 'ACTIVE',
      priority: 1,
      weight: 1,
      models: '[]',
    });
  }

  it('HTTP 401 → emits CHANNEL/CRITICAL AlertEvent with channelId sourceId', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });

    const r = await service.test('ch-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 401');
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('CHANNEL');
    expect(arg.severity).toBe('CRITICAL');
    expect(arg.sourceType).toBe('channel');
    expect(arg.sourceId).toBe('ch-1');
    expect(arg.userId).toBeNull();
    expect(arg.context).toMatchObject({
      channelId: 'ch-1',
      provider: 'openai',
      reason: 'HTTP 401',
    });
    expect(arg.message).toMatch(/HTTP 401/);
  });

  it('fetch throws (timeout / network) → emits CHANNEL/CRITICAL AlertEvent', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await service.test('ch-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(r.success).toBe(false);
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('CHANNEL');
    expect(arg.severity).toBe('CRITICAL');
    expect(arg.message).toMatch(/ECONNREFUSED/);
  });

  it('HTTP 200 (success) → does NOT emit AlertEvent', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    const r = await service.test('ch-1');
    await Promise.resolve();

    expect(r.success).toBe(true);
    expect(alertEvents.createAlert).not.toHaveBeenCalled();
  });

  it('createAlert throwing does NOT propagate to caller', async () => {
    mockChannel('https://api.openai.com/v1');
    dnsMock.mockResolvedValue([{ address: '104.16.1.1', family: 4 }]);
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });
    alertEvents.createAlert.mockRejectedValue(new Error('alert DB down'));

    // .test() should still return a clean { success: false } envelope.
    const r = await service.test('ch-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 503');
  });
});

// ─── discoverModels: 拉取上游 /v1/models 列表 ─────────────────────────────────
describe('ChannelService.discoverModels()', () => {
  let service: ChannelService;
  const channelRepository = {
    findById: jest.fn(),
    findByIdWithSecret: jest.fn(),
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    dnsMock.mockReset();
    dnsMock.mockResolvedValue([{ address: '1.2.3.4', family: 4 }]);
    const m = await Test.createTestingModule({
      providers: [
        ChannelService,
        { provide: ChannelRepository, useValue: channelRepository },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('') } },
        { provide: ProviderAccountIdentityService, useValue: providerAccountIdentities },
      ],
    }).compile();
    service = m.get(ChannelService);
  });

  function mockChannel(baseUrl: string, overrides: Record<string, unknown> = {}) {
    channelRepository.findById.mockResolvedValue({
      id: 'c1',
      name: 'test',
      provider: 'openai',
      baseUrl,
      apiKey: 'sk-test',
      status: 'active',
      priority: 1,
      weight: 1,
      models: '[]',
      ...overrides,
    });
  }

  it('parses OpenAI-style model list and returns ids', async () => {
    mockChannel('https://api.openai.com/v1');
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-4o-mini', object: 'model' },
          { id: 'o1-mini' },
        ],
      }),
    });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(true);
    expect(r.models).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1-mini']);
  });

  it('non-OK HTTP → success=false with HTTP error', async () => {
    mockChannel('https://api.example.com/v1');
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid key' }),
    });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 401');
    expect(r.models).toEqual([]);
  });

  it('empty data array → success=false with helpful error', async () => {
    mockChannel('https://api.example.com/v1');
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(r.error).toContain('0 个模型');
  });

  it('fetch throws → success=false with error message', async () => {
    mockChannel('https://api.example.com/v1');
    fetchSpy.mockRejectedValue(new Error('network down'));
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('network down');
    expect(r.models).toEqual([]);
  });

  it('SSRF guard rejects loopback baseUrl', async () => {
    mockChannel('http://127.0.0.1:8080');
    dnsMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('filters out non-string model ids defensively', async () => {
    mockChannel('https://api.example.com/v1');
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: '' },        // empty string filtered out
          { id: null },      // non-string filtered out
          { id: 'claude-3' },
        ],
      }),
    });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(true);
    expect(r.models).toEqual(['gpt-4o', 'claude-3']);
  });

  it('parses Gemini native model list and strips models/ prefix', async () => {
    mockChannel('https://generativelanguage.googleapis.com', {
      provider: 'google',
      sdkType: 'gemini',
    });
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-pro' },
          { name: 'models/gemini-2.5-flash' },
        ],
      }),
    });

    const r = await service.discoverModels('c1');

    expect(r.success).toBe(true);
    expect(r.models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({ 'x-goog-api-key': 'sk-test' });
  });

  // 智能拼接:baseUrl 不带 /v1,优先试 /v1/models,失败 fallback /models
  it('baseUrl without /v1 → tries /v1/models first', async () => {
    mockChannel('https://sub2api-test.codesphere.run');
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'kimi-k2' }] }),
    });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://sub2api-test.codesphere.run/v1/models');
  });

  it('baseUrl already with /v1 → only tries /v1/models once (no fallback)', async () => {
    mockChannel('https://api.openai.com/v1');
    fetchSpy.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
  });

  it('first /v1/models 404 → fallback to /models', async () => {
    mockChannel('http://18.141.203.177:8080');
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'claude-opus-4-7' }] }),
      });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://18.141.203.177:8080/v1/models');
    expect(fetchSpy.mock.calls[1][0]).toBe('http://18.141.203.177:8080/models');
  });

  it('non-404 error on first candidate → return immediately, no fallback', async () => {
    mockChannel('http://example.com');
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const r = await service.discoverModels('c1');
    expect(r.success).toBe(false);
    expect(r.error).toBe('HTTP 401');
    expect(fetchSpy).toHaveBeenCalledTimes(1);  // 没尝试第二个
  });
});

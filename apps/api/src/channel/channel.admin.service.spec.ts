import { BadRequestException, ConflictException } from '@nestjs/common';
import { ChannelAdminService } from './channel.admin.service';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
function makeRepo() {
  return {
    findModelPricing: jest.fn(),
    upsertModelPricing: jest.fn(),
    createModelPricing: jest.fn(),
    findModelPricingByName: jest.fn(),
    findActiveModelPricingNotIn: jest.fn(),
    findActiveModelAccessNames: jest.fn().mockResolvedValue([]),
    deactivateModelPricingNotIn: jest.fn(),
    findChannelsForHealth: jest.fn().mockResolvedValue([]),
    findModelAccess: jest.fn(),
    upsertModelAccess: jest.fn(),
    findModelRoutePolicies: jest.fn(),
    upsertModelRoutePolicy: jest.fn(),
    findPlansByIds: jest.fn(),
    findProductById: jest.fn(),
    findModelAccessReferences: jest.fn().mockResolvedValue([]),
    deleteModelPricingByName: jest.fn(),
    publishAllActiveModelPricing: jest.fn(),
  };
}

function makeProductSync() {
  return {
    notifyProductSaas: jest.fn().mockResolvedValue(undefined),
  };
}

function buildService() {
  const repo = makeRepo();
  const productSync = makeProductSync();
  const publisherSync = {
    deleteModelRuntime: jest.fn().mockResolvedValue(undefined),
    syncOpsTopologyFresh: jest.fn().mockResolvedValue(undefined),
    syncApiKeysByPlanId: jest.fn().mockResolvedValue(undefined),
  };
  // finding #13：批量绑定写现走 prisma.$transaction + per-plan advisory 锁 + active 绑定守卫。
  // tx.plan.findUnique 默认返回 null（非自营/未上架）→ 不触发守卫，保持既有用例行为。
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    modelAccess: {
      upsert: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    },
    modelRoutePolicy: { upsert: jest.fn().mockResolvedValue({}) },
    plan: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    // 下架/删除闸门要查未结算 Gateway 事件；默认"都清干净了"，个别用例再覆盖。
    gatewayBillingEvent: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };

  const service = new ChannelAdminService(
    repo as any,
    prisma as any,
    productSync as any,
    undefined,
    publisherSync as any,
  );

  return { service, repo, productSync, publisherSync, prisma, tx };
}

// ---------------------------------------------------------------------------
// listModelPricing
// ---------------------------------------------------------------------------
describe('ChannelAdminService.listModelPricing', () => {
  it('derives displayName from modelId while preserving modelName', async () => {
    const { service, repo } = buildService();
    repo.findModelPricing.mockResolvedValue([{
      modelName: 'gpt-4',
      modelId: 'GPT-4 用户版',
    }]);

    const result = await service.listModelPricing();

    expect(result).toEqual([{
      modelName: 'gpt-4',
      modelId: 'GPT-4 用户版',
      displayName: 'GPT-4 用户版',
    }]);
    expect(repo.findModelPricing).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no pricing configured', async () => {
    const { service, repo } = buildService();
    repo.findModelPricing.mockResolvedValue([]);

    const result = await service.listModelPricing();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// upsertModelPricing
// ---------------------------------------------------------------------------
describe('ChannelAdminService.upsertModelPricing', () => {
  it('calls repo with correct data including isActive default', async () => {
    const { service, repo } = buildService();
    repo.upsertModelPricing.mockResolvedValue({ modelName: 'gpt-4', inputPricePerMToken: 100 });

    const result = await service.upsertModelPricing({
      modelName: 'gpt-4',
      inputPricePerMToken: 100,
      outputPricePerMToken: 200,
    });

    expect(repo.upsertModelPricing).toHaveBeenCalledWith('gpt-4', {
      inputPricePerMToken: 100,
      outputPricePerMToken: 200,
      isActive: true,
    });
    expect(result).toEqual({ modelName: 'gpt-4', inputPricePerMToken: 100 });
  });

  it('passes explicit isActive=false when provided', async () => {
    const { service, repo, publisherSync } = buildService();
    repo.upsertModelPricing.mockResolvedValue({});

    await service.upsertModelPricing({
      modelName: 'claude-3',
      inputPricePerMToken: 50,
      outputPricePerMToken: 150,
      isActive: false,
    });

    expect(repo.upsertModelPricing).toHaveBeenCalledWith('claude-3', expect.objectContaining({
      isActive: false,
    }));
    expect(publisherSync.deleteModelRuntime).toHaveBeenCalledWith('claude-3');
    expect(publisherSync.syncOpsTopologyFresh).toHaveBeenCalledTimes(1);
  });

  it('does not touch publisher runtime for isPublished-only changes', async () => {
    const { service, repo, publisherSync } = buildService();
    repo.upsertModelPricing.mockResolvedValue({});

    await service.upsertModelPricing({
      modelName: 'claude-3',
      inputPricePerMToken: 50,
      outputPricePerMToken: 150,
      isPublished: false,
    });

    expect(publisherSync.deleteModelRuntime).not.toHaveBeenCalled();
    expect(publisherSync.syncOpsTopologyFresh).not.toHaveBeenCalled();
  });

  it('accepts context-based price tiers', async () => {
    const { service, repo } = buildService();
    repo.upsertModelPricing.mockResolvedValue({});

    await service.upsertModelPricing({
      modelName: 'glm-5.1',
      inputPricePerMToken: 6,
      outputPricePerMToken: 24,
      priceTiers: [
        {
          tierKey: 'short',
          minInputTokens: 0,
          maxInputTokensExclusive: 32_000,
          inputPricePerMToken: 6,
          outputPricePerMToken: 24,
          cachedInputPrice: 1.3,
          rawCondition: '输入长度 [0, 32)',
        },
        {
          tierKey: 'long',
          minInputTokens: 32_000,
          inputPricePerMToken: 8,
          outputPricePerMToken: 28,
          cachedInputPrice: 2,
          rawCondition: '输入长度 [32+)',
          priority: 10,
        },
      ],
    });

    expect(repo.upsertModelPricing).toHaveBeenCalledWith('glm-5.1', expect.objectContaining({
      priceTiers: [
        expect.objectContaining({
          tierKey: 'short',
          minInputTokens: 0,
          maxInputTokensExclusive: 32_000,
          inputPricePerMToken: 6,
          outputPricePerMToken: 24,
          cachedInputPrice: 1.3,
          rawCondition: '输入长度 [0, 32)',
          currency: 'USD',
          isActive: true,
        }),
        expect.objectContaining({
          tierKey: 'long',
          minInputTokens: 32_000,
          maxInputTokensExclusive: null,
          inputPricePerMToken: 8,
          outputPricePerMToken: 28,
          cachedInputPrice: 2,
          priority: 10,
        }),
      ],
    }));
  });

  // ─── v2 catalog field validation (PR4) ────────────────────────────────────

  describe('v2 catalog field validation', () => {
    it('rejects when modelName is missing', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: '',
          inputPricePerMToken: 100,
          outputPricePerMToken: 200,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts and forwards a fully-populated v2 payload', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'gpt-4o',
        inputPricePerMToken: 2.5,
        outputPricePerMToken: 10,
        provider: 'openai',
        modelId: 'GPT-4o 用户版',
        description: '## GPT-4o',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        contextLength: 128_000,
        maxOutputTokens: 16_384,
        providerLogo: 'https://example.com/logo.png',
        isPublished: true,
        displayOrder: 5,
        releaseAt: '2024-05-13T00:00:00Z',
        tags: ['推理', '快速'],
        supportedFeatures: ['function_call', 'streaming'],
        cachedInputPrice: 1.25,
        batchDiscount: 0.5,
      });

      const call = repo.upsertModelPricing.mock.calls[0];
      expect(call[0]).toBe('gpt-4o');
      const payload = call[1];
      expect(payload).toMatchObject({
        provider: 'openai',
        modelId: 'GPT-4o 用户版',
        description: '## GPT-4o',
        inputModalities: JSON.stringify(['text', 'image']),
        outputModalities: JSON.stringify(['text']),
        contextLength: 128_000,
        maxOutputTokens: 16_384,
        providerLogo: 'https://example.com/logo.png',
        isPublished: true,
        displayOrder: 5,
        tags: JSON.stringify(['推理', '快速']),
        supportedFeatures: JSON.stringify(['function_call', 'streaming']),
        cachedInputPrice: 1.25,
        batchDiscount: 0.5,
      });
      expect(payload.releaseAt).toBeInstanceOf(Date);
    });

    it('updates the user-facing name through modelId without changing modelName', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'gpt-4o',
        modelId: 'Legacy display label',
        inputPricePerMToken: 2.5,
        outputPricePerMToken: 10,
      });

      expect(repo.upsertModelPricing).toHaveBeenCalledWith(
        'gpt-4o',
        expect.objectContaining({ modelId: 'Legacy display label' }),
      );
    });

    it('rejects invalid provider', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          provider: 'not-a-provider',
        }),
      ).rejects.toThrow(/provider/);
    });

    it('accepts moonshot provider for Kimi models', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'kimi-k2.5',
        inputPricePerMToken: 0.6,
        outputPricePerMToken: 3,
        provider: 'moonshot',
      });

      expect(repo.upsertModelPricing.mock.calls[0][1]).toMatchObject({
        provider: 'moonshot',
      });
    });

    it('accepts minimax provider for MiniMax models', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'MiniMax-M2.7',
        inputPricePerMToken: 0.6,
        outputPricePerMToken: 3,
        provider: 'minimax',
      });

      expect(repo.upsertModelPricing.mock.calls[0][1]).toMatchObject({
        provider: 'minimax',
      });
    });

    it('accepts Seedance video catalog metadata fields', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'doubao-seedance-2-0-260128',
        inputPricePerMToken: 0,
        outputPricePerMToken: 0,
        provider: 'seedance',
        modelType: 'video',
        pricingUnit: 'video_task',
        inputModalities: ['text', 'image', 'video', 'audio'],
        outputModalities: ['video', 'audio'],
        supportedFeatures: [
          'video_generation',
          'async_task',
          't2v',
          'i2v',
          'first_last_frame',
          'reference_to_video',
          'video_edit',
          'video_extend',
        ],
        pricingMetadata: {
          schemaVersion: 'video-generation.v1',
          providerFamily: 'seedance',
        },
      });

      expect(repo.upsertModelPricing.mock.calls[0][1]).toMatchObject({
        provider: 'seedance',
        modelType: 'video',
        pricingUnit: 'video_task',
        inputModalities: JSON.stringify(['text', 'image', 'video', 'audio']),
        outputModalities: JSON.stringify(['video', 'audio']),
        supportedFeatures: JSON.stringify([
          'video_generation',
          'async_task',
          't2v',
          'i2v',
          'first_last_frame',
          'reference_to_video',
          'video_edit',
          'video_extend',
        ]),
        pricingMetadata: {
          schemaVersion: 'video-generation.v1',
          providerFamily: 'seedance',
        },
      });
    });

    it('filters unknown modalities instead of rejecting synced catalog data', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'm',
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
        inputModalities: ['text', 'hologram'],
      });

      expect(repo.upsertModelPricing).toHaveBeenCalledWith('m', expect.objectContaining({
        inputModalities: JSON.stringify(['text']),
      }));
    });

    it('filters unknown supportedFeature instead of rejecting synced catalog data', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});

      await service.upsertModelPricing({
        modelName: 'm',
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
        supportedFeatures: ['function_call', 'telepathy'],
      });

      expect(repo.upsertModelPricing).toHaveBeenCalledWith('m', expect.objectContaining({
        supportedFeatures: JSON.stringify(['function_call']),
      }));
    });

    it('rejects too many tags', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          tags: Array.from({ length: 17 }, (_, i) => `tag${i}`),
        }),
      ).rejects.toThrow(/tags/);
    });

    it('rejects negative contextLength', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          contextLength: -1,
        }),
      ).rejects.toThrow(/contextLength/);
    });

    it('rejects batchDiscount > 1', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          batchDiscount: 1.5,
        }),
      ).rejects.toThrow(/batchDiscount/);
    });

    it('rejects invalid releaseAt string', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          releaseAt: 'not-a-date',
        }),
      ).rejects.toThrow(/releaseAt/);
    });

    it('treats null v2 fields as explicit "clear" (forwards null to repo)', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});
      await service.upsertModelPricing({
        modelName: 'm',
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
        provider: null,
        description: null,
        contextLength: null,
        tags: null,
      });
      const payload = repo.upsertModelPricing.mock.calls[0][1];
      expect(payload.provider).toBeNull();
      expect(payload.description).toBeNull();
      expect(payload.contextLength).toBeNull();
      expect(payload.tags).toBeNull();
    });

    it('rejects cachedInputPrice above MAX_TOKEN_FIELD (10_000_000) — consistency with other token fields', async () => {
      const { service } = buildService();
      await expect(
        service.upsertModelPricing({
          modelName: 'm',
          inputPricePerMToken: 1,
          outputPricePerMToken: 1,
          cachedInputPrice: 10_000_001,
        }),
      ).rejects.toThrow(/cachedInputPrice/);
    });

    it('treats explicit displayOrder=null as clear (sets to 0)', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});
      await service.upsertModelPricing({
        modelName: 'm',
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
        displayOrder: null as unknown as number,
      });
      expect(repo.upsertModelPricing.mock.calls[0][1]).toMatchObject({ displayOrder: 0 });
    });

    it('does NOT include v2 fields in repo payload when not passed (preserves existing values)', async () => {
      const { service, repo } = buildService();
      repo.upsertModelPricing.mockResolvedValue({});
      await service.upsertModelPricing({
        modelName: 'm',
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
      });
      const payload = repo.upsertModelPricing.mock.calls[0][1];
      // Only the legacy fields are present.
      expect(payload).toEqual({
        inputPricePerMToken: 1,
        outputPricePerMToken: 1,
        isActive: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// syncModelPricingFromProxy
// ---------------------------------------------------------------------------
describe('ChannelAdminService.syncModelPricingFromProxy', () => {
  it('creates entries for new models not yet in DB', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['model-a', 'model-b']), isActive: true, status: 'active' },
    ]);
    repo.findModelPricingByName
      .mockResolvedValueOnce(null) // model-a: new
      .mockResolvedValueOnce({ modelName: 'model-b' }); // model-b: exists
    repo.createModelPricing.mockResolvedValue({});

    const result = await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledTimes(1);
    expect(repo.createModelPricing).toHaveBeenCalledWith('model-a', {
      provider: 'other',
      modelType: 'chat',
      pricingUnit: 'token_1m',
      inputModalities: '["text"]',
      outputModalities: '["text"]',
      supportedFeatures: '[]',
      pricingMetadata: null,
    });
    expect(result).toEqual({ added: 1, total: 2 });
  });

  it('infers minimax provider for MiniMax channel models', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['MiniMax-M2.7']), isActive: true, status: 'active' },
    ]);
    repo.findModelPricingByName.mockResolvedValue(null);
    repo.createModelPricing.mockResolvedValue({});

    await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledWith('MiniMax-M2.7', {
      provider: 'minimax',
      modelType: 'chat',
      pricingUnit: 'token_1m',
      inputModalities: '["text"]',
      outputModalities: '["text"]',
      supportedFeatures: '[]',
      pricingMetadata: null,
    });
  });

  it('infers Seedance video catalog defaults from channel provider and sdkType', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      {
        provider: 'doubao',
        sdkType: 'seedance_video',
        models: JSON.stringify(['doubao-seedance-2-0-fast-260128']),
        isActive: true,
        status: 'active',
      },
    ]);
    repo.findModelPricingByName.mockResolvedValue(null);
    repo.createModelPricing.mockResolvedValue({});

    await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'doubao-seedance-2-0-fast-260128',
      expect.objectContaining({
        provider: 'seedance',
        modelType: 'video',
        pricingUnit: 'video_task',
        inputModalities: JSON.stringify(['text', 'image', 'video', 'audio']),
        outputModalities: JSON.stringify(['video', 'audio']),
        supportedFeatures: JSON.stringify([
          'video_generation',
          'async_task',
          't2v',
          'i2v',
          'first_last_frame',
          'audio_generation',
          'reference_to_video',
          'video_edit',
          'video_extend',
        ]),
        pricingMetadata: expect.objectContaining({
          schemaVersion: 'video-generation.v1',
          providerFamily: 'seedance',
          gatewayProtocol: 'video_generation.v1',
        }),
      }),
    );
  });

  it('infers Claude and Codex runtime capabilities from channel sdkType', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      {
        provider: 'claude',
        sdkType: 'anthropic',
        models: JSON.stringify(['claude-opus-4-7']),
        isActive: true,
        status: 'active',
      },
      {
        provider: 'openai',
        sdkType: 'openai_responses',
        models: JSON.stringify(['gpt-5.3-codex']),
        isActive: true,
        status: 'active',
      },
    ]);
    repo.findModelPricingByName.mockResolvedValue(null);
    repo.createModelPricing.mockResolvedValue({});

    await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'claude-opus-4-7',
      expect.objectContaining({
        provider: 'anthropic',
        modelType: 'chat',
        pricingUnit: 'token_1m',
        inputModalities: JSON.stringify(['text', 'image']),
        outputModalities: JSON.stringify(['text']),
        supportedFeatures: JSON.stringify([
          'function_call',
          'function_tools',
          'streaming',
          'streaming_tools',
          'reasoning',
          'vision',
        ]),
      }),
    );
    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'gpt-5.3-codex',
      expect.objectContaining({
        provider: 'openai',
        modelType: 'chat',
        pricingUnit: 'token_1m',
        inputModalities: JSON.stringify(['text']),
        outputModalities: JSON.stringify(['text']),
        supportedFeatures: JSON.stringify([
          'function_call',
          'function_tools',
          'streaming',
          'streaming_tools',
          'reasoning',
        ]),
      }),
    );
  });

  it('infers OpenAI image catalog defaults from image SDK', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      {
        provider: 'openai',
        sdkType: 'openai_image',
        models: JSON.stringify(['gpt-image-2']),
        isActive: true,
        status: 'active',
      },
    ]);
    repo.findModelPricingByName.mockResolvedValue(null);
    repo.createModelPricing.mockResolvedValue({});

    await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'gpt-image-2',
      expect.objectContaining({
        provider: 'openai',
        modelType: 'image',
        pricingUnit: 'image',
        inputModalities: JSON.stringify(['text', 'image']),
        outputModalities: JSON.stringify(['image']),
        supportedFeatures: JSON.stringify([
          'image_generation',
          'text_to_image',
          'image_edit',
          'image_variation',
        ]),
        pricingMetadata: expect.objectContaining({
          schemaVersion: 'image-generation.v1',
          providerFamily: 'openai',
          gatewayProtocol: 'image_generation.v1',
        }),
      }),
    );
  });

  it('infers audio catalog defaults for STT and music models', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      {
        provider: 'openai',
        sdkType: 'openai_audio',
        models: JSON.stringify(['gpt-4o-transcribe']),
        isActive: true,
        status: 'active',
      },
      {
        provider: 'minimax',
        sdkType: 'minimax_music',
        models: JSON.stringify(['music-2.6']),
        isActive: true,
        status: 'active',
      },
    ]);
    repo.findModelPricingByName.mockResolvedValue(null);
    repo.createModelPricing.mockResolvedValue({});

    await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'gpt-4o-transcribe',
      expect.objectContaining({
        provider: 'openai',
        modelType: 'audio',
        pricingUnit: 'audio_minute',
        inputModalities: JSON.stringify(['audio']),
        outputModalities: JSON.stringify(['text']),
        supportedFeatures: JSON.stringify(['audio_generation', 'stt', 'speech_to_text', 'timestamps']),
        pricingMetadata: expect.objectContaining({
          schemaVersion: 'audio.v1',
          providerFamily: 'openai',
          gatewayProtocol: 'audio.v1',
        }),
      }),
    );
    expect(repo.createModelPricing).toHaveBeenCalledWith(
      'music-2.6',
      expect.objectContaining({
        provider: 'minimax',
        modelType: 'audio',
        pricingUnit: 'request',
        inputModalities: JSON.stringify(['text', 'audio']),
        outputModalities: JSON.stringify(['audio']),
        supportedFeatures: JSON.stringify(['audio_generation', 'music_generation']),
        pricingMetadata: expect.objectContaining({
          schemaVersion: 'audio.v1',
          providerFamily: 'minimax',
          gatewayProtocol: 'audio.v1',
        }),
      }),
    );
  });

  it('returns added=0 when all models already exist', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['gpt-4']), isActive: true, status: 'active' },
    ]);
    repo.findModelPricingByName.mockResolvedValue({ modelName: 'gpt-4' });

    const result = await service.syncModelPricingFromProxy();

    expect(repo.createModelPricing).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 0, total: 1 });
  });

  it('handles empty model list from proxy', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([]);

    const result = await service.syncModelPricingFromProxy();

    expect(result).toEqual({ added: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// deactivateOrphanModelPricing
// ---------------------------------------------------------------------------
describe('ChannelAdminService.deactivateOrphanModelPricing', () => {
  it('preview (confirm=false) returns orphans WITHOUT writing', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['glm-5.1', 'claude-sonnet-4-6']), isActive: true, status: 'active' },
    ]);
    repo.findActiveModelAccessNames.mockResolvedValue(['gpt-5.4']);
    repo.findActiveModelPricingNotIn.mockResolvedValue([
      { modelName: 'gpt-5' },
      { modelName: 'gemini-3.1-pro-preview' },
    ]);

    const result = await service.deactivateOrphanModelPricing(false);

    expect(result).toEqual({
      orphans: ['gpt-5', 'gemini-3.1-pro-preview'],
      deactivated: 0,
      dryRun: true,
    });
    expect(repo.findActiveModelPricingNotIn).toHaveBeenCalledWith(['glm-5.1', 'claude-sonnet-4-6', 'gpt-5.4']);
    expect(repo.deactivateModelPricingNotIn).not.toHaveBeenCalled();
  });

  it('commit (confirm=true) deactivates orphans and removes them from publisher runtime', async () => {
    const { service, repo, publisherSync } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['glm-5.1']), isActive: true, status: 'active' },
    ]);
    repo.findActiveModelAccessNames.mockResolvedValue(['claude-sonnet-4-6']);
    repo.findActiveModelPricingNotIn.mockResolvedValue([{ modelName: 'gpt-5' }]);
    repo.deactivateModelPricingNotIn.mockResolvedValue({ count: 19 });

    const result = await service.deactivateOrphanModelPricing(true);

    expect(result).toEqual({
      orphans: ['gpt-5'],
      deactivated: 19,
      dryRun: false,
    });
    expect(repo.deactivateModelPricingNotIn).toHaveBeenCalledWith(['glm-5.1', 'claude-sonnet-4-6']);
    expect(publisherSync.deleteModelRuntime).toHaveBeenCalledWith('gpt-5');
    expect(publisherSync.syncOpsTopologyFresh).toHaveBeenCalledTimes(1);
  });

  it('returns empty orphans when all active pricings are covered', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([
      { models: JSON.stringify(['glm-5.1']), isActive: true, status: 'active' },
    ]);
    repo.findActiveModelPricingNotIn.mockResolvedValue([]);

    const result = await service.deactivateOrphanModelPricing(false);

    expect(result.orphans).toEqual([]);
    expect(result.dryRun).toBe(true);
  });

  it('handles empty Channel list without deactivating models still used by active plans', async () => {
    const { service, repo } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([]);
    repo.findActiveModelAccessNames.mockResolvedValue(['claude-sonnet-4-6']);
    repo.findActiveModelPricingNotIn.mockResolvedValue([
      { modelName: 'gpt-5' },
    ]);

    const result = await service.deactivateOrphanModelPricing(false);

    expect(repo.findActiveModelPricingNotIn).toHaveBeenCalledWith(['claude-sonnet-4-6']);
    expect(result.orphans).toEqual(['gpt-5']);
  });
});

// ---------------------------------------------------------------------------
// deleteModelPricing
// ---------------------------------------------------------------------------
describe('ChannelAdminService.deleteModelPricing', () => {
  it('deletes the catalog row and removes runtime model state', async () => {
    const { service, repo, publisherSync } = buildService();
    repo.findModelPricingByName.mockResolvedValue({ modelName: 'glm-5.2' });
    repo.findModelAccessReferences.mockResolvedValue([]);
    repo.deleteModelPricingByName.mockResolvedValue({});

    const result = await service.deleteModelPricing(' glm-5.2 ');

    expect(result).toEqual({ deleted: true, modelName: 'glm-5.2' });
    expect(repo.deleteModelPricingByName).toHaveBeenCalledWith('glm-5.2');
    expect(publisherSync.deleteModelRuntime).toHaveBeenCalledWith('glm-5.2');
    expect(publisherSync.syncOpsTopologyFresh).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 下架/删除前置闸门（2026-09-07 国内 prod 事故）
//
// 事故形状：结算滞后 146 分钟时下架模型，9,622 笔还没结算的历史事件随后取不到价，
// 转人工隔离并连带把客户 Key 封了 4 小时。闸门要覆盖**所有**能让模型失效的入口，
// 少一个就能绕过。
// ---------------------------------------------------------------------------
describe('ChannelAdminService 模型下架闸门', () => {
  const unsettled = [{
    modelName: 'deepseek-v4-flash',
    _count: { _all: 9622 },
    _min: { occurredAt: new Date('2026-09-07T03:02:08.000Z') },
  }];

  it('物理删除：有未结算事件时拒绝，且不碰删除', async () => {
    const { service, repo, prisma, publisherSync } = buildService();
    repo.findModelPricingByName.mockResolvedValue({ modelName: 'deepseek-v4-flash' });
    repo.findModelAccessReferences.mockResolvedValue([]);
    prisma.gatewayBillingEvent.groupBy.mockResolvedValue(unsettled);

    await expect(service.deleteModelPricing('deepseek-v4-flash')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.deleteModelPricing('deepseek-v4-flash')).rejects.toThrow(/9622 笔未结算/);
    expect(repo.deleteModelPricingByName).not.toHaveBeenCalled();
    expect(publisherSync.deleteModelRuntime).not.toHaveBeenCalled();
  });

  it('清理孤儿 commit：有未结算事件时拒绝，且不写 updateMany', async () => {
    const { service, repo, prisma } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([]);
    repo.findActiveModelAccessNames.mockResolvedValue([]);
    repo.findActiveModelPricingNotIn.mockResolvedValue([{ modelName: 'deepseek-v4-flash' }]);
    prisma.gatewayBillingEvent.groupBy.mockResolvedValue(unsettled);

    await expect(service.deactivateOrphanModelPricing(true)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.deactivateModelPricingNotIn).not.toHaveBeenCalled();
  });

  it('清理孤儿 preview：把会被拦住的孤儿先报给运营', async () => {
    const { service, repo, prisma } = buildService();
    repo.findChannelsForHealth.mockResolvedValue([]);
    repo.findActiveModelAccessNames.mockResolvedValue([]);
    repo.findActiveModelPricingNotIn.mockResolvedValue([{ modelName: 'deepseek-v4-flash' }]);
    prisma.gatewayBillingEvent.groupBy.mockResolvedValue(unsettled);

    const result = await service.deactivateOrphanModelPricing(false);

    expect(result.dryRun).toBe(true);
    expect(result.blocked).toEqual([{
      modelName: 'deepseek-v4-flash',
      count: 9622,
      earliestOccurredAt: new Date('2026-09-07T03:02:08.000Z'),
    }]);
    expect(repo.deactivateModelPricingNotIn).not.toHaveBeenCalled();
  });

  it('判定用终态集合的补集，未来新增状态默认算未结算', async () => {
    const { service, repo, prisma } = buildService();
    repo.findModelPricingByName.mockResolvedValue({ modelName: 'glm-5.2' });
    repo.findModelAccessReferences.mockResolvedValue([]);
    repo.deleteModelPricingByName.mockResolvedValue({});

    await service.deleteModelPricing('glm-5.2');

    expect(prisma.gatewayBillingEvent.groupBy).toHaveBeenCalledWith({
      by: ['modelName'],
      where: {
        modelName: { in: ['glm-5.2'] },
        status: { notIn: ['DEDUCTED', 'SKIPPED', 'FAILED', 'ABSORBED', 'DEBT_OPEN'] },
      },
      _count: { _all: true },
      _min: { occurredAt: true },
    });
  });
});

// ---------------------------------------------------------------------------
// listModelAccess
// ---------------------------------------------------------------------------
describe('ChannelAdminService.listModelAccess', () => {
  it('delegates to repo.findModelAccess', async () => {
    const { service, repo } = buildService();
    repo.findModelAccess.mockResolvedValue([{ planId: 'free', modelName: 'gpt-4', isActive: true }]);

    const result = await service.listModelAccess();

    expect(result).toEqual([{ planId: 'free', modelName: 'gpt-4', isActive: true }]);
  });
});

// ---------------------------------------------------------------------------
// batchUpdateModelAccess
// ---------------------------------------------------------------------------
describe('ChannelAdminService.batchUpdateModelAccess', () => {
  it('upserts each item with correct planId, modelName, isActive', async () => {
    const { service, repo, tx } = buildService();
    repo.findPlansByIds.mockResolvedValue([]);

    await service.batchUpdateModelAccess([
      { tierId: 'free', modelName: 'gpt-4', isActive: true },
      { planId: 'pro', model: 'claude-3', isActive: false, creditMultiplier: 1.5 },
    ]);

    expect(tx.modelAccess.upsert).toHaveBeenCalledTimes(2);
    expect(tx.modelAccess.upsert).toHaveBeenCalledWith({
      where: { planId_modelName: { planId: 'free', modelName: 'gpt-4' } },
      update: { isActive: true },
      create: { planId: 'free', modelName: 'gpt-4', isActive: true },
    });
    expect(tx.modelAccess.upsert).toHaveBeenCalledWith({
      where: { planId_modelName: { planId: 'pro', modelName: 'claude-3' } },
      update: { isActive: false, creditMultiplier: 1.5 },
      create: { planId: 'pro', modelName: 'claude-3', isActive: false, creditMultiplier: 1.5 },
    });
  });

  it('uses isAllowed as fallback for isActive when isActive is undefined', async () => {
    const { service, repo, tx } = buildService();
    repo.findPlansByIds.mockResolvedValue([]);

    await service.batchUpdateModelAccess([{ planId: 'free', model: 'gpt-4', isAllowed: true }]);

    expect(tx.modelAccess.upsert).toHaveBeenCalledWith({
      where: { planId_modelName: { planId: 'free', modelName: 'gpt-4' } },
      update: { isActive: true },
      create: { planId: 'free', modelName: 'gpt-4', isActive: true },
    });
  });

  it('defaults isActive to true when neither isActive nor isAllowed is set', async () => {
    const { service, repo, tx } = buildService();
    repo.findPlansByIds.mockResolvedValue([]);

    await service.batchUpdateModelAccess([{ planId: 'free', model: 'gpt-4' }]);

    expect(tx.modelAccess.upsert).toHaveBeenCalledWith({
      where: { planId_modelName: { planId: 'free', modelName: 'gpt-4' } },
      update: { isActive: true },
      create: { planId: 'free', modelName: 'gpt-4', isActive: true },
    });
  });

  it('throws BadRequestException when items is empty', async () => {
    const { service } = buildService();
    await expect(service.batchUpdateModelAccess([])).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when items is null/undefined', async () => {
    const { service } = buildService();
    await expect(service.batchUpdateModelAccess(null as any)).rejects.toThrow(BadRequestException);
  });

  it('notifies plans webhook with deduplicated planIds', async () => {
    const { service, repo, productSync } = buildService();
    repo.upsertModelAccess.mockResolvedValue({});
    repo.findPlansByIds.mockResolvedValue([{ productId: 'prod-1' }]);
    repo.findProductById.mockResolvedValue({ slug: 'raytone' });

    await service.batchUpdateModelAccess([
      { tierId: 'free', model: 'gpt-4', isActive: true },
      { tierId: 'free', model: 'claude-3', isActive: true }, // same planId — deduped
    ]);

    // Deduped: ['free'] → findPlansByIds should be called once with ['free']
    expect(repo.findPlansByIds).toHaveBeenCalledWith(['free']);
    // Wait a tick for the fire-and-forget webhook
    await new Promise((r) => setImmediate(r));
    expect(productSync.notifyProductSaas).toHaveBeenCalledWith('raytone', 'model_access_changed');
  });

  it('does not include creditMultiplier in update data when not provided', async () => {
    const { service, repo, tx } = buildService();
    repo.findPlansByIds.mockResolvedValue([]);

    await service.batchUpdateModelAccess([{ planId: 'free', model: 'gpt-4', isActive: true }]);

    const callArg = tx.modelAccess.upsert.mock.calls[0][0];
    expect(callArg.update.creditMultiplier).toBeUndefined();
    expect(callArg.create.creditMultiplier).toBeUndefined();
  });

  it('已上架自营套餐移除全部启用模型被拒(active 绑定守卫)', async () => {
    const { service, repo, tx } = buildService();
    repo.findPlansByIds.mockResolvedValue([]);
    // 该 plan 为已上架自营(features 非转售)，变更后 0 启用模型 → 守卫拒绝
    tx.plan.findUnique.mockResolvedValue({
      isActive: true,
      features: '[]',
      product: { billingMode: 'CODING_PLAN' },
    });
    tx.modelAccess.count.mockResolvedValue(0);

    await expect(
      service.batchUpdateModelAccess([{ planId: 'cp1', model: 'gpt-4', isActive: false }]),
    ).rejects.toThrow(ConflictException);
  });

});

// ---------------------------------------------------------------------------
// model route policies
// ---------------------------------------------------------------------------
describe('ChannelAdminService.modelRoutePolicies', () => {
  it('delegates list to repository', async () => {
    const { service, repo } = buildService();
    repo.findModelRoutePolicies.mockResolvedValue([{ planId: 'free', routeKey: 'general' }]);

    await expect(service.listModelRoutePolicies()).resolves.toEqual([
      { planId: 'free', routeKey: 'general' },
    ]);
  });

  it('upserts route policies and notifies product webhook', async () => {
    const { service, repo, productSync } = buildService();
    repo.upsertModelRoutePolicy.mockResolvedValue({});
    repo.findPlansByIds.mockResolvedValue([{ productId: 'prod-1' }]);
    repo.findProductById.mockResolvedValue({ slug: 'raytone' });

    await service.batchUpdateModelRoutePolicies([
      {
        planId: 'free',
        routeKey: 'vision',
        primaryModel: 'kimi-k2.6',
        fallbackModels: ['glm-5.1', 'glm-5.1'],
        isActive: true,
      },
    ]);

    expect(repo.upsertModelRoutePolicy).toHaveBeenCalledWith('free', 'vision', {
      primaryModel: 'kimi-k2.6',
      fallbackModels: '["glm-5.1"]',
      isActive: true,
    });
    await new Promise((r) => setImmediate(r));
    expect(productSync.notifyProductSaas).toHaveBeenCalledWith('raytone', 'model_route_policy_changed');
  });
});

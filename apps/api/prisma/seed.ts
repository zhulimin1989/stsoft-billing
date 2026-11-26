import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/common/utils/crypto';

const prisma = new PrismaClient();

async function main() {
  // Guard against accidental production seeding. seed.ts writes dev users,
  // placeholder channels, and other test data that must not land in prod.
  // Override with SEED_ALLOW_PRODUCTION=true if you really mean it.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.SEED_ALLOW_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'seed.ts refuses to run in NODE_ENV=production. ' +
      'Set SEED_ALLOW_PRODUCTION=true to override, or (recommended) create ' +
      'Channels via the /admin/channels UI instead.',
    );
  }

  const admin = await prisma.user.upsert({
    where: { email: 'admin@iruidong.com' },
    update: { nickname: '管理员' },
    create: {
      email: 'admin@iruidong.com',
      nickname: '管理员',
    },
  });

  // 创建测试用户
  const testUser = await prisma.user.upsert({
    where: { email: 'test@iruidong.com' },
    update: { nickname: '测试用户' },
    create: {
      email: 'test@iruidong.com',
      nickname: '测试用户',
    },
  });

  // 创建 Raytone 产品
  const raytone = await prisma.product.upsert({
    where: { slug: 'raytone' },
    update: {
      name: 'Raytone',
      description: 'AI 编程助手 SaaS 平台',
      webhookUrl: process.env.RAYTONE_WEBHOOK_URL || null,
    },
    create: {
      name: 'Raytone',
      slug: 'raytone',
      description: 'AI 编程助手 SaaS 平台',
      webhookUrl: process.env.RAYTONE_WEBHOOK_URL || null,
      sortOrder: 1,
    },
  });

  // 创建套餐（关联到 Raytone 产品）
  const planDefs = [
    {
      id: 'free',
      productId: raytone.id,
      name: '体验版',
      description: '适合个人试用',
      planType: 'individual',
      monthlyPrice: 0,
      quarterlyPrice: 0,
      yearlyPrice: 0,
      billingPeriod: 'monthly',
      monthlyCredits: 100000,
      rateLimitRpm: 20,
      rateLimitTpm: 40000,
      maxContextWindow: 128000,

      memberLimit: 1,
      supportTier: 'community',
      features: JSON.stringify(['基础模型访问', '社区支持']),
      trialDays: 0,
      sortOrder: 1,
    },
    {
      id: 'pro',
      productId: raytone.id,
      name: '标准版',
      description: '适合轻度使用',
      planType: 'individual',
      monthlyPrice: 4900,
      quarterlyPrice: 4500,
      yearlyPrice: 3900,
      billingPeriod: 'monthly',
      monthlyCredits: 1000000,
      creditsRollover: true,
      rolloverMaxMonths: 3,
      rateLimitRpm: 60,
      rateLimitTpm: 100000,
      maxContextWindow: 200000,
      usageMultiplier: 1.0,

      memberLimit: 5,
      supportTier: 'standard',
      priorityAccess: true,
      badge: '最受欢迎',
      features: JSON.stringify(['全部模型访问', '优先支持', '高级分析']),
      trialDays: 7,
      sortOrder: 2,
    },
    {
      id: 'max',
      productId: raytone.id,
      name: '专业版',
      description: '适合重度使用',
      planType: 'team',
      monthlyPrice: 19900,
      quarterlyPrice: 17900,
      yearlyPrice: 15900,
      billingPeriod: 'monthly',
      monthlyCredits: 5000000,
      creditsRollover: true,
      rolloverMaxMonths: 6,
      rateLimitRpm: 120,
      rateLimitTpm: 500000,
      maxContextWindow: 200000,
      overageEnabled: true,
      usageMultiplier: 5.0,

      memberLimit: 20,
      minimumSeats: 3,
      dataTraining: 'never',
      supportTier: 'priority',
      ssoEnabled: true,
      priorityAccess: true,
      badge: '最佳性价比',
      features: JSON.stringify(['全部模型访问', '专属支持', '高级分析', 'API 优先级']),
      trialDays: 14,
      sortOrder: 3,
    },
  ];

  for (const plan of planDefs) {
    await prisma.plan.upsert({
      where: { id: plan.id },
      update: { ...plan },
      create: { ...plan },
    });
  }

  // ============================
  // Seed plan_prices（多币种定价）
  // 目前 seed USD；SGD 需要业务方填，见 PlanPrice 管理页
  // ============================
  for (const plan of planDefs) {
    // 跳过免费套餐（0 价格不需要币种化）
    if (plan.monthlyPrice === 0 && plan.quarterlyPrice === 0 && plan.yearlyPrice === 0) continue;

    await prisma.planPrice.upsert({
      where: { planId_currency: { planId: plan.id, currency: 'usd' } },
      update: {
        monthlyPrice: plan.monthlyPrice,
        quarterlyPrice: plan.quarterlyPrice,
        yearlyPrice: plan.yearlyPrice,
        isActive: true,
      },
      create: {
        planId: plan.id,
        currency: 'usd',
        monthlyPrice: plan.monthlyPrice,
        quarterlyPrice: plan.quarterlyPrice,
        yearlyPrice: plan.yearlyPrice,
        isActive: true,
      },
    });
  }

  // ============================
  // Seed ModelPricing — 基于 2026-04 生产实际定价
  // 单位：美元 / 1M tokens（inputPrice=0.6 表示 $0.60/M input tokens）
  // 新模型由 admin UI 手动添加，不需要更新此 seed
  // ============================
  const claudeRuntimeFeatures = JSON.stringify([
    'function_call',
    'function_tools',
    'streaming',
    'streaming_tools',
    'reasoning',
    'vision',
  ]);
  const codexRuntimeFeatures = JSON.stringify([
    'function_call',
    'function_tools',
    'streaming',
    'streaming_tools',
    'reasoning',
  ]);
  const modelPricingSeeds: Array<{
    modelName: string;
    inputPricePerMToken: number;
    outputPricePerMToken: number;
    provider?: string;
    modelType?: string;
    inputModalities?: string;
    outputModalities?: string;
    supportedFeatures?: string;
  }> = [
    { modelName: 'kimi-k2.5', inputPricePerMToken: 0.6, outputPricePerMToken: 3.0 },
    { modelName: 'claude-3-5-haiku-20241022', inputPricePerMToken: 1.0, outputPricePerMToken: 1.0 },
    { modelName: 'claude-3-7-sonnet-20250219', inputPricePerMToken: 3.0, outputPricePerMToken: 15.0 },
    { modelName: 'claude-haiku-4-5-20251001', inputPricePerMToken: 1.0, outputPricePerMToken: 5.0 },
    { modelName: 'claude-opus-4-1-20250805', inputPricePerMToken: 15.0, outputPricePerMToken: 75.0 },
    { modelName: 'claude-opus-4-20250514', inputPricePerMToken: 15.0, outputPricePerMToken: 75.0 },
    { modelName: 'claude-opus-4-5-20251101', inputPricePerMToken: 5.0, outputPricePerMToken: 25.0 },
    { modelName: 'claude-opus-4-6', inputPricePerMToken: 5.0, outputPricePerMToken: 25.0 },
    {
      modelName: 'claude-opus-4-7',
      inputPricePerMToken: 5.0,
      outputPricePerMToken: 25.0,
      provider: 'anthropic',
      modelType: 'chat',
      inputModalities: JSON.stringify(['text', 'image']),
      outputModalities: JSON.stringify(['text']),
      supportedFeatures: claudeRuntimeFeatures,
    },
    { modelName: 'claude-sonnet-4-20250514', inputPricePerMToken: 3.0, outputPricePerMToken: 15.0 },
    { modelName: 'claude-sonnet-4-5-20250929', inputPricePerMToken: 3.0, outputPricePerMToken: 15.0 },
    {
      modelName: 'claude-sonnet-4-6',
      inputPricePerMToken: 3.0,
      outputPricePerMToken: 15.0,
      provider: 'anthropic',
      modelType: 'chat',
      inputModalities: JSON.stringify(['text', 'image']),
      outputModalities: JSON.stringify(['text']),
      supportedFeatures: claudeRuntimeFeatures,
    },
    {
      modelName: 'gpt-5.3-codex',
      inputPricePerMToken: 1.25,
      outputPricePerMToken: 10.0,
      provider: 'openai',
      modelType: 'chat',
      inputModalities: JSON.stringify(['text']),
      outputModalities: JSON.stringify(['text']),
      supportedFeatures: codexRuntimeFeatures,
    },
  ];

  for (const pricing of modelPricingSeeds) {
    const catalogFields = {
      provider: pricing.provider,
      modelType: pricing.modelType,
      inputModalities: pricing.inputModalities,
      outputModalities: pricing.outputModalities,
      supportedFeatures: pricing.supportedFeatures,
    };
    await prisma.modelPricing.upsert({
      where: { modelName: pricing.modelName },
      update: {
        inputPricePerMToken: pricing.inputPricePerMToken,
        outputPricePerMToken: pricing.outputPricePerMToken,
        isActive: true,
        ...catalogFields,
      },
      create: {
        ...pricing,
        isActive: true,
      },
    });
  }

  // Channel seeds (ADR-024) — dev only.
  // Keys sourced from SHENHOME_*_KEY env vars; if unset or empty, we seed
  // placeholder entries marked inactive so dev startup doesn't fail AND
  // the gateway won't route to a channel with an empty Bearer token.
  // Production: admins create channels via /admin/channels UI.
  //
  // Encryption parity with admin create path: if ENCRYPTION_KEY is set,
  // apiKey is AES-256-GCM encrypted before write (matches ChannelService.create).
  const encryptionKeyHex = (process.env.ENCRYPTION_KEY ?? '').trim();
  const maybeEncrypt = (plaintext: string): string =>
    encryptionKeyHex ? encrypt(plaintext, encryptionKeyHex) : plaintext;

  const channelSeeds: Array<{
    name: string;
    provider: string;
    baseUrl: string;
    rawKey: string | undefined; // pre-encryption; empty/undefined -> placeholder
    models: string[];
    sdkType: string;
    priority: number;
    remark: string;
  }> = [
    {
      name: 'shenhome-claude',
      provider: 'claude',
      baseUrl: 'http://18.141.203.177:8080',
      rawKey: process.env.SHENHOME_CLAUDE_KEY,
      models: [
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5-20250929',
      ],
      sdkType: 'anthropic',
      priority: 5,
      remark: 'shenhome Sub2API claude 分组 (ADR-024)',
    },
    {
      name: 'shenhome-glm',
      provider: 'glm',
      baseUrl: 'http://18.141.203.177:8080',
      rawKey: process.env.SHENHOME_GLM_KEY,
      models: ['glm-4.6', 'glm-5', 'glm-5.1', 'glm-5-turbo'],
      sdkType: 'glm',
      priority: 5,
      remark: 'shenhome Sub2API glm 分组 (ADR-024)',
    },
    {
      name: 'shenhome-codex',
      provider: 'openai',
      baseUrl: 'http://18.141.203.177:8080',
      rawKey: process.env.SHENHOME_CODEX_KEY,
      models: ['gpt-5.3-codex'],
      sdkType: 'openai_responses',
      priority: 5,
      remark: 'shenhome Sub2API openai 分组 (ChatGPT Codex 账号, 仅 codex 模型可用)',
    },
  ];

  for (const seed of channelSeeds) {
    // Treat undefined AND empty string as "no key configured" — avoids
    // creating an active channel with empty Bearer token.
    const trimmedKey = (seed.rawKey ?? '').trim();
    const hasRealKey = trimmedKey.length > 0;
    const apiKeyStored = hasRealKey
      ? maybeEncrypt(trimmedKey)
      : `DEV_PLACEHOLDER_SET_${seed.name.toUpperCase().replace(/-/g, '_')}_KEY`;

    // name is not @unique in schema, use findFirst + create for idempotency
    const existing = await prisma.channel.findFirst({ where: { name: seed.name } });
    if (!existing) {
      await prisma.channel.create({
        data: {
          name: seed.name,
          provider: seed.provider,
          baseUrl: seed.baseUrl,
          apiKey: apiKeyStored,
          models: JSON.stringify(seed.models),
          sdkType: seed.sdkType,
          priority: seed.priority,
          weight: 1,
          status: 'active',
          isActive: hasRealKey, // placeholder / empty -> disabled
          remark: seed.remark,
        },
      });
    } else {
      await prisma.channel.update({
        where: { id: existing.id },
        data: {
          provider: seed.provider,
          baseUrl: seed.baseUrl,
          models: JSON.stringify(seed.models),
          sdkType: seed.sdkType,
          priority: seed.priority,
          remark: seed.remark,
        },
      });
    }
  }

  const planCount = await prisma.plan.count();
  const channelCount = await prisma.channel.count();
  console.log('Seed complete:', {
    admin: admin.email,
    user: testUser.email,
    product: raytone.slug,
    plans: planCount,
    modelPricing: modelPricingSeeds.length,
    channels: channelCount,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

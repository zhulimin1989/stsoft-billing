import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ModelPricingService } from './model-pricing.service';
import { CreditPricingService } from './credit-pricing.service';

/**
 * 集成测试：使用真实 DB + Redis。
 *
 * 默认跳过（本地开发不依赖 Docker）。
 * 在测试环境或 CI 上通过 TEST_INTEGRATION=1 激活：
 *   TEST_INTEGRATION=1 pnpm test --testPathPattern=credit-pricing.integration
 *
 * 运行前确保 PG + Redis 可达（通过环境变量 DATABASE_URL / REDIS_HOST / REDIS_PORT）。
 * 测试环境由 .env.test 或环境变量配置。
 *
 * ⚠️ 测试 Redis 必须是隔离实例（独占 DB 或独立部署），不可与其他业务共用。
 * beforeEach 用 KEYS 命令清缓存，在大 keyspace 或生产共享实例上会阻塞 Redis。
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

maybeDescribe('CreditPricingService (integration)', () => {
  let service: CreditPricingService;
  let prisma: PrismaService;
  let redis: RedisService;

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          // 优先读 .env.test，不存在时回退到进程环境变量
          envFilePath: ['.env.test', '.env'],
          ignoreEnvFile: false,
        }),
      ],
      providers: [PrismaService, RedisService, ModelPricingService, CreditPricingService],
    }).compile();

    service = m.get(CreditPricingService);
    prisma = m.get(PrismaService);
    redis = m.get(RedisService);

    // NestJS 测试模块不自动触发 OnModuleInit，手动连接 Prisma
    await prisma.$connect();

    // 幂等确保 kimi-k2.5 定价存在（生产 bug 复现所需）
    // inputPricePerMToken=0.6, outputPricePerMToken=3.0（单位：美元/M tokens）
    await prisma.modelPricing.upsert({
      where: { modelName: 'kimi-k2.5' },
      update: {
        inputPricePerMToken: 0.6,
        outputPricePerMToken: 3,
        isActive: true,
      },
      create: {
        modelName: 'kimi-k2.5',
        inputPricePerMToken: 0.6,
        outputPricePerMToken: 3,
        isActive: true,
      },
    });
  });

  beforeEach(async () => {
    // 清缓存避免 case 间污染。
    // RedisService 继承自 ioredis.Redis，keys() 和 del() 是原生方法，直接调用。
    const cachedCreditKeys = await redis.keys('credit_mult:*');
    for (const key of cachedCreditKeys) {
      await redis.del(key);
    }

    const cachedPricingKeys = await redis.keys('modelpricing:*');
    for (const key of cachedPricingKeys) {
      await redis.del(key);
    }
  });

  afterAll(async () => {
    // 断开 Prisma 连接（PrismaService.onModuleDestroy 里也有 $disconnect，但测试里要手动调）
    // 清理错误吞掉避免 Jest timeout hang（集成测试，非生产代码）
    await prisma.$disconnect().catch(() => {});
    // 断开 Redis 连接（RedisService.onModuleDestroy 调用 quit()，测试里手动）
    await redis.quit().catch(() => {});
  });

  it('production bug reproduction: kimi-k2.5 20159/110 tokens × 5x → 7 credits', async () => {
    // 公式：ceil((20159 * 60 + 110 * 300) / 1_000_000 * 1.0 * 5.0)
    //      = ceil((1209540 + 33000) / 1_000_000 * 5.0)
    //      = ceil(1242540 / 1_000_000 * 5.0)
    //      = ceil(1.24254 * 5.0)
    //      = ceil(6.2127)
    //      = 7
    // 'nonexistent-plan' → modelAccess 找不到记录 → creditMultiplier fallback 为 1.0
    const cost = await service.calculateCreditCost(
      'nonexistent-plan', 'kimi-k2.5', 20159, 110, 5.0,
    );
    expect(cost).toBe(7);
  });

  it('returns 0 for 0 tokens even with 5x multiplier', async () => {
    const cost = await service.calculateCreditCost(
      'nonexistent-plan', 'kimi-k2.5', 0, 0, 5.0,
    );
    expect(cost).toBe(0);
  });

  it('throws when model not in ModelPricing', async () => {
    await expect(
      service.calculateCreditCost('nonexistent-plan', 'nonexistent-model-xyz', 100, 100, 1.0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

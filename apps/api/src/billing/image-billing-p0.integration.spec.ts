import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { GatewayRequestEventBillingService } from './gateway-request-event-billing.service';
import { ModelPricingService } from './model-pricing.service';
import { ProviderCostPricingService } from './provider-cost-pricing.service';
import { UsageBillingStrategyService } from './usage-billing-strategy.service';

const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

maybeDescribe('image billing P0 realistic pipeline (integration)', () => {
  let prisma: PrismaService;
  let redis: RedisService;
  let gatewayBilling: GatewayRequestEventBillingService;

  beforeAll(async () => {
    const config = new ConfigService();
    prisma = new PrismaService(config);
    redis = new RedisService(config);
    await Promise.all([prisma.$connect(), redis.ping()]);

    const [database] = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    const expectedDatabase = process.env.TEST_DATABASE_NAME;
    if (!expectedDatabase || database?.name !== expectedDatabase) {
      throw new Error(
        `integration test requires isolated TEST_DATABASE_NAME=${expectedDatabase ?? '<missing>'}; ` +
        `connected=${database?.name ?? '<unknown>'}`,
      );
    }

    const creditPolicy = {
      resolvePolicyForUser: jest.fn().mockResolvedValue({
        allowOverdraft: false,
        creditLimitCents: 0,
      }),
    };
    const billingService = new BillingService(
      new BillingRepository(prisma),
      redis,
      prisma,
      creditPolicy as never,
    );
    const modelPricingService = new ModelPricingService(prisma, redis);
    const usageBilling = new UsageBillingStrategyService(
      prisma,
      redis,
      billingService,
      {} as never,
      {} as never,
      modelPricingService,
      new ProviderCostPricingService(prisma, modelPricingService),
      {} as never,
      creditPolicy as never,
      undefined,
      config,
    );
    const publisherSync = {
      syncBillingAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceByIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    gatewayBilling = new GatewayRequestEventBillingService(
      usageBilling,
      prisma,
      config,
      undefined,
      publisherSync as never,
    );
  }, 15_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
  }, 10_000);

  it('persists an image line and debits the real wallet from a synthetic Gateway UsageEvent', async () => {
    const suffix = randomUUID();
    const userId = `image-p0-user-${suffix}`;
    const tenantId = `image-p0-tenant-${suffix}`;
    const billingAccountId = `image-p0-account-${suffix}`;
    const productId = `image-p0-product-${suffix}`;
    const apiKeyId = `image-p0-key-${suffix}`;
    const requestId = `image-p0-request-${suffix}`;
    const logicalModel = `cogview-p0-synthetic-${suffix}`;

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        nickname: 'Image Billing P0 Integration',
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.billingAccount.create({
        data: {
          id: billingAccountId,
          type: 'personal',
          name: 'Image Billing P0 Integration',
          ownerUserId: userId,
          status: 'active',
          currency: 'USD',
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(),
        },
      });
      await tx.tenant.create({
        data: {
          id: tenantId,
          name: 'Image Billing P0 Integration',
          type: 'personal',
          status: 'active',
          ownerUserId: userId,
          billingAccountId,
          balanceAllowanceUsedUsd: new Prisma.Decimal(0),
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { currentTenantId: tenantId },
      });
      await tx.tenantMember.create({
        data: {
          id: `image-p0-tenant-member-${suffix}`,
          tenantId,
          userId,
          role: 'owner',
          status: 'active',
        },
      });
      await tx.billingAccountMember.create({
        data: {
          id: `image-p0-account-member-${suffix}`,
          billingAccountId,
          userId,
          role: 'owner',
          status: 'active',
        },
      });
      await tx.accountWallet.create({
        data: { billingAccountId, balanceUsd: new Prisma.Decimal(0) },
      });
    });
    await prisma.product.create({
      data: {
        id: productId,
        name: 'Image Billing P0 Integration PAYG',
        slug: `image-p0-${suffix}`,
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
      },
    });
    await prisma.apiKey.create({
      data: {
        id: apiKeyId,
        userId,
        tenantId,
        productId,
        name: 'Image Billing P0 Integration Key',
        prefix: 'sk-image-p0',
        keyHash: `image-p0-hash-${suffix}`,
        isActive: true,
        mirrorStatus: 'ACTIVE',
      },
    });
    await prisma.modelPricing.create({
      data: {
        modelName: logicalModel,
        provider: 'zhipu',
        modelType: 'image',
        pricingUnit: 'image',
        // Synthetic USD configuration for this isolated acceptance test only.
        unitPriceUsd: new Prisma.Decimal('0.06'),
        inputPricePerMToken: new Prisma.Decimal(0),
        outputPricePerMToken: new Prisma.Decimal(0),
        isActive: true,
      },
    });

    const funding = new BillingService(
      new BillingRepository(prisma),
      redis,
      prisma,
    );
    await funding.adminRecharge(
      userId,
      1000,
      'image billing P0 integration funding',
      undefined,
      {
        tenantId,
        idempotencyKey: `image-p0-funding-${suffix}`,
      },
    );

    const walletBefore = await prisma.accountWallet.findUniqueOrThrow({
      where: { billingAccountId },
    });
    const occurredAt = new Date();
    const event = {
      version: 'v2',
      event_type: 'usage',
      event_id: `image-p0-event-${suffix}`,
      request_id: requestId,
      occurred_at: occurredAt.toISOString(),
      key_id: apiKeyId,
      tenant_id: tenantId,
      logical_model: logicalModel,
      model: logicalModel,
      provider: 'zhipu',
      resolved_api_type: 'openai',
      upstream_model: 'cogview-4',
      call_type: 'image_generation',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      token_source: 'image_count',
      token_extras: { image_count: 1 },
      status: 'success',
      status_code: 200,
      quota_settlement: 'settled',
      labels: {
        tenant_id: tenantId,
        user_id: userId,
        'usr.product_id': productId,
        'usr.product_slug': `image-p0-${suffix}`,
        region: 'integration',
      },
      error: null,
    };
    const result = await gatewayBilling.process(event);
    const replay = await gatewayBilling.process(event);

    const [gatewayRow, usageRow, walletAfter, usageRowCount] = await Promise.all([
      prisma.gatewayBillingEvent.findUniqueOrThrow({ where: { requestId } }),
      prisma.tokenUsage.findUniqueOrThrow({ where: { requestId } }),
      prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId } }),
      prisma.tokenUsage.count({ where: { requestId } }),
    ]);
    const [balanceRow, balanceRowCount] = await Promise.all([
      prisma.balanceTransaction.findUniqueOrThrow({
        where: { tokenUsageId: usageRow.id },
      }),
      prisma.balanceTransaction.count({ where: { tokenUsageId: usageRow.id } }),
    ]);

    expect(result.action).toBe('deducted');
    expect(replay.action).toBe('deducted');
    expect(gatewayRow.status).toBe('DEDUCTED');
    expect(gatewayRow.reason).toBeNull();
    expect(gatewayRow.billingResult).toMatchObject({
      success: true,
      unit: 'BALANCE',
      quote: {
        effectiveCostUsd: '0.06',
        lineItems: [{
          meter: 'image',
          quantity: 1,
          unitPriceUsd: '0.06',
          amountUsd: '0.06',
        }],
      },
    });
    expect(usageRow).toMatchObject({
      meter: 'image',
      quantity: 1,
      callType: 'image_generation',
      upstreamModel: 'cogview-4',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      providerCostEstimateUsd: null,
    });
    expect(usageRow.unitPriceUsd?.toString()).toBe('0.06');
    expect(usageRow.customerChargeUsd.toString()).toBe('0.06');
    expect(balanceRow.type).toBe('CONSUME');
    expect(balanceRow.amountUsd.toString()).toBe('-0.06');
    expect(walletBefore.balanceUsd.toString()).toBe('10');
    expect(walletAfter.balanceUsd.toString()).toBe('9.94');
    expect(walletBefore.balanceUsd.minus(walletAfter.balanceUsd).toString()).toBe('0.06');
    expect(usageRowCount).toBe(1);
    expect(balanceRowCount).toBe(1);

    process.stdout.write(`${JSON.stringify({
      evidence: 'IMAGE_BILLING_P0_SYNTHETIC_E2E',
      pricing: {
        currency: 'USD',
        synthetic: true,
        pricingUnit: 'image',
        unitPriceUsd: '0.06',
      },
      gatewayBillingEvent: {
        requestId: gatewayRow.requestId,
        status: gatewayRow.status,
        billingResult: gatewayRow.billingResult,
      },
      tokenUsageLine: {
        requestId: usageRow.requestId,
        meter: usageRow.meter,
        quantity: usageRow.quantity,
        unitPriceUsd: usageRow.unitPriceUsd?.toString() ?? null,
        amountUsd: usageRow.customerChargeUsd.toString(),
        callType: usageRow.callType,
        upstreamModel: usageRow.upstreamModel,
        providerCostEstimateUsd: usageRow.providerCostEstimateUsd?.toString() ?? null,
      },
      balanceTransaction: {
        id: balanceRow.id,
        type: balanceRow.type,
        amountUsd: balanceRow.amountUsd.toString(),
        balanceAfterUsd: balanceRow.balanceAfterUsd.toString(),
      },
      wallet: {
        beforeUsd: walletBefore.balanceUsd.toString(),
        afterUsd: walletAfter.balanceUsd.toString(),
        deductedUsd: walletBefore.balanceUsd.minus(walletAfter.balanceUsd).toString(),
      },
      idempotentReplay: {
        action: replay.action,
        tokenUsageRows: usageRowCount,
        balanceTransactionRows: balanceRowCount,
        walletAfterReplayUsd: walletAfter.balanceUsd.toString(),
      },
    })}\n`);
  }, 30_000);
});

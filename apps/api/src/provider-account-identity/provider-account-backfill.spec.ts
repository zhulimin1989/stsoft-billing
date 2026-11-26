import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  runBackfill,
} from '../../scripts/backfill-provider-account-identities';
import { requireBillingDatabaseUrl } from '../prisma/prisma.service';

describe('provider account identity backfill', () => {
  let tempDir: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'provider-account-backfill-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires BILLING_DATABASE_URL even when DATABASE_URL is present', () => {
    expect(() => requireBillingDatabaseUrl({
      DATABASE_URL: 'postgresql://wrong-default',
    })).toThrow('BILLING_DATABASE_URL is required');
    expect(requireBillingDatabaseUrl({
      BILLING_DATABASE_URL: '  postgresql://billing-authority  ',
      DATABASE_URL: 'postgresql://wrong-default',
    })).toBe('postgresql://billing-authority');
  });

  it('validates and dry-runs a provider-line binding with canonical provider ownership', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [{ id: 'line-1', providerAccountRef: 'pa_kimi' }],
      codingPlanProviderEntitlements: [],
    });
    const prisma = fakePrisma({
      providerLine: {
        id: 'line-1',
        providerCode: 'moonshot',
        apiBaseUrl: 'https://api.moonshot.cn',
        partnerCodeEncrypted: 'encrypted-code',
        partnerSecretEncrypted: 'encrypted-secret',
        providerAccountIdentityId: null,
        providerAccountIdentity: null,
      },
    });

    await runBackfill(prisma.client, [`--mapping=${mappingPath}`]);

    expect(prisma.codingPlanProviderLine.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['line-1'] } },
      select: expect.objectContaining({
        providerCode: true,
        providerAccountIdentityId: true,
        providerAccountIdentity: {
          select: { ref: true, providerCode: true, status: true },
        },
      }),
    }));
    expect(prisma.transaction).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"provider": "kimi"'));
  });

  it('updates provider-line bindings inside the apply transaction', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [{ id: 'line-1', providerAccountRef: 'pa_kimi' }],
      codingPlanProviderEntitlements: [],
    });
    const prisma = fakePrisma({
      providerLine: {
        id: 'line-1',
        providerCode: 'kimi',
        apiBaseUrl: 'https://api.moonshot.cn',
        partnerCodeEncrypted: null,
        partnerSecretEncrypted: null,
        providerAccountIdentityId: null,
        providerAccountIdentity: null,
      },
    });

    await runBackfill(prisma.client, [`--mapping=${mappingPath}`, '--apply']);

    expect(prisma.transaction).toHaveBeenCalledTimes(1);
    expect(prisma.providerLineUpdate).toHaveBeenCalledWith({
      where: { id: 'line-1', providerAccountIdentityId: null },
      data: { providerAccountIdentityId: 'identity-1' },
    });
  });

  it('refuses to overwrite an existing provider-line identity binding', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [{ id: 'line-1', providerAccountRef: 'pa_kimi' }],
      codingPlanProviderEntitlements: [],
    });
    const prisma = fakePrisma({
      providerLine: {
        id: 'line-1',
        providerCode: 'kimi',
        apiBaseUrl: 'https://api.moonshot.cn',
        partnerCodeEncrypted: null,
        partnerSecretEncrypted: null,
        providerAccountIdentityId: 'another-identity',
        providerAccountIdentity: null,
      },
    });

    await expect(runBackfill(
      prisma.client,
      [`--mapping=${mappingPath}`, '--apply'],
    )).rejects.toThrow('拒绝覆盖');
    expect(prisma.transaction).not.toHaveBeenCalled();
  });

  it('rejects a provider-line binding to an inactive identity', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [{ id: 'line-1', providerAccountRef: 'pa_kimi' }],
      codingPlanProviderEntitlements: [],
    });
    const prisma = fakePrisma({
      identity: {
        id: 'identity-1',
        ref: 'pa_kimi',
        providerCode: 'kimi',
        status: 'inactive',
      },
      providerLine: {
        id: 'line-1',
        providerCode: 'kimi',
        apiBaseUrl: 'https://api.moonshot.cn',
        partnerCodeEncrypted: null,
        partnerSecretEncrypted: null,
        providerAccountIdentityId: null,
        providerAccountIdentity: null,
      },
    });

    await expect(runBackfill(
      prisma.client,
      [`--mapping=${mappingPath}`, '--apply'],
    )).rejects.toThrow('已停用');
    expect(prisma.transaction).not.toHaveBeenCalled();
  });

  it('binds an entitlement only to the identity selected by its provider line', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [],
      codingPlanProviderEntitlements: [{
        id: 'entitlement-1',
        providerAccountRef: 'pa_kimi',
      }],
    });
    const prisma = fakePrisma({
      providerLine: providerLineFixture('identity-1'),
      providerEntitlement: providerEntitlementFixture('identity-1'),
    });

    await runBackfill(prisma.client, [`--mapping=${mappingPath}`, '--apply']);

    expect(prisma.entitlementUpdate).toHaveBeenCalledWith({
      where: { id: 'entitlement-1', providerAccountIdentityId: null },
      data: { providerAccountIdentityId: 'identity-1' },
    });
  });

  it('rejects an entitlement mapping that differs from its provider-line identity', async () => {
    const mappingPath = writeMapping({
      channels: [],
      codingPlanProviderLines: [],
      codingPlanProviderEntitlements: [{
        id: 'entitlement-1',
        providerAccountRef: 'pa_kimi',
      }],
    });
    const prisma = fakePrisma({
      providerLine: providerLineFixture('identity-other'),
      providerEntitlement: providerEntitlementFixture('identity-other'),
    });

    await expect(runBackfill(
      prisma.client,
      [`--mapping=${mappingPath}`, '--apply'],
    )).rejects.toThrow('Provider Entitlement 的账户身份与供应商线路不一致');
    expect(prisma.transaction).not.toHaveBeenCalled();
  });

  function writeMapping(mapping: Record<string, unknown>): string {
    const path = join(tempDir, 'mapping.json');
    writeFileSync(path, JSON.stringify(mapping), 'utf8');
    return path;
  }
});

function fakePrisma(input: {
  providerLine: Record<string, unknown>;
  providerEntitlement?: Record<string, unknown>;
  identity?: Record<string, unknown>;
}) {
  const channelUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const providerLineUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const entitlementUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    channel: { updateMany: channelUpdate },
    codingPlanProviderLine: { updateMany: providerLineUpdate },
    codingPlanProviderEntitlement: { updateMany: entitlementUpdate },
  };
  const transaction = jest.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx));
  const delegates = {
    providerAccountIdentity: {
      findMany: jest.fn().mockResolvedValue([input.identity ?? {
        id: 'identity-1',
        ref: 'pa_kimi',
        providerCode: 'kimi',
        status: 'active',
      }]),
    },
    channel: { findMany: jest.fn().mockResolvedValue([]) },
    codingPlanProviderLine: { findMany: jest.fn().mockResolvedValue([input.providerLine]) },
    codingPlanProviderEntitlement: {
      findMany: jest.fn().mockResolvedValue(
        input.providerEntitlement ? [input.providerEntitlement] : [],
      ),
    },
    $transaction: transaction,
  };
  return {
    client: delegates as unknown as PrismaClient,
    codingPlanProviderLine: delegates.codingPlanProviderLine,
    providerLineUpdate,
    entitlementUpdate,
    transaction,
  };
}

function providerLineFixture(providerAccountIdentityId: string) {
  return {
    id: 'line-1',
    providerCode: 'kimi',
    apiBaseUrl: 'https://api.moonshot.cn',
    partnerCodeEncrypted: null,
    partnerSecretEncrypted: null,
    providerAccountIdentityId,
    providerAccountIdentity: null,
  };
}

function providerEntitlementFixture(providerLineIdentityId: string) {
  return {
    id: 'entitlement-1',
    provider: 'kimi',
    providerCode: 'kimi',
    providerLineId: 'line-1',
    providerLine: {
      providerCode: 'kimi',
      providerAccountIdentityId: providerLineIdentityId,
    },
    upstreamApiKeyEncrypted: 'encrypted-api-key',
    upstreamSecretKeyEncrypted: 'encrypted-secret-key',
    providerAccountIdentityId: null,
    providerAccountIdentity: null,
  };
}

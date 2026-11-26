import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
  DEDICATED_PROVIDER_LINE_ACCOUNT_SOURCE_SELECT,
  requireProviderAccountRef,
  resolveDedicatedProviderCode,
  validateDedicatedProviderAccountIdentityInheritance,
  validateProviderAccountIdentityForProvider,
} from '../src/provider-account-identity/provider-account-identity.policy';
import { requireBillingDatabaseUrl } from '../src/prisma/prisma.service';

type MappingEntry = {
  id: string;
  providerAccountRef: string;
};

type BackfillMapping = {
  channels: MappingEntry[];
  codingPlanProviderLines: MappingEntry[];
  codingPlanProviderEntitlements: MappingEntry[];
};

type PlannedBinding = {
  kind: 'channel' | 'coding_plan_provider_line' | 'coding_plan_provider_entitlement';
  id: string;
  provider: string;
  providerAccountRef: string;
  providerAccountIdentityId: string;
  action: 'bind' | 'already_bound';
};

export async function runBackfill(
  prisma: PrismaClient,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  const mapping = parseMapping(args.mappingPath);
  const entries = [
    ...mapping.channels.map((entry) => ({ ...entry, kind: 'channel' as const })),
    ...mapping.codingPlanProviderLines.map((entry) => ({
      ...entry,
      kind: 'coding_plan_provider_line' as const,
    })),
    ...mapping.codingPlanProviderEntitlements.map((entry) => ({
      ...entry,
      kind: 'coding_plan_provider_entitlement' as const,
    })),
  ];
  if (entries.length === 0) throw new Error('映射文件至少需要一条绑定记录');

  assertNoDuplicateTargets(entries);
  const refs = [...new Set(entries.map((entry) => requireProviderAccountRef(entry.providerAccountRef)))];
  const identities = await prisma.providerAccountIdentity.findMany({
    where: { ref: { in: refs } },
    select: { id: true, ref: true, providerCode: true, status: true },
  });
  const identitiesByRef = new Map(identities.map((identity) => [identity.ref, identity]));
  const missingRefs = refs.filter((ref) => !identitiesByRef.has(ref));
  if (missingRefs.length > 0) {
    throw new Error(`供应商账户身份不存在: ${missingRefs.join(', ')}`);
  }
  const plannedProviderLineIdentityIds = new Map(
    mapping.codingPlanProviderLines.map((entry) => [
      entry.id,
      identitiesByRef.get(entry.providerAccountRef)!.id,
    ]),
  );

  const [channels, providerLines, providerEntitlements] = await Promise.all([
    prisma.channel.findMany({
      where: {
        id: { in: mapping.channels.map((entry) => entry.id) },
        deletedAt: null,
      },
      select: {
        id: true,
        provider: true,
        apiKeyEncrypted: true,
        providerAccountIdentityId: true,
      },
    }),
    prisma.codingPlanProviderLine.findMany({
      where: { id: { in: mapping.codingPlanProviderLines.map((entry) => entry.id) } },
      select: {
        id: true,
        ...DEDICATED_PROVIDER_LINE_ACCOUNT_SOURCE_SELECT,
      },
    }),
    prisma.codingPlanProviderEntitlement.findMany({
      where: { id: { in: mapping.codingPlanProviderEntitlements.map((entry) => entry.id) } },
      select: {
        id: true,
        ...DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
        upstreamApiKeyEncrypted: true,
        upstreamSecretKeyEncrypted: true,
        providerAccountIdentityId: true,
      },
    }),
  ]);
  const channelsById = new Map(channels.map((record) => [record.id, record]));
  const providerLinesById = new Map(providerLines.map((record) => [record.id, record]));
  const entitlementsById = new Map(providerEntitlements.map((record) => [record.id, record]));

  const plan: PlannedBinding[] = [];
  for (const entry of entries) {
    const identity = identitiesByRef.get(entry.providerAccountRef)!;
    if (entry.kind === 'channel') {
      const channel = channelsById.get(entry.id);
      if (!channel) throw new Error(`Channel 不存在: ${entry.id}`);
      validateProviderAccountIdentityForProvider(identity, channel.provider, {
        forbiddenValues: [channel.id, channel.apiKeyEncrypted],
      });
      plan.push(plannedBinding(entry, channel.provider, identity, channel.providerAccountIdentityId));
      continue;
    }

    if (entry.kind === 'coding_plan_provider_line') {
      const providerLine = providerLinesById.get(entry.id);
      if (!providerLine) throw new Error(`CodingPlanProviderLine 不存在: ${entry.id}`);
      const provider = resolveDedicatedProviderCode({ providerLine });
      validateProviderAccountIdentityForProvider(identity, provider, {
        forbiddenValues: [
          providerLine.id,
          providerLine.providerCode,
          providerLine.apiBaseUrl,
          providerLine.partnerCodeEncrypted,
          providerLine.partnerSecretEncrypted,
        ],
      });
      plan.push(plannedBinding(
        entry,
        provider,
        identity,
        providerLine.providerAccountIdentityId,
      ));
      continue;
    }

    const entitlement = entitlementsById.get(entry.id);
    if (!entitlement) throw new Error(`CodingPlanProviderEntitlement 不存在: ${entry.id}`);
    const provider = resolveDedicatedProviderCode(entitlement);
    validateProviderAccountIdentityForProvider(identity, provider, {
      forbiddenValues: [
        entitlement.id,
        entitlement.upstreamApiKeyEncrypted,
        entitlement.upstreamSecretKeyEncrypted,
      ],
    });
    const providerLineIdentityId = plannedProviderLineIdentityIds.get(
      String(entitlement.providerLineId),
    ) ?? entitlement.providerLine?.providerAccountIdentityId;
    validateDedicatedProviderAccountIdentityInheritance({
      ...entitlement,
      providerAccountIdentityId: identity.id,
      providerLine: {
        ...entitlement.providerLine,
        providerAccountIdentityId: providerLineIdentityId,
      },
    });
    plan.push(plannedBinding(entry, provider, identity, entitlement.providerAccountIdentityId));
  }

  if (args.apply) {
    await prisma.$transaction(async (tx) => {
      for (const item of plan.filter((candidate) => candidate.action === 'bind')) {
        let updatedCount: number;
        if (item.kind === 'channel') {
          updatedCount = (await tx.channel.updateMany({
              where: { id: item.id, providerAccountIdentityId: null },
              data: { providerAccountIdentityId: item.providerAccountIdentityId },
            })).count;
        } else if (item.kind === 'coding_plan_provider_line') {
          updatedCount = (await tx.codingPlanProviderLine.updateMany({
            where: { id: item.id, providerAccountIdentityId: null },
            data: { providerAccountIdentityId: item.providerAccountIdentityId },
          })).count;
        } else {
          updatedCount = (await tx.codingPlanProviderEntitlement.updateMany({
              where: { id: item.id, providerAccountIdentityId: null },
              data: { providerAccountIdentityId: item.providerAccountIdentityId },
            })).count;
        }
        if (updatedCount !== 1) {
          throw new Error(`${item.kind} ${item.id} 的账户身份在回填期间发生变化，已回滚全部变更`);
        }
      }
    });
  }

  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    mapping: resolve(args.mappingPath),
    scanned: plan.length,
    toBind: plan.filter((item) => item.action === 'bind').length,
    alreadyBound: plan.filter((item) => item.action === 'already_bound').length,
    bindings: plan.map(({ providerAccountIdentityId: _privateId, ...safe }) => safe),
  }, null, 2));
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasourceUrl: requireBillingDatabaseUrl(),
  });
  try {
    await runBackfill(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

function parseArgs(argv: string[]): { mappingPath: string; apply: boolean } {
  let mappingPath = '';
  let apply = false;
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--mapping=')) {
      mappingPath = arg.slice('--mapping='.length).trim();
    } else {
      throw new Error(`不支持的参数: ${arg}`);
    }
  }
  if (!mappingPath) throw new Error('必须提供 --mapping=/absolute/path/provider-account-mapping.json');
  return { mappingPath, apply };
}

function parseMapping(path: string): BackfillMapping {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`无法读取映射文件: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error('映射文件根节点必须是对象');
  return {
    channels: parseEntries(raw.channels, 'channels'),
    codingPlanProviderLines: parseEntries(
      raw.codingPlanProviderLines,
      'codingPlanProviderLines',
    ),
    codingPlanProviderEntitlements: parseEntries(
      raw.codingPlanProviderEntitlements,
      'codingPlanProviderEntitlements',
    ),
  };
}

function parseEntries(value: unknown, field: string): MappingEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${field}[${index}] 必须是对象`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error(`${field}[${index}].id 为必填字符串`);
    return {
      id,
      providerAccountRef: requireProviderAccountRef(item.providerAccountRef),
    };
  });
}

function assertNoDuplicateTargets(
  entries: Array<MappingEntry & { kind: PlannedBinding['kind'] }>,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) throw new Error(`映射目标重复: ${key}`);
    seen.add(key);
  }
}

function plannedBinding(
  entry: MappingEntry & { kind: PlannedBinding['kind'] },
  provider: string,
  identity: { id: string; ref: string },
  existingIdentityId: string | null,
): PlannedBinding {
  if (existingIdentityId && existingIdentityId !== identity.id) {
    throw new Error(`${entry.kind} ${entry.id} 已绑定其他供应商账户身份，拒绝覆盖`);
  }
  return {
    kind: entry.kind,
    id: entry.id,
    provider,
    providerAccountRef: identity.ref,
    providerAccountIdentityId: identity.id,
    action: existingIdentityId === identity.id ? 'already_bound' : 'bind',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

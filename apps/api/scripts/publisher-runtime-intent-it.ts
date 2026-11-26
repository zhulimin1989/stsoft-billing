import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  loadGoldenFixture,
  validateRuntimeIntent,
} from '@raytone-lab/publisher-contracts';
import type { RuntimeIntent } from '@raytone-lab/publisher-contracts';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PublisherModule } from '../src/publisher/publisher.module';
import { PublisherSyncService } from '../src/publisher/publisher-sync.service';
import { RedisModule } from '../src/redis/redis.module';

type Mode =
  | 'dump'
  | 'post-valid'
  | 'post-invalid-enum'
  | 'post-no-route-graph';

type Source = 'db' | 'golden';

type Args = {
  mode: Mode;
  source: Source;
  out?: string;
  dryRun: boolean;
};

const DEFAULT_GOLDEN_FIXTURE = 'runtime_intent.channelized_shared_key.json';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    PublisherModule,
  ],
})
class PublisherRuntimeIntentToolModule {}

async function main(): Promise<void> {
  process.env.RUIDONG_SERVICE = process.env.RUIDONG_SERVICE || 'billing';
  process.env.PUBLISHER_SYNC_WORKER_ENABLED = process.env.PUBLISHER_SYNC_WORKER_ENABLED || 'false';

  const args = parseArgs(process.argv.slice(2));
  const intent = await loadIntent(args);
  mutateIntent(intent, args.mode);

  const locallyValid = validateRuntimeIntent(intent);
  const validation = {
    valid: locallyValid,
    errors: validationErrors(),
  };

  if (args.out) {
    writeJson(args.out, intent);
  }

  if (args.mode === 'dump') {
    console.log(JSON.stringify({
      mode: args.mode,
      source: args.source,
      dryRun: args.dryRun,
      validation,
      summary: summarizeIntent(intent),
      out: args.out ? resolve(args.out) : undefined,
      intent,
    }, null, 2));
    return;
  }

  if (!locallyValid && args.mode !== 'post-invalid-enum') {
    throw new Error(`RuntimeIntent failed local validation: ${validation.errors.join('; ')}`);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      mode: args.mode,
      source: args.source,
      dryRun: true,
      validation,
      summary: summarizeIntent(intent),
      out: args.out ? resolve(args.out) : undefined,
      intent,
    }, null, 2));
    return;
  }

  const response = await postIntent(intent, args.mode);
  console.log(JSON.stringify({
    mode: args.mode,
    source: args.source,
    dryRun: false,
    validation,
    request: {
      url: response.url,
      idempotencyKey: response.idempotencyKey,
    },
    response: {
      status: response.status,
      body: response.body,
      warnings: extractWarnings(response.body),
    },
    summary: summarizeIntent(intent),
    out: args.out ? resolve(args.out) : undefined,
  }, null, 2));
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | true> = {};
  for (const item of argv) {
    if (!item.startsWith('--')) {
      raw.mode = item;
      continue;
    }
    const [key, value] = item.slice(2).split('=', 2);
    raw[key] = value ?? true;
  }

  const mode = String(raw.mode ?? 'dump') as Mode;
  const modes: Mode[] = ['dump', 'post-valid', 'post-invalid-enum', 'post-no-route-graph'];
  if (!modes.includes(mode)) {
    throw new Error(`Unsupported --mode=${String(raw.mode)}. Expected one of: ${modes.join(', ')}`);
  }

  const source = String(raw.source ?? 'db') as Source;
  if (source !== 'db' && source !== 'golden') {
    throw new Error(`Unsupported --source=${String(raw.source)}. Expected db or golden`);
  }

  return {
    mode,
    source,
    out: typeof raw.out === 'string' ? raw.out : undefined,
    dryRun: raw['dry-run'] === true || raw.dryRun === true || raw.dry === true,
  };
}

async function loadIntent(args: Args): Promise<RuntimeIntent> {
  if (args.source === 'golden') {
    return structuredClone(loadGoldenFixture(DEFAULT_GOLDEN_FIXTURE)) as RuntimeIntent;
  }

  const app = await NestFactory.createApplicationContext(PublisherRuntimeIntentToolModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    return await app.get(PublisherSyncService).buildRuntimeIntent();
  } finally {
    await app.close();
  }
}

function mutateIntent(intent: RuntimeIntent, mode: Mode): void {
  if (mode === 'post-valid') {
    return;
  }

  if (mode === 'post-invalid-enum') {
    const endpoint = intent.provider_endpoints?.[0];
    if (!endpoint) throw new Error('Cannot mutate invalid enum: provider_endpoints is empty');
    endpoint.provider_profile = 'invalid_profile' as never;
    return;
  }

  if (mode === 'post-no-route-graph') {
    for (const policy of intent.product_policies ?? []) {
      delete policy.route_graph;
      delete policy.route_graph_required;
    }
  }
}

async function postIntent(intent: RuntimeIntent, mode: Mode): Promise<{
  url: string;
  idempotencyKey: string;
  status: number;
  body: unknown;
}> {
  const baseUrl = envValue('PUBLISHER_BASE_URL')?.replace(/\/+$/, '');
  const token = envValue('PUBLISHER_ADMIN_TOKEN') || envValue('PUBLISHER_OPS_TOKEN') || envValue('PUBLISHER_TOKEN');
  if (!baseUrl) throw new Error('PUBLISHER_BASE_URL is required for post modes');
  if (!token) throw new Error('PUBLISHER_ADMIN_TOKEN or PUBLISHER_OPS_TOKEN is required for post modes');

  const path = '/admin/api/v1/providers:from-intent';
  const url = `${baseUrl}${path}`;
  const idempotencyKey = runtimeIntentIdempotencyKey(mode, path, intent);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-ID': randomUUID(),
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(intent),
    signal: AbortSignal.timeout(Number(envValue('PUBLISHER_TIMEOUT_MS') ?? 10_000)),
  });
  const text = await response.text();
  return {
    url,
    idempotencyKey,
    status: response.status,
    body: parseJson(text),
  };
}

function runtimeIntentIdempotencyKey(mode: Mode, path: string, intent: RuntimeIntent): string {
  const base = envValue('PUBLISHER_INTENT_TEST_RUN_ID') || randomUUID();
  const digest = createHash('sha256')
    .update(JSON.stringify({
      mode,
      path,
      body: intent,
      base,
    }))
    .digest('hex')
    .slice(0, 32);
  return `rd:intent-it:${mode}:${base.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)}:${digest}`;
}

function summarizeIntent(intent: RuntimeIntent): Record<string, unknown> {
  const sharedCredentialGroups = new Map<string, string[]>();
  for (const credential of intent.provider_credentials ?? []) {
    const keyRef = credential.key_ref;
    if (!keyRef) continue;
    sharedCredentialGroups.set(keyRef, [
      ...(sharedCredentialGroups.get(keyRef) ?? []),
      credential.provider_id,
    ]);
  }

  return {
    schema_version: intent.schema_version,
    provider_endpoints: intent.provider_endpoints?.length ?? 0,
    provider_credentials: intent.provider_credentials?.length ?? 0,
    client_exposures: intent.client_exposures?.length ?? 0,
    model_routes: intent.model_routes?.length ?? 0,
    product_policies: intent.product_policies?.length ?? 0,
    route_graph_schema_versions: (intent.product_policies ?? [])
      .map((policy) => policy.route_graph?.schema_version ?? null),
    shared_credential_groups: Array.from(sharedCredentialGroups.entries())
      .filter(([, providers]) => providers.length > 1)
      .map(([keyRef, providers]) => ({
        key_ref: keyRef,
        provider_ids: providers,
      })),
  };
}

function validationErrors(): string[] {
  return (validateRuntimeIntent.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`);
}

function extractWarnings(value: unknown): unknown[] {
  const warnings: unknown[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase().includes('warning')) warnings.push(child);
      visit(child);
    }
  };
  visit(value);
  return warnings;
}

function writeJson(file: string, value: unknown): void {
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});

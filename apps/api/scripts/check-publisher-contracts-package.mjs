#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const expectedVersion = '3.4.0';
const packageName = '@raytone-lab/publisher-contracts';
const allowedDependencySpecs = [
  `^${expectedVersion}`,
  expectedVersion,
  `file:../../vendor/raytone-lab-publisher-contracts-${expectedVersion}.tgz`,
];
const requiredEnums = [
  'PROVIDER_PROFILES',
  'CLIENT_COMPATIBILITIES',
  'INBOUND_PROTOCOLS',
  'CAPABILITIES',
  'REQUEST_CONTRACTS',
  'OUTBOUND_PROTOCOLS',
  'TOKEN_COUNT_STRATEGIES',
  'AUTH_SCHEMES',
  'TRANSLATORS',
  'COMPAT_API_TYPES',
  'DEDICATED_PROTOCOL_CHANNELS',
  'LOSSY_TIERS',
];
const exactEnums = {
  DEDICATED_PROTOCOL_CHANNELS: ['passthrough', 'responses_to_chat', 'anthropic_to_chat'],
  LOSSY_TIERS: ['low', 'high'],
};
const requiredArkEnumValues = {
  PROVIDER_PROFILES: 'ark_video_native',
  INBOUND_PROTOCOLS: 'ark',
  CAPABILITIES: 'video_generation',
  REQUEST_CONTRACTS: 'ark_video_task_create',
  OUTBOUND_PROTOCOLS: 'ark',
  AUTH_SCHEMES: 'bearer',
  TRANSLATORS: 'passthrough',
  COMPAT_API_TYPES: 'ark',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const apiPackage = readJson(path.join(apiRoot, 'package.json'));
const actualDependency = apiPackage.dependencies?.[packageName];
if (!allowedDependencySpecs.includes(actualDependency)) {
  fail(`${packageName} must resolve to ${expectedVersion}; found ${actualDependency ?? '<missing>'}`);
}

const contracts = require(packageName);
if (contracts.contractVersion !== expectedVersion) {
  fail(`${packageName} contractVersion must be ${expectedVersion}; found ${contracts.contractVersion}`);
}
if (typeof contracts.validateRuntimeIntent !== 'function') {
  fail(`${packageName} must export validateRuntimeIntent`);
}
if (typeof contracts.loadGoldenFixture !== 'function') {
  fail(`${packageName} must export loadGoldenFixture`);
}
if (typeof contracts.validateProductRuntimePolicy !== 'function') {
  fail(`${packageName} must export validateProductRuntimePolicy`);
}
if (typeof contracts.validateProductPolicyDelete !== 'function') {
  fail(`${packageName} must export validateProductPolicyDelete`);
}
for (const enumName of requiredEnums) {
  if (!Array.isArray(contracts[enumName]) || contracts[enumName].length === 0) {
    fail(`${packageName} must export non-empty ${enumName}`);
  }
}
for (const [enumName, expectedValues] of Object.entries(exactEnums)) {
  if (JSON.stringify(contracts[enumName]) !== JSON.stringify(expectedValues)) {
    fail(`${packageName} ${enumName} must be ${JSON.stringify(expectedValues)}; found ${JSON.stringify(contracts[enumName])}`);
  }
}
for (const [enumName, expectedValue] of Object.entries(requiredArkEnumValues)) {
  if (!contracts[enumName].includes(expectedValue)) {
    fail(`${packageName} ${enumName} must include ${expectedValue}`);
  }
}

const removedLocalArtifacts = [
  'apps/api/scripts/generate-publisher-intent-types.mjs',
  'apps/api/src/publisher/publisher-intent.types.ts',
  'apps/api/src/publisher/generated/publisher-contracts.lock.json',
  'apps/api/src/publisher/generated/publisher-intent.generated.ts',
];
for (const artifact of removedLocalArtifacts) {
  if (existsSync(path.join(repoRoot, artifact))) {
    fail(`Local Publisher contract artifact must be removed: ${artifact}`);
  }
}

const fixture = {
  schema_version: 2,
  provider_endpoints: [{
    id: 'pc_fixture',
    provider_profile: 'openai_compatible',
    base_url: 'https://example.test/v1',
    status: 'active',
  }, {
    id: 'pc_dedicated_fixture',
    provider_profile: 'glm_coding',
    base_url: 'https://dedicated.example.test/v1',
    status: 'active',
    visibility: 'dedicated_only',
    credential_source: 'dedicated_upstream',
    allowed_route_kinds: ['dedicated_route'],
    owner_scope: { tenant_id: 'tenant_demo', product_id: 'prod_coding' },
  }],
  provider_credentials: [{
    provider_id: 'pc_fixture',
    key_ref: 'enc:local:fixture',
    provider_account_ref: 'pa_fixture',
    status: 'active',
  }],
  client_exposures: [{
    provider_id: 'pc_fixture',
    served_inbound_protocols: ['openai'],
    capabilities: ['chat'],
    token_count_strategy: 'unsupported',
  }],
  model_routes: [{
    logical_model: 'fixture-model',
    routes: [{
      provider_id: 'pc_fixture',
      upstream_model: 'fixture-model',
      status: 'active',
      priority: 1,
      weight: 100,
      capabilities: ['chat'],
    }],
  }],
  product_policies: [{
    product_id: 'prod_fixture',
    revision: 1,
    product_slug: 'fixture',
    status: 'active',
    credential_source: 'keypool',
    model_scope_mode: 'plan_configured',
    fallback_policy: 'none',
    billing_mode: 'payg_balance',
    allow_high_loss_bridge_when_no_native: false,
    allow_bridge_on_native_failure: false,
    allowed_provider_ids: ['pc_fixture'],
    allowed_channel_ids: ['channel_fixture'],
    allowed_models: ['fixture-model'],
    route_graph: {
      schema_version: 1,
      default_target: {
        target_type: 'PRODUCT_CHANNEL',
        target_id: 'pc_fixture',
      },
      groups: [],
      product_channels: [{
        id: 'pc_fixture',
        channel_id: 'channel_fixture',
        provider_id: 'pc_fixture',
        allowed_models: ['fixture-model'],
        denied_models: [],
        priority: 1,
        weight: 100,
        status: 'active',
      }],
      assignments: [],
    },
  }],
};

if (!contracts.validateRuntimeIntent(fixture)) {
  fail(`RuntimeIntent fixture failed ${packageName} validation: ${JSON.stringify(contracts.validateRuntimeIntent.errors)}`);
}

const productRuntimePolicyFixture = {
  schema_version: 1,
  product_id: 'prod_fixture',
  product_slug: 'fixture',
  status: 'active',
  credential_source: 'keypool',
  allowed_provider_ids: ['pc_fixture'],
  allowed_channel_ids: ['channel_fixture'],
  allowed_provider_profiles: ['openai_compatible'],
  model_scope_mode: 'plan_configured',
  allowed_models: ['fixture-model'],
  fallback_policy: 'none',
  billing_mode: 'payg_balance',
  allow_high_loss_bridge_when_no_native: false,
  allow_bridge_on_native_failure: false,
  revision: 1,
};

if (!contracts.validateProductRuntimePolicy(productRuntimePolicyFixture)) {
  fail(`ProductRuntimePolicy fixture failed ${packageName} validation: ${JSON.stringify(contracts.validateProductRuntimePolicy.errors)}`);
}

const productPolicyDeleteFixture = {
  product_id: 'prod_fixture',
  revision: 2,
};
if (!contracts.validateProductPolicyDelete(productPolicyDeleteFixture)) {
  fail(`ProductPolicyDelete fixture failed ${packageName} validation: ${JSON.stringify(contracts.validateProductPolicyDelete.errors)}`);
}

const golden = contracts.loadGoldenFixture('runtime_intent.channelized_shared_key.json');
if (!contracts.validateRuntimeIntent(golden)) {
  fail(`RuntimeIntent golden failed ${packageName} validation: ${JSON.stringify(contracts.validateRuntimeIntent.errors)}`);
}

console.log(`${packageName}@${expectedVersion} contract gate passed`);

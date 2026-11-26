#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const baselinePath = path.join(scriptDir, 'capability-axis-freeze.baseline.json');

const baseline = readJSON(baselinePath);

const modelConfigsSource = readFile('apps/api/src/channel/model-configs.ts');
const publisherTypesSource = readFile('apps/api/src/publisher/publisher.types.ts');
const prismaSchema = readFile('apps/api/prisma/schema.prisma');

const perModelConfigBlock = extractBraceBlock(modelConfigsSource, 'export interface PerModelConfig');
const routePolicyBlock = extractBraceBlock(publisherTypesSource, 'export interface PublisherRoutePolicyConfig');

const current = {
  model_config_axis_fields: topLevelTypeProperties(perModelConfigBlock)
    .filter((name) => /capabilit|feature|param|profile|policy/i.test(name)),
  capability_override_fields: capabilityOverrideFields(perModelConfigBlock),
  publisher_route_policy_axis_fields: topLevelTypeProperties(routePolicyBlock)
    .filter((name) => /capabilit|param|feature|profile/i.test(name)),
  prisma_capability_axis_fields: prismaCapabilityAxisFields(prismaSchema),
};

assertReviewMarker(baseline);
for (const field of Object.keys(current).sort()) {
  assertSameSet(field, current[field], baseline[field] ?? []);
}

console.log('capability axis freeze OK');
for (const field of Object.keys(current).sort()) {
  console.log(`${field}: ${current[field].sort().join(', ')}`);
}

function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function fail(message) {
  console.error(`capability axis freeze breach: ${message}`);
  process.exit(1);
}

function extractBraceBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) fail(`missing marker ${marker}`);
  const open = source.indexOf('{', markerIndex);
  if (open < 0) fail(`missing opening brace after ${marker}`);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  fail(`missing closing brace after ${marker}`);
}

function topLevelTypeProperties(block) {
  const names = [];
  let depth = 0;
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (depth === 0 && match) names.push(match[1]);
    depth += countChar(line, '{') - countChar(line, '}');
  }
  return uniqueSorted(names);
}

function capabilityOverrideFields(perModelConfigBlock) {
  const match = perModelConfigBlock.match(/capabilityOverrides\??:\s*{([^}]*)}/s);
  if (!match) return [];
  return uniqueSorted([...match[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\??:/g)].map((m) => m[1]));
}

function prismaCapabilityAxisFields(schema) {
  const out = [];
  const modelRegex = /model\s+([A-Za-z_][A-Za-z0-9_]*)\s*{([\s\S]*?)\n}/g;
  for (const model of schema.matchAll(modelRegex)) {
    const modelName = model[1];
    for (const line of model[2].split('\n')) {
      const field = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/)?.[1];
      if (!field) continue;
      if (/capabilit|supportedFeatures|supported_features|supportedParams|supported_params|requestParamPolicy|request_param_policy|capabilityOverrides|capability_overrides/i.test(line)) {
        out.push(`${modelName}.${field}`);
      }
    }
  }
  return uniqueSorted(out);
}

function assertReviewMarker(snapshot) {
  const marker = String(snapshot.architecture_review ?? '');
  if (!marker.includes('ARCH-REVIEW-APPROVED')) {
    fail(`baseline ${baselinePath} must carry ARCH-REVIEW-APPROVED marker`);
  }
  const digest = hashAxes(snapshot);
  if (!marker.includes(`sha256:${digest}`)) {
    fail(`baseline ${baselinePath} review marker must include sha256:${digest}`);
  }
}

function hashAxes(snapshot) {
  const axes = {};
  for (const key of [
    'capability_override_fields',
    'model_config_axis_fields',
    'prisma_capability_axis_fields',
    'publisher_route_policy_axis_fields',
  ]) {
    axes[key] = uniqueSorted(snapshot[key] ?? []);
  }
  return createHash('sha256').update(JSON.stringify(axes)).digest('hex');
}

function assertSameSet(name, got, want) {
  const gotSorted = uniqueSorted(got);
  const wantSorted = uniqueSorted(want);
  if (JSON.stringify(gotSorted) === JSON.stringify(wantSorted)) return;

  const added = gotSorted.filter((item) => !wantSorted.includes(item));
  const removed = wantSorted.filter((item) => !gotSorted.includes(item));
  fail(`${name} changed; added=[${added.join(', ')}] removed=[${removed.join(', ')}]. New protocol conversion support must be a whole protocol-to-protocol bridge/profile, not a new capability/feature/param axis. If this is architecture-approved, update ${path.relative(repoRoot, baselinePath)} and its ARCH-REVIEW-APPROVED sha256 marker.`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function countChar(value, ch) {
  return [...value].filter((candidate) => candidate === ch).length;
}

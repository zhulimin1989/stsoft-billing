/**
 * Generate or verify the deterministic Partner OpenAPI artifact.
 *
 *   pnpm --filter @ruidong/api openapi:generate
 *   pnpm --filter @ruidong/api openapi:check
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertPartnerOpenApiDocument,
  buildPartnerOpenApiDocument,
  PARTNER_API_OPERATION_COUNT,
} from '../src/openapi/partner-api.contract';

const outputPath = join(__dirname, '..', 'openapi', 'partner-openapi.json');
const checkOnly = process.argv.includes('--check');

function generate(): void {
  // The checked-in artifact deliberately uses a relative server. Deployment
  // may provide PARTNER_API_PUBLIC_BASE_URL when serving /openapi.json.
  const document = buildPartnerOpenApiDocument();
  assertPartnerOpenApiDocument(document);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  if (checkOnly) {
    if (!existsSync(outputPath)) {
      throw new Error(
        `Partner OpenAPI artifact is missing: ${outputPath}. Run openapi:generate.`,
      );
    }
    const committed = readFileSync(outputPath, 'utf8');
    if (committed !== serialized) {
      throw new Error(
        'Partner OpenAPI artifact is stale. Run openapi:generate and commit the resulting diff.',
      );
    }
    console.log(
      `Partner OpenAPI contract is current: ${PARTNER_API_OPERATION_COUNT} operations (${outputPath})`,
    );
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, 'utf8');
  console.log(
    `Partner OpenAPI artifact generated: ${PARTNER_API_OPERATION_COUNT} operations (${outputPath})`,
  );
}

try {
  generate();
} catch (error) {
  console.error(
    'Partner OpenAPI generation failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

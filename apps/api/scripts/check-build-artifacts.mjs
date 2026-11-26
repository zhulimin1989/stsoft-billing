import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(apiRoot, 'dist');
const requiredEntrypoints = ['billing-main.js', 'openapi-main.js'];

const missingEntrypoints = requiredEntrypoints.filter((entrypoint) => {
  const path = join(distRoot, entrypoint);
  return !existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0;
});

function listFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const unexpectedArtifacts = listFiles(distRoot)
  .map((path) => relative(distRoot, path).split(sep).join('/'))
  .filter(
    (path) =>
      path.startsWith('src/')
      || path.startsWith('scripts/')
      || path.includes('.spec.')
      || path.includes('.test.'),
  );

if (missingEntrypoints.length > 0 || unexpectedArtifacts.length > 0) {
  if (missingEntrypoints.length > 0) {
    console.error(`Missing build entrypoints: ${missingEntrypoints.join(', ')}`);
  }
  if (unexpectedArtifacts.length > 0) {
    console.error(`Unexpected build artifacts: ${unexpectedArtifacts.join(', ')}`);
  }
  process.exit(1);
}

for (const entrypoint of requiredEntrypoints) {
  execFileSync(process.execPath, ['--check', join(distRoot, entrypoint)], {
    stdio: 'inherit',
  });
}

console.log(`Verified build entrypoints: ${requiredEntrypoints.join(', ')}`);

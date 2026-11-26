/** Canonical provider identifier used across control-plane and runtime data. */
export function normalizeProviderCode(provider: string): string {
  const normalized = (provider || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return normalized === 'moonshot' ? 'kimi' : normalized;
}

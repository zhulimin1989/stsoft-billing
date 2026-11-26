export interface TokenBreakdownInput {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  outputTokens?: number | null;
}

function safeTokenCount(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(Number(value)));
}

export function getRegularInputTokens(input: TokenBreakdownInput): number {
  const totalInputTokens = safeTokenCount(input.inputTokens);
  const cacheReadInputTokens = Math.min(
    safeTokenCount(input.cachedInputTokens),
    totalInputTokens,
  );
  const cacheWriteInputTokens = Math.min(
    safeTokenCount(input.cacheWriteInputTokens),
    Math.max(0, totalInputTokens - cacheReadInputTokens),
  );
  return Math.max(0, totalInputTokens - cacheReadInputTokens - cacheWriteInputTokens);
}

export function buildTokenTypeBreakdown(input: TokenBreakdownInput): string {
  const parts: string[] = [];
  const regularInputTokens = getRegularInputTokens(input);
  const cacheReadInputTokens = safeTokenCount(input.cachedInputTokens);
  const cacheWriteInputTokens = safeTokenCount(input.cacheWriteInputTokens);
  const outputTokens = safeTokenCount(input.outputTokens);

  if (regularInputTokens > 0) parts.push(`input ${regularInputTokens}`);
  if (cacheReadInputTokens > 0) parts.push(`cache read ${cacheReadInputTokens}`);
  if (cacheWriteInputTokens > 0) parts.push(`cache write ${cacheWriteInputTokens}`);
  if (outputTokens > 0) parts.push(`output ${outputTokens}`);

  return parts.length > 0 ? parts.join(' / ') : '—';
}

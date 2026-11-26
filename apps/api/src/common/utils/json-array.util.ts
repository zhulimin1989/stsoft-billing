export function parseStringArrayJson(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean);
  }

  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return parseStringArrayJson(parsed);
  } catch {
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

export function normalizeStringArrayInput(raw: unknown): string[] {
  return Array.from(new Set(parseStringArrayJson(raw)));
}

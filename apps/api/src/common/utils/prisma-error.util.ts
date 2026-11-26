export function prismaErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function hasPrismaErrorCode(err: unknown, code: string): boolean {
  return prismaErrorCode(err) === code;
}

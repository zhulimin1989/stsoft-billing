type ConfigLike = {
  get<T = string>(key: string): T | undefined;
};

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.APP_ENV === 'production';
}

export function isProductionConfig(
  config: ConfigLike,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = config.get<string>('NODE_ENV') ?? env.NODE_ENV;
  const appEnv = config.get<string>('APP_ENV') ?? env.APP_ENV;
  return nodeEnv === 'production' || appEnv === 'production';
}

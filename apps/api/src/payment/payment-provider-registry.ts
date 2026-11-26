import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { decryptCredentials } from './credential-crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { isBillingRuntime } from '../common/runtime/service-role';

export interface ProviderInstance {
  id: string;
  providerKey: string;
  name: string;
  config: Record<string, string>;
  supportedTypes: string[];
  isActive: boolean;
  dailyLimitCents: number;
}

@Injectable()
export class PaymentProviderRegistry implements OnModuleInit {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  private instances: ProviderInstance[] = [];
  private roundRobinCounters: Record<string, number> = {};
  private encryptionKey: string;
  private loaded = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    // Production: throws if key missing/malformed (no silent fallback to
    // "default-key-change-me"). Non-prod: empty string acceptable.
    this.encryptionKey = resolveEncryptionKey(config);
  }

  async onModuleInit() {
    if (!isBillingRuntime()) {
      this.logger.log('Skip payment provider registry preload outside billing runtime');
      return;
    }
    await this.loadInstances();
  }

  async loadInstances() {
    const rows = await this.prisma.paymentProviderInstance.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    this.instances = rows.map((r) => this.deserializeInstance(r));
    this.loaded = true;

    this.logger.log(`Loaded ${this.instances.length} payment provider instances`);
  }

  async selectInstance(providerKey: string, paymentType?: string): Promise<ProviderInstance | null> {
    await this.ensureLoaded();
    const normalizedProviderKey = providerKey.toLowerCase();
    const normalizedPaymentType = paymentType?.toLowerCase();
    const candidates = this.instances.filter(
      (i) =>
        i.providerKey.toLowerCase() === normalizedProviderKey &&
        i.isActive &&
        this.supportsPaymentType(i, normalizedPaymentType),
    );

    if (candidates.length === 0) return null;

    // TODO: Check daily limit (query today's order sum per instance)
    // For now, simple round-robin
    const counterKey = providerKey;
    const idx = (this.roundRobinCounters[counterKey] || 0) % candidates.length;
    this.roundRobinCounters[counterKey] = idx + 1;
    return candidates[idx];
  }

  getInstanceCount(providerKey: string): number {
    const normalizedProviderKey = providerKey.toLowerCase();
    return this.instances.filter((i) => i.providerKey.toLowerCase() === normalizedProviderKey && i.isActive).length;
  }

  async getInstanceById(id: string): Promise<ProviderInstance | null> {
    const cached = this.instances.find((i) => i.id === id);
    if (cached) return cached;

    const row = await this.prisma.paymentProviderInstance.findUnique({ where: { id } });
    return row ? this.deserializeInstance(row) : null;
  }

  async getInstances(
    providerKey: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<ProviderInstance[]> {
    const normalizedProviderKey = providerKey.toLowerCase();
    if (!options.includeInactive) {
      await this.ensureLoaded();
      return this.instances.filter(
        (i) => i.providerKey.toLowerCase() === normalizedProviderKey && i.isActive,
      );
    }

    const rows = await this.prisma.paymentProviderInstance.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows
      .map((row) => this.deserializeInstance(row))
      .filter((i) => i.providerKey.toLowerCase() === normalizedProviderKey);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.loadInstances();
  }

  private deserializeInstance(row: {
    id: string;
    providerKey: string;
    name: string;
    config: string;
    supportedTypes: string;
    isActive: boolean;
    dailyLimitCents: number;
  }): ProviderInstance {
    let config: Record<string, string> = {};
    try {
      const decrypted = decryptCredentials(row.config, this.encryptionKey);
      config = JSON.parse(decrypted);
    } catch {
      // If decryption fails, try plain JSON (for dev/migration)
      try { config = JSON.parse(row.config); } catch { /* empty */ }
    }
    let supportedTypes: string[] = [];
    try { supportedTypes = JSON.parse(row.supportedTypes); } catch { /* empty */ }

    return {
      id: row.id,
      providerKey: row.providerKey,
      name: row.name,
      config,
      supportedTypes,
      isActive: row.isActive,
      dailyLimitCents: row.dailyLimitCents,
    };
  }

  private supportsPaymentType(instance: ProviderInstance, paymentType?: string): boolean {
    if (!paymentType || instance.supportedTypes.length === 0) {
      return true;
    }
    return instance.supportedTypes.some((type) => type.toLowerCase() === paymentType);
  }
}

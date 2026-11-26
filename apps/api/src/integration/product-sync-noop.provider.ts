import { Injectable, Logger, Optional, Provider } from '@nestjs/common';
import { ProductConfigSyncService } from './product-config-sync/product-config-sync.service';
import { ProductSyncNotifier } from './product-sync-notifier';

@Injectable()
export class NoopProductSyncNotifier implements ProductSyncNotifier {
  private readonly logger = new Logger(NoopProductSyncNotifier.name);
  private readonly warned = new Set<string>();

  constructor(@Optional() private readonly productConfigSync?: ProductConfigSyncService) {}

  async notifyCreditChanged(_email: string, _productSlug: string): Promise<void> {
    this.warnOnce('notifyCreditChanged');
  }

  async notifyProductSaas(productSlug?: string, changeType?: string): Promise<void> {
    if (this.productConfigSync && productSlug && changeType) {
      await this.productConfigSync.enqueueProduct(productSlug, changeType);
      return;
    }
    this.warnOnce('notifyProductSaas');
  }

  async notifyAllProductSaas(changeType?: string): Promise<void> {
    if (this.productConfigSync && changeType) {
      await this.productConfigSync.enqueueAll(changeType);
      return;
    }
    this.warnOnce('notifyAllProductSaas');
  }

  private warnOnce(method: string): void {
    if (this.warned.has(method)) return;
    this.warned.add(method);
    this.logger.warn(
      `ProductSyncNotifier.${method} skipped; use publisher sync or product integration callbacks for cross-service propagation.`,
    );
  }
}

export const noopProductSyncNotifierProvider: Provider = {
  provide: ProductSyncNotifier,
  useClass: NoopProductSyncNotifier,
};

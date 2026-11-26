export abstract class ProductSyncNotifier {
  abstract notifyCreditChanged(email: string, productSlug: string): Promise<void>;
  abstract notifyProductSaas(productSlug?: string, changeType?: string): Promise<void>;
  abstract notifyAllProductSaas(changeType?: string): Promise<void>;
}

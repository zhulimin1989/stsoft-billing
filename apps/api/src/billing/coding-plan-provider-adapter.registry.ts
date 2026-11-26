import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CodingPlanProviderAdapter } from './coding-plan-provider.types';
import { ZhipuPartnerAdapter } from './zhipu-partner.adapter';

@Injectable()
export class CodingPlanProviderAdapterRegistry {
  private readonly adapters = new Map<string, CodingPlanProviderAdapter>();

  constructor(zhipu: ZhipuPartnerAdapter) {
    this.register(zhipu);
  }

  register(adapter: CodingPlanProviderAdapter): void {
    this.adapters.set(adapter.adapterType, adapter);
  }

  get(adapterType: string): CodingPlanProviderAdapter {
    const adapter = this.adapters.get(adapterType);
    if (!adapter) {
      throw new ServiceUnavailableException(`未注册供应商适配器: ${adapterType}`);
    }
    return adapter;
  }
}

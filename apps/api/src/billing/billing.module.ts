import { Module } from '@nestjs/common';
import { BillingCoreModule } from './billing-core.module';

/**
 * BillingModule
 *
 * P2-A3 §8.1: 引入 AlertEventsModule 让 CreditService 能拿到 UsageThresholdService
 * (deduct 成功后用 setImmediate 异步检查用量阈值)。CreditService 用 @Optional 注入
 * 兼容旧的单测,生产路径走这里的 imports。
 */
@Module({
  imports: [BillingCoreModule],
  exports: [BillingCoreModule],
})
export class BillingModule {}

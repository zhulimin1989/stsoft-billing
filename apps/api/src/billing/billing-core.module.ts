import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlertEventService } from '../alert-events/alert-events.service';
import { UsageThresholdService } from '../alert-events/usage-threshold.service';
import { CreditPolicyService } from '../credit-policy/credit-policy.service';
import { BalanceGrantExpiryService } from './balance-grant-expiry.service';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { TokenUsagePeriodSummaryV2Repository } from './token-usage-period-summary-v2.repository';
import { TokenUsagePeriodSummaryV2Service } from './token-usage-period-summary-v2.service';
import { BoosterPackService } from './booster-pack.service';
import { CreditPricingService } from './credit-pricing.service';
import { GatewayRequestEventBillingService } from './gateway-request-event-billing.service';
import { GatewayProvisionalExposureConfig } from './gateway-provisional-exposure.config';
import { HistoricalPlatformLossBatchService } from './historical-platform-loss-batch.service';
import { CodingPlanProviderAdapterRegistry } from './coding-plan-provider-adapter.registry';
import { CodingPlanProviderAdminService } from './coding-plan-provider-admin.service';
import { CodingPlanProviderEntitlementAttemptService } from './coding-plan-provider-entitlement-attempt.service';
import { CodingPlanProviderKeyRevealService } from './coding-plan-provider-key-reveal.service';
import { CodingPlanProviderLineService } from './coding-plan-provider-line.service';
import { CodingPlanProviderUsageService } from './coding-plan-provider-usage.service';
import { CodingPlanResaleRouteService } from './coding-plan-resale-route.service';
import { CreditService } from './credit.service';
import { CreditBalanceStateService } from './credit-balance-state.service';
import { ModelPricingService } from './model-pricing.service';
import { ProviderCostPricingService } from './provider-cost-pricing.service';
import { ProductService } from './product.service';
import { StartupPricingValidator } from './startup-pricing-validator';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionResolverService } from './subscription-resolver.service';
import { SystemConfigService } from './system-config.service';
import { RollingQuotaGateConfigService } from './rolling-quota-gate-config.service';
import { SelfopNegativeDeductConfigService } from './selfop-negative-deduct-config.service';
import { CodingPlanMonthlyRefreshService } from './coding-plan-monthly-refresh.service';
import { UsageBillingStrategyService } from './usage-billing-strategy.service';
import { ZhipuPartnerAdapter } from './zhipu-partner.adapter';
import { PublisherModule } from '../publisher/publisher.module';
import { CampaignServiceModule } from '../campaign/campaign-service.module';
import { GrowthEventsService } from '../growth-events/growth-events.service';

/**
 * Provider-only billing boundary.
 *
 * Import this from standalone runtimes that need billing behavior without
 * pulling admin-facing controllers from AlertEventsModule/CreditPolicyModule.
 */
@Module({
  imports: [ConfigModule, PublisherModule],
  providers: [
    // provisional exposure 的历史边界（= 建 exposure 表那次迁移的完成时刻）。
    // 惰性读取 + 成功即永久缓存，所以这里既不需要构造期解析，也不需要靠模块图保证顺序。
    GatewayProvisionalExposureConfig,
    AlertEventService,
    BalanceGrantExpiryService,
    BillingService,
    BillingRepository,
    TokenUsagePeriodSummaryV2Repository,
    TokenUsagePeriodSummaryV2Service,
    CodingPlanProviderAdapterRegistry,
    CodingPlanProviderAdminService,
    CodingPlanProviderEntitlementAttemptService,
    CodingPlanProviderKeyRevealService,
    CodingPlanProviderLineService,
    CodingPlanProviderUsageService,
    CodingPlanResaleRouteService,
    ProductService,
    BoosterPackService,
    CreditBalanceStateService,
    CreditService,
    SystemConfigService,
    RollingQuotaGateConfigService,
    SelfopNegativeDeductConfigService,
    CodingPlanMonthlyRefreshService,
    SubscriptionExpiryService,
    SubscriptionLifecycleService,
    SubscriptionResolverService,
    CreditPricingService,
    GatewayRequestEventBillingService,
    HistoricalPlatformLossBatchService,
    GrowthEventsService,
    ModelPricingService,
    ProviderCostPricingService,
    StartupPricingValidator,
    CreditPolicyService,
    UsageThresholdService,
    UsageBillingStrategyService,
    ZhipuPartnerAdapter,
  ],
  exports: [
    GatewayProvisionalExposureConfig,
    AlertEventService,
    BalanceGrantExpiryService,
    BillingService,
    BillingRepository,
    TokenUsagePeriodSummaryV2Repository,
    TokenUsagePeriodSummaryV2Service,
    CodingPlanProviderAdapterRegistry,
    CodingPlanProviderAdminService,
    CodingPlanProviderEntitlementAttemptService,
    CodingPlanProviderKeyRevealService,
    CodingPlanProviderLineService,
    CodingPlanProviderUsageService,
    CodingPlanResaleRouteService,
    ProductService,
    BoosterPackService,
    CreditBalanceStateService,
    CreditService,
    SystemConfigService,
    RollingQuotaGateConfigService,
    SelfopNegativeDeductConfigService,
    CodingPlanMonthlyRefreshService,
    SubscriptionExpiryService,
    SubscriptionLifecycleService,
    SubscriptionResolverService,
    CreditPricingService,
    GatewayRequestEventBillingService,
    HistoricalPlatformLossBatchService,
    GrowthEventsService,
    ModelPricingService,
    ProviderCostPricingService,
    StartupPricingValidator,
    CreditPolicyService,
    UsageThresholdService,
    UsageBillingStrategyService,
    ZhipuPartnerAdapter,
  ],
})
export class BillingCoreModule {}

@Module({
  imports: [BillingCoreModule, CampaignServiceModule],
  controllers: [BillingController],
  exports: [BillingCoreModule],
})
export class BillingHttpModule {}

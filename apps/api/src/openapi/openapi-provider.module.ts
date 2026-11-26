import { Module } from '@nestjs/common';
import { BillingRepository } from '../billing/billing.repository';
import { BillingService } from '../billing/billing.service';
import { BoosterPackService } from '../billing/booster-pack.service';
import { CreditService } from '../billing/credit.service';
import { CreditBalanceStateService } from '../billing/credit-balance-state.service';
import { ProductIntegrationAuthService } from '../billing/product-integration-auth.service';
import { ProductPortalCatalogService } from '../billing/product-portal-catalog.service';
import { ProductService } from '../billing/product.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { SystemConfigService } from '../billing/system-config.service';
import { BillingUserMirrorService } from '../billing-runtime/billing-user-mirror.service';
import { SaasProvisioningService } from '../billing-runtime/saas-provisioning.service';
import { CampaignServiceModule } from '../campaign/campaign-service.module';
import { DiscountCodeRepository } from '../campaign/discount-code.repository';
import { DiscountCodeService } from '../campaign/discount-code.service';
import { noopProductSyncNotifierProvider } from '../integration/product-sync-noop.provider';
import { AlipayService } from '../payment/alipay.service';
import { PaymentProviderRegistry } from '../payment/payment-provider-registry';
import { PaymentRepository } from '../payment/payment.repository';
import { PaymentService } from '../payment/payment.service';
import { ProviderRefundSagaService } from '../payment/provider-refund-saga.service';
import { RefundCompensationService } from '../payment/refund-compensation.service';
import { StripeService } from '../payment/stripe.service';
import { UserPurchaseVerificationClient } from '../payment/user-purchase-verification.client';
import { WechatPayService } from '../payment/wechat-pay.service';
import { PublisherClient } from '../publisher/publisher.client';
import { PublisherSyncJobService } from '../publisher/publisher-sync-job.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { RollingQuotaGateService } from '../publisher/rolling-quota-gate.service';

@Module({
  imports: [CampaignServiceModule],
  providers: [
    BillingRepository,
    BillingService,
    BoosterPackService,
    CreditBalanceStateService,
    CreditService,
    ProductIntegrationAuthService,
    ProductPortalCatalogService,
    ProductService,
    SubscriptionResolverService,
    SubscriptionLifecycleService,
    SystemConfigService,
    BillingUserMirrorService,
    SaasProvisioningService,
    DiscountCodeRepository,
    DiscountCodeService,
    PaymentService,
    ProviderRefundSagaService,
    RefundCompensationService,
    PaymentRepository,
    UserPurchaseVerificationClient,
    WechatPayService,
    AlipayService,
    StripeService,
    PaymentProviderRegistry,
    noopProductSyncNotifierProvider,
    PublisherClient,
    PublisherSyncJobService,
    PublisherSyncService,
    RollingQuotaGateService,
  ],
  exports: [
    BillingService,
    CreditService,
    ProductIntegrationAuthService,
    ProductPortalCatalogService,
    SaasProvisioningService,
    SubscriptionResolverService,
    PaymentService,
  ],
})
export class OpenApiProviderModule {}

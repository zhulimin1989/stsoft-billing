import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { WechatPayService } from './wechat-pay.service';
import { AlipayService } from './alipay.service';
import { StripeService } from './stripe.service';
import { BillingModule } from '../billing/billing.module';
import { CampaignModule } from '../campaign/campaign.module';
import { AlertEventsModule } from '../alert-events/alert-events.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { OrderTimeoutService } from './order-timeout.service';
import { PaymentProviderRegistry } from './payment-provider-registry';
import { CodingPlanFulfillmentService } from './coding-plan-fulfillment.service';
import { ProductConfigSyncModule } from '../integration/product-config-sync/product-config-sync.module';
import { noopProductSyncNotifierProvider } from '../integration/product-sync-noop.provider';
import { UserPurchaseVerificationClient } from './user-purchase-verification.client';
import { RefundCompensationService } from './refund-compensation.service';
import { ProviderRefundSagaService } from './provider-refund-saga.service';

@Module({
  imports: [
    BillingModule,
    CampaignModule,
    AlertEventsModule,
    ReferralsModule,
    ProductConfigSyncModule,
  ],
  providers: [
    PaymentService,
    RefundCompensationService,
    ProviderRefundSagaService,
    PaymentRepository,
    WechatPayService,
    AlipayService,
    StripeService,
    OrderTimeoutService,
    PaymentProviderRegistry,
    UserPurchaseVerificationClient,
    CodingPlanFulfillmentService,
    noopProductSyncNotifierProvider,
  ],
  exports: [
    PaymentService,
    PaymentProviderRegistry,
    RefundCompensationService,
    ProviderRefundSagaService,
  ],
})
export class PaymentModule {}

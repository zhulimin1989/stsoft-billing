import { Module } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { CampaignRepository } from '../campaign/campaign.repository';
import { CampaignService } from '../campaign/campaign.service';
import { DiscountCodeRepository } from '../campaign/discount-code.repository';
import { DiscountCodeService } from '../campaign/discount-code.service';
import { StripeCouponSyncService } from '../campaign/stripe-coupon-sync.service';
import { AlipayService } from '../payment/alipay.service';
import { CodingPlanFulfillmentService } from '../payment/coding-plan-fulfillment.service';
import { OrderTimeoutService } from '../payment/order-timeout.service';
import { PaymentController } from '../payment/payment.controller';
import { PaymentProviderRegistry } from '../payment/payment-provider-registry';
import { PaymentRepository } from '../payment/payment.repository';
import { PaymentService } from '../payment/payment.service';
import { RefundCompensationService } from '../payment/refund-compensation.service';
import { ProviderRefundSagaService } from '../payment/provider-refund-saga.service';
import { StripeService } from '../payment/stripe.service';
import { UserPurchaseVerificationClient } from '../payment/user-purchase-verification.client';
import { WechatPayService } from '../payment/wechat-pay.service';
import { noopProductSyncNotifierProvider } from '../integration/product-sync-noop.provider';
import { CreditGrantExecutor } from '../credit-grants/credit-grant-executor';
import { CreditGrantsService } from '../credit-grants/credit-grants.service';
import { ReferralsService } from '../referrals/referrals.service';

@Module({
  imports: [BillingCoreModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    RefundCompensationService,
    ProviderRefundSagaService,
    PaymentRepository,
    UserPurchaseVerificationClient,
    WechatPayService,
    AlipayService,
    StripeService,
    OrderTimeoutService,
    PaymentProviderRegistry,
    CodingPlanFulfillmentService,
    CreditGrantExecutor,
    CreditGrantsService,
    ReferralsService,
    CampaignService,
    CampaignRepository,
    DiscountCodeService,
    DiscountCodeRepository,
    StripeCouponSyncService,
    noopProductSyncNotifierProvider,
  ],
  exports: [
    PaymentService,
    PaymentProviderRegistry,
    RefundCompensationService,
    ProviderRefundSagaService,
  ],
})
export class PaymentRuntimeModule {}

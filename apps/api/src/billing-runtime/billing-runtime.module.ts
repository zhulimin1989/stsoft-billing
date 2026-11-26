import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { AdminRepository } from '../admin/admin.repository';
import { BillingAdminService } from '../billing/billing.admin.service';
import { BillingHttpModule } from '../billing/billing-core.module';
import { CampaignRepository } from '../campaign/campaign.repository';
import { CampaignService } from '../campaign/campaign.service';
import { DiscountCodeRepository } from '../campaign/discount-code.repository';
import { DiscountCodeService } from '../campaign/discount-code.service';
import { StripeCouponSyncService } from '../campaign/stripe-coupon-sync.service';
import { ChannelAdminService } from '../channel/channel.admin.service';
import { ChannelRepository } from '../channel/channel.repository';
import { ChannelService } from '../channel/channel.service';
import { CreditExpireService } from '../credit-grants/credit-expire.service';
import { CreditGrantExecutor } from '../credit-grants/credit-grant-executor';
import { CreditGrantsService } from '../credit-grants/credit-grants.service';
import { CreditPolicyService } from '../credit-policy/credit-policy.service';
import { FunnelService } from '../funnel/funnel.service';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { createLoggerConfig } from '../common/logger/logger.config';
import { HealthController } from '../health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { BillingAccountContextController } from './billing-account-context.controller';
import { BillingAdminController } from './billing-admin.controller';
import { AccountingReconciliationService } from './accounting-reconciliation.service';
import { BillingAuthGuard } from './billing-auth.guard';
import { BillingInternalGuard } from './billing-internal.guard';
import { BillingUsageKafkaConsumerService } from './billing-usage-kafka-consumer.service';
import { BillingRestrictionProjectionWorkerService } from './billing-restriction-projection-worker.service';
import { BillingUserMirrorController } from './billing-user-mirror.controller';
import { BillingUserMirrorService } from './billing-user-mirror.service';
import { BillingWorkspaceMirrorController } from './billing-workspace-mirror.controller';
import { BillingWorkspaceMirrorService } from './billing-workspace-mirror.service';
import { EnterpriseAccountInternalController } from './enterprise-account-internal.controller';
import { EnterpriseBillsInternalController } from './enterprise-bills-internal.controller';
import { EnterpriseBillMonthSummariesController } from './enterprise-bill-month-summaries.controller';
import { EnterpriseAccountService } from '../billing/enterprise-account.service';
import { EnterpriseBillsService } from '../billing/enterprise-bills.service';
import { EnterpriseBillWalletAdapter } from '../billing/enterprise-bills-wallet.adapter';
import { EnterpriseRecoveryFanoutService } from '../billing/enterprise-recovery-fanout.service';
import { CreditReconcileWorkerService } from './credit-reconcile-worker.service';
import { CreditBalanceOutboxWorkerService } from './credit-balance-outbox-worker.service';
import { BalanceDebtSettlementWorkerService } from './balance-debt-settlement-worker.service';
import { EnterpriseCreditOverdueWorkerService } from './enterprise-credit-overdue-worker.service';
import { EnterpriseBillsOverdueWorkerService } from './enterprise-bills-overdue-worker.service';
import { RetryWaitRecoveryWorkerService } from './retry-wait-recovery-worker.service';
import { HistoryGrowthWatchService } from './history-growth-watch.service';
import { FinanceExportJobWorkerService } from './finance-export-job-worker.service';
import { RefundCompensationWorkerService } from './refund-compensation-worker.service';
import { StripeSubscriptionCancellationWorkerService } from './stripe-subscription-cancellation-worker.service';
import { ProviderRefundWorkerService } from './provider-refund-worker.service';
import { noopProductSyncNotifierProvider } from '../integration/product-sync-noop.provider';
import { PaymentRuntimeModule } from './payment-runtime.module';
import { PublisherModule } from '../publisher/publisher.module';
import { ProductConfigSyncModule } from '../integration/product-config-sync/product-config-sync.module';
import { ProductRouteAdminController } from './product-route-admin.controller';
import { ProductRouteModule } from '../product-route/product-route.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { QuotaTemplatesService } from '../quota-templates/quota-templates.service';
import { PublicRechargeTiersController } from '../recharge-tiers/recharge-tiers.public.controller';
import { RechargeTiersService } from '../recharge-tiers/recharge-tiers.service';
import { ReferralsService } from '../referrals/referrals.service';
import { ReferralsUserController } from '../referrals/referrals.user.controller';
import { GrowthEventsWorkerService } from './growth-events-worker.service';
import { UserSegmentsModule } from '../user-segments/user-segments.module';
import { UserSegmentsInternalController } from '../user-segments/user-segments-internal.controller';
import { ProviderAccountIdentityModule } from '../provider-account-identity/provider-account-identity.module';
import { ProviderAccountIdentityController } from '../provider-account-identity/provider-account-identity.controller';
import { MetricsModule } from '../metrics/metrics.module';
import { UserPurchaseVerificationClient } from '../payment/user-purchase-verification.client';
import { FinanceUserIdentityResolver } from '../billing/finance-user-identity.resolver';
import { FinanceReportOverviewCacheService } from '../billing/finance-report-overview-cache.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../../.env', '/app/.env'],
    }),
    LoggerModule.forRoot(createLoggerConfig()),
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    PublisherModule,
    ProductConfigSyncModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    BillingHttpModule,
    PaymentRuntimeModule,
    ProductRouteModule,
    // 分群数据/逻辑(UserSegmentsService + 刷新 job)都在 billing;此处引入以便把
    // 既有 service 复用到 admin-api 调用的 internal 入口(UserSegmentsInternalController)。
    UserSegmentsModule,
    InvoiceModule,
    ProviderAccountIdentityModule,
    MetricsModule,
  ],
  controllers: [
    BillingAccountContextController,
    BillingAdminController,
    UserSegmentsInternalController,
    BillingUserMirrorController,
    BillingWorkspaceMirrorController,
    EnterpriseAccountInternalController,
    EnterpriseBillsInternalController,
    EnterpriseBillMonthSummariesController,
    ProductRouteAdminController,
    PublicRechargeTiersController,
    // 用户端「推介计划」取/懒生成自己的邀请码(GET /api/user/referral-code)。
    // ★ ReferralsService 早就在下方 providers 里,但这个 controller 一直没挂 ——
    //   ReferralsModule 只被 PaymentModule 引入,而 PaymentModule 全仓无人引入,
    //   所以 billing-api 上从来没有这条路由,请求一律 Cannot GET → 404。
    //   而用户端页面把 404 当成「没有可用活动」,把路由缺失伪装成了数据问题。
    ReferralsUserController,
    ProviderAccountIdentityController,
    HealthController,
  ],
  providers: [
    AdminRepository,
    BillingAdminService,
    FinanceReportOverviewCacheService,
    UserPurchaseVerificationClient,
    FinanceUserIdentityResolver,
    CampaignRepository,
    CampaignService,
    ChannelAdminService,
    ChannelRepository,
    ChannelService,
    CreditExpireService,
    CreditGrantExecutor,
    CreditGrantsService,
    CreditPolicyService,
    DiscountCodeRepository,
    DiscountCodeService,
    FunnelService,
    AccountingReconciliationService,
    BillingUsageKafkaConsumerService,
    BillingRestrictionProjectionWorkerService,
    BalanceDebtSettlementWorkerService,
    GrowthEventsWorkerService,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    BillingInternalGuard,
    BillingUserMirrorService,
    BillingWorkspaceMirrorService,
    EnterpriseAccountService,
    EnterpriseBillWalletAdapter,
    EnterpriseBillsService,
    EnterpriseRecoveryFanoutService,
    CreditBalanceOutboxWorkerService,
    CreditReconcileWorkerService,
    EnterpriseCreditOverdueWorkerService,
    EnterpriseBillsOverdueWorkerService,
    RetryWaitRecoveryWorkerService,
    HistoryGrowthWatchService,
    FinanceExportJobWorkerService,
    RefundCompensationWorkerService,
    StripeSubscriptionCancellationWorkerService,
    ProviderRefundWorkerService,
    QuotaTemplatesService,
    RechargeTiersService,
    ReferralsService,
    StripeCouponSyncService,
    noopProductSyncNotifierProvider,
    {
      provide: APP_GUARD,
      useClass: BillingAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class BillingRuntimeModule {}

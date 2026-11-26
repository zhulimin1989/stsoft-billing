import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CampaignService } from './campaign.service';
import { CampaignRepository } from './campaign.repository';
import { StripeCouponSyncService } from './stripe-coupon-sync.service';

/**
 * Provider-only campaign boundary.
 *
 * 仅暴露 CampaignService（活动价解析/命中），不挂载任何 admin controller。
 * 供 billing HTTP runtime 注入 CampaignService（如 /billing/plans/promotions 展示）
 * 而不把 /admin/campaigns、/admin/discount-codes 路由面引入该 runtime。
 */
@Module({
  imports: [ConfigModule],
  providers: [CampaignService, CampaignRepository, StripeCouponSyncService],
  exports: [CampaignService, StripeCouponSyncService],
})
export class CampaignServiceModule {}

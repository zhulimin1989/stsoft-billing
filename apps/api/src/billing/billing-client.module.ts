import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BillingPortalClient } from './billing-portal.client';

@Module({
  imports: [ConfigModule],
  providers: [BillingPortalClient],
  exports: [BillingPortalClient],
})
export class BillingClientModule {}

import { Module } from '@nestjs/common';
import { BillingClientModule } from './billing-client.module';
import { BillingProxyController } from './billing-proxy.controller';

@Module({
  imports: [BillingClientModule],
  controllers: [BillingProxyController],
})
export class BillingProxyModule {}

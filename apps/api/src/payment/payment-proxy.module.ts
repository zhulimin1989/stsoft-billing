import { Module } from '@nestjs/common';
import { BillingClientModule } from '../billing/billing-client.module';
import { PaymentProxyController } from './payment-proxy.controller';

@Module({
  imports: [BillingClientModule],
  controllers: [PaymentProxyController],
})
export class PaymentProxyModule {}

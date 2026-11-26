import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProductConfigSyncService } from './product-config-sync.service';
import { ProductConfigSyncWorkerService } from './product-config-sync-worker.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [ProductConfigSyncService, ProductConfigSyncWorkerService],
  exports: [ProductConfigSyncService],
})
export class ProductConfigSyncModule {}

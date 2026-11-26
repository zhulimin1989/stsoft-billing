import { Module } from '@nestjs/common';
import { ApiKeyController } from './apikey.controller';
import { ApiKeyService } from './apikey.service';
import { ApiKeyRepository } from './apikey.repository';
import { BillingModule } from '../billing/billing.module';
import { PublisherModule } from '../publisher/publisher.module';

/**
 * Legacy, not mounted by `BillingRuntimeModule`.
 *
 * Current deployed API key flows are served by `codesphere-user`. See
 * `apps/api/src/apikey/README.md` before wiring this module back into billing.
 */
@Module({
  imports: [BillingModule, PublisherModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, ApiKeyRepository],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}

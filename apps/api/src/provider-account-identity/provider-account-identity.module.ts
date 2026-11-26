import { Module } from '@nestjs/common';
import { ProviderAccountIdentityRepository } from './provider-account-identity.repository';
import { ProviderAccountIdentityService } from './provider-account-identity.service';

@Module({
  providers: [ProviderAccountIdentityRepository, ProviderAccountIdentityService],
  exports: [ProviderAccountIdentityService],
})
export class ProviderAccountIdentityModule {}

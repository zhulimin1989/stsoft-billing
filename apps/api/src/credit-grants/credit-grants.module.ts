import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { BillingModule } from '../billing/billing.module';
import { buildBullConnection } from '../integration/queue/queue.config';
import { UserSegmentsModule } from '../user-segments/user-segments.module';
import { CreditExpireService } from './credit-expire.service';
import { CreditGrantExecutor } from './credit-grant-executor';
import { CreditGrantsController } from './credit-grants.controller';
import { CreditGrantsService } from './credit-grants.service';
import {
  CREDIT_EXPIRE_QUEUE,
  CreditExpireProcessor,
} from './jobs/credit-expire.job';
import {
  CREDIT_GRANT_QUEUE,
  CreditGrantProcessor,
} from './jobs/credit-grant.job';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullConnection(config),
      }),
    }),
    BullModule.registerQueue({ name: CREDIT_GRANT_QUEUE }),
    BullModule.registerQueue({ name: CREDIT_EXPIRE_QUEUE }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
    UserSegmentsModule, // for DYNAMIC segment resolution
    BillingModule, // PR0-2: BillingService for BALANCE reward delivery
  ],
  controllers: [CreditGrantsController],
  providers: [
    CreditGrantsService,
    CreditGrantExecutor,
    CreditExpireService,
    CreditGrantProcessor,
    CreditExpireProcessor,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  exports: [CreditGrantsService, CreditGrantExecutor, CreditExpireService],
})
export class CreditGrantsModule implements OnModuleInit {
  constructor(private readonly grants: CreditGrantsService) {}

  async onModuleInit(): Promise<void> {
    // Wire DYNAMIC segment resolution via the UserSegmentRuleEngine. We do
    // this lazily to avoid a hard dependency at import time and to keep
    // the executor unit-testable without redis/prisma.
    //
    // The rule engine lives inside UserSegmentsService; PR5 doesn't need to
    // touch its public API. We import a tiny wrapper to avoid pulling the
    // engine into our module's DI graph directly.
    try {
      // Lazy require avoids cycle if UserSegmentsService later depends on
      // grant references (it currently does not).
      const { UserSegmentRuleEngine } = await import(
        '../user-segments/user-segment-rule-engine'
      );
      const { PrismaService } = await import('../prisma/prisma.service');
      void PrismaService;
      // Engine is a value-type that takes Prisma — but to avoid a second DI
      // path here, we resolve it through the grants service which already
      // has Prisma injected. Resolver wiring is best-effort: if loading
      // fails, executor falls back to materialized members (DYNAMIC = empty).
      const prisma = (this.grants as unknown as { prisma: unknown }).prisma;
      const engine = new UserSegmentRuleEngine(
        prisma as ConstructorParameters<typeof UserSegmentRuleEngine>[0],
      );
      this.grants.setDynamicResolver(async (ruleExpr) => {
        if (!ruleExpr) return [];
        try {
          return await engine.resolve(ruleExpr);
        } catch {
          // Engine raises RuleMatchTooLargeError for >MAX rules — caller
          // shouldn't crash, just degrade to empty.
          return [];
        }
      });
    } catch {
      // Best-effort wiring — silent fallback is fine.
    }
  }
}

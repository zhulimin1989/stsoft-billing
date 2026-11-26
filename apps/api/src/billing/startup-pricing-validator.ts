import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isBillingRuntime } from '../common/runtime/service-role';

@Injectable()
export class StartupPricingValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupPricingValidator.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!isBillingRuntime()) {
      this.logger.log('Skip pricing startup validation outside billing runtime');
      return;
    }
    // 查 active plan 中开放的模型（distinct modelName）。
    // Inactive plan 的历史配置不应触发启动校验。
    const accessRows = await this.prisma.modelAccess.findMany({
      where: { isActive: true, plan: { is: { isActive: true } } },
      select: { modelName: true },
      distinct: ['modelName'],
    });

    // 查所有报价行。此 validator 的职责是防"漏配报价行"，
    // inactive 报价是另一类数据状态问题，不能误报成 no ModelPricing。
    const pricedRows = await this.prisma.modelPricing.findMany({
      select: { modelName: true, isActive: true },
    });

    const pricingByName = new Map(pricedRows.map((r) => [r.modelName, r]));
    const accessModelNames = accessRows.map((r) => r.modelName);
    const missing = accessModelNames.filter((name) => !pricingByName.has(name));
    const inactive = accessModelNames.filter((name) => {
      const pricing = pricingByName.get(name);
      return pricing && !pricing.isActive;
    });

    if (missing.length > 0) {
      const message = `STARTUP_VALIDATION_FAILED: ${missing.length} active ModelAccess records have no ModelPricing row: ${missing.join(', ')}`;
      this.logger.error(message);
      if (process.env.NODE_ENV === 'production') {
        throw new Error(message);
      }
      // 非生产只告警，不中断
      return;
    }

    if (inactive.length > 0) {
      this.logger.warn(
        `ModelPricing coverage OK, but ${inactive.length} active ModelAccess records reference inactive ModelPricing: ${inactive.join(', ')}`,
      );
      return;
    }

    this.logger.log(
      `ModelPricing coverage OK: ${accessRows.length} active models all priced`,
    );
  }
}

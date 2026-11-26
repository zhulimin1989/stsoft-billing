import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isBillingRuntime } from '../common/runtime/service-role';
import { EnterpriseBillsService } from '../billing/enterprise-bills.service';
import { EnterpriseAccountService } from '../billing/enterprise-account.service';
import { AUTO_SUSPEND_REASON } from '../billing/enterprise-bills.policy';

const SWEEP_MS = 60_000;
const SUSPEND_REASON = AUTO_SUSPEND_REASON;
const RESTORE_REASON = 'monthly_bill_overdue_auto_restore';
const ACTOR = 'system:enterprise-bills-overdue';

@Injectable()
export class EnterpriseBillsOverdueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnterpriseBillsOverdueWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly bills: EnterpriseBillsService,
    private readonly enterpriseAccounts: EnterpriseAccountService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip enterprise bills overdue worker outside billing runtime');
      return;
    }
    // TEMP: 企业账户 V2「账期到期自动停授信 / 禁止继续消耗」暂不生效。
    // evaluateOverdue 已改为集合 SQL 判定；恢复时取消下方注释即可重新按 60s 扫描后串行改授信。
    this.logger.log(
      'Enterprise bills overdue worker disabled (TEMP: skip auto-suspend on bill due)',
    );
    // this.timer = setInterval(() => {
    //   void this.sweep();
    // }, SWEEP_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<void> {
    // TEMP: 与 onModuleInit 同开关联动，避免手工触发仍停授信
    this.logger.debug('enterprise bills overdue sweep skipped (TEMP disabled)');
    return; // V2 自动停授信仍关闭；evaluateOverdue 可单独调用，sweep 不改授信。
    /*
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const decision = await this.bills.evaluateOverdue(new Date());
      for (const accountId of decision.suspend) {
        await this.enterpriseAccounts.updateEnterpriseCredit(accountId, {
          status: 'SUSPENDED',
          reason: SUSPEND_REASON,
          updatedBy: ACTOR,
        });
      }
      for (const accountId of decision.restore) {
        await this.enterpriseAccounts.updateEnterpriseCredit(accountId, {
          status: 'ACTIVE',
          reason: RESTORE_REASON,
          updatedBy: ACTOR,
        });
      }
    } catch (error) {
      this.logger.error(
        `enterprise bills overdue sweep failed: ${(error as Error)?.message ?? error}`,
      );
    } finally {
      this.running = false;
    }
    */
  }
}

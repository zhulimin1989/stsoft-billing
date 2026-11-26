/**
 * Daily/weekly cron-based credit grant job (BullMQ Repeatable).
 *
 * - Queue: `credit-grant`
 * - Repeatable jobs:
 *     - jobId="daily"  cron "0 0 * * *"   → DAILY_CRON rules
 *     - jobId="weekly" cron "0 0 * * 1"   → WEEKLY_CRON rules (Mon 0:00 UTC)
 * - Worker: invokes CreditGrantExecutor.executeAllByTrigger(...) and logs
 *           per-rule metrics.
 *
 * NOTE: FIRST_LOGIN / DAILY_CHECKIN / TASK_COMPLETE are event-driven and
 *       are NOT scheduled here. Wiring those will be a follow-up PR.
 */
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { CreditGrantExecutor } from '../credit-grant-executor';

export const CREDIT_GRANT_QUEUE = 'credit-grant';
export const CREDIT_GRANT_DAILY_JOB = 'daily';
export const CREDIT_GRANT_WEEKLY_JOB = 'weekly';

@Processor(CREDIT_GRANT_QUEUE)
export class CreditGrantProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CreditGrantProcessor.name);

  constructor(
    @InjectQueue(CREDIT_GRANT_QUEUE)
    private readonly queue: Queue,
    private readonly executor: CreditGrantExecutor,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      // Daily 0:00 UTC — run all DAILY_CRON rules.
      await this.queue.add(
        CREDIT_GRANT_DAILY_JOB,
        { triggerType: 'DAILY_CRON' },
        {
          jobId: `${CREDIT_GRANT_QUEUE}:repeatable:daily`,
          repeat: { pattern: '0 0 * * *' },
          removeOnComplete: { count: 30 },
          removeOnFail: { count: 30 },
        },
      );
      // Weekly Mon 0:00 UTC — run all WEEKLY_CRON rules.
      await this.queue.add(
        CREDIT_GRANT_WEEKLY_JOB,
        { triggerType: 'WEEKLY_CRON' },
        {
          jobId: `${CREDIT_GRANT_QUEUE}:repeatable:weekly`,
          repeat: { pattern: '0 0 * * 1' },
          removeOnComplete: { count: 12 },
          removeOnFail: { count: 12 },
        },
      );
      this.logger.log(
        `scheduled repeatables: daily=${CREDIT_GRANT_DAILY_JOB} weekly=${CREDIT_GRANT_WEEKLY_JOB}`,
      );
    } catch (err) {
      this.logger.error(
        `failed to schedule credit-grant jobs: ${(err as Error).message}`,
      );
    }
  }

  async process(
    job: Job<{ triggerType: 'DAILY_CRON' | 'WEEKLY_CRON' }>,
  ): Promise<{ rules: number; granted: number; failed: number }> {
    const trigger = job.data?.triggerType ?? 'DAILY_CRON';
    this.logger.log(`credit-grant tick (job=${job.id} trigger=${trigger})`);
    const results = await this.executor.executeAllByTrigger(trigger);
    const granted = results.reduce((sum, r) => sum + r.granted, 0);
    const failed = results.reduce((sum, r) => sum + r.failed, 0);
    this.logger.log(
      `credit-grant done: rules=${results.length} granted=${granted} failed=${failed}`,
    );
    return { rules: results.length, granted, failed };
  }
}

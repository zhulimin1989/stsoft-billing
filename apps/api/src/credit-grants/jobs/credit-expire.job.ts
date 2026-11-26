/**
 * Daily expiration sweep (BullMQ Repeatable).
 *
 * - Queue: `credit-expire`
 * - Repeatable: daily 0:30 UTC (offset from credit-grant 0:00 to avoid
 *   contention on credit_transactions writes)
 * - Worker: scans CreditTransaction(type=GRANT, expiresAt<now, isExpired=false)
 *   and writes reverse EXPIRE rows. See CreditExpireService for the per-row
 *   logic + simplification notes.
 */
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { CreditExpireService } from '../credit-expire.service';

export const CREDIT_EXPIRE_QUEUE = 'credit-expire';
export const CREDIT_EXPIRE_JOB = 'sweep';

@Processor(CREDIT_EXPIRE_QUEUE)
export class CreditExpireProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(CreditExpireProcessor.name);

  constructor(
    @InjectQueue(CREDIT_EXPIRE_QUEUE)
    private readonly queue: Queue,
    private readonly service: CreditExpireService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        CREDIT_EXPIRE_JOB,
        {},
        {
          jobId: `${CREDIT_EXPIRE_QUEUE}:repeatable:sweep`,
          repeat: { pattern: '30 0 * * *' },
          removeOnComplete: { count: 30 },
          removeOnFail: { count: 30 },
        },
      );
      this.logger.log(
        `scheduled repeatable: queue=${CREDIT_EXPIRE_QUEUE} cron="30 0 * * *"`,
      );
    } catch (err) {
      this.logger.error(
        `failed to schedule credit-expire: ${(err as Error).message}`,
      );
    }
  }

  async process(job: Job): Promise<{ scanned: number; expired: number; failed: number; totalReversed: number }> {
    this.logger.log(`credit-expire tick (job=${job.id})`);
    const result = await this.service.sweep();
    return result;
  }
}

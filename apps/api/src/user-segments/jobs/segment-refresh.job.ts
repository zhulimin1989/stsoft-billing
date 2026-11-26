/**
 * UserSegment hourly refresh job (BullMQ Repeatable).
 *
 * - Queue: `segment-refresh`
 * - Repeatable: every hour at :00
 * - Worker: re-resolves every active DYNAMIC segment's ruleExpr and writes the
 *   resulting count back to UserSegment.memberCount.
 *
 * Static segments are NOT touched by this job — their memberCount is updated
 * synchronously by the service whenever members are added/removed.
 */

import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { UserSegmentsService } from '../user-segments.service';

export const SEGMENT_REFRESH_QUEUE = 'segment-refresh';
export const SEGMENT_REFRESH_JOB_NAME = 'hourly';

@Processor(SEGMENT_REFRESH_QUEUE)
export class SegmentRefreshProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SegmentRefreshProcessor.name);

  constructor(
    @InjectQueue(SEGMENT_REFRESH_QUEUE)
    private readonly queue: Queue,
    private readonly service: UserSegmentsService,
  ) {
    super();
  }

  /**
   * On boot, ensure the hourly Repeatable Job is scheduled. BullMQ dedupes
   * Repeatables by their `key`, so even with N replicas only one schedule
   * persists. The actual job execution is also single-flight per replica via
   * BullMQ's Worker concurrency — and idempotent (just writes counts).
   */
  async onModuleInit(): Promise<void> {
    try {
      // Cron: at minute 0 every hour. UTC.
      await this.queue.add(
        SEGMENT_REFRESH_JOB_NAME,
        {},
        {
          repeat: { pattern: '0 * * * *' },
          removeOnComplete: { count: 24 },
          removeOnFail: { count: 24 },
        },
      );
      this.logger.log(
        `scheduled repeatable: queue=${SEGMENT_REFRESH_QUEUE} cron="0 * * * *"`,
      );
    } catch (err) {
      this.logger.error(
        `failed to schedule segment-refresh: ${(err as Error).message}`,
      );
    }
  }

  async process(job: Job): Promise<{ ok: number; failed: number }> {
    this.logger.log(`segment-refresh tick (job=${job.id})`);
    const result = await this.service.refreshAllDynamic();
    this.logger.log(
      `segment-refresh done: ok=${result.ok} failed=${result.failed}`,
    );
    return result;
  }
}

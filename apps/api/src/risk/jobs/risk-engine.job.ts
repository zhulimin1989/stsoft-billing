/**
 * Risk engine BullMQ Repeatable: every 5 minutes scan all active rules
 * (USAGE_THRESHOLD / IP_LIMIT / REFUND_RATE) and create RiskFlag rows.
 *
 * BLACKLIST is handled on the request path via RiskEngineService.isUserBlocked.
 * FRAUD_PROVIDER is handled by external webhook (out of PR6 scope).
 *
 * jobId is stable so onModuleInit calls are idempotent across restarts.
 */
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { RiskEngineService } from '../risk-engine.service';

export const RISK_ENGINE_QUEUE = 'risk-engine';
export const RISK_ENGINE_SCAN_JOB = 'scan';

@Processor(RISK_ENGINE_QUEUE)
export class RiskEngineProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RiskEngineProcessor.name);

  constructor(
    @InjectQueue(RISK_ENGINE_QUEUE)
    private readonly queue: Queue,
    private readonly engine: RiskEngineService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        RISK_ENGINE_SCAN_JOB,
        { tick: 'periodic' },
        {
          jobId: `${RISK_ENGINE_QUEUE}:repeatable:scan`,
          repeat: { pattern: '*/5 * * * *' },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      );
      this.logger.log(
        `scheduled repeatable: ${RISK_ENGINE_SCAN_JOB} every 5 minutes`,
      );
    } catch (err) {
      this.logger.error(
        `failed to schedule risk-engine job: ${(err as Error).message}`,
      );
    }
  }

  async process(job: Job): Promise<{
    rulesScanned: number;
    totalMatched: number;
    totalFlagsCreated: number;
  }> {
    this.logger.log(`risk-engine tick (job=${job.id})`);
    const result = await this.engine.scanAll();
    this.logger.log(
      `risk-engine done: rules=${result.rulesScanned} matched=${result.totalMatched} flagsCreated=${result.totalFlagsCreated}`,
    );
    return {
      rulesScanned: result.rulesScanned,
      totalMatched: result.totalMatched,
      totalFlagsCreated: result.totalFlagsCreated,
    };
  }
}

/**
 * Ticket SLA BullMQ Repeatable: every 30 minutes, scan OPEN/IN_PROGRESS
 * tickets per priority and emit an AlertEvent for any past their SLA window.
 *
 * Per-priority SLA: URGENT 1h / HIGH 4h / NORMAL 24h / LOW 72h.
 * 24h dedup window inside TicketsService.checkSla() prevents repeat
 * notifications for the same ticket.
 *
 * jobId is stable so onModuleInit calls are idempotent across restarts.
 */
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { TicketsService } from '../tickets.service';

export const TICKET_SLA_QUEUE = 'ticket-sla';
export const TICKET_SLA_SCAN_JOB = 'scan';

@Processor(TICKET_SLA_QUEUE)
export class TicketSlaProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(TicketSlaProcessor.name);

  constructor(
    @InjectQueue(TICKET_SLA_QUEUE)
    private readonly queue: Queue,
    private readonly tickets: TicketsService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        TICKET_SLA_SCAN_JOB,
        { tick: 'periodic' },
        {
          jobId: `${TICKET_SLA_QUEUE}:repeatable:scan`,
          repeat: { pattern: '*/30 * * * *' },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      );
      this.logger.log(
        `scheduled repeatable: ${TICKET_SLA_SCAN_JOB} every 30 minutes`,
      );
    } catch (err) {
      this.logger.error(
        `failed to schedule ticket-sla job: ${(err as Error).message}`,
      );
    }
  }

  async process(job: Job): Promise<{
    scanned: number;
    overdue: number;
    alerted: number;
  }> {
    this.logger.log(`ticket-sla tick (job=${job.id})`);
    const result = await this.tickets.checkSla();
    this.logger.log(
      `ticket-sla done: scanned=${result.scanned} overdue=${result.overdue} alerted=${result.alerted}`,
    );
    return result;
  }
}

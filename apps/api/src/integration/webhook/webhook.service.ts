import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { signHmac, webhookTimestamp } from '../../common/utils/hmac.util';
import { WEBHOOK_QUEUE } from './webhook.queue';
import type { WebhookJobData } from './webhook.dto';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue<WebhookJobData>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Enqueue a signed webhook. Caller is fire-and-forget.
   * BullMQ worker delivers with exponential backoff (1s/2s/4s), 3 attempts max.
   * Failed jobs are retained (removeOnFail: false) for DLQ inspection.
   */
  async enqueueSigned(
    url: string,
    payload: Record<string, unknown>,
    opts: { label: string; secret?: string },
  ): Promise<void> {
    const syncToken = this.config.get<string>('SYNC_TOKEN') || '';
    const secret = opts.secret || this.config.get<string>('SYNC_WEBHOOK_SECRET') || syncToken;

    const ts = webhookTimestamp();
    const body = JSON.stringify(payload);
    let signature = '';
    try {
      signature = signHmac(secret, ts, body);
    } catch (e) {
      this.logger.error(
        `[${opts.label}] HMAC sign failed at enqueue: ${(e as Error).message}`,
      );
      return; // do not enqueue unsigned payloads
    }

    try {
      await this.queue.add(
        opts.label,
        { url, body, timestamp: ts, signature, label: opts.label, syncToken },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s
          removeOnComplete: { count: 100 },
          removeOnFail: false, // retain failed for DLQ inspection
        },
      );
    } catch (err) {
      // Enqueue itself failing means Redis/Bull is down. The job never
      // enters the queue, so our DLQ never sees it. Surface it loudly
      // with the full payload so an operator (or a log-based alert)
      // can replay manually. Do NOT rethrow — callers are fire-and-forget
      // and we must not crash the admin request that triggered this.
      this.logger.error(
        `[${opts.label}] WEBHOOK_ENQUEUE_FAILED (queue unavailable): ${(err as Error).message} ` +
          `| url=${url} | payload=${body}`,
        (err as Error).stack,
      );
    }
  }
}

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { assertSafeExternalUrl } from '../../common/utils/url-guard.util';
import { WEBHOOK_QUEUE } from './webhook.queue';
import type { WebhookJobData } from './webhook.dto';

@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { url, body, timestamp, signature, label, syncToken } = job.data;

    // SSRF guard (defense in depth — URL is embedded at enqueue time,
    // but the guard is cheap and prevents any data-layer tampering).
    // Treat guard failure as UNRECOVERABLE — the URL won't pass on retry,
    // retrying would just waste queue attempts and delay DLQ visibility.
    try {
      await assertSafeExternalUrl(url);
    } catch (err) {
      const msg = `[${label}] SSRF guard blocked URL: ${(err as Error).message}`;
      this.logger.error(msg);
      throw new UnrecoverableError(msg);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Token': syncToken,
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      this.logger.log(`[${label}] delivered (attempt ${job.attemptsMade + 1})`);
      return;
    }

    // 4xx = non-retryable; throw UnrecoverableError to stop retries immediately
    if (res.status >= 400 && res.status < 500) {
      const msg = `[${label}] 4xx non-retryable: ${res.status}`;
      this.logger.warn(msg);
      throw new UnrecoverableError(msg);
    }

    // 5xx / network: throw regular error → BullMQ retries per backoff config
    throw new Error(`[${label}] ${res.status} retrying`);
  }
}

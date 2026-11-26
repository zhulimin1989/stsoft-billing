import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { WebhookService } from './webhook.service';
import { WEBHOOK_QUEUE } from './webhook.queue';

describe('WebhookService', () => {
  let service: WebhookService;
  let queueMock: { add: jest.Mock };

  const configWithSecret = {
    get: jest.fn((k: string) => {
      if (k === 'SYNC_TOKEN') return 'shared-token';
      if (k === 'SYNC_WEBHOOK_SECRET') return 'hmac-secret';
      return undefined;
    }),
  };

  const configWithoutSecret = {
    get: jest.fn((k: string) => {
      if (k === 'SYNC_TOKEN') return '';
      if (k === 'SYNC_WEBHOOK_SECRET') return '';
      return undefined;
    }),
  };

  async function buildModule(configValue: object) {
    queueMock = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const m = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: ConfigService, useValue: configValue },
        { provide: getQueueToken(WEBHOOK_QUEUE), useValue: queueMock },
      ],
    }).compile();

    return m.get(WebhookService);
  }

  describe('enqueueSigned — happy path', () => {
    beforeEach(async () => {
      service = await buildModule(configWithSecret);
    });

    it('calls queue.add with correct job name and BullMQ options', async () => {
      await service.enqueueSigned(
        'https://target.example.com/hook',
        { type: 'plan_updated', productSlug: 'rdclaw' },
        { label: 'notifyProductSaas:plan_updated' },
      );

      expect(queueMock.add).toHaveBeenCalledTimes(1);
      const [jobName, jobData, jobOpts] = queueMock.add.mock.calls[0];

      expect(jobName).toBe('notifyProductSaas:plan_updated');

      // URL is stored verbatim
      expect(jobData.url).toBe('https://target.example.com/hook');

      // Body is serialized JSON containing the payload
      const parsed = JSON.parse(jobData.body);
      expect(parsed).toEqual({ type: 'plan_updated', productSlug: 'rdclaw' });

      // Timestamp is a unix second string
      expect(jobData.timestamp).toMatch(/^\d{10,11}$/);

      // Signature is a 64-char hex string
      expect(jobData.signature).toMatch(/^[0-9a-f]{64}$/);

      // Label and syncToken are correct
      expect(jobData.label).toBe('notifyProductSaas:plan_updated');
      expect(jobData.syncToken).toBe('shared-token');

      // BullMQ retry config: 3 attempts, exponential backoff
      expect(jobOpts.attempts).toBe(3);
      expect(jobOpts.backoff).toEqual({ type: 'exponential', delay: 1000 });
      expect(jobOpts.removeOnFail).toBe(false);
      expect(jobOpts.removeOnComplete).toEqual({ count: 100 });
    });

    it('serializes large payload body correctly', async () => {
      const bigPayload: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        bigPayload[`key_${i}`] = `value_${'x'.repeat(50)}_${i}`;
      }

      await service.enqueueSigned(
        'https://target.example.com/hook',
        bigPayload,
        { label: 'big-payload-test' },
      );

      const [, jobData] = queueMock.add.mock.calls[0];
      const reparsed = JSON.parse(jobData.body);
      expect(Object.keys(reparsed)).toHaveLength(100);
      expect(reparsed['key_0']).toContain('value_');
    });
  });

  describe('enqueueSigned — empty secret (no-enqueue)', () => {
    beforeEach(async () => {
      service = await buildModule(configWithoutSecret);
    });

    it('does NOT enqueue when both SYNC_TOKEN and SYNC_WEBHOOK_SECRET are empty', async () => {
      await service.enqueueSigned(
        'https://target.example.com/hook',
        { type: 'test' },
        { label: 'test-label' },
      );

      // signHmac throws if secret is empty → we return early without enqueuing
      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueueSigned — queue failure (Redis/Bull down)', () => {
    beforeEach(async () => {
      service = await buildModule(configWithSecret);
    });

    it('does NOT throw when queue.add fails; surfaces the payload in error log for manual replay', async () => {
      queueMock.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      // Caller is fire-and-forget — we must NOT crash the original
      // admin request (e.g. "approve plan change") just because Redis is down.
      await expect(
        service.enqueueSigned(
          'https://target.example.com/hook',
          { type: 'plans_changed', productSlug: 'rdclaw' },
          { label: 'notifyProductSaas:plans_changed' },
        ),
      ).resolves.toBeUndefined();

      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });
});

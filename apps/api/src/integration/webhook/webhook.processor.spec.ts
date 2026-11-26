import { BadRequestException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { WebhookProcessor } from './webhook.processor';
import type { WebhookJobData } from './webhook.dto';

// Mock DNS so SSRF guard tests work without network
jest.mock('node:dns', () => ({
  promises: { lookup: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dnsMock = require('node:dns').promises.lookup as jest.Mock;

const fetchSpy = jest.fn();
(global as any).fetch = fetchSpy;

function makeJob(overrides: Partial<WebhookJobData> = {}): any {
  return {
    data: {
      url: 'https://safe.example.com/hook',
      body: JSON.stringify({ type: 'plan_updated' }),
      timestamp: '1700000000',
      signature: 'abc123',
      label: 'test:plan_updated',
      syncToken: 'shared-token',
      ...overrides,
    },
    attemptsMade: 0,
  };
}

describe('WebhookProcessor', () => {
  let processor: WebhookProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    dnsMock.mockReset();
    dnsMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    processor = new WebhookProcessor();
  });

  it('HTTP 200 → resolves without throwing', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends correct headers and body to target URL', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    await processor.process(makeJob());

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://safe.example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Sync-Token']).toBe('shared-token');
    expect(init.headers['X-Webhook-Timestamp']).toBe('1700000000');
    expect(init.headers['X-Webhook-Signature']).toBe('abc123');
    expect(init.body).toBe(JSON.stringify({ type: 'plan_updated' }));
  });

  it('HTTP 503 → throws regular Error (triggers BullMQ retry)', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });

    await expect(processor.process(makeJob())).rejects.toThrow(Error);
    await expect(processor.process(makeJob())).rejects.not.toThrow(UnrecoverableError);
  });

  it('HTTP 404 → throws UnrecoverableError (4xx non-retryable)', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
    await expect(processor.process(makeJob())).rejects.toThrow(/4xx non-retryable/);
  });

  it('HTTP 400 → throws UnrecoverableError (4xx non-retryable)', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 400 });

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
  });

  it('HTTP 499 → throws UnrecoverableError (4xx boundary)', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 499 });

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
  });

  it('HTTP 500 → throws regular Error (5xx retryable)', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });

    const err = await processor.process(makeJob()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('network error (fetch throws) → propagates as regular Error (BullMQ retries)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('ETIMEDOUT'));

    await expect(processor.process(makeJob())).rejects.toThrow('ETIMEDOUT');
  });

  it('SSRF guard rejects internal IP → throws UnrecoverableError (no retry) before fetch', async () => {
    const job = makeJob({ url: 'http://127.0.0.1:8080/hook' });

    // SSRF-blocked URLs must NOT retry — the URL won't become safe on retry,
    // and retrying wastes queue slots before reaching DLQ.
    await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('SSRF guard rejects DNS-rebinding to internal IP (UnrecoverableError)', async () => {
    dnsMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const job = makeJob({ url: 'https://rebind.attacker.test/x' });

    await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

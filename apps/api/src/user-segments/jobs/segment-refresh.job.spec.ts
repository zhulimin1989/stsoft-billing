import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  SEGMENT_REFRESH_QUEUE,
  SegmentRefreshProcessor,
} from './segment-refresh.job';
import { UserSegmentsService } from '../user-segments.service';

describe('SegmentRefreshProcessor', () => {
  let processor: SegmentRefreshProcessor;
  let queue: { add: jest.Mock };
  let service: { refreshAllDynamic: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    service = { refreshAllDynamic: jest.fn() };

    // BullMQ's WorkerHost wires up a real Worker on construction unless we
    // stub it. Easiest path: bypass DI's instantiation and construct manually.
    const module = await Test.createTestingModule({
      providers: [
        { provide: getQueueToken(SEGMENT_REFRESH_QUEUE), useValue: queue },
        { provide: UserSegmentsService, useValue: service },
        {
          provide: SegmentRefreshProcessor,
          useFactory: (q: any, s: any) => {
            // Construct without invoking the WorkerHost super hooks too aggressively.
            const inst = Object.create(SegmentRefreshProcessor.prototype);
            (inst as any).queue = q;
            (inst as any).service = s;
            (inst as any).logger = { log: jest.fn(), error: jest.fn() };
            return inst as SegmentRefreshProcessor;
          },
          inject: [getQueueToken(SEGMENT_REFRESH_QUEUE), UserSegmentsService],
        },
      ],
    }).compile();

    processor = module.get(SegmentRefreshProcessor);
  });

  it('onModuleInit schedules a repeatable hourly job', async () => {
    await processor.onModuleInit();
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('hourly');
    expect(data).toEqual({});
    expect(opts.repeat).toEqual({ pattern: '0 * * * *' });
    expect(opts.removeOnComplete).toBeDefined();
    expect(opts.removeOnFail).toBeDefined();
  });

  it('onModuleInit swallows scheduling errors (does not crash boot)', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(processor.onModuleInit()).resolves.toBeUndefined();
  });

  it('process delegates to service.refreshAllDynamic and returns result', async () => {
    service.refreshAllDynamic.mockResolvedValueOnce({ ok: 3, failed: 1 });
    const r = await processor.process({ id: '1' } as any);
    expect(r).toEqual({ ok: 3, failed: 1 });
    expect(service.refreshAllDynamic).toHaveBeenCalled();
  });
});

import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { TicketsService } from '../tickets.service';
import {
  TICKET_SLA_QUEUE,
  TICKET_SLA_SCAN_JOB,
  TicketSlaProcessor,
} from './ticket-sla.job';

describe('TicketSlaProcessor', () => {
  let processor: TicketSlaProcessor;
  let queue: any;
  let service: any;

  beforeEach(async () => {
    queue = { add: jest.fn() };
    service = { checkSla: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        TicketSlaProcessor,
        { provide: getQueueToken(TICKET_SLA_QUEUE), useValue: queue },
        { provide: TicketsService, useValue: service },
      ],
    }).compile();
    processor = module.get(TicketSlaProcessor);
  });

  it('onModuleInit: schedules repeatable job with stable id', async () => {
    queue.add.mockResolvedValueOnce({ id: 'j1' });
    await processor.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      TICKET_SLA_SCAN_JOB,
      expect.any(Object),
      expect.objectContaining({
        jobId: `${TICKET_SLA_QUEUE}:repeatable:scan`,
        repeat: { pattern: '*/30 * * * *' },
      }),
    );
  });

  it('onModuleInit: swallows queue add failure (logged, not thrown)', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(processor.onModuleInit()).resolves.toBeUndefined();
  });

  it('process: calls checkSla and returns its result', async () => {
    service.checkSla.mockResolvedValueOnce({
      scanned: 5,
      overdue: 2,
      alerted: 1,
    });
    const r = await processor.process({ id: 'job1' } as any);
    expect(r).toEqual({ scanned: 5, overdue: 2, alerted: 1 });
    expect(service.checkSla).toHaveBeenCalled();
  });
});

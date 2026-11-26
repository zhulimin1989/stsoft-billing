import { Test } from '@nestjs/testing';
import { AlertEventService } from './alert-events/alert-events.service';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';

function makeReply() {
  const reply = { statusCode: 200, status: jest.fn() };
  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  return reply as unknown as { statusCode: number; status: jest.Mock };
}

async function buildController(
  prismaOverride?: any,
  redisOverride?: any,
  alertOverride?: any,
) {
  const prisma = prismaOverride ?? { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
  const redis = redisOverride ?? { ping: jest.fn().mockResolvedValue('PONG') };
  const alertEvents = alertOverride ?? {
    createSystemAlert: jest.fn().mockResolvedValue({ id: 'a' }),
  };

  const m = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
      { provide: AlertEventService, useValue: alertEvents },
    ],
  }).compile();
  return { controller: m.get(HealthController), prisma, redis, alertEvents };
}

describe('HealthController.live', () => {
  it('returns alive with uptime — never touches downstream', async () => {
    const { controller, prisma, redis } = await buildController();
    const result = controller.live();

    expect(result.code).toBe(0);
    expect(result.data.status).toBe('alive');
    expect(result.data.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.ping).not.toHaveBeenCalled();
  });
});

describe('HealthController.ready', () => {
  it('returns 200 + ok when DB and Redis both respond', async () => {
    const { controller } = await buildController();
    const reply = makeReply();

    const result = await controller.ready(reply as any);

    expect(reply.status).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
    expect(result.data.status).toBe('ok');
    expect(result.data.checks.db.status).toBe('ok');
    expect(result.data.checks.redis.status).toBe('ok');
    expect(result.data.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 + degraded when DB check throws', async () => {
    const { controller } = await buildController(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')) },
    );
    const reply = makeReply();

    const result = await controller.ready(reply as any);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.code).toBe(1);
    expect(result.data.status).toBe('degraded');
    expect(result.data.checks.db.status).toBe('down');
    expect(result.data.checks.db.error).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('connection refused');
    expect(result.data.checks.redis.status).toBe('ok');
  });

  it('returns 503 when Redis is down', async () => {
    const { controller } = await buildController(undefined, {
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const reply = makeReply();

    const result = await controller.ready(reply as any);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.data.checks.redis.status).toBe('down');
  });

  it('returns 503 when both are down (checks run in parallel)', async () => {
    const { controller } = await buildController(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('db gone')) },
      { ping: jest.fn().mockRejectedValue(new Error('redis gone')) },
    );
    const reply = makeReply();

    const result = await controller.ready(reply as any);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.data.checks.db.status).toBe('down');
    expect(result.data.checks.redis.status).toBe('down');
  });

  it('times out a hanging DB query instead of blocking forever', async () => {
    jest.useFakeTimers();
    let rejectHang: ((err: Error) => void) | undefined;
    const hang = new Promise((_, reject) => {
      rejectHang = reject;
    });
    const { controller } = await buildController({ $queryRaw: jest.fn(() => hang) });
    const reply = makeReply();

    const pending = controller.ready(reply as any);
    // Advance past the 1500ms timeout
    jest.advanceTimersByTime(2000);
    const result = await pending;

    expect(result.data.checks.db.status).toBe('down');
    expect(result.data.checks.db.error).toBe('timeout');
    expect(JSON.stringify(result)).not.toContain('db check timed out');
    // Clean up the dangling promise so jest doesn't keep an open handle.
    rejectHang?.(new Error('teardown'));
    jest.useRealTimers();
  });
});

describe('HealthController.check (legacy /health)', () => {
  it('delegates to readiness so old callers get real status', async () => {
    const { controller } = await buildController();
    const reply = makeReply();

    const result = await controller.check(reply as any);

    expect(result.data.checks.db.status).toBe('ok');
    expect(result.data.checks.redis.status).toBe('ok');
  });

  it('legacy route returns 503 when downstream down', async () => {
    const { controller } = await buildController(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('x')) },
    );
    const reply = makeReply();

    await controller.check(reply as any);

    expect(reply.status).toHaveBeenCalledWith(503);
  });
});

// =====================================================================
// P2-A3 §8.2 系统健康占位:redis ping fail 时调 createSystemAlert
// =====================================================================
describe('HealthController.ready — system alert on redis down', () => {
  it('emits SYSTEM alert via createSystemAlert when redis ping rejects', async () => {
    const { controller, alertEvents } = await buildController(undefined, {
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const reply = makeReply();

    await controller.ready(reply as any);

    expect(alertEvents.createSystemAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createSystemAlert.mock.calls[0][0];
    expect(arg.metric).toBe('redis_unreachable');
    expect(arg.severity).toBe('CRITICAL');
    expect(arg.message).toContain('ECONNREFUSED');
  });

  it('does NOT emit when redis is healthy', async () => {
    const { controller, alertEvents } = await buildController();
    const reply = makeReply();

    await controller.ready(reply as any);

    expect(alertEvents.createSystemAlert).not.toHaveBeenCalled();
  });

  it('createSystemAlert throw is swallowed — ready still returns 503 cleanly', async () => {
    const { controller, alertEvents } = await buildController(
      undefined,
      { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
      {
        createSystemAlert: jest.fn().mockRejectedValue(new Error('alert dead')),
      },
    );
    const reply = makeReply();

    const result = await controller.ready(reply as any);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(result.data.checks.redis.status).toBe('down');
    expect(alertEvents.createSystemAlert).toHaveBeenCalled();
  });
});

import { Injectable } from '@nestjs/common';
import { InvoiceActorType, InvoiceApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = PrismaService | Prisma.TransactionClient;

export interface RecordEventInput {
  applicationId: string;
  fromStatus: InvoiceApplicationStatus | null;
  toStatus: InvoiceApplicationStatus;
  actorType: InvoiceActorType;
  actorId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class InvoiceEventService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordEventInput, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.invoiceEventLog.create({
      data: {
        applicationId: input.applicationId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        reason: input.reason ?? null,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });
  }

  async listForApplication(applicationId: string) {
    return this.prisma.invoiceEventLog.findMany({
      where: { applicationId },
      orderBy: { occurredAt: 'asc' },
    });
  }
}

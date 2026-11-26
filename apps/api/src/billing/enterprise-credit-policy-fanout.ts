import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';

export type EnterpriseCreditPolicyFanoutTarget = {
  billingAccountId: string;
  eventId: string;
  policyRevision: number;
};

export type EnterpriseCreditTimedFanoutPhase = 'ACTIVATION' | 'EXPIRATION';

/**
 * Publish the current account-level balance projection and durably record that
 * this policy revision has been handed to Publisher. The async Publisher path
 * either accepts each key refresh or creates a durable PublisherSyncJob; any
 * enumeration/database failure propagates so the policy recovery sweep can
 * retry an unmarked event.
 */
export async function enqueueEnterpriseCreditPolicyFanout(
  prisma: PrismaService,
  publisherSync: PublisherSyncService,
  target: EnterpriseCreditPolicyFanoutTarget,
): Promise<void> {
  await publisherSync.syncBillingAccountKeyBalances(target.billingAccountId);

  const marked = await prisma.billingAccountCreditEvent.updateMany({
    where: {
      id: target.eventId,
      billingAccountId: target.billingAccountId,
      policyRevision: target.policyRevision,
      policyBoundaryComplete: true,
      policyFanoutEnqueuedAt: null,
    },
    data: { policyFanoutEnqueuedAt: new Date() },
  });
  if (marked.count === 1) return;

  // A concurrent replay may have marked the same immutable event after this
  // publisher call. Accept only that exact terminal state; every other shape
  // is a hard failure and remains visible to the recovery worker.
  const event = await prisma.billingAccountCreditEvent.findUnique({
    where: { id: target.eventId },
    select: {
      billingAccountId: true,
      policyRevision: true,
      policyBoundaryComplete: true,
      policyFanoutEnqueuedAt: true,
    },
  });
  if (
    event?.billingAccountId === target.billingAccountId
    && event.policyRevision === target.policyRevision
    && event.policyBoundaryComplete
    && event.policyFanoutEnqueuedAt instanceof Date
  ) {
    return;
  }
  throw new Error(
    `enterprise credit policy fanout marker conflict: ${target.billingAccountId}:${target.policyRevision}`,
  );
}

/**
 * Re-project a policy when wall-clock time crosses effectiveAt/expiresAt. Each
 * phase has a separate monotonic marker because the immediate revision fanout
 * may have happened long before either boundary. Publisher's async path is
 * already durable; the marker is written only after every Key was accepted or
 * queued, so a worker crash safely repeats the projection.
 */
export async function enqueueEnterpriseCreditTimedFanout(
  prisma: PrismaService,
  publisherSync: PublisherSyncService,
  target: EnterpriseCreditPolicyFanoutTarget & {
    phase: EnterpriseCreditTimedFanoutPhase;
  },
): Promise<void> {
  await publisherSync.syncBillingAccountKeyBalances(target.billingAccountId);

  const markerField = target.phase === 'ACTIVATION'
    ? 'activationFanoutEnqueuedAt'
    : 'expirationFanoutEnqueuedAt';
  const marked = await prisma.billingAccountCreditEvent.updateMany({
    where: {
      id: target.eventId,
      billingAccountId: target.billingAccountId,
      policyRevision: target.policyRevision,
      policyBoundaryComplete: true,
      [markerField]: null,
    },
    data: { [markerField]: new Date() },
  });
  if (marked.count === 1) return;

  const event = await prisma.billingAccountCreditEvent.findUnique({
    where: { id: target.eventId },
    select: {
      billingAccountId: true,
      policyRevision: true,
      policyBoundaryComplete: true,
      activationFanoutEnqueuedAt: true,
      expirationFanoutEnqueuedAt: true,
    },
  });
  const marker = target.phase === 'ACTIVATION'
    ? event?.activationFanoutEnqueuedAt
    : event?.expirationFanoutEnqueuedAt;
  if (
    event?.billingAccountId === target.billingAccountId
    && event.policyRevision === target.policyRevision
    && event.policyBoundaryComplete
    && marker instanceof Date
  ) {
    return;
  }
  throw new Error(
    `enterprise credit ${target.phase.toLowerCase()} fanout marker conflict: `
    + `${target.billingAccountId}:${target.policyRevision}`,
  );
}

import { Injectable } from '@nestjs/common';
import { InvoiceProfile, InvoiceProfileKind, InvoiceType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceAccessDeniedError, InvoiceProfileNotFoundError } from './invoice.errors';

export interface CreateProfileInput {
  userId: string;
  tenantId: string;
  kind: InvoiceProfileKind;
  invoiceType: InvoiceType;
  title: string;
  taxNo?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  registeredAddress?: string | null;
  registeredPhone?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  recipientAddress?: string | null;
  isDefault?: boolean;
}

export type UpdateProfileInput = Partial<Omit<CreateProfileInput, 'userId' | 'tenantId'>>;

@Injectable()
export class InvoiceProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, tenantId: string): Promise<InvoiceProfile[]> {
    return this.prisma.invoiceProfile.findMany({
      where: { userId, tenantId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async create(input: CreateProfileInput): Promise<InvoiceProfile> {
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await this.clearDefault(tx, input.userId, input.tenantId);
      }
      return tx.invoiceProfile.create({
        data: {
          userId: input.userId,
          tenantId: input.tenantId,
          kind: input.kind,
          invoiceType: input.invoiceType,
          title: input.title,
          taxNo: input.taxNo ?? null,
          bankName: input.bankName ?? null,
          bankAccount: input.bankAccount ?? null,
          registeredAddress: input.registeredAddress ?? null,
          registeredPhone: input.registeredPhone ?? null,
          recipientName: input.recipientName ?? null,
          recipientEmail: input.recipientEmail ?? null,
          recipientPhone: input.recipientPhone ?? null,
          recipientAddress: input.recipientAddress ?? null,
          isDefault: input.isDefault ?? false,
        },
      });
    });
  }

  async update(
    userId: string,
    tenantId: string,
    id: string,
    input: UpdateProfileInput,
  ): Promise<InvoiceProfile> {
    const existing = await this.requireOwnedProfile(userId, tenantId, id);
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await this.clearDefault(tx, userId, tenantId, existing.id);
      }
      return tx.invoiceProfile.update({
        where: { id: existing.id },
        data: input,
      });
    });
  }

  async softDelete(userId: string, tenantId: string, id: string): Promise<void> {
    const existing = await this.requireOwnedProfile(userId, tenantId, id);
    await this.prisma.invoiceProfile.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }

  /**
   * 内部调用：拉抬头并校验属于该 user/tenant，给 submitApplication 使用。
   */
  async requireOwnedProfile(
    userId: string,
    tenantId: string,
    id: string,
  ): Promise<InvoiceProfile> {
    const profile = await this.prisma.invoiceProfile.findFirst({
      where: { id, deletedAt: null },
    });
    if (!profile) throw new InvoiceProfileNotFoundError();
    if (profile.userId !== userId || profile.tenantId !== tenantId) {
      throw new InvoiceAccessDeniedError();
    }
    return profile;
  }

  private async clearDefault(
    tx: PrismaService | Prisma.TransactionClient,
    userId: string,
    tenantId: string,
    excludeId?: string,
  ): Promise<void> {
    await tx.invoiceProfile.updateMany({
      where: {
        userId,
        tenantId,
        isDefault: true,
        deletedAt: null,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      data: { isDefault: false },
    });
  }
}

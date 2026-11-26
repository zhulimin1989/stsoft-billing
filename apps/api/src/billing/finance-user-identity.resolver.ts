import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type FinanceUserContact,
  UserPurchaseVerificationClient,
} from '../payment/user-purchase-verification.client';

export type FinanceUserSearchPlan = {
  userIds: string[];
  apiKeyIds: string[];
  billingAccountIds: string[];
  tenantIds: string[];
};

@Injectable()
export class FinanceUserIdentityResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userClient: UserPurchaseVerificationClient,
  ) {}

  async resolveSearch(value: string): Promise<FinanceUserSearchPlan> {
    const authoritativeUserIds = await this.userClient.findFinanceUserIdsByContact(value);
    const [localUsers, enterpriseAccounts] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            { id: value },
            { email: { equals: value, mode: 'insensitive' } },
            { phone: value },
          ],
        },
        select: { id: true },
        take: 3,
      }),
      this.prisma.billingAccount.findMany({
        where: {
          type: 'enterprise',
          verificationId: { not: null },
          enterpriseName: { contains: value, mode: 'insensitive' },
        },
        select: { id: true },
      }),
    ]);
    const userIds = this.unique([
      value,
      ...authoritativeUserIds,
      ...localUsers.map((user) => user.id),
    ]);
    const billingAccountIds = this.unique(enterpriseAccounts.map((account) => account.id));
    const [apiKeys, tenants] = await Promise.all([
      this.prisma.apiKey.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      }),
      billingAccountIds.length > 0
        ? this.prisma.tenant.findMany({
            where: { billingAccountId: { in: billingAccountIds } },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      userIds,
      apiKeyIds: this.unique(apiKeys.map((apiKey) => apiKey.id)),
      billingAccountIds,
      tenantIds: this.unique(tenants.map((tenant) => tenant.id)),
    };
  }

  async getContactsByIds(ids: string[]): Promise<Map<string, FinanceUserContact>> {
    const contacts = await this.userClient.getFinanceUserContactsByIds(this.unique(ids));
    return new Map(contacts.map((contact) => [contact.id, contact]));
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  }
}

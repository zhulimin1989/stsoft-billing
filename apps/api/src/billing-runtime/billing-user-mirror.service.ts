import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_SOURCE_UPDATED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type BillingUserMirrorSnapshot = {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
  isActive?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
};

@Injectable()
export class BillingUserMirrorService {
  private readonly logger = new Logger(BillingUserMirrorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async mirrorUser(
    snapshot: BillingUserMirrorSnapshot,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ id: string; skippedStale: boolean; sourceUpdatedAt: Date | null }> {
    const userId = this.requireString(snapshot.id, 'user.id');
    const sourceUpdatedAt = this.parseOptionalDate(snapshot.sourceUpdatedAt);
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, sourceUpdatedAt: true },
    });

    if (this.isStale(existing?.sourceUpdatedAt ?? null, sourceUpdatedAt)) {
      await db.user.updateMany({
        where: { id: userId },
        data: { mirroredAt: new Date() },
      });
      return { id: userId, skippedStale: true, sourceUpdatedAt: existing?.sourceUpdatedAt ?? null };
    }

    const email = this.hasOwn(snapshot, 'email')
      ? await this.normalizeUniqueEmail(db, userId, snapshot.email)
      : undefined;
    const phone = this.hasOwn(snapshot, 'phone')
      ? await this.normalizeUniquePhone(db, userId, snapshot.phone)
      : undefined;
    const hasNickname = this.hasOwn(snapshot, 'nickname');
    const emailForNickname = this.hasOwn(snapshot, 'email')
      ? this.normalizeNullableString(snapshot.email)
      : null;
    const nickname = hasNickname
      ? this.normalizeNickname(snapshot.nickname, snapshot.email)
      : emailForNickname
        ? this.normalizeNickname(undefined, emailForNickname)
        : undefined;
    const hasIsActive = typeof snapshot.isActive === 'boolean';
    const mirroredAt = new Date();

    await db.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        email: email ?? null,
        phone: phone ?? null,
        nickname: nickname ?? this.normalizeNickname(undefined, snapshot.email),
        isActive: hasIsActive ? Boolean(snapshot.isActive) : true,
        sourceUpdatedAt,
        mirroredAt,
      },
      update: {
        ...(email !== undefined ? { email } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(nickname !== undefined ? { nickname } : {}),
        ...(hasIsActive ? { isActive: Boolean(snapshot.isActive) } : {}),
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        mirroredAt,
      },
    });

    if (hasIsActive) {
      await this.updateOwnedBillingAccounts(db, userId, Boolean(snapshot.isActive));
    }

    return { id: userId, skippedStale: false, sourceUpdatedAt };
  }

  private async updateOwnedBillingAccounts(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    isActive: boolean,
  ): Promise<void> {
    // ⚠️ 只同步**个人**账户（评审 P1）：企业账户的状态归开通/回收编排独占。
    //
    // 不加这个过滤的后果：企业开通被作废回收后账户是 suspended、owner 成员是 inactive，
    // 而 owner 之后任何一次带 isActive 的镜像（改个昵称就够）都会把它们推回 active/active
    // ⇒ 批一自己的验收断言（「账户 suspended、成员失活」）被悄悄推翻，
    // 且 /reconcile 的 anyAccountActive 永久为 true、/hazards 永久成单。
    //
    // 用 type 而不是 quarantine 判据：前者贴语义（这个方法本就只该管个人账户），
    // 后者容易漏（回收中的中间态、软删行等都要各自判一遍）。
    // ⚠️ 只碰**个人**账户，两个方向都一样（终审 P1：上一版的「非对称」已回退）。
    //
    // 我上一版让收缩方向（isActive=false）连企业账户一起 suspend，本意是纵深防御，
    // 但实测查执行点后确认那是**负收益**：
    //   · `account.status !== 'active'` **不拦消费** —— 网关准入投影只过 deleted_at
    //     （publisher-sync.service.ts 的准入 SQL），status 压根不在里面；
    //     它拦的是 resolveFundingAnchor（企业充值/授信）⇒ 效果是「消费照旧、打款被封」；
    //   · 而且是**单向陷门**：封禁 owner 会 suspend 企业账户 + 失活 owner member 行，
    //     解封时放开方向只碰 personal ⇒ 两者都不恢复；唯一恢复入口
    //     updateEnterpriseAccount(status:'active') 也不改 member 行，且对已 quarantine 账户 409。
    //
    // 企业账户的状态归开通/回收编排独占。若业务确实要「封 owner 连坐企业」，
    // 必须另加可识别的暂停来源（如 ownerDisabledAt）以便定向恢复账户**和** member 行，
    // 那是独立议题，不该用这里的一个三元表达式顺带实现。
    const scopedTypes = ['personal'];
    const accounts = await db.billingAccount.findMany({
      where: { ownerUserId: userId, deletedAt: null, type: { in: scopedTypes } },
      select: { id: true },
    });
    if (accounts.length === 0) return;

    const accountIds = accounts.map((account) => account.id);
    const accountStatus = isActive ? 'active' : 'suspended';
    const memberStatus = isActive ? 'active' : 'inactive';
    await db.billingAccount.updateMany({
      // 写侧同样带 type 条件：即便上面的枚举将来被改坏，也不会越过本次的范围。
      // 相同状态的镜像保持原个人账户及成员行（包括 updatedAt）。
      where: { id: { in: accountIds }, deletedAt: null, type: { in: scopedTypes }, status: { not: accountStatus } },
      data: { status: accountStatus },
    });
    await db.billingAccountMember.updateMany({
      where: {
        billingAccountId: { in: accountIds },
        userId,
        role: 'owner',
        status: { not: memberStatus },
      },
      data: { status: memberStatus },
    });
  }

  private isStale(existing: Date | null, incoming: Date | null): boolean {
    if (!existing) return false;
    if (!incoming) return true;
    return incoming.getTime() < existing.getTime();
  }

  private async normalizeUniqueEmail(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    value?: string | null,
  ): Promise<string | null | undefined> {
    if (value === undefined) return undefined;
    const email = this.normalizeNullableString(value);
    if (!email) return null;
    const conflict = await db.user.findFirst({
      where: { email, NOT: { id: userId } },
      select: { id: true },
    });
    if (conflict) {
      this.logger.warn(`user mirror email conflict ignored user=${userId} email=${email}`);
      return null;
    }
    return email;
  }

  private async normalizeUniquePhone(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    value?: string | null,
  ): Promise<string | null | undefined> {
    if (value === undefined) return undefined;
    const phone = this.normalizeNullableString(value);
    if (!phone) return null;
    const conflict = await db.user.findFirst({
      where: { phone, NOT: { id: userId } },
      select: { id: true },
    });
    if (conflict) {
      this.logger.warn(`user mirror phone conflict ignored user=${userId}`);
      return null;
    }
    return phone;
  }

  private parseOptionalDate(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('user.sourceUpdatedAt 必须是有效时间');
    }
    if (date.getTime() > Date.now() + MAX_SOURCE_UPDATED_AT_FUTURE_SKEW_MS) {
      throw new BadRequestException('user.sourceUpdatedAt 不能超过当前时间 5 分钟');
    }
    return date;
  }

  private normalizeNullableString(value?: string | null): string | null {
    const normalized = value?.trim();
    return normalized || null;
  }

  private normalizeNickname(value?: string | null, emailValue?: string | null): string {
    const nickname = this.normalizeNullableString(value);
    if (nickname) return nickname;
    const email = this.normalizeNullableString(emailValue);
    if (email) return email.split('@')[0] || '';
    return '';
  }

  private requireString(value: string | null | undefined, label: string): string {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) throw new BadRequestException(`${label} is required`);
    return normalized;
  }

  private hasOwn<T extends object>(obj: T, key: keyof T): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
}

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DiscountCodeRepository } from './discount-code.repository';
import { StripeCouponSyncService } from './stripe-coupon-sync.service';

export interface CreateDiscountCodeInput {
  code: string;
  name: string;
  description?: string;
  discountType: 'percent_off' | 'amount_off';
  discountValue: number;          // percent: 1~99 整数；amount: cents
  currency?: string;              // amount_off 时必填
  duration?: 'once' | 'repeating' | 'forever';
  durationMonths?: number;        // repeating 必填
  planIds?: string[];             // 空=所有
  firstTimeOnly?: boolean;
  scope?: 'all' | 'new_users' | 'old_users';
  maxUses?: number;
  maxUsesPerUser?: number;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
}

export interface UpdateDiscountCodeInput extends Partial<CreateDiscountCodeInput> {
  isActive?: boolean;
}

/**
 * 验证促销码并返回折扣描述（用于 PaymentService 计算 priceC）
 */
export interface DiscountCodeHit {
  code: {
    id: string;
    code: string;
    name: string;
    discountType: 'percent_off' | 'amount_off';
    discountValue: number;
    stripeCouponId: string | null;
  };
  originalAmountCents: number;
  amountAfterCents: number;
  amountSavedCents: number;
}

@Injectable()
export class DiscountCodeService {
  private readonly logger = new Logger(DiscountCodeService.name);

  constructor(
    private readonly repo: DiscountCodeRepository,
    private readonly stripeCouponSync: StripeCouponSyncService,
  ) {}

  // ================================================
  // CRUD
  // ================================================

  async create(input: CreateDiscountCodeInput) {
    this.validateInput(input);
    const code = input.code.toUpperCase();

    const existing = await this.repo.findByCode(code);
    if (existing) throw new BadRequestException(`码 ${code} 已存在`);

    // 先不落库 Stripe coupon id —— 先建码，然后建 coupon
    const created = await this.repo.create({
      code,
      name: input.name,
      description: input.description ?? '',
      discountType: input.discountType,
      discountValue: input.discountValue,
      currency: input.discountType === 'amount_off' ? (input.currency ?? 'usd').toLowerCase() : null,
      duration: input.duration ?? 'once',
      durationMonths: input.duration === 'repeating' ? input.durationMonths ?? null : null,
      planIdsJson: JSON.stringify(input.planIds ?? []),
      firstTimeOnly: input.firstTimeOnly ?? false,
      scope: input.scope ?? 'all',
      maxUses: input.maxUses ?? 0,
      maxUsesPerUser: input.maxUsesPerUser ?? 1,
      startAt: input.startAt ? new Date(input.startAt) : null,
      endAt: input.endAt ? new Date(input.endAt) : null,
      isActive: true,
    });

    try {
      const couponId = await this.stripeCouponSync.createDiscountCodeCoupon({
        name: `CODE ${code}`,
        discountType: input.discountType,
        discountValue: input.discountValue,
        currency: input.discountType === 'amount_off' ? (input.currency ?? 'usd').toLowerCase() : undefined,
        duration: input.duration ?? 'once',
        durationMonths: input.durationMonths,
        metadata: { discountCodeId: created.id, code },
      });
      return this.repo.update(created.id, { stripeCouponId: couponId });
    } catch (err) {
      this.logger.error(`DiscountCode ${code} Stripe Coupon 创建失败，禁用: ${err}`);
      await this.repo.update(created.id, { isActive: false });
      throw err;
    }
  }

  async update(id: string, input: UpdateDiscountCodeInput) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('促销码不存在');

    const needsCouponResync =
      input.discountType !== undefined ||
      input.discountValue !== undefined ||
      input.duration !== undefined ||
      input.durationMonths !== undefined ||
      (input.isActive === false && existing.stripeCouponId);

    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.discountType !== undefined) data.discountType = input.discountType;
    if (input.discountValue !== undefined) data.discountValue = input.discountValue;
    if (input.currency !== undefined) data.currency = input.currency ? input.currency.toLowerCase() : null;
    if (input.duration !== undefined) data.duration = input.duration;
    if (input.durationMonths !== undefined) data.durationMonths = input.durationMonths;
    if (input.planIds !== undefined) data.planIdsJson = JSON.stringify(input.planIds);
    if (input.firstTimeOnly !== undefined) data.firstTimeOnly = input.firstTimeOnly;
    if (input.scope !== undefined) data.scope = input.scope;
    if (input.maxUses !== undefined) data.maxUses = input.maxUses;
    if (input.maxUsesPerUser !== undefined) data.maxUsesPerUser = input.maxUsesPerUser;
    if (input.startAt !== undefined) data.startAt = input.startAt ? new Date(input.startAt) : null;
    if (input.endAt !== undefined) data.endAt = input.endAt ? new Date(input.endAt) : null;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    if (needsCouponResync && existing.stripeCouponId) {
      await this.stripeCouponSync.archiveCoupon(existing.stripeCouponId);
      data.stripeCouponId = null;
    }

    const updated = await this.repo.update(id, data);

    if (needsCouponResync && updated.isActive) {
      const couponId = await this.stripeCouponSync.createDiscountCodeCoupon({
        name: `CODE ${updated.code}`,
        discountType: updated.discountType as any,
        discountValue: updated.discountValue,
        currency: updated.currency ?? undefined,
        duration: updated.duration as any,
        durationMonths: updated.durationMonths ?? undefined,
        metadata: { discountCodeId: updated.id, code: updated.code },
      });
      return this.repo.update(updated.id, { stripeCouponId: couponId });
    }

    return updated;
  }

  async disable(id: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('促销码不存在');
    if (existing.stripeCouponId) {
      await this.stripeCouponSync.archiveCoupon(existing.stripeCouponId);
    }
    return this.repo.update(id, { isActive: false, stripeCouponId: null });
  }

  async findById(id: string) {
    const c = await this.repo.findById(id);
    if (!c) throw new NotFoundException('促销码不存在');
    return c;
  }

  async findAll(filters: { isActive?: boolean }) {
    return this.repo.findAll(filters);
  }

  async stats(id: string) {
    const record = await this.repo.findById(id);
    if (!record) throw new NotFoundException('促销码不存在');
    const saved = await this.repo.sumSaved(id);
    return {
      uses: record.currentUses,
      maxUses: record.maxUses,
      amountSavedCents: saved,
    };
  }

  // ================================================
  // 运行时：验证 + 计算折扣
  // ================================================

  async validateAndGet(params: {
    code: string;
    userId: string;
    planId: string;
    currency: string;
    isNewUser: boolean;
    userHasPlanHistory: boolean;
    originalAmountCents: number;
  }): Promise<DiscountCodeHit> {
    const record = await this.repo.findByCode(params.code);
    if (!record || !record.isActive) throw new BadRequestException('促销码无效');

    const now = new Date();
    if (record.startAt && record.startAt > now) throw new BadRequestException('促销码未生效');
    if (record.endAt && record.endAt < now) throw new BadRequestException('促销码已过期');

    // 全局限次
    const [reservedUses, completedUses] = await Promise.all([
      this.repo.countReservedOrders(record.id),
      this.repo.countCompletedOrders(record.id),
    ]);
    const globalUsedOrReserved = Math.max(record.currentUses, completedUses) + reservedUses;
    if (record.maxUses > 0 && globalUsedOrReserved >= record.maxUses) {
      throw new BadRequestException('促销码已使用完');
    }

    // 适用 plan
    const planIds: string[] = this.parsePlanIds(record.planIdsJson);
    if (planIds.length > 0 && !planIds.includes(params.planId)) {
      throw new BadRequestException('此促销码不适用于当前套餐');
    }

    // scope
    if (!this.matchScope(record.scope, params.isNewUser)) {
      throw new BadRequestException('不符合使用条件');
    }

    // firstTimeOnly
    if (record.firstTimeOnly && params.userHasPlanHistory) {
      throw new BadRequestException('仅限该套餐首次购买');
    }

    // per-user 限次
    if (record.maxUsesPerUser > 0) {
      const [redeemed, reserved, completed] = await Promise.all([
        this.repo.countUserRedemptions(record.id, params.userId),
        this.repo.countReservedOrders(record.id, params.userId),
        this.repo.countCompletedOrders(record.id, params.userId),
      ]);
      const used = Math.max(redeemed, completed) + reserved;
      if (used >= record.maxUsesPerUser) throw new BadRequestException('促销码使用次数已达上限');
    }

    // amount_off 的币种必须匹配
    if (record.discountType === 'amount_off' && record.currency !== params.currency.toLowerCase()) {
      throw new BadRequestException(
        `此促销码仅适用于 ${record.currency?.toUpperCase()} 币种`,
      );
    }

    const after = this.applyDiscount(
      params.originalAmountCents,
      record.discountType as 'percent_off' | 'amount_off',
      record.discountValue,
    );

    return {
      code: {
        id: record.id,
        code: record.code,
        name: record.name,
        discountType: record.discountType as any,
        discountValue: record.discountValue,
        stripeCouponId: record.stripeCouponId,
      },
      originalAmountCents: params.originalAmountCents,
      amountAfterCents: after,
      amountSavedCents: params.originalAmountCents - after,
    };
  }

  applyDiscount(
    originalCents: number,
    type: 'percent_off' | 'amount_off',
    value: number,
  ): number {
    if (type === 'percent_off') {
      return Math.max(0, Math.round(originalCents * (1 - value / 100)));
    }
    return Math.max(0, originalCents - value);
  }

  async incrementUsage(id: string) {
    return this.repo.update(id, { currentUses: { increment: 1 } });
  }

  // ================================================
  // 辅助
  // ================================================

  private validateInput(input: CreateDiscountCodeInput) {
    if (!/^[A-Z0-9_-]{3,32}$/i.test(input.code)) {
      throw new BadRequestException('促销码格式不合法（3-32位字母数字）');
    }
    if (input.discountType === 'percent_off') {
      if (input.discountValue < 1 || input.discountValue > 99) {
        throw new BadRequestException('百分比必须在 1~99 之间');
      }
    } else {
      if (input.discountValue <= 0) {
        throw new BadRequestException('金额折扣必须大于 0');
      }
      if (!input.currency) {
        throw new BadRequestException('amount_off 必须指定 currency');
      }
    }
    if (input.duration === 'repeating' && (!input.durationMonths || input.durationMonths <= 0)) {
      throw new BadRequestException('duration=repeating 时 durationMonths 必填且 > 0');
    }
  }

  private matchScope(scope: string, isNewUser: boolean): boolean {
    if (scope === 'all') return true;
    if (scope === 'new_users') return isNewUser;
    if (scope === 'old_users') return !isNewUser;
    return false;
  }

  private parsePlanIds(json: string): string[] {
    try {
      const arr = JSON.parse(json || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
}

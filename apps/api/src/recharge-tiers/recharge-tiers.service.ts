import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RechargeBonusType, RechargeTier } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// NOTE: Spec §5.2 requires user-side recharge flow to read RechargeTier and
// write `tierId` to order metadata for reconciliation. That integration is
// DEFERRED to a later PR (or coordinated with the user-end repo). PR3 ships
// admin CRUD only; consumption side is admin v2 P2.

// Upper bounds (defensive — prevent overflow attacks). Postgres INTEGER caps at
// 2^31 - 1; we cap well below to keep formatted display readable.
const MAX_AMOUNT_CENTS = 100_000_000; // ¥1,000,000
const MAX_BONUS_FIXED_CENTS = 100_000_000;
const MAX_PERCENT = 100;
const MAX_BADGE_LEN = 32;
const MAX_SORT_ORDER = 1_000_000;

const BONUS_TYPES: ReadonlySet<RechargeBonusType> = new Set([
  'FIXED',
  'PERCENT',
]);

export interface CreateRechargeTierInput {
  productId: string;
  amountCents: number;
  bonusType: RechargeBonusType;
  bonusValue: number;
  badge?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
}

export interface UpdateRechargeTierInput {
  productId?: string;
  amountCents?: number;
  bonusType?: RechargeBonusType;
  bonusValue?: number;
  badge?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
}

export interface ListFilters {
  page: number;
  pageSize: number;
  productId?: string;
  isActive?: boolean;
}

export interface RechargeTierDTO {
  id: string;
  productId: string;
  amountCents: number;
  bonusType: RechargeBonusType;
  bonusValue: number;
  badge: string | null;
  sortOrder: number;
  isActive: boolean;
  startAt: Date | null;
  endAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Soft warning: other active tiers with same productId+amountCents exist. */
  overlapWarning?: string;
}

export interface PublicRechargeTierDTO {
  id: string;
  productId: string;
  amountCents: number;
  bonusType: RechargeBonusType;
  bonusValue: number;
  bonusCents: number;
  badge: string | null;
  sortOrder: number;
}

@Injectable()
export class RechargeTiersService {
  private readonly logger = new Logger(RechargeTiersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------ CRUD -------------------------------

  async listPaygProducts(): Promise<{
    items: Array<{
      id: string;
      name: string;
      slug: string;
      billingMode: string;
      isActive: boolean;
    }>;
  }> {
    const items = await this.prisma.product.findMany({
      where: {
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
        deletedAt: null,
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        billingMode: true,
        isActive: true,
      },
    });
    return { items };
  }

  async listPublicActive(productId: string): Promise<{
    items: PublicRechargeTierDTO[];
  }> {
    const rows = await this.findActiveTiers(this.normalizeProductId(productId));

    return {
      items: rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        amountCents: row.amountCents,
        bonusType: row.bonusType,
        bonusValue: row.bonusValue,
        bonusCents: this.calculateBonusCents(row, row.amountCents),
        badge: row.badge,
        sortOrder: row.sortOrder,
      })),
    };
  }

  async list(filters: ListFilters): Promise<{
    items: RechargeTierDTO[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize, productId, isActive } = filters;
    const where: Prisma.RechargeTierWhereInput = { deletedAt: null };
    if (productId) where.productId = productId;
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const [rows, total] = await Promise.all([
      this.prisma.rechargeTier.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.rechargeTier.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toDTO(r)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<RechargeTierDTO> {
    const row = await this.prisma.rechargeTier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('充值面额不存在');
    return this.toDTO(row);
  }

  async create(input: CreateRechargeTierInput): Promise<RechargeTierDTO> {
    const data = await this.normalizeCreate(input);
    const row = await this.prisma.rechargeTier.create({ data });
    const dto = this.toDTO(row);
    const overlap = await this.checkOverlap(row.productId, row.amountCents, row.id);
    if (overlap) dto.overlapWarning = overlap;
    return dto;
  }

  async update(
    id: string,
    input: UpdateRechargeTierInput,
  ): Promise<RechargeTierDTO> {
    const existing = await this.prisma.rechargeTier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('充值面额不存在');

    const data: Prisma.RechargeTierUpdateInput = {};

    if (input.productId !== undefined) {
      await this.assertProductExists(input.productId);
      data.product = { connect: { id: input.productId } };
    }

    const nextBonusType = input.bonusType ?? existing.bonusType;
    if (input.bonusType !== undefined) {
      this.assertBonusType(input.bonusType);
      data.bonusType = input.bonusType;
    }

    if (input.amountCents !== undefined) {
      this.assertAmountCents(input.amountCents);
      data.amountCents = input.amountCents;
    }

    if (input.bonusValue !== undefined) {
      this.assertBonusValue(nextBonusType, input.bonusValue);
      data.bonusValue = input.bonusValue;
    } else if (input.bonusType !== undefined) {
      // bonusType changed without bonusValue — re-validate existing value
      // against the new type, fail fast if it's incompatible.
      this.assertBonusValue(nextBonusType, existing.bonusValue);
    }

    if (input.badge !== undefined) {
      data.badge = this.normalizeBadge(input.badge);
    }

    if (input.sortOrder !== undefined) {
      this.assertSortOrder(input.sortOrder);
      data.sortOrder = input.sortOrder;
    }

    if (input.isActive !== undefined) data.isActive = input.isActive;

    // Time window: validate if either changed; null means clear.
    if (input.startAt !== undefined || input.endAt !== undefined) {
      const start =
        input.startAt !== undefined
          ? this.normalizeDate(input.startAt)
          : existing.startAt;
      const end =
        input.endAt !== undefined
          ? this.normalizeDate(input.endAt)
          : existing.endAt;
      this.assertWindow(start, end);
      if (input.startAt !== undefined) data.startAt = start;
      if (input.endAt !== undefined) data.endAt = end;
    }

    const row = await this.prisma.rechargeTier.update({
      where: { id: existing.id },
      data,
    });
    const dto = this.toDTO(row);
    const overlap = await this.checkOverlap(row.productId, row.amountCents, row.id);
    if (overlap) dto.overlapWarning = overlap;
    return dto;
  }

  /**
   * Soft delete. No unique constraint on this table, so this is a plain
   * `deletedAt = now()` + filter on read.
   */
  async softDelete(id: string): Promise<void> {
    const existing = await this.prisma.rechargeTier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('充值面额不存在');
    await this.prisma.rechargeTier.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /**
   * Clone (deep copy). Same product, badge="副本"; clears the time window so
   * the copy doesn't immediately go live with the source's schedule.
   *
   * No unique constraint on this table, so P2002 is structurally impossible
   * here — but we still defensively retry once if Prisma somehow surfaces one
   * (e.g. future composite unique add).
   */
  async clone(id: string): Promise<RechargeTierDTO> {
    const src = await this.prisma.rechargeTier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!src) throw new NotFoundException('充值面额不存在');

    const baseData: Prisma.RechargeTierCreateInput = {
      product: { connect: { id: src.productId } },
      amountCents: src.amountCents,
      bonusType: src.bonusType,
      bonusValue: src.bonusValue,
      badge: '副本',
      sortOrder: src.sortOrder,
      isActive: false, // copy starts as inactive — operator opts in
      startAt: null,
      endAt: null,
    };

    try {
      const row = await this.prisma.rechargeTier.create({ data: baseData });
      return this.toDTO(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.warn(
          `clone hit P2002 for tier ${id} — retrying with timestamp badge`,
        );
        const row = await this.prisma.rechargeTier.create({
          data: { ...baseData, badge: `副本 ${Date.now()}` },
        });
        return this.toDTO(row);
      }
      throw err;
    }
  }

  // ------------------------------ helpers ----------------------------

  private toDTO(row: RechargeTier): RechargeTierDTO {
    return {
      id: row.id,
      productId: row.productId,
      amountCents: row.amountCents,
      bonusType: row.bonusType,
      bonusValue: row.bonusValue,
      badge: row.badge,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      startAt: row.startAt,
      endAt: row.endAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Build the create payload, validating every field. */
  private async normalizeCreate(
    input: CreateRechargeTierInput,
  ): Promise<Prisma.RechargeTierCreateInput> {
    if (!input.productId) throw new BadRequestException('productId 必填');
    await this.assertProductExists(input.productId);

    this.assertBonusType(input.bonusType);
    this.assertAmountCents(input.amountCents);
    this.assertBonusValue(input.bonusType, input.bonusValue);

    const sortOrder = input.sortOrder ?? 0;
    this.assertSortOrder(sortOrder);

    const startAt = this.normalizeDate(input.startAt);
    const endAt = this.normalizeDate(input.endAt);
    this.assertWindow(startAt, endAt);

    return {
      product: { connect: { id: input.productId } },
      amountCents: input.amountCents,
      bonusType: input.bonusType,
      bonusValue: input.bonusValue,
      badge: this.normalizeBadge(input.badge),
      sortOrder,
      isActive: input.isActive ?? true,
      startAt,
      endAt,
    };
  }

  private assertBonusType(t: unknown): asserts t is RechargeBonusType {
    if (typeof t !== 'string' || !BONUS_TYPES.has(t as RechargeBonusType)) {
      throw new BadRequestException('bonusType 必须是 FIXED 或 PERCENT');
    }
  }

  private assertAmountCents(v: unknown): asserts v is number {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      v <= 0
    ) {
      throw new BadRequestException('amountCents 必须是正整数');
    }
    if (v > MAX_AMOUNT_CENTS) {
      throw new BadRequestException(
        `amountCents 超过上限 ${MAX_AMOUNT_CENTS}`,
      );
    }
  }

  private assertBonusValue(type: RechargeBonusType, v: unknown): asserts v is number {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      v < 0
    ) {
      throw new BadRequestException('bonusValue 必须是 ≥ 0 的整数');
    }
    if (type === 'PERCENT' && v > MAX_PERCENT) {
      throw new BadRequestException(
        `PERCENT 类型 bonusValue 不得超过 ${MAX_PERCENT}`,
      );
    }
    if (type === 'FIXED' && v > MAX_BONUS_FIXED_CENTS) {
      throw new BadRequestException(
        `FIXED 类型 bonusValue 不得超过 ${MAX_BONUS_FIXED_CENTS} 分`,
      );
    }
  }

  private assertSortOrder(v: unknown): asserts v is number {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      v < 0
    ) {
      throw new BadRequestException('sortOrder 必须是 ≥ 0 的整数');
    }
    if (v > MAX_SORT_ORDER) {
      throw new BadRequestException(`sortOrder 超过上限 ${MAX_SORT_ORDER}`);
    }
  }

  private normalizeBadge(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') {
      throw new BadRequestException('badge 必须是字符串');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_BADGE_LEN) {
      throw new BadRequestException(
        `badge 长度不得超过 ${MAX_BADGE_LEN} 个字符`,
      );
    }
    return trimmed;
  }

  private normalizeDate(raw: string | Date | null | undefined): Date | null {
    if (raw === null || raw === undefined) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('startAt / endAt 必须是合法时间');
    }
    return d;
  }

  private assertWindow(start: Date | null, end: Date | null): void {
    if (start && end && end.getTime() <= start.getTime()) {
      throw new BadRequestException('endAt 必须晚于 startAt');
    }
  }

  private normalizeProductId(productId: string): string {
    const normalized = typeof productId === 'string' ? productId.trim() : '';
    if (!normalized) {
      throw new BadRequestException('productId 必填');
    }
    return normalized;
  }

  private async findActiveTiers(productId: string): Promise<RechargeTier[]> {
    const now = new Date();
    return this.prisma.rechargeTier.findMany({
      where: {
        productId,
        isActive: true,
        deletedAt: null,
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private calculateBonusCents(
    row: Pick<RechargeTier, 'id' | 'bonusType' | 'bonusValue'>,
    amountCents: number,
  ): number {
    if (row.bonusType === RechargeBonusType.FIXED) {
      return Math.max(0, row.bonusValue);
    }

    if (row.bonusType === RechargeBonusType.PERCENT) {
      const pct = row.bonusValue;
      if (pct < 0 || pct > 100) {
        this.logger.warn(
          `RechargeTier ${row.id} PERCENT bonusValue=${pct} 越界，跳过 bonus`,
        );
        return 0;
      }
      return Math.floor((amountCents * pct) / 100);
    }

    return 0;
  }

  private async assertProductExists(productId: string): Promise<void> {
    if (typeof productId !== 'string' || productId.length === 0) {
      throw new BadRequestException('productId 必填');
    }
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) {
      throw new BadRequestException('productId 不存在');
    }
  }

  /**
   * Soft warning: detect other active tiers with same productId + amountCents.
   * Multiple active tiers with same amount aren't blocked (A/B testing,
   * seasonal variants are valid use cases) — just surfaced to the operator.
   */
  private async checkOverlap(
    productId: string,
    amountCents: number,
    selfId: string,
  ): Promise<string | undefined> {
    const others = await this.prisma.rechargeTier.count({
      where: {
        productId,
        amountCents,
        isActive: true,
        deletedAt: null,
        NOT: { id: selfId },
      },
    });
    if (others > 0) {
      return `当前产品下已有 ${others} 个相同面额的启用中 tier`;
    }
    return undefined;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}

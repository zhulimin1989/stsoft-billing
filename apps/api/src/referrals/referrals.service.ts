/**
 * ReferralsService — admin v2 邀请裂变 (P2-D)
 *
 * 三表 (ReferralProgram / ReferralCode / ReferralRedemption) + 4 个职责:
 *   1. Admin CRUD: programs 列表/创建/更新/软删
 *   2. 用户端: getMyReferralCode 懒生成 8 位 BASE32 邀请码
 *   3. 注册归因: AuthService.register 调 attribute(fire-and-forget)
 *   4. 触发回调: PaymentService.fulfillOrder 调 onOrderCompleted
 *
 * 奖励发放复用既有 GrantRule + CreditGrantExecutor.grantToUserDirect:
 *   每个 program 创建时同步创建 2 条 hidden GrantRule (triggerType=TASK_COMPLETE,
 *   不会被 cron 自动扫到), name 用 `__referral:program-{id}:inviter|invitee` 前缀
 *   方便运营 UI 过滤。
 *
 * 红线:
 *   - 注册主链路绝不阻塞 → service 内部所有路径 try/catch + warn
 *   - 防作弊命中仍写 redemption (rejectReason 字段) 但不发奖,便于运营追溯
 *   - referralCode 查询走 60s Redis cache (注册热路径)
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-referrals-design.md
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  CreditGrantRule,
  Prisma,
  ReferralCode,
  ReferralProgram,
  ReferralRedemption,
  ReferralRewardCondition,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditGrantExecutor } from '../credit-grants/credit-grant-executor';
import { lookupGeo } from './geo.util';

const NAME_MAX = 128;
const REWARD_AMOUNT_MAX = 10_000_000;
const REWARD_CONDITIONS: ReadonlySet<ReferralRewardCondition> = new Set([
  'REGISTER',
  'FIRST_RECHARGE',
  'FIRST_SUBSCRIBE',
]);
const CODE_CACHE_TTL_SECONDS = 60;
const CODE_LENGTH = 8;
const CODE_GENERATION_RETRIES = 3;
// RFC 4648 BASE32 alphabet, 用户友好(无 0/1/O/I 视觉混淆问题已在 BASE32 标准里规避)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface CreateProgramInput {
  name: string;
  inviterReward: number;
  inviteeReward: number;
  rewardCondition: ReferralRewardCondition;
  productId?: string | null;
  trackingOnly?: boolean;
  isActive?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  sameIpLimit?: number | null;
  sameDeviceLimit?: number | null;
  perUserInviteLimit?: number | null;
}

export type UpdateProgramInput = Partial<CreateProgramInput>;

export interface AttributeArgs {
  inviteeUserId: string;
  referralCode?: string | null;
  inviteeIp?: string | null;
  deviceId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  landingUrl?: string | null;
  capturedAt?: string | Date | null;
  referrer?: string | null;
}

export interface ClickArgs {
  referralCode?: string | null;
  /** 访客标识(前端 deviceId);无则用 ip:<ip> 兜底 */
  visitorKey?: string | null;
  ip?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
}

export interface ListRedemptionsOpts {
  programId?: string;
  inviterUserId?: string;
  /** true=已满足触发条件; false=仅完成注册归因、尚未触发 */
  triggered?: boolean;
  page: number;
  pageSize: number;
}

export interface LeaderboardOpts {
  programId?: string;
  days?: number;
}

export interface SummaryOpts {
  programId?: string;
}

export interface ReferralSummary {
  /** 成功发奖行里 distinct 邀请人数 */
  totalInviters: number;
  /** 成功发奖行里 distinct 被邀请人数 */
  totalInvitees: number;
  /** 成功发奖(rewardGranted=true)兑换行数 */
  totalRedemptions: number;
  /** 兑换记录总行数(含未发奖/被拒),转化率分母 */
  totalAttempts: number;
  /** totalRedemptions / totalAttempts,0..1;分母为 0 时返回 0 */
  conversionRate: number;
  /** Σ 各 program (inviterReward + inviteeReward) × 该 program 成功行数 */
  totalRewardIssued: number;
  /** 去重点击人数(UV):referral_clicks 行数 */
  totalClickUv: number;
  /**
   * 每个 program 的聚合,键为 programId:
   * - redemptionCount:成功发奖兑换数
   * - clickUv:去重点击人数(UV)
   */
  perProgram: Record<string, { redemptionCount: number; clickUv: number }>;
}

interface CachedReferralCode {
  programId: string;
  inviterUserId: string;
  programIsActive: boolean;
  programStartAt: string | null;
  programEndAt: string | null;
  programDeletedAt: string | null;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly grantExecutor: CreditGrantExecutor,
  ) {}

  // ============================================================
  // Admin CRUD
  // ============================================================

  async listPrograms(): Promise<ReferralProgram[]> {
    return this.prisma.referralProgram.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 列出某 program 已生成的邀请码(带推广方联系方式),供生成链接弹窗回显。 */
  async listCodes(programId: string): Promise<
    Array<{
      code: string;
      inviterUserId: string;
      inviter: { email: string | null; phone: string | null; nickname: string } | null;
      createdAt: Date;
    }>
  > {
    return this.prisma.referralCode.findMany({
      where: { programId },
      orderBy: { createdAt: 'desc' },
      select: {
        code: true,
        inviterUserId: true,
        createdAt: true,
        inviter: { select: { email: true, phone: true, nickname: true } },
      },
    });
  }

  async getProgram(id: string): Promise<ReferralProgram> {
    const row = await this.prisma.referralProgram.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('邀请活动不存在');
    return row;
  }

  async createProgram(input: CreateProgramInput): Promise<ReferralProgram> {
    // 奖励发放逻辑尚未定稿,暂时强制所有 program 走「仅追踪」模式:
    // 只记录邀请/兑换(markTrackingOnlyTriggered 立即置 rewardGranted=true 供看板/
    // 排行榜统计),不创建 hidden GrantRule、不实际发奖。这样也彻底规避了
    // trackingOnly true→false 切换时 grantRuleId 残留为 null 导致 triggerRewards
    // 空转、奖励永远卡在「待发放」的 bug。开关放开发奖时删掉这行、恢复入参即可。
    // 注意要在 assertCommonProgram 之前置位:校验按 trackingOnly 放宽奖励下限到 0。
    input.trackingOnly = true;
    this.assertCommonProgram(input);

    const startAt = this.normalizeDate(input.startAt ?? null);
    const endAt = this.normalizeDate(input.endAt ?? null);
    if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('endAt 必须晚于 startAt');
    }

    const trackingOnly = true;
    // GrantRule rewardType: productId 有 → BALANCE; 没有 → CREDIT
    const rewardType: 'BALANCE' | 'CREDIT' = input.productId
      ? 'BALANCE'
      : 'CREDIT';

    return this.prisma.$transaction(async (tx) => {
      // 1) 先创建 program (拿到 id)
      const program = await tx.referralProgram.create({
        data: {
          name: input.name.trim(),
          inviterReward: input.inviterReward,
          inviteeReward: input.inviteeReward,
          rewardCondition: input.rewardCondition,
          productId: input.productId ?? null,
          trackingOnly,
          isActive: input.isActive ?? true,
          startAt,
          endAt,
          sameIpLimit: input.sameIpLimit ?? null,
          sameDeviceLimit: input.sameDeviceLimit ?? null,
          perUserInviteLimit: input.perUserInviteLimit ?? null,
        },
      });

      if (trackingOnly) {
        return program;
      }

      // 2) 同步创建 2 条 hidden GrantRule (triggerType=TASK_COMPLETE 避免被 cron 扫)
      const inviterRule = await tx.creditGrantRule.create({
        data: this.buildHiddenGrantRuleData({
          programId: program.id,
          role: 'inviter',
          rewardAmount: input.inviterReward,
          rewardType,
          productId: input.productId ?? null,
        }),
      });
      const inviteeRule = await tx.creditGrantRule.create({
        data: this.buildHiddenGrantRuleData({
          programId: program.id,
          role: 'invitee',
          rewardAmount: input.inviteeReward,
          rewardType,
          productId: input.productId ?? null,
        }),
      });

      // 3) 回填 program 的两个 grantRuleId
      return tx.referralProgram.update({
        where: { id: program.id },
        data: {
          inviterGrantRuleId: inviterRule.id,
          inviteeGrantRuleId: inviteeRule.id,
        },
      });
    });
  }

  async updateProgram(
    id: string,
    input: UpdateProgramInput,
  ): Promise<ReferralProgram> {
    const existing = await this.getProgram(id);

    // 合并视图,单独校验
    const merged: CreateProgramInput = {
      name: input.name ?? existing.name,
      inviterReward:
        input.inviterReward !== undefined
          ? input.inviterReward
          : existing.inviterReward,
      inviteeReward:
        input.inviteeReward !== undefined
          ? input.inviteeReward
          : existing.inviteeReward,
      rewardCondition: input.rewardCondition ?? existing.rewardCondition,
      productId:
        input.productId === undefined ? existing.productId : input.productId,
      // 强制仅追踪(见 createProgram 注释):入参/旧值一律忽略,锁死为 true。
      trackingOnly: true,
      isActive: input.isActive === undefined ? existing.isActive : input.isActive,
      sameIpLimit:
        input.sameIpLimit === undefined ? existing.sameIpLimit : input.sameIpLimit,
      sameDeviceLimit:
        input.sameDeviceLimit === undefined
          ? existing.sameDeviceLimit
          : input.sameDeviceLimit,
      perUserInviteLimit:
        input.perUserInviteLimit === undefined
          ? existing.perUserInviteLimit
          : input.perUserInviteLimit,
    };
    this.assertCommonProgram(merged);

    const startAt =
      input.startAt === undefined
        ? existing.startAt
        : this.normalizeDate(input.startAt ?? null);
    const endAt =
      input.endAt === undefined
        ? existing.endAt
        : this.normalizeDate(input.endAt ?? null);
    if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('endAt 必须晚于 startAt');
    }

    const data: Prisma.ReferralProgramUpdateInput = {};
    if (input.name !== undefined) data.name = merged.name.trim();
    if (input.inviterReward !== undefined)
      data.inviterReward = merged.inviterReward;
    if (input.inviteeReward !== undefined)
      data.inviteeReward = merged.inviteeReward;
    if (input.rewardCondition !== undefined)
      data.rewardCondition = merged.rewardCondition;
    if (input.productId !== undefined) data.productId = merged.productId ?? null;
    // 每次编辑都把 trackingOnly 归正为 true,顺带修复历史遗留的 false 程序。
    data.trackingOnly = true;
    if (input.isActive !== undefined) data.isActive = merged.isActive ?? true;
    if (input.startAt !== undefined) data.startAt = startAt;
    if (input.endAt !== undefined) data.endAt = endAt;
    if (input.sameIpLimit !== undefined) data.sameIpLimit = merged.sameIpLimit ?? null;
    if (input.sameDeviceLimit !== undefined)
      data.sameDeviceLimit = merged.sameDeviceLimit ?? null;
    if (input.perUserInviteLimit !== undefined)
      data.perUserInviteLimit = merged.perUserInviteLimit ?? null;

    const updated = await this.prisma.referralProgram.update({
      where: { id: existing.id },
      data,
    });

    // 同步 GrantRule rewardAmount / productId 变化
    const productChanged = input.productId !== undefined;
    const inviterAmountChanged = input.inviterReward !== undefined;
    const inviteeAmountChanged = input.inviteeReward !== undefined;
    const newRewardType: 'BALANCE' | 'CREDIT' = merged.productId
      ? 'BALANCE'
      : 'CREDIT';

    if (merged.trackingOnly) {
      return updated;
    }

    if (
      existing.inviterGrantRuleId &&
      (inviterAmountChanged || productChanged)
    ) {
      await this.prisma.creditGrantRule
        .update({
          where: { id: existing.inviterGrantRuleId },
          data: {
            rewardAmount: merged.inviterReward,
            rewardType: newRewardType,
            productId: merged.productId ?? null,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `failed to sync inviter GrantRule ${existing.inviterGrantRuleId}: ${(err as Error).message}`,
          );
        });
    }
    if (
      existing.inviteeGrantRuleId &&
      (inviteeAmountChanged || productChanged)
    ) {
      await this.prisma.creditGrantRule
        .update({
          where: { id: existing.inviteeGrantRuleId },
          data: {
            rewardAmount: merged.inviteeReward,
            rewardType: newRewardType,
            productId: merged.productId ?? null,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `failed to sync invitee GrantRule ${existing.inviteeGrantRuleId}: ${(err as Error).message}`,
          );
        });
    }

    return updated;
  }

  async deleteProgram(id: string): Promise<void> {
    const existing = await this.getProgram(id);
    await this.prisma.referralProgram.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    // 级联软停用 hidden GrantRule
    const ids = [
      existing.inviterGrantRuleId,
      existing.inviteeGrantRuleId,
    ].filter((x): x is string => Boolean(x));
    if (ids.length) {
      await this.prisma.creditGrantRule
        .updateMany({
          where: { id: { in: ids } },
          data: { isActive: false },
        })
        .catch((err) => {
          this.logger.warn(
            `failed to deactivate hidden GrantRules ${ids.join(',')}: ${(err as Error).message}`,
          );
        });
    }
  }

  // ============================================================
  // 用户端: getMyReferralCode (懒生成 8 位 BASE32)
  // ============================================================

  async getMyReferralCode(
    userId: string,
    programId?: string,
  ): Promise<{ code: string; programId: string }> {
    // 默认拿第一个 active program
    const program = programId
      ? await this.prisma.referralProgram.findFirst({
          where: { id: programId, deletedAt: null, isActive: true },
        })
      : await this.prisma.referralProgram.findFirst({
          where: { deletedAt: null, isActive: true },
          orderBy: { createdAt: 'asc' },
        });
    if (!program) {
      throw new NotFoundException('当前没有可用的邀请活动');
    }

    // 已存在的 code 直接返
    const existing = await this.prisma.referralCode.findUnique({
      where: {
        programId_inviterUserId: {
          programId: program.id,
          inviterUserId: userId,
        },
      },
    });
    if (existing) {
      return { code: existing.code, programId: program.id };
    }

    // 懒生成: 重试至 CODE_GENERATION_RETRIES 次
    let lastErr: unknown = null;
    for (let i = 0; i < CODE_GENERATION_RETRIES; i++) {
      const code = this.generateCode();
      try {
        const created = await this.prisma.referralCode.create({
          data: {
            programId: program.id,
            inviterUserId: userId,
            code,
          },
        });
        return { code: created.code, programId: program.id };
      } catch (err) {
        // P2002 = unique violation (code 或 program+inviter 撞了)
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          // 如果是 (program, inviter) 撞,说明并发请求另一边赢了 → 直接返
          const again = await this.prisma.referralCode.findUnique({
            where: {
              programId_inviterUserId: {
                programId: program.id,
                inviterUserId: userId,
              },
            },
          });
          if (again) {
            return { code: again.code, programId: program.id };
          }
          // 否则 code unique 撞,继续重试
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `生成邀请码失败,已重试 ${CODE_GENERATION_RETRIES} 次: ${lastErr instanceof Error ? lastErr.message : 'unknown'}`,
    );
  }

  // ============================================================
  // 注册归因 hook (fire-and-forget — 内部所有路径 try/catch)
  // ============================================================

  async attribute(args: AttributeArgs): Promise<void> {
    try {
      const { inviteeUserId, referralCode, inviteeIp, deviceId } = args;
      if (!referralCode || !referralCode.trim()) return;
      const attribution = {
        utmSource: this.normalizeOptionalText(args.utmSource),
        utmMedium: this.normalizeOptionalText(args.utmMedium),
        utmCampaign: this.normalizeOptionalText(args.utmCampaign),
        utmContent: this.normalizeOptionalText(args.utmContent),
        landingUrl: this.normalizeOptionalText(args.landingUrl),
        capturedAt: this.normalizeDate(args.capturedAt ?? null),
        referrer: this.normalizeOptionalText(args.referrer),
      };
      // 访客地理:由真实 inviteeIp 就地解析(尽力而为,查不到为空,绝不阻塞)
      const geo = lookupGeo(inviteeIp);

      // 1) cache 查 referralCode
      const cached = await this.lookupReferralCodeCached(referralCode.trim());
      if (!cached) {
        // 找不到 → 静默 (归因失败不影响注册)
        return;
      }

      // 2) 时间窗口检查
      const now = Date.now();
      if (
        !cached.programIsActive ||
        cached.programDeletedAt ||
        (cached.programStartAt &&
          now < new Date(cached.programStartAt).getTime()) ||
        (cached.programEndAt && now >= new Date(cached.programEndAt).getTime())
      ) {
        return;
      }

      // 3) 自归因
      if (cached.inviterUserId === inviteeUserId) return;

      // 4) 拿 program 完整信息(防作弊上限 + condition + grantRuleId)
      const program = await this.prisma.referralProgram.findFirst({
        where: { id: cached.programId, deletedAt: null, isActive: true },
      });
      if (!program) return;

      // 5) 防作弊检查(spec §7.2)
      const reject = await this.checkAntiAbuse({
        program,
        inviterUserId: cached.inviterUserId,
        inviteeIp: inviteeIp ?? null,
        inviteeDeviceId: deviceId ?? null,
      });

      // 6) 找到 codeId 用于 redemption FK
      const code = await this.prisma.referralCode.findUnique({
        where: { code: referralCode.trim() },
      });
      if (!code) return;

      // 7) upsert ReferralRedemption (program + invitee 唯一)
      const triggeredAt =
        !reject && program.rewardCondition === 'REGISTER' ? new Date() : null;

      const redemption = await this.prisma.referralRedemption.upsert({
        where: {
          programId_inviteeUserId: {
            programId: program.id,
            inviteeUserId,
          },
        },
        create: {
          programId: program.id,
          codeId: code.id,
          inviterUserId: cached.inviterUserId,
          inviteeUserId,
          triggeredAt,
          rewardGranted: false,
          inviteeIp: inviteeIp ?? null,
          inviteeDeviceId: deviceId ?? null,
          utmSource: attribution.utmSource,
          utmMedium: attribution.utmMedium,
          utmCampaign: attribution.utmCampaign,
          utmContent: attribution.utmContent,
          landingUrl: attribution.landingUrl,
          capturedAt: attribution.capturedAt,
          country: geo.country ?? null,
          city: geo.city ?? null,
          referrer: attribution.referrer,
          rejectReason: reject ?? null,
        },
        update: {
          // 既有记录(用户可能重新触发) — 不覆盖,只写 rejectReason 用于审计
          rejectReason: reject ?? undefined,
        },
      });

      if (reject) {
        // 防作弊命中 → 写了记录但不发奖
        return;
      }

      // 8) REGISTER 条件 → 立即触发奖励; 其他 condition 等 onOrderCompleted
      if (program.rewardCondition === 'REGISTER') {
        // 双重检查模式:upsert 后再次 count,为高并发兜底(TOCTOU)。
        // 两个并发 attribute 同 program 同 IP 时,都可能在第一次 count 时
        // 全部通过(都返回 0),然后各自 upsert 自己的 redemption。
        // 此处在调 grantToUserDirect 之前,用同一套防作弊规则再 count 一次,
        // 命中则把 redemption.rejectReason 改成 RACE_REJECTED + 命中规则名,
        // 不调 grantExecutor,从而把残留窗口期压缩到 triggerRewards 单步。
        const recheck = await this.checkAntiAbuse({
          program,
          inviterUserId: cached.inviterUserId,
          inviteeIp: inviteeIp ?? null,
          inviteeDeviceId: deviceId ?? null,
        });
        if (recheck) {
          try {
            await this.prisma.referralRedemption.update({
              where: { id: redemption.id },
              data: {
                rejectReason: `RACE_REJECTED:${recheck}`,
                triggeredAt: null,
              },
            });
          } catch (err) {
            this.logger.warn(
              `redemption ${redemption.id} mark RACE_REJECTED failed: ${(err as Error).message}`,
            );
          }
          return;
        }

        if (program.trackingOnly) {
          await this.markTrackingOnlyTriggered(redemption.id);
          return;
        }

        await this.triggerRewards({
          program,
          inviterUserId: cached.inviterUserId,
          inviteeUserId,
          redemptionId: redemption.id,
        });
      }
    } catch (err) {
      // 红线: 注册主链路绝不阻塞,所有错误 swallow + warn
      this.logger.warn(
        `attribute failed (silent): ${(err as Error).message}`,
      );
    }
  }

  /**
   * 记录邀请链接点击(落地即上报,与注册无关)。
   * 按 (programId, visitorKey) 去重:重复点击 clickCount++ + 更新 lastClickedAt。
   * 尽力而为:code 无效或任何异常静默返回,不影响访客页面。
   */
  async recordClick(args: ClickArgs): Promise<void> {
    try {
      const code = args.referralCode?.trim();
      if (!code) return;
      const visitorKey =
        this.normalizeOptionalText(args.visitorKey) ??
        (args.ip ? `ip:${args.ip.trim()}` : null);
      if (!visitorKey) return; // 无任何访客标识则无法去重,放弃

      const cached = await this.lookupReferralCodeCached(code);
      if (!cached) return; // code 不存在 → 不记噪声

      const geo = lookupGeo(args.ip);
      const now = new Date();
      await this.prisma.referralClick.upsert({
        where: {
          programId_visitorKey: {
            programId: cached.programId,
            visitorKey,
          },
        },
        create: {
          programId: cached.programId,
          inviterUserId: cached.inviterUserId,
          visitorKey,
          ip: this.normalizeOptionalText(args.ip),
          country: geo.country ?? null,
          city: geo.city ?? null,
          referrer: this.normalizeOptionalText(args.referrer),
          utmSource: this.normalizeOptionalText(args.utmSource),
          utmMedium: this.normalizeOptionalText(args.utmMedium),
          utmCampaign: this.normalizeOptionalText(args.utmCampaign),
          utmContent: this.normalizeOptionalText(args.utmContent),
          clickCount: 1,
          firstClickedAt: now,
          lastClickedAt: now,
        },
        update: {
          clickCount: { increment: 1 },
          lastClickedAt: now,
        },
      });
    } catch (err) {
      this.logger.warn(`recordClick failed (silent): ${(err as Error).message}`);
    }
  }

  // ============================================================
  // 触发回调 — 由 PaymentService.fulfillOrder 调用 (fire-and-forget)
  // ============================================================

  async onOrderCompleted(args: { orderId: string }): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: args.orderId },
        select: {
          id: true,
          userId: true,
          orderType: true,
          status: true,
        },
      });
      if (!order || order.status !== 'COMPLETED') return;

      // 找该用户(invitee)所有未发奖的 redemption。
      // P2-D review fix: 改用 (inviterGranted=false OR inviteeGranted=false)
      // 而不是 rewardGranted=false,这样上一轮 inviter 成功 / invitee 失败的
      // 记录,下一次 onOrderCompleted 仍会扫到并补发未发奖的那一方。
      // 注意 triggeredAt 条件保留为 null —— 第一次匹配时才进入触发流程。
      const redemptions = await this.prisma.referralRedemption.findMany({
        where: {
          inviteeUserId: order.userId,
          OR: [{ inviterGranted: false }, { inviteeGranted: false }],
          triggeredAt: null,
          rejectReason: null,
        },
        include: { program: true },
      });

      for (const r of redemptions) {
        const cond = r.program.rewardCondition;
        const matches =
          (cond === 'FIRST_RECHARGE' && order.orderType === 'RECHARGE') ||
          (cond === 'FIRST_SUBSCRIBE' && order.orderType === 'SUBSCRIPTION');
        if (!matches) continue;
        if (!r.program.isActive || r.program.deletedAt) continue;

        try {
          await this.prisma.referralRedemption.update({
            where: { id: r.id },
            data: { triggeredAt: new Date() },
          });
          if (r.program.trackingOnly) {
            await this.markTrackingOnlyTriggered(r.id);
            continue;
          }
          await this.triggerRewards({
            program: r.program,
            inviterUserId: r.inviterUserId,
            inviteeUserId: r.inviteeUserId,
            redemptionId: r.id,
          });
        } catch (err) {
          this.logger.warn(
            `onOrderCompleted reward trigger failed: redemption=${r.id} ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `onOrderCompleted failed (silent): order=${args.orderId} ${(err as Error).message}`,
      );
    }
  }

  // ============================================================
  // Admin: list redemptions / leaderboard
  // ============================================================

  async listRedemptions(opts: ListRedemptionsOpts): Promise<{
    items: Array<
      ReferralRedemption & {
        inviter?: {
          email: string | null;
          phone: string | null;
          nickname: string;
        } | null;
        invitee?: {
          email: string | null;
          phone: string | null;
          nickname: string;
        } | null;
      }
    >;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const where: Prisma.ReferralRedemptionWhereInput = {};
    if (opts.programId) where.programId = opts.programId;
    if (opts.inviterUserId) where.inviterUserId = opts.inviterUserId;
    if (opts.triggered !== undefined) {
      where.triggeredAt = opts.triggered ? { not: null } : null;
    }

    const [items, total] = await Promise.all([
      this.prisma.referralRedemption.findMany({
        where,
        orderBy: opts.triggered
          ? { triggeredAt: 'desc' }
          : { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
        include: {
          inviter: { select: { email: true, phone: true, nickname: true } },
          invitee: { select: { email: true, phone: true, nickname: true } },
        },
      }),
      this.prisma.referralRedemption.count({ where }),
    ]);
    return {
      items,
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      totalPages: Math.ceil(total / opts.pageSize),
    };
  }

  async leaderboard(opts: LeaderboardOpts): Promise<{
    items: Array<{
      userId: string;
      email: string | null;
      phone: string | null;
      nickname: string | null;
      inviteCount: number;
      rewardTotal: number;
    }>;
  }> {
    const where: Prisma.ReferralRedemptionWhereInput = {
      rewardGranted: true,
    };
    if (opts.programId) where.programId = opts.programId;
    if (opts.days && opts.days > 0) {
      const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
      where.triggeredAt = { gte: since };
    }

    const grouped = await this.prisma.referralRedemption.groupBy({
      by: ['inviterUserId', 'programId'],
      where,
      _count: { _all: true },
    });

    if (grouped.length === 0) return { items: [] };

    // 按 programId 拿 inviterReward 算 rewardTotal
    const programIds = Array.from(new Set(grouped.map((g) => g.programId)));
    const programs = await this.prisma.referralProgram.findMany({
      where: { id: { in: programIds } },
      select: { id: true, inviterReward: true },
    });
    const rewardByProgram = new Map(
      programs.map((p) => [p.id, p.inviterReward]),
    );

    // 合并到用户级
    const userAgg = new Map<
      string,
      { userId: string; inviteCount: number; rewardTotal: number }
    >();
    for (const g of grouped) {
      const reward = rewardByProgram.get(g.programId) ?? 0;
      const cur = userAgg.get(g.inviterUserId) ?? {
        userId: g.inviterUserId,
        inviteCount: 0,
        rewardTotal: 0,
      };
      cur.inviteCount += g._count._all;
      cur.rewardTotal += reward * g._count._all;
      userAgg.set(g.inviterUserId, cur);
    }

    const userIds = Array.from(userAgg.keys());
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, phone: true, nickname: true },
    });
    const contactById = new Map(
      users.map((u) => [
        u.id,
        { email: u.email, phone: u.phone, nickname: u.nickname },
      ]),
    );

    const items = Array.from(userAgg.values())
      .map((u) => ({
        userId: u.userId,
        email: contactById.get(u.userId)?.email ?? null,
        phone: contactById.get(u.userId)?.phone ?? null,
        nickname: contactById.get(u.userId)?.nickname ?? null,
        inviteCount: u.inviteCount,
        rewardTotal: u.rewardTotal,
      }))
      .sort((a, b) => b.rewardTotal - a.rewardTotal);

    return { items };
  }

  /**
   * 汇总看板:总邀请人 / 总被邀请人 / 转化率 / 累计奖励发放 + 每 program 成功兑换数。
   * 口径:计数只算成功发奖行(rewardGranted=true);转化率 = 成功行 / 兑换总行数。
   * 全量累计(不带 days 窗口),契合「累计」语义。
   */
  async summary(opts: SummaryOpts): Promise<ReferralSummary> {
    const grantedWhere: Prisma.ReferralRedemptionWhereInput = {
      rewardGranted: true,
    };
    const attemptsWhere: Prisma.ReferralRedemptionWhereInput = {};
    const clicksWhere: Prisma.ReferralClickWhereInput = {};
    if (opts.programId) {
      grantedWhere.programId = opts.programId;
      attemptsWhere.programId = opts.programId;
      clicksWhere.programId = opts.programId;
    }

    const [
      totalAttempts,
      grantedByProgram,
      invitersGrouped,
      inviteesGrouped,
      clickByProgram,
    ] = await Promise.all([
      this.prisma.referralRedemption.count({ where: attemptsWhere }),
      this.prisma.referralRedemption.groupBy({
        by: ['programId'],
        where: grantedWhere,
        _count: { _all: true },
      }),
      this.prisma.referralRedemption.groupBy({
        by: ['inviterUserId'],
        where: grantedWhere,
      }),
      this.prisma.referralRedemption.groupBy({
        by: ['inviteeUserId'],
        where: grantedWhere,
      }),
      // 去重点击 UV:每行 = 一个 (program, visitor),count = 该 program 的 UV
      this.prisma.referralClick.groupBy({
        by: ['programId'],
        where: clicksWhere,
        _count: { _all: true },
      }),
    ]);

    // 每 program 聚合(成功兑换数 + 点击 UV),取两个集合的并集
    const perProgram: Record<
      string,
      { redemptionCount: number; clickUv: number }
    > = {};
    const ensure = (id: string) =>
      (perProgram[id] ??= { redemptionCount: 0, clickUv: 0 });
    let totalRedemptions = 0;
    for (const g of grantedByProgram) {
      ensure(g.programId).redemptionCount = g._count._all;
      totalRedemptions += g._count._all;
    }
    let totalClickUv = 0;
    for (const c of clickByProgram) {
      ensure(c.programId).clickUv = c._count._all;
      totalClickUv += c._count._all;
    }

    // 累计奖励发放 = Σ (inviterReward + inviteeReward) × 该 program 成功行数
    let totalRewardIssued = 0;
    const programIds = grantedByProgram.map((g) => g.programId);
    if (programIds.length > 0) {
      const programs = await this.prisma.referralProgram.findMany({
        where: { id: { in: programIds } },
        select: { id: true, inviterReward: true, inviteeReward: true },
      });
      const rewardByProgram = new Map(
        programs.map((p) => [p.id, p.inviterReward + p.inviteeReward]),
      );
      for (const g of grantedByProgram) {
        const reward = rewardByProgram.get(g.programId) ?? 0;
        totalRewardIssued += reward * g._count._all;
      }
    }

    return {
      totalInviters: invitersGrouped.length,
      totalInvitees: inviteesGrouped.length,
      totalRedemptions,
      totalAttempts,
      conversionRate: totalAttempts > 0 ? totalRedemptions / totalAttempts : 0,
      totalRewardIssued,
      totalClickUv,
      perProgram,
    };
  }

  /**
   * 某 program 的点击来源分布:分别按 referrer(来源页面)与 utmSource(投放渠道)
   * 分组。每组 uv=去重访客数(行数)、pv=Σ clickCount。referrer 空归 "direct",
   * utmSource 空归 "(未标记)"。各按 uv 降序取 Top 50。
   */
  async clickSources(opts: { programId: string }): Promise<{
    byReferrer: Array<{ source: string; uv: number; pv: number }>;
    byUtmSource: Array<{ source: string; uv: number; pv: number }>;
  }> {
    const where: Prisma.ReferralClickWhereInput = { programId: opts.programId };
    const [byRef, byUtm] = await Promise.all([
      this.prisma.referralClick.groupBy({
        by: ['referrer'],
        where,
        _count: { _all: true },
        _sum: { clickCount: true },
      }),
      this.prisma.referralClick.groupBy({
        by: ['utmSource'],
        where,
        _count: { _all: true },
        _sum: { clickCount: true },
      }),
    ]);
    const top = (rows: Array<{ source: string; uv: number; pv: number }>) =>
      rows.sort((a, b) => b.uv - a.uv).slice(0, 50);
    return {
      byReferrer: top(
        byRef.map((r) => ({
          source: r.referrer || 'direct',
          uv: r._count._all,
          pv: r._sum.clickCount ?? 0,
        })),
      ),
      byUtmSource: top(
        byUtm.map((r) => ({
          source: r.utmSource || '(未标记)',
          uv: r._count._all,
          pv: r._sum.clickCount ?? 0,
        })),
      ),
    };
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /** 60s Redis cache + DB fallthrough 查询 referralCode → 携带 program 时间窗口信息 */
  private async lookupReferralCodeCached(
    code: string,
  ): Promise<CachedReferralCode | null> {
    const key = `referral:code:${code}`;
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as CachedReferralCode;
          // 简单校验形状
          if (parsed && typeof parsed.programId === 'string') {
            return parsed;
          }
        } catch {
          // cache 损坏 → fallthrough
        }
      }
    } catch (err) {
      this.logger.warn(
        `redis get referral:code failed (fallthrough): ${(err as Error).message}`,
      );
    }

    const row = await this.prisma.referralCode.findFirst({
      where: { code, isActive: true },
      include: { program: true },
    });
    if (!row || !row.program) return null;

    const result: CachedReferralCode = {
      programId: row.programId,
      inviterUserId: row.inviterUserId,
      programIsActive: row.program.isActive,
      programStartAt: row.program.startAt
        ? row.program.startAt.toISOString()
        : null,
      programEndAt: row.program.endAt ? row.program.endAt.toISOString() : null,
      programDeletedAt: row.program.deletedAt
        ? row.program.deletedAt.toISOString()
        : null,
    };
    try {
      await this.redis.set(
        key,
        JSON.stringify(result),
        'EX',
        CODE_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `redis set referral:code failed (degrade): ${(err as Error).message}`,
      );
    }
    return result;
  }

  /** 防作弊检查 (spec §7.2) - 三种规则任一命中 → 返回 reason 字符串 */
  private async checkAntiAbuse(args: {
    program: ReferralProgram;
    inviterUserId: string;
    inviteeIp: string | null;
    inviteeDeviceId: string | null;
  }): Promise<string | null> {
    const { program, inviterUserId, inviteeIp, inviteeDeviceId } = args;

    // 1) sameIpLimit
    if (program.sameIpLimit != null && inviteeIp) {
      const count = await this.prisma.referralRedemption.count({
        where: {
          programId: program.id,
          rewardGranted: true,
          OR: [{ inviteeIp }, { inviterIp: inviteeIp }],
        },
      });
      if (count >= program.sameIpLimit) return 'SAME_IP_LIMIT';
    }

    // 2) sameDeviceLimit
    if (program.sameDeviceLimit != null && inviteeDeviceId) {
      const count = await this.prisma.referralRedemption.count({
        where: {
          programId: program.id,
          rewardGranted: true,
          inviteeDeviceId,
        },
      });
      if (count >= program.sameDeviceLimit) return 'SAME_DEVICE_LIMIT';
    }

    // 3) perUserInviteLimit
    if (program.perUserInviteLimit != null) {
      const count = await this.prisma.referralRedemption.count({
        where: {
          programId: program.id,
          rewardGranted: true,
          inviterUserId,
        },
      });
      if (count >= program.perUserInviteLimit) return 'PER_USER_INVITE_LIMIT';
    }

    return null;
  }

  /**
   * 触发实际奖励发放: inviter + invitee 各发一次。
   *
   * P2-D review fix(per-party 幂等):
   *   - 读当前 redemption 的 inviterGranted / inviteeGranted,只对未发奖的一方调
   *     grantToUserDirect。
   *   - 单方成功 → update inviterGranted=true 或 inviteeGranted=true(独立写)。
   *   - 两方都成功 → 同步置 rewardGranted=true(向后兼容旧字段)。
   *   - 任一方失败 → 留给 onOrderCompleted / 后续扫描重试,只重试失败的一方。
   */
  private async triggerRewards(args: {
    program: ReferralProgram;
    inviterUserId: string;
    inviteeUserId: string;
    redemptionId: string;
  }): Promise<void> {
    const { program, inviterUserId, inviteeUserId, redemptionId } = args;
    if (program.trackingOnly) {
      await this.markTrackingOnlyTriggered(redemptionId);
      return;
    }
    if (!program.inviterGrantRuleId || !program.inviteeGrantRuleId) {
      this.logger.warn(
        `program ${program.id} missing GrantRule ids (inviter=${program.inviterGrantRuleId}, invitee=${program.inviteeGrantRuleId}) — cannot grant`,
      );
      return;
    }

    // 读 redemption 当前 per-party 状态(可能上一轮 inviter 已发但 invitee 失败)
    let redemption: ReferralRedemption | null = null;
    try {
      redemption = await this.prisma.referralRedemption.findUnique({
        where: { id: redemptionId },
      });
    } catch {
      // 读失败保守视为未发奖,继续走完流程
      redemption = null;
    }
    const inviterAlready = redemption?.inviterGranted ?? false;
    const inviteeAlready = redemption?.inviteeGranted ?? false;

    const [inviterRule, inviteeRule] = await Promise.all([
      this.prisma.creditGrantRule.findUnique({
        where: { id: program.inviterGrantRuleId },
      }),
      this.prisma.creditGrantRule.findUnique({
        where: { id: program.inviteeGrantRuleId },
      }),
    ]);

    if (!inviterRule || !inviteeRule) {
      this.logger.warn(
        `program ${program.id} GrantRule lookup failed`,
      );
      return;
    }

    let inviterOk = inviterAlready;
    let inviteeOk = inviteeAlready;
    if (!inviterAlready) {
      try {
        await this.grantExecutor.grantToUserDirect(
          inviterRule as CreditGrantRule,
          inviterUserId,
        );
        inviterOk = true;
        try {
          await this.prisma.referralRedemption.update({
            where: { id: redemptionId },
            data: { inviterGranted: true },
          });
        } catch (err) {
          this.logger.warn(
            `redemption ${redemptionId} mark inviterGranted failed: ${(err as Error).message}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `inviter grant failed: program=${program.id} user=${inviterUserId} ${(err as Error).message}`,
        );
      }
    }
    if (!inviteeAlready) {
      try {
        await this.grantExecutor.grantToUserDirect(
          inviteeRule as CreditGrantRule,
          inviteeUserId,
        );
        inviteeOk = true;
        try {
          await this.prisma.referralRedemption.update({
            where: { id: redemptionId },
            data: { inviteeGranted: true },
          });
        } catch (err) {
          this.logger.warn(
            `redemption ${redemptionId} mark inviteeGranted failed: ${(err as Error).message}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `invitee grant failed: program=${program.id} user=${inviteeUserId} ${(err as Error).message}`,
        );
      }
    }

    if (inviterOk && inviteeOk) {
      try {
        await this.prisma.referralRedemption.update({
          where: { id: redemptionId },
          data: { rewardGranted: true },
        });
      } catch (err) {
        this.logger.warn(
          `redemption ${redemptionId} mark granted failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async markTrackingOnlyTriggered(redemptionId: string): Promise<void> {
    await this.prisma.referralRedemption.update({
      where: { id: redemptionId },
      data: {
        rewardGranted: true,
        inviterGranted: true,
        inviteeGranted: true,
      },
    });
  }

  /** 8 位 BASE32 随机邀请码 (spec §11): crypto.randomBytes 5 字节 → 取每字节高 5 位 */
  private generateCode(): string {
    const buf = crypto.randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += BASE32_ALPHABET[buf[i] % 32];
    }
    return out;
  }

  /** Hidden GrantRule 数据构造器 — triggerType=TASK_COMPLETE 避免被 cron 扫到 */
  private buildHiddenGrantRuleData(args: {
    programId: string;
    role: 'inviter' | 'invitee';
    rewardAmount: number;
    rewardType: 'CREDIT' | 'BALANCE';
    productId: string | null;
  }): Prisma.CreditGrantRuleCreateInput {
    return {
      name: `__referral:program-${args.programId}:${args.role}`,
      // TASK_COMPLETE: 不会被 DAILY_CRON / WEEKLY_CRON 调度器扫到。
      // 实际触发点是 ReferralsService.triggerRewards 直接调
      // CreditGrantExecutor.grantToUserDirect。
      triggerType: 'TASK_COMPLETE',
      rewardType: args.rewardType,
      rewardAmount: args.rewardAmount,
      productId: args.productId,
      // PERMANENT: 邀请奖励通常永不过期(由 program 自身的 startAt/endAt 控时)。
      expirePolicy: 'PERMANENT',
      perUserLimit: 100, // 每个 program 同一用户最多领 100 次(防止极端循环)
      isActive: true,
    };
  }

  private assertCommonProgram(input: {
    name: string;
    inviterReward: number;
    inviteeReward: number;
    rewardCondition: ReferralRewardCondition;
    trackingOnly?: boolean | null;
    sameIpLimit?: number | null;
    sameDeviceLimit?: number | null;
    perUserInviteLimit?: number | null;
  }): void {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new BadRequestException('name 必填');
    }
    if (input.name.length > NAME_MAX) {
      throw new BadRequestException(`name 长度不得超过 ${NAME_MAX} 字符`);
    }
    const minReward = input.trackingOnly ? 0 : 1;
    if (
      !Number.isInteger(input.inviterReward) ||
      input.inviterReward < minReward ||
      input.inviterReward > REWARD_AMOUNT_MAX
    ) {
      throw new BadRequestException(
        `inviterReward 必须是 ${minReward}-${REWARD_AMOUNT_MAX} 的整数`,
      );
    }
    if (
      !Number.isInteger(input.inviteeReward) ||
      input.inviteeReward < minReward ||
      input.inviteeReward > REWARD_AMOUNT_MAX
    ) {
      throw new BadRequestException(
        `inviteeReward 必须是 ${minReward}-${REWARD_AMOUNT_MAX} 的整数`,
      );
    }
    if (!REWARD_CONDITIONS.has(input.rewardCondition)) {
      throw new BadRequestException('rewardCondition 非法');
    }
    for (const key of [
      'sameIpLimit',
      'sameDeviceLimit',
      'perUserInviteLimit',
    ] as const) {
      const v = input[key];
      if (v != null && (!Number.isInteger(v) || v < 1)) {
        throw new BadRequestException(`${key} 必须是 ≥ 1 的整数或留空`);
      }
    }
  }

  private normalizeOptionalText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  private normalizeDate(d: string | Date | null): Date | null {
    if (d == null) return null;
    if (d instanceof Date) return d;
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('日期格式不合法');
    }
    return parsed;
  }
}

// 让 ReferralCode / ReferralRedemption 类型被外部使用(测试 / 控制器)
export type { ReferralCode, ReferralProgram, ReferralRedemption };

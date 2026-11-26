import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { billingProvisionalExposureBoundarySeconds } from '../metrics/metrics.registry';

/**
 * 建 exposure 表的那次迁移。它的完成时刻就是本功能的历史边界。
 *
 * ⚠️ 名字与 `prisma/migrations/` 下的目录名必须一字不差 —— 改目录名等于改边界来源。
 */
export const PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION =
  '20260828000100_gateway_usage_provisional_exposure';

/** 未就绪的负缓存 TTL。 */
const NEGATIVE_CACHE_MS = 30_000;

/**
 * provisional exposure 的历史边界（cutover）。
 *
 * ## 为什么不用环境变量
 *
 * 早先的做法是两个 GitOps 环境变量：`..._ENABLED` 与 `..._CUTOVER_AT`。它们的共同问题是
 * **一次性** —— 上线时人工设一个"未来时刻"、确认全副本一致、到点生效，此后永不再动。
 * 这类只翻转一次的开关是纯粹的运维心智负担：谁都记不住它当初为什么是那个值。
 *
 * 而 cutover 的**唯一**职责是排除「新格式的历史积压」：
 *   - 旧网关产的事件没有 `is_stream`，已被 writer 的三态判定挡掉，与边界无关；
 *   - 开启前就被消费掉的事件，writer 没跑，本就不会记。
 * 真正要挡的只有一种：**新格式、发生在本功能可用之前、却在之后才被（重新）收到**的事件。
 *
 * 「本功能何时可用」这件事，数据库自己知道 —— 就是建 exposure 表那次迁移的完成时刻。
 * 于是边界改为从 `_prisma_migrations` 读取：
 *   - **零环境变量、零 GitOps 变更、零人工动作**；
 *   - 全副本读同一行 ⇒ 天然同值，不再需要「确认所有副本拿到同一个 T」这一步；
 *   - 可审计：拿已记录行的 `min(created_at)` 与该时刻对一下即可；
 *   - 迁移与代码在同一次发布里上线，两者之间的窗口是分钟级。
 *
 * ## 为什么是惰性读取而不是启动时读一次
 *
 * 因为「靠 Nest 生命周期顺序」是一个不写在代码里的假设。真正调用 getBoundary() 的是
 * GatewayRequestEventBillingService（与本 provider 同在 BillingCoreModule），但同 module 内
 * onModuleInit 是并发的（callModuleInitHook 用 Promise.all），跨 module 又由模块图决定顺序 ——
 * 两种情形都可能让最初几秒的消息读到空边界、被误判 schema_not_ready 而静默漏记。
 * 惰性读取把这层假设整个去掉。
 *
 * 所以边界改为**首次用到时才读、读成功即永久缓存**（迁移的 finished_at 不会再变）。
 * onModuleInit 仍会预热一次，但那只是为了让启动日志尽早出现，不是正确性的前提。
 * 读失败不缓存 ⇒ 下一次调用自动重试，不会因为一次瞬时抖动把功能永久关掉。
 *
 * ## 为什么没有运行时关停开关
 *
 * 曾经加过一个 DB 侧的 `provisional_exposure_writes_enabled`（默认开），后来**整个删掉**了：
 *
 * 它唯一的场景是「writer 连续出错影响主路径」，但 writer 可达的 8 个不变量码**全是**
 * `QUARANTINE_AND_DLQ`（投 DLQ 成功后 commit ⇒ partition 继续跑，且 quarantine 的前提就是
 * 钱已确定落地 ⇒ 不丢账、不错钱）；两个 `BLOCK_PARTITION` 码里，`decision_missing` 在当前
 * wiring 下不可达，另一个已是死代码并已删除。而最现实的触发源（畸形 completion_tokens）也已
 * 从 invariant 降级为不抛的 `output_tokens_unrepresentable`。
 *
 * 于是那个键剩下的只是「一个没有控制面、只能手工写库的配置」——半个一次性开关，
 * 正是本文件开头要消灭的形态。真需要止血时回滚镜像仍然可用，而剩余可达伤害若来自未来重构，
 * 那本就是刚部署的代码缺陷，回滚才是正确工具。
 *
 * schema 未就绪（读不到迁移记录 / 表不存在）时 writer 仍然 **fail-closed**：什么都不写，
 * 归因 `schema_not_ready`。
 */
@Injectable()
export class GatewayProvisionalExposureConfig implements OnModuleInit {
  private readonly logger = new Logger(GatewayProvisionalExposureConfig.name);

  /** 读成功后的边界。一旦有值就永不再变（迁移的 finished_at 是历史事实）。 */
  private cutoverAt: Date | null = null;

  /** 正在进行的读取；用于合并并发调用，避免每条消息都打一次库。 */
  private pending: Promise<Date | null> | null = null;

  /**
   * 未就绪时的**负缓存**到期时刻（epoch ms）。
   *
   * ⚠️ 没有它，未就绪的稳定态（迁移没跑成 / 无权限）会按事件频率打库 + 每条一条 warn。
   * 30s 足够短（迁移跑完最多 30s 后自动恢复），也足够长（不会洪泛）。
   */
  private negativeUntil = 0;


  constructor(
    // ⚠️ 不加 @Optional：consumer 那条「只为顺序而存在」的必需注入已随惰性化删除，
    // 若这里也可选，则将来新增 standalone runtime 时本功能会**静默关闭**（只剩 warn + gauge=0）。
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 预热：只为让启动日志尽早出现，正确性不依赖它（见类注释）。
   *
   * 读失败**不阻断启动**：边界留空 ⇒ writer 走 `schema_not_ready` 什么都不写。
   * 这比让进程起不来更合适 —— 本功能是旁路观测，不该把整个结算服务拖 down。
   */
  async onModuleInit(): Promise<void> {
    const cutoverAt = await this.getBoundary();
    this.logger.log({
      event: 'gateway_provisional_exposure_startup',
      cutover_at: cutoverAt?.toISOString() ?? null,
      source: 'schema_migration',
      migration: PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION,
    });
  }

  /**
   * 已就绪时返回边界；未就绪返回 null（writer 据此 fail-closed）。
   *
   * 首次调用读库，成功即永久缓存；失败不缓存，下次调用重试。
   * 并发调用共享同一次读取。
   */
  async getBoundary(): Promise<Date | null> {
    if (this.cutoverAt) return this.cutoverAt;
    if (Date.now() < this.negativeUntil) return null;
    if (!this.pending) {
      this.pending = this.readCutoverAt().finally(() => {
        this.pending = null;
      });
    }
    const value = await this.pending;
    if (!value) {
      this.negativeUntil = Date.now() + NEGATIVE_CACHE_MS;
    }
    if (value) {
      this.cutoverAt = value;
      // 各副本读到的应是同一个边界；有采集栈时对 max-min != 0 告警即可。
      billingProvisionalExposureBoundarySeconds.set(
        Math.floor(value.getTime() / 1000),
      );
    }
    return value;
  }

  private async readCutoverAt(): Promise<Date | null> {

    try {
      // 只认**已完成且未回滚**的那条记录。
      // 用 min(finished_at)：同名迁移在 Prisma 里只应有一条，取 min 是为了万一有重复
      // 也拿最早那次（边界只能前移一次、不能因重放而后移）。
      // ⚠️ 别名 "finishedAt" 必须带双引号：PG 会把不带引号的别名折成小写，
      // 于是 rows[0].finishedAt 恒 undefined ⇒ 边界恒空 ⇒ 悄悄什么都不写。
      // 这是「SQL 与 TS 键名」之间唯一的绑定，有用例按完整 SQL 文本钉住。
      //
      // to_regclass：迁移记录只证明「被记录为完成」，不证明表现在真的存在
      // （migrate resolve --applied、手改历史、表被误删都能造成两者不一致）。
      // 两个条件都满足才算就绪。
      const rows = await this.prisma.$queryRaw<
        Array<{ finishedAt: Date | null; tableExists: boolean | null }>
      >`
        SELECT MIN("finished_at") AS "finishedAt",
               (to_regclass('"gateway_usage_provisional_exposures"') IS NOT NULL)
                 AS "tableExists"
        FROM "_prisma_migrations"
        WHERE "migration_name" = ${PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION}
          AND "finished_at" IS NOT NULL
          AND "rolled_back_at" IS NULL
      `;
      const row = rows[0];
      if (!row?.finishedAt || row.tableExists !== true) return null;
      return row.finishedAt;
    } catch (err) {
      // 表不存在 / 无权限 / 连接异常 ⇒ 视为未就绪，fail-closed。
      this.logger.warn({
        event: 'gateway_provisional_exposure_boundary_unavailable',
        migration: PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

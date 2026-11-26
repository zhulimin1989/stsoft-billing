import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PlanQuotaTemplate, Prisma, ProductBillingMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { RollingQuotaGateService } from '../publisher/rolling-quota-gate.service';
import { acquirePlanWriteLock, acquireTemplateWriteLock } from '../billing/plan-write-lock';
import {
  resolvePlanQuotaRuleViews,
  findCreditWindowConsistencyViolations,
  findCreditMonotonicViolations,
  formatCreditWindowConsistencyError,
  isProviderResalePlan,
  type PlanQuotaRuleBinding,
} from './plan-quota-rule-views';

const MAX_RULES_PER_TEMPLATE = 16;
const VALID_WINDOW_TYPES = new Set([
  'ROLLING',
  'FIXED_PERIOD',
  'CUMULATIVE',
]);
const VALID_METRICS = new Set([
  'REQUESTS',
  'INPUT_TOKENS',
  'OUTPUT_TOKENS',
  'TOTAL_TOKENS',
  'CREDITS',
]);

export interface QuotaRule {
  windowType: 'ROLLING' | 'FIXED_PERIOD' | 'CUMULATIVE';
  durationLabel: string;
  durationSec: number;
  metric:
    | 'REQUESTS'
    | 'INPUT_TOKENS'
    | 'OUTPUT_TOKENS'
    | 'TOTAL_TOKENS'
    | 'CREDITS';
  limitValue: number;
  modelGroupId?: string | null;
}

export interface CreateTemplateInput {
  name: string;
  description?: string;
  rules: QuotaRule[] | string; // accept either parsed array or JSON string
  isActive?: boolean;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  rules?: QuotaRule[] | string;
  isActive?: boolean;
}

export interface ListFilters {
  page: number;
  pageSize: number;
  search?: string;
  isActive?: boolean;
}

/**
 * Output shape for API responses: parses `rules` (DB column is JSON-as-text)
 * into a typed QuotaRule[] and includes the active plans that bind this
 * template through PlanQuotaRule.
 */
export interface PlanQuotaTemplateDTO {
  id: string;
  name: string;
  description: string;
  rules: QuotaRule[];
  referencedPlanIds: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanQuotaRuleDTO {
  id: string;
  planId: string;
  templateId: string;
  templateName: string;
  templateDescription: string;
  rules: QuotaRule[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class QuotaTemplatesService {
  private readonly logger = new Logger(QuotaTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherSync: PublisherSyncService,
    private readonly rollingQuotaGate: RollingQuotaGateService,
  ) {}

  // ------------------------------ CRUD -------------------------------

  async list(filters: ListFilters): Promise<{
    items: PlanQuotaTemplateDTO[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, pageSize, search, isActive } = filters;
    const where: Prisma.PlanQuotaTemplateWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const [rows, total] = await Promise.all([
      this.prisma.planQuotaTemplate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.planQuotaTemplate.count({ where }),
    ]);

    const referencedPlanIdsByTemplateId = await this.getReferencedPlanIdsByTemplateId(
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((r) => this.toDTO(r, referencedPlanIdsByTemplateId.get(r.id) ?? [])),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<PlanQuotaTemplateDTO> {
    const row = await this.prisma.planQuotaTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('配额模板不存在');
    const refs = await this.getReferencedPlanIdsByTemplateId([row.id]);
    return this.toDTO(row, refs.get(row.id) ?? []);
  }

  async create(input: CreateTemplateInput): Promise<PlanQuotaTemplateDTO> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name 必填');
    const rules = this.normalizeAndValidateRules(input.rules);
    const rulesJson = JSON.stringify(rules);
    // 模板内单调（me/quota-window-monthly-consistency.md）：同一模板内 CREDITS 滚动窗口短窗 ≤ 长窗
    // （月度无关，fail-early）；月度封顶仍在绑定时校验。
    this.assertTemplateInternalConsistency(name, rulesJson);

    try {
      const row = await this.prisma.planQuotaTemplate.create({
        data: {
          name,
          description: input.description ?? '',
          rules: rulesJson,
          isActive: input.isActive ?? true,
        },
      });
      return this.toDTO(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('模板名已存在');
      }
      throw err;
    }
  }

  async update(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<PlanQuotaTemplateDTO> {
    const existing = await this.prisma.planQuotaTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('配额模板不存在');

    const data: Prisma.PlanQuotaTemplateUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('name 不能为空');
      data.name = name;
    }
    if (input.description !== undefined) data.description = input.description;
    let nextRulesJson = existing.rules;
    if (input.rules !== undefined) {
      const rules = this.normalizeAndValidateRules(input.rules);
      nextRulesJson = JSON.stringify(rules);
      data.rules = nextRulesJson;
      // 模板内单调（与月度无关）：同一模板内 CREDITS 滚动窗口短窗 ≤ 长窗，改 rules 时早拦。
      this.assertTemplateInternalConsistency(
        (input.name && input.name.trim()) || existing.name,
        nextRulesJson,
      );
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    // 配额一致性（me/quota-window-monthly-consistency.md）：模板全局共享，改 rules 或 isActive
    // 可能使已绑定该模板的某些套餐窗口超月度/非单调。提交前以「改动后」状态重校验所有引用套餐，
    // 任一违规整体拒绝（列出受影响套餐）。仅改 name/description 不触发。
    if (input.rules !== undefined || input.isActive !== undefined) {
      await this.assertReferencedPlansConsistent(
        existing.id,
        nextRulesJson,
        input.isActive !== undefined ? input.isActive : existing.isActive,
      );
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // finding #13：禁用模板不能使某已上架自营套餐失去最后一个启用配额规则（否则 active-无绑定）。
        // 与 setPlanActive 取同一 per-plan 锁，锁内校验。
        if (input.isActive === false) {
          await this.assertActivePlansRetainQuotaRuleOnTemplateDisable(tx, existing.id);
        }
        return tx.planQuotaTemplate.update({ where: { id: existing.id }, data });
      });
      return this.toDTO(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('模板名已存在');
      }
      throw err;
    }
  }

  /**
   * Soft delete. Renames the template to `{name} (已删除 {iso-ts})` so the
   * @unique constraint on `name` doesn't lock out future re-creates with the
   * original name. Cheaper than a partial unique index and more portable.
   */
  async softDelete(id: string): Promise<void> {
    const existing = await this.prisma.planQuotaTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('配额模板不存在');

    const ts = new Date();
    const tombstoneName = `${existing.name} (已删除 ${ts.toISOString()})`;
    await this.prisma.$transaction(async (tx) => {
      // finding #13：软删=禁用，不能使已上架自营套餐失去最后一个启用配额规则。
      await this.assertActivePlansRetainQuotaRuleOnTemplateDisable(tx, existing.id);
      await tx.planQuotaTemplate.update({
        where: { id: existing.id },
        data: {
          name: tombstoneName.slice(0, 255), // guard pathological long names
          isActive: false,
          deletedAt: ts,
        },
      });
    });
  }

  /**
   * finding #13 守卫：禁用/软删某配额模板前，确保没有**已上架自营套餐**因此失去最后一个启用配额规则
   * （否则复现 active-无绑定坏状态）。与 setPlanActive/replacePlanRules/batchUpdateModelAccess 取
   * 同一 per-plan advisory 锁串行化；锁内按「排除本模板后剩余启用有效规则数」判定。
   */
  private async assertActivePlansRetainQuotaRuleOnTemplateDisable(
    tx: Prisma.TransactionClient,
    templateId: string,
  ): Promise<void> {
    // 全局锁序（codex R2 P1-4）：先锁模板，与 replacePlanRules 一致，序列化「绑定 vs 禁用」。
    // 先锁后查引用：并发 replace 若在本事务前绑定则其提交后 refs 可见，若在本事务后则它锁内重校验会拒。
    await acquireTemplateWriteLock(tx, templateId);
    const refs = await tx.planQuotaRule.findMany({
      where: { templateId, isActive: true },
      select: { planId: true },
    });
    const planIds = [...new Set(refs.map((r) => r.planId))];
    for (const pid of [...planIds].sort()) {
      await acquirePlanWriteLock(tx, pid);
    }
    for (const pid of planIds) {
      const plan = await tx.plan.findUnique({
        where: { id: pid },
        select: {
          name: true,
          isActive: true,
          features: true,
          product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
        },
      });
      const selfOpActive =
        !!plan?.isActive &&
        plan.product?.billingMode === ProductBillingMode.CODING_PLAN &&
        plan.product?.codingPlanFulfillmentMode !== 'provider_resale' &&
        !isProviderResalePlan(plan.features);
      if (!selfOpActive) continue;
      const remaining = await tx.planQuotaRule.count({
        where: {
          planId: pid,
          isActive: true,
          templateId: { not: templateId },
          template: { isActive: true, deletedAt: null },
        },
      });
      if (remaining < 1) {
        throw new ConflictException(
          `配额模板被已上架自营套餐「${plan?.name ?? pid}」引用为唯一启用配额，禁用/删除前请先为该套餐改绑其它启用模板或先下架`,
        );
      }
    }
  }

  /**
   * Clone (deep copy). Suffix `{name} 副本`; if a row with that name already
   * exists, append the millisecond timestamp to keep it unique.
   *
   * The findUnique pre-check is a best-effort optimization for the common case.
   * Two concurrent clones of the same source can both pass the pre-check and
   * race on insert — the second hits P2002. We catch that and retry with a
   * timestamp suffix so the caller never sees a 500 from a benign collision.
   */
  async clone(id: string): Promise<PlanQuotaTemplateDTO> {
    const src = await this.prisma.planQuotaTemplate.findFirst({
      where: { id, deletedAt: null },
    });
    if (!src) throw new NotFoundException('配额模板不存在');

    const baseName = `${src.name} 副本`;
    const candidate = await this.prisma.planQuotaTemplate.findUnique({
      where: { name: baseName },
    });
    const newName = candidate ? `${baseName} ${Date.now()}` : baseName;

    try {
      const row = await this.prisma.planQuotaTemplate.create({
        data: {
          name: newName,
          description: src.description,
          rules: src.rules, // already a JSON string; deep-copy by serialization
          isActive: src.isActive,
        },
      });
      return this.toDTO(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // Race: another clone won between our findUnique and create.
        // Retry once with a timestamp suffix — guaranteed-unique enough.
        const row = await this.prisma.planQuotaTemplate.create({
          data: {
            name: `${baseName} ${Date.now()}`,
            description: src.description,
            rules: src.rules,
            isActive: src.isActive,
          },
        });
        return this.toDTO(row);
      }
      throw err;
    }
  }

  async references(id: string): Promise<{ planIds: string[]; count: number }> {
    await this.getById(id); // 404 if missing
    const rows = await this.prisma.planQuotaRule.findMany({
      where: { templateId: id, isActive: true },
      select: { planId: true },
    });
    const planIds = [...new Set(rows.map((row) => row.planId))];
    return { planIds, count: planIds.length };
  }

  async listPlanRules(planId: string): Promise<PlanQuotaRuleDTO[]> {
    const normalizedPlanId = await this.assertPlanExists(planId);
    const rows = await this.prisma.planQuotaRule.findMany({
      where: {
        planId: normalizedPlanId,
        isActive: true,
        template: { deletedAt: null, isActive: true },
      },
      include: { template: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toPlanRuleDTO(row));
  }

  async replacePlanRules(
    planId: string,
    templateIds: string[],
  ): Promise<PlanQuotaRuleDTO[]> {
    const normalizedPlanId = await this.assertPlanExists(planId);
    if (!Array.isArray(templateIds)) {
      throw new BadRequestException('templateIds 必须是数组');
    }
    const uniqueTemplateIds = [...new Set(
      templateIds
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0),
    )];
    if (uniqueTemplateIds.length !== templateIds.length) {
      throw new BadRequestException('templateIds 不能包含空值或重复值');
    }
    const templates = uniqueTemplateIds.length === 0
      ? []
      : await this.prisma.planQuotaTemplate.findMany({
          where: {
            id: { in: uniqueTemplateIds },
            deletedAt: null,
            isActive: true,
          },
          select: { id: true, rules: true },
        });
    const existingIds = new Set(templates.map((template) => template.id));
    const missingIds = uniqueTemplateIds.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      throw new BadRequestException(`配额模板不存在或未启用: ${missingIds.join(', ')}`);
    }

    // 配额一致性（me/quota-window-monthly-consistency.md）：提交前以「绑定后合并视图」
    // 校验 CREDITS 滚动窗口 ≤ 该套餐 monthlyCredits 且单调；违规拒绝（不落库）。
    // 红线：仅自营(非转售) CODING_PLAN 校验；其余套餐跳过（monthly<=0 时纯函数亦直接返回）。
    const plan = await this.prisma.plan.findUnique({
      where: { id: normalizedPlanId },
      select: {
        name: true,
        isActive: true,
        monthlyCredits: true,
        features: true,
        product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
      },
    });
    // 自营口径与 setPlanActive/batchUpdateModelAccess 一致（三重排除转售，防误伤，codex）。
    const isSelfOpCodingPlan =
      plan?.product?.billingMode === ProductBillingMode.CODING_PLAN &&
      plan?.product?.codingPlanFulfillmentMode !== 'provider_resale' &&
      !isProviderResalePlan(plan.features);
    if (isSelfOpCodingPlan) {
      const bindings: PlanQuotaRuleBinding[] = templates.map((t) => ({
        template: { rules: t.rules, isActive: true, deletedAt: null },
      }));
      const monthlyCredits = plan?.monthlyCredits ?? 0;
      const violations = findCreditWindowConsistencyViolations(
        monthlyCredits,
        resolvePlanQuotaRuleViews(bindings, (m) => this.logger.warn(m)),
      );
      if (violations.length > 0) {
        throw new BadRequestException(
          formatCreditWindowConsistencyError(violations, monthlyCredits, plan?.name),
        );
      }
    }

    // finding #13：与 setPlanActive 取同一 per-plan advisory 锁串行化，杜绝「本 replace 在
    // plan 仍 inactive 时开始 → setPlanActive 读旧绑定通过并翻 active → 本 replace 提交清空绑定」
    // 的跨事务竞态。锁内重读 isActive 做 active 绑定删除守卫：已上架自营套餐不得被清空配额绑定。
    await this.prisma.$transaction(async (tx) => {
      // 全局锁序（codex R2 P1-4）：先模板(升序)后 plan，与模板 disable 守卫一致，防死锁 + 防并发 disable。
      for (const tid of [...uniqueTemplateIds].sort()) {
        await acquireTemplateWriteLock(tx, tid);
      }
      await acquirePlanWriteLock(tx, normalizedPlanId);
      // 锁内**重新**校验模板仍存在且启用：防「本 replace 事务外预检通过→并发 disable 置 inactive→
      // 本 replace 仍绑定」导致 active plan 指向 inactive 模板(有效配额=0)。
      if (uniqueTemplateIds.length > 0) {
        const activeNow = await tx.planQuotaTemplate.findMany({
          where: { id: { in: uniqueTemplateIds }, deletedAt: null, isActive: true },
          select: { id: true },
        });
        const activeIds = new Set(activeNow.map((t) => t.id));
        const nowMissing = uniqueTemplateIds.filter((id) => !activeIds.has(id));
        if (nowMissing.length > 0) {
          throw new BadRequestException(`配额模板不存在或未启用: ${nowMissing.join(', ')}`);
        }
      }
      if (isSelfOpCodingPlan && uniqueTemplateIds.length === 0) {
        const locked = await tx.plan.findUnique({
          where: { id: normalizedPlanId },
          select: { isActive: true },
        });
        if (locked?.isActive) {
          throw new ConflictException('已上架的自营套餐不能清空配额模板绑定，请先下架');
        }
      }
      await tx.planQuotaRule.deleteMany({ where: { planId: normalizedPlanId } });
      if (uniqueTemplateIds.length > 0) {
        await tx.planQuotaRule.createMany({
          data: uniqueTemplateIds.map((templateId) => ({
            planId: normalizedPlanId,
            templateId,
            isActive: true,
          })),
        });
      }
    });

    // finding #13 附带修复：主动失效 cpq:rules 缓存，让改绑后新滚动限额立即对存量订阅生效
    // （原仅依赖 5min TTL 自然过期）。失败不阻断（缓存过期兜底）。
    await this.rollingQuotaGate.invalidateRulesCache(normalizedPlanId).catch(() => undefined);

    // 配额规则已变更，异步重新下发受影响 key 的 KeyMeta（让新策略对网关可见）。
    // 故意不 await：受影响 key 可能较多(N+1)，不阻塞管理端保存响应；
    // 失败不回滚 DB（已提交），仅告警，由后续全量同步兜底。
    void this.publisherSync
      .syncApiKeysByPlanId(normalizedPlanId)
      .catch((err) =>
        this.logger.warn(
          `failed to fan out quota-rule change to publisher for plan=${normalizedPlanId}: ${(err as Error).message}`,
        ),
      );

    return this.listPlanRules(normalizedPlanId);
  }

  // ------------------------------ helpers ----------------------------

  private toDTO(
    row: PlanQuotaTemplate,
    referencedPlanIds: string[] = [],
  ): PlanQuotaTemplateDTO {
    const rules = this.parseRules(row);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      rules,
      referencedPlanIds,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toPlanRuleDTO(
    row: {
      id: string;
      planId: string;
      templateId: string;
      isActive: boolean;
      createdAt: Date;
      updatedAt: Date;
      template: PlanQuotaTemplate;
    },
  ): PlanQuotaRuleDTO {
    return {
      id: row.id,
      planId: row.planId,
      templateId: row.templateId,
      templateName: row.template.name,
      templateDescription: row.template.description,
      rules: this.parseRules(row.template),
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseRules(row: PlanQuotaTemplate): QuotaRule[] {
    try {
      const parsed = JSON.parse(row.rules);
      if (Array.isArray(parsed)) return parsed as QuotaRule[];
    } catch (err) {
      // Defensive: if a row has corrupt JSON we surface it as empty rather
      // than 500-ing the list endpoint. Log so we can spot data drift.
      this.logger.warn(
        `template ${row.id} has invalid rules JSON: ${(err as Error).message}`,
      );
    }
    return [];
  }

  /**
   * 配额一致性（me/quota-window-monthly-consistency.md）：以模板「改动后」状态（prospectiveRulesJson /
   * prospectiveIsActive）重校验所有引用该模板的套餐——每个套餐用其各自 monthlyCredits + 其它绑定模板
   * 的现状 + 本模板的改动后状态合并，任一违规整体抛 400（列出受影响套餐）。引用为空则零开销返回。
   */
  /**
   * 模板内单调校验（me/quota-window-monthly-consistency.md）：同一模板内 CREDITS 滚动窗口
   * 短窗 limitValue ≤ 长窗 limitValue（与月度无关，恒成立），违规抛 400。create/update 改 rules 时调用，
   * fail-early。月度封顶与跨模板合并校验仍在 plan 绑定时（assertReferencedPlansConsistent / billing 写入路径）。
   */
  private assertTemplateInternalConsistency(name: string, rulesJson: string): void {
    const views = resolvePlanQuotaRuleViews(
      [{ template: { rules: rulesJson, isActive: true, deletedAt: null } }],
      (m) => this.logger.warn(m),
    );
    const violations = findCreditMonotonicViolations(views);
    if (violations.length === 0) return;
    const parts = violations.map(
      (v) =>
        `${v.durationLabel} 窗口积分上限 ${v.limitValue} 高于更长窗口 ${v.comparedDurationLabel}(${v.comparedLimitValue})`,
    );
    throw new BadRequestException(
      `配额模板「${name}」规则不一致：${parts.join('；')}。同一模板内 CREDITS 滚动窗口短窗预算必须 ≤ 长窗。`,
    );
  }

  private async assertReferencedPlansConsistent(
    templateId: string,
    prospectiveRulesJson: string,
    prospectiveIsActive: boolean,
  ): Promise<void> {
    const refMap = await this.getReferencedPlanIdsByTemplateId([templateId]);
    const planIds = refMap.get(templateId) ?? [];
    if (planIds.length === 0) return;

    const [plans, allBindings] = await Promise.all([
      this.prisma.plan.findMany({
        where: { id: { in: planIds } },
        select: {
          id: true,
          name: true,
          monthlyCredits: true,
          features: true,
          product: { select: { billingMode: true } },
        },
      }),
      this.prisma.planQuotaRule.findMany({
        where: { planId: { in: planIds }, isActive: true },
        select: {
          planId: true,
          templateId: true,
          template: { select: { rules: true, isActive: true, deletedAt: true } },
        },
      }),
    ]);

    const bindingsByPlan = new Map<string, PlanQuotaRuleBinding[]>();
    for (const row of allBindings) {
      const bucket = bindingsByPlan.get(row.planId) ?? [];
      // 被改模板的绑定替换为「改动后」状态；其它模板用现状。
      bucket.push(
        row.templateId === templateId
          ? { template: { rules: prospectiveRulesJson, isActive: prospectiveIsActive, deletedAt: null } }
          : { template: row.template },
      );
      bindingsByPlan.set(row.planId, bucket);
    }

    const failures: string[] = [];
    for (const plan of plans) {
      // 红线：仅自营(非转售) CODING_PLAN 套餐校验；其余引用套餐跳过。
      if (
        plan.product?.billingMode !== ProductBillingMode.CODING_PLAN ||
        isProviderResalePlan(plan.features)
      ) {
        continue;
      }
      const views = resolvePlanQuotaRuleViews(
        bindingsByPlan.get(plan.id) ?? [],
        (m) => this.logger.warn(m),
      );
      const violations = findCreditWindowConsistencyViolations(plan.monthlyCredits, views);
      if (violations.length > 0) {
        failures.push(formatCreditWindowConsistencyError(violations, plan.monthlyCredits, plan.name));
      }
    }
    if (failures.length > 0) {
      throw new BadRequestException(`模板改动后以下套餐配额不一致：${failures.join(' | ')}`);
    }
  }

  private async getReferencedPlanIdsByTemplateId(
    templateIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (templateIds.length === 0) return result;
    const rows = await this.prisma.planQuotaRule.findMany({
      where: {
        templateId: { in: templateIds },
        isActive: true,
      },
      select: {
        templateId: true,
        planId: true,
      },
    });
    for (const row of rows) {
      const bucket = result.get(row.templateId) ?? [];
      if (!bucket.includes(row.planId)) bucket.push(row.planId);
      result.set(row.templateId, bucket);
    }
    return result;
  }

  private async assertPlanExists(planId: string): Promise<string> {
    const id = planId?.trim();
    if (!id) throw new BadRequestException('planId 必填');
    const plan = await this.prisma.plan.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!plan) throw new NotFoundException('套餐不存在');
    return id;
  }

  private normalizeAndValidateRules(
    raw: QuotaRule[] | string | undefined,
  ): QuotaRule[] {
    let rules: unknown;
    if (raw === undefined || raw === null) {
      throw new BadRequestException('rules 必填');
    }
    if (typeof raw === 'string') {
      try {
        rules = JSON.parse(raw);
      } catch {
        throw new BadRequestException('rules 必须是合法 JSON');
      }
    } else {
      rules = raw;
    }
    if (!Array.isArray(rules)) {
      throw new BadRequestException('rules 必须是数组');
    }
    if (rules.length > MAX_RULES_PER_TEMPLATE) {
      throw new BadRequestException(
        `rules 超过上限 ${MAX_RULES_PER_TEMPLATE} 条`,
      );
    }
    const validated: QuotaRule[] = rules.map((r, i) =>
      this.validateRule(r, i),
    );
    return validated;
  }

  private validateRule(r: unknown, index: number): QuotaRule {
    if (!r || typeof r !== 'object') {
      throw new BadRequestException(`rules[${index}] 必须是对象`);
    }
    const obj = r as Record<string, unknown>;

    const windowType = obj.windowType;
    if (typeof windowType !== 'string' || !VALID_WINDOW_TYPES.has(windowType)) {
      throw new BadRequestException(
        `rules[${index}].windowType 必须是 ROLLING / FIXED_PERIOD / CUMULATIVE`,
      );
    }
    const metric = obj.metric;
    if (typeof metric !== 'string' || !VALID_METRICS.has(metric)) {
      throw new BadRequestException(
        `rules[${index}].metric 必须是 REQUESTS / INPUT_TOKENS / OUTPUT_TOKENS / TOTAL_TOKENS / CREDITS`,
      );
    }
    const durationLabel = obj.durationLabel;
    if (typeof durationLabel !== 'string' || durationLabel.length === 0) {
      throw new BadRequestException(`rules[${index}].durationLabel 必填`);
    }
    const durationSec = obj.durationSec;
    if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new BadRequestException(
        `rules[${index}].durationSec 必须是正数`,
      );
    }
    const limitValue = obj.limitValue;
    if (typeof limitValue !== 'number' || !Number.isFinite(limitValue) || limitValue <= 0) {
      throw new BadRequestException(
        `rules[${index}].limitValue 必须是正数`,
      );
    }
    let modelGroupId: string | null | undefined = undefined;
    if (obj.modelGroupId !== undefined && obj.modelGroupId !== null) {
      if (typeof obj.modelGroupId !== 'string') {
        throw new BadRequestException(
          `rules[${index}].modelGroupId 必须是字符串`,
        );
      }
      modelGroupId = obj.modelGroupId;
    } else if (obj.modelGroupId === null) {
      modelGroupId = null;
    }

    return {
      windowType: windowType as QuotaRule['windowType'],
      metric: metric as QuotaRule['metric'],
      durationLabel,
      durationSec,
      limitValue,
      ...(modelGroupId !== undefined ? { modelGroupId } : {}),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }
}

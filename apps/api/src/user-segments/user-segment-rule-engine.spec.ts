import {
  MAX_RESOLVE_SIZE,
  MAX_RULE_BRANCH_FANOUT,
  MAX_RULE_DEPTH,
  MAX_RULE_NODES,
  RuleMatchTooLargeError,
  UserSegmentRuleEngine,
} from './user-segment-rule-engine';

/**
 * Rule engine tests run against a stubbed PrismaService — we don't need a real
 * DB. The stub returns predictable rows for each table that the engine queries.
 */
describe('UserSegmentRuleEngine', () => {
  // ---------- prisma stub ----------
  const stubPrisma = () => {
    const userFindMany = jest.fn();
    const queryRaw = jest.fn();
    return {
      user: { findMany: userFindMany },
      $queryRaw: queryRaw,
      __mocks: { userFindMany, queryRaw },
    } as any;
  };

  function makeEngine(prisma: any) {
    return new UserSegmentRuleEngine(prisma);
  }

  // -------------------- parse / shape validation --------------------

  it('returns [] for null/empty ruleExpr', async () => {
    const prisma = stubPrisma();
    const engine = makeEngine(prisma);
    expect(await engine.resolve(null)).toEqual([]);
    expect(await engine.resolve('')).toEqual([]);
  });

  it('throws on invalid JSON', async () => {
    const engine = makeEngine(stubPrisma());
    await expect(engine.resolve('not json')).rejects.toThrow(/Invalid ruleExpr/);
  });

  it('throws on unsupported field', async () => {
    const engine = makeEngine(stubPrisma());
    await expect(
      engine.resolve(JSON.stringify({ field: 'nope', op: 'eq', value: 1 })),
    ).rejects.toThrow(/unsupported field/);
  });

  it('throws on unsupported op for a known field', async () => {
    const engine = makeEngine(stubPrisma());
    await expect(
      engine.resolve(
        JSON.stringify({ field: 'createdAt', op: 'contains', value: 'x' }),
      ),
    ).rejects.toThrow(/does not support op/);
  });

  it('throws on empty and[]', async () => {
    const engine = makeEngine(stubPrisma());
    await expect(engine.resolve(JSON.stringify({ and: [] }))).rejects.toThrow(
      /and\[\] cannot be empty/,
    );
  });

  // -------------------- direct fields --------------------

  it('createdAt > date — translates to gt where', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        field: 'createdAt',
        op: '>',
        value: '2026-01-01T00:00:00Z',
      }),
    );
    expect(r).toEqual(['u1', 'u2']);
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.createdAt).toEqual({ gt: new Date('2026-01-01T00:00:00Z') });
    expect(args.where.deletedAt).toBeNull();
  });

  it('createdAt between — translates to gte/lte', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([{ id: 'u1' }]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({
        field: 'createdAt',
        op: 'between',
        value: ['2026-01-01', '2026-02-01'],
      }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.createdAt.gte.getTime()).toBe(
      new Date('2026-01-01').getTime(),
    );
    expect(args.where.createdAt.lte.getTime()).toBe(
      new Date('2026-02-01').getTime(),
    );
  });

  it('subscriptionStatus = NONE — translates to none:{}', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([{ id: 'u3' }]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'NONE' }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.subscriptions).toEqual({ none: {} });
  });

  it('subscriptionStatus = ACTIVE — translates to some:{status:ACTIVE}', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'ACTIVE' }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.subscriptions).toEqual({ some: { status: 'ACTIVE' } });
  });

  it('currentPlanId = X — adds status: ACTIVE filter', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({ field: 'currentPlanId', op: '=', value: 'plan-pro' }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.subscriptions).toEqual({
      some: { planId: 'plan-pro', status: 'ACTIVE' },
    });
  });

  it('currentPlanId in [...] — translates to planId.in', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({
        field: 'currentPlanId',
        op: 'in',
        value: ['plan-a', 'plan-b'],
      }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.subscriptions.some.planId).toEqual({
      in: ['plan-a', 'plan-b'],
    });
  });

  it('emailDomain = example.com — endsWith @example.com', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({
        field: 'emailDomain',
        op: '=',
        value: 'example.com',
      }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.email).toEqual({ endsWith: '@example.com' });
  });

  it('emailDomain contains — substring match', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([]);
    const engine = makeEngine(prisma);
    await engine.resolve(
      JSON.stringify({
        field: 'emailDomain',
        op: 'contains',
        value: 'biz',
      }),
    );
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.where.email).toEqual({ contains: 'biz' });
  });

  it('signupChannel — column missing, returns empty set with warning', async () => {
    const prisma = stubPrisma();
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({ field: 'signupChannel', op: '=', value: 'web' }),
    );
    expect(r).toEqual([]);
    expect(prisma.__mocks.userFindMany).not.toHaveBeenCalled();
  });

  // -------------------- aggregate fields --------------------

  it('monthlySpentCents > N — sums orders, applies cmp', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u1', total: 50_000 },
      { user_id: 'u2', total: 150_000 },
      { user_id: 'u3', total: 200_000 },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({ field: 'monthlySpentCents', op: '>', value: 100_000 }),
    );
    expect(r.sort()).toEqual(['u2', 'u3']);
  });

  it('currentBalanceCents < N — uses latest balance per user', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u1', balance: 100 },
      { user_id: 'u2', balance: 5_000 },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        field: 'currentBalanceCents',
        op: '<',
        value: 1_000,
      }),
    );
    expect(r).toEqual(['u1']);
  });

  it('lastActiveAt > date — picks users with last_active beyond threshold', async () => {
    const prisma = stubPrisma();
    const old = new Date('2026-01-01');
    const recent = new Date('2026-04-15');
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u1', last_active: old },
      { user_id: 'u2', last_active: recent },
      { user_id: 'u3', last_active: null },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        field: 'lastActiveAt',
        op: '>',
        value: '2026-03-01',
      }),
    );
    expect(r).toEqual(['u2']);
  });

  // -------------------- composition --------------------

  it('AND intersects multiple branches', async () => {
    const prisma = stubPrisma();
    // direct branch: returns u1, u2, u3
    prisma.__mocks.userFindMany.mockResolvedValueOnce([
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    // aggregate branch: returns u2, u4
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u2', total: 200_000 },
      { user_id: 'u4', total: 300_000 },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        and: [
          {
            field: 'subscriptionStatus',
            op: '=',
            value: 'ACTIVE',
          },
          { field: 'monthlySpentCents', op: '>', value: 100_000 },
        ],
      }),
    );
    expect(r).toEqual(['u2']);
  });

  it('OR unions multiple branches', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([{ id: 'u1' }]);
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u2', total: 200_000 },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        or: [
          { field: 'subscriptionStatus', op: '=', value: 'ACTIVE' },
          { field: 'monthlySpentCents', op: '>', value: 100_000 },
        ],
      }),
    );
    expect(r.sort()).toEqual(['u1', 'u2']);
  });

  it('nested AND/OR composes correctly', async () => {
    const prisma = stubPrisma();
    // outer AND first child (or branch — two direct sub-branches)
    prisma.__mocks.userFindMany
      .mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }]) // subscriptionStatus = ACTIVE
      .mockResolvedValueOnce([{ id: 'u2' }, { id: 'u5' }]); // emailDomain = example.com
    // outer AND second child (aggregate)
    prisma.__mocks.queryRaw.mockResolvedValueOnce([
      { user_id: 'u2', total: 200_000 },
      { user_id: 'u3', total: 200_000 },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({
        and: [
          {
            or: [
              { field: 'subscriptionStatus', op: '=', value: 'ACTIVE' },
              { field: 'emailDomain', op: '=', value: 'example.com' },
            ],
          },
          { field: 'monthlySpentCents', op: '>', value: 100_000 },
        ],
      }),
    );
    expect(r).toEqual(['u2']);
  });

  // -------------------- DoS guards --------------------

  it('rejects rule whose depth exceeds MAX_RULE_DEPTH', async () => {
    // Build {and:[{and:[{and:[ ... leaf ]}]}]} with depth = MAX_RULE_DEPTH+1
    // (root counts as depth 0, so we need MAX_RULE_DEPTH+1 wrappers + leaf
    // for the leaf to live at depth MAX_RULE_DEPTH+1).
    let node: any = {
      field: 'subscriptionStatus',
      op: '=',
      value: 'ACTIVE',
    };
    for (let i = 0; i <= MAX_RULE_DEPTH; i++) {
      node = { and: [node] };
    }
    const engine = makeEngine(stubPrisma());
    await expect(engine.resolve(JSON.stringify(node))).rejects.toThrow(
      /rule depth exceeds/,
    );
  });

  it('rejects rule whose total node count exceeds MAX_RULE_NODES', async () => {
    // Single OR with MAX_RULE_NODES leaves — total nodes = 1 (or wrapper) +
    // leaves. We pad with MAX_RULE_NODES leaves which together with the
    // wrapper exceeds the cap. Wrap fanout-batches in nested OR to stay under
    // MAX_RULE_BRANCH_FANOUT per level.
    const totalLeaves = MAX_RULE_NODES + 5;
    const leaf = (i: number) => ({
      field: 'currentPlanId',
      op: '=',
      value: `plan-${i}`,
    });
    const groups: any[] = [];
    for (let i = 0; i < totalLeaves; i += MAX_RULE_BRANCH_FANOUT) {
      const slice = [];
      for (
        let j = i;
        j < Math.min(i + MAX_RULE_BRANCH_FANOUT, totalLeaves);
        j++
      ) {
        slice.push(leaf(j));
      }
      groups.push({ or: slice });
    }
    // groups.length is well under MAX_RULE_BRANCH_FANOUT for these sizes.
    const node = { or: groups };
    const engine = makeEngine(stubPrisma());
    await expect(engine.resolve(JSON.stringify(node))).rejects.toThrow(
      /more than \d+ nodes/,
    );
  });

  it('rejects and[] whose fanout exceeds MAX_RULE_BRANCH_FANOUT', async () => {
    const children = [];
    for (let i = 0; i <= MAX_RULE_BRANCH_FANOUT; i++) {
      children.push({ field: 'currentPlanId', op: '=', value: `p-${i}` });
    }
    const engine = makeEngine(stubPrisma());
    await expect(
      engine.resolve(JSON.stringify({ and: children })),
    ).rejects.toThrow(/and\[\] fanout exceeds/);
  });

  it('accepts rule at exact limits (depth=16, ~200 nodes, fanout=32)', async () => {
    // depth: 16 nested ands (root depth 0, leaf depth 16). Each wrapper
    // contributes 1 node, plus 1 leaf = 17 nodes, well under 200.
    let depthNode: any = {
      field: 'subscriptionStatus',
      op: '=',
      value: 'ACTIVE',
    };
    for (let i = 0; i < MAX_RULE_DEPTH; i++) {
      depthNode = { and: [depthNode] };
    }
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValue([{ id: 'u1' }]);
    const engine = makeEngine(prisma);
    await expect(engine.resolve(JSON.stringify(depthNode))).resolves.toEqual([
      'u1',
    ]);

    // Fanout: exactly MAX_RULE_BRANCH_FANOUT children — should pass shape
    // validation. Use OR so each child resolves directly via findMany.
    const fanoutChildren = [];
    for (let i = 0; i < MAX_RULE_BRANCH_FANOUT; i++) {
      fanoutChildren.push({
        field: 'currentPlanId',
        op: '=',
        value: `p-${i}`,
      });
    }
    prisma.__mocks.userFindMany.mockResolvedValue([{ id: 'u1' }]);
    const engine2 = makeEngine(prisma);
    await expect(
      engine2.resolve(JSON.stringify({ or: fanoutChildren })),
    ).resolves.toEqual(['u1']);
  });

  it('throws RuleMatchTooLargeError when leaf set exceeds MAX_RESOLVE_SIZE', async () => {
    const prisma = stubPrisma();
    // Return MAX_RESOLVE_SIZE+1 rows so the cap trips. We avoid actually
    // allocating that many objects by spying on findMany and synthesizing.
    const oversized = Array.from(
      { length: MAX_RESOLVE_SIZE + 1 },
      (_, i) => ({ id: `u${i}` }),
    );
    prisma.__mocks.userFindMany.mockResolvedValueOnce(oversized);
    const engine = makeEngine(prisma);
    await expect(
      engine.resolve(
        JSON.stringify({
          field: 'subscriptionStatus',
          op: '=',
          value: 'ACTIVE',
        }),
      ),
    ).rejects.toBeInstanceOf(RuleMatchTooLargeError);
    // The leaf query should request take = cap+1 so we can detect overflow
    // without scanning the whole table.
    const args = prisma.__mocks.userFindMany.mock.calls[0][0];
    expect(args.take).toBe(MAX_RESOLVE_SIZE + 1);
  });

  it('limit caps the returned set', async () => {
    const prisma = stubPrisma();
    prisma.__mocks.userFindMany.mockResolvedValueOnce([
      { id: 'u3' },
      { id: 'u1' },
      { id: 'u2' },
    ]);
    const engine = makeEngine(prisma);
    const r = await engine.resolve(
      JSON.stringify({ field: 'subscriptionStatus', op: '=', value: 'ACTIVE' }),
      2,
    );
    // sorted asc, limited to 2
    expect(r).toEqual(['u1', 'u2']);
  });
});

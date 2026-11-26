import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'crypto';
import { EnterpriseAccountService } from './enterprise-account.service';
import { EnterpriseAccountInternalController } from '../billing-runtime/enterprise-account-internal.controller';
import { BillingInternalGuard } from '../billing-runtime/billing-internal.guard';
import { BillingWorkspaceMirrorService } from '../billing-runtime/billing-workspace-mirror.service';
import { BillingUserMirrorService } from '../billing-runtime/billing-user-mirror.service';
import { BillingService } from './billing.service';
import { PrismaService, createBillingAdvisoryLockClient } from '../prisma/prisma.service';

const databaseUrl = process.env.BILLING_DB_TEST_URL;
if (!databaseUrl && process.env.CI) throw new Error('BILLING_DB_TEST_URL required for enterprise contract tests');
const describeDatabase = databaseUrl ? describe : describe.skip;
describeDatabase('enterprise onboarding contract (real Billing PostgreSQL and HTTP)', () => {
  let prisma: PrismaClient;
  let second: PrismaClient;
  let service: EnterpriseAccountService;
  let app: NestFastifyApplication;
  const prefix = `eac-billing-${randomUUID()}`;
  const owner = `${prefix}-owner`;
  const other = `${prefix}-other`;
  const config = new ConfigService({ PLATFORM_REGION: 'domestic', USER_TO_BILLING_TOKEN: 'eac-contract-test-token' });
  const publisher = { syncBillingAccountKeyBalances: jest.fn(async () => undefined) };
  const billing = { syncTenantBalanceCacheForCurrentBinding: jest.fn(async () => undefined) };
  const headers = { 'x-internal-caller': 'user-api', 'x-internal-token': 'eac-contract-test-token', 'x-billing-api-version': '2026-05-16' };
  let sequence = 0;
  function input() {
    sequence++;
    return { userId: owner, verificationId: `${prefix}-${sequence}`, enterpriseName: '隔离测试企业', uscc: `91110000${sequence.toString().padStart(10, '0')}` };
  }
  function build(db: PrismaClient) { return new EnterpriseAccountService(db as never, publisher as never, billing as never, config); }
  async function historicalAccount(request: ReturnType<typeof input>, withWallet = true) {
    // Import a declared legacy fixture; never downgrade a clean account or disable its guards.
    const account = await prisma.billingAccount.create({ data: {
      name: request.enterpriseName, enterpriseName: request.enterpriseName, type: 'enterprise', currency: 'CNY',
      ownerUserId: request.userId, verificationId: request.verificationId, uscc: request.uscc,
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
    } });
    if (withWallet) await prisma.accountWallet.create({ data: { billingAccountId: account.id, balanceUsd: 0 } });
    return account;
  }
  it('owned advisory-lock client keeps one physical session and excludes an independent connection until explicit unlock', async () => {
    const previous = { DATABASE_URL: process.env.DATABASE_URL, BILLING_DATABASE_URL: process.env.BILLING_DATABASE_URL, RUIDONG_SERVICE: process.env.RUIDONG_SERVICE };
    process.env.DATABASE_URL = databaseUrl; process.env.BILLING_DATABASE_URL = databaseUrl; process.env.RUIDONG_SERVICE = 'billing';
    const dedicated = createBillingAdvisoryLockClient()!;
    const lock = `${prefix}-owned-session`;
    try {
      const [first] = await dedicated.$queryRaw<Array<{ pid: number; db: string }>>`SELECT pg_backend_pid() AS pid,current_database() AS db`;
      expect(first.db).toBe(new URL(databaseUrl!).pathname.slice(1));
      expect((await dedicated.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lock})) AS acquired`)[0].acquired).toBe(true);
      await second.$transaction(async tx => {
        const [other] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        expect(other.pid).not.toBe(first.pid);
        expect((await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lock})) AS acquired`)[0].acquired).toBe(false);
        expect((await dedicated.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid).toBe(first.pid);
        expect((await dedicated.$queryRaw<Array<{ unlocked: boolean }>>`SELECT pg_advisory_unlock(hashtext(${lock})) AS unlocked`)[0].unlocked).toBe(true);
        expect((await tx.$queryRaw<Array<{ acquired: boolean }>>`SELECT pg_try_advisory_lock(hashtext(${lock})) AS acquired`)[0].acquired).toBe(true);
        expect((await tx.$queryRaw<Array<{ unlocked: boolean }>>`SELECT pg_advisory_unlock(hashtext(${lock})) AS unlocked`)[0].unlocked).toBe(true);
        console.info('EAC22 owned advisory session', { firstPid: first.pid, secondPid: other.pid, database: first.db });
      });
    } finally {
      await dedicated.$disconnect();
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
  it('preserves personal account/member timestamps on an unchanged mirror while real disable/enable remains personal-only', async () => {
    const userId = `${prefix}-personal-preservation`;
    const accountId = `ba_personal_${userId}`;
    await prisma.user.create({ data: { id: userId } });
    try {
      await prisma.billingAccount.create({ data: { id: accountId, ownerUserId: userId, name: '既有个人账户', type: 'personal', currency: 'USD' } });
      await prisma.accountWallet.create({ data: { billingAccountId: accountId, balanceUsd: '123.456789012345' } });
      await prisma.billingAccountMember.create({ data: { billingAccountId: accountId, userId, role: 'owner', status: 'active' } });
      const enterprise = await service.createEnterpriseAccount({ ...input(), userId });
      const personal = async () => ({
        account: await prisma.billingAccount.findUniqueOrThrow({ where: { id: accountId } }),
        member: await prisma.billingAccountMember.findFirstOrThrow({ where: { billingAccountId: accountId, userId } }),
        wallet: await prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId: accountId } }),
      });
      const corporate = await prisma.billingAccount.findUniqueOrThrow({ where: { id: enterprise.id }, include: { members: true, wallet: true } });
      const before = await personal();
      const mirror = new BillingUserMirrorService(prisma as never);
      await mirror.mirrorUser({ id: userId, isActive: true });
      expect(await personal()).toEqual(before);
      await mirror.mirrorUser({ id: userId, isActive: false });
      const disabled = await personal();
      expect(disabled.account.status).toBe('suspended');
      expect(disabled.member.status).toBe('inactive');
      expect(disabled.wallet).toEqual(before.wallet);
      await mirror.mirrorUser({ id: userId, isActive: true });
      const restored = await personal();
      expect(restored.account.status).toBe('active');
      expect(restored.member.status).toBe('active');
      expect(restored.wallet).toEqual(before.wallet);
      await mirror.mirrorUser({ id: userId, isActive: true });
      expect(await personal()).toEqual(restored);
      expect(await prisma.billingAccount.findUniqueOrThrow({ where: { id: enterprise.id }, include: { members: true, wallet: true } })).toEqual(corporate);
    } finally {
      await prisma.billingAccount.deleteMany({ where: { ownerUserId: userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  });
  beforeAll(async () => {
    if (!/test/i.test(new URL(databaseUrl!).pathname)) throw new Error('Test database required');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    second = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.user.createMany({ data: [{ id: owner }, { id: other }] });
    service = build(prisma);
    const module = await Test.createTestingModule({
      controllers: [EnterpriseAccountInternalController],
      providers: [BillingInternalGuard, { provide: ConfigService, useValue: config },
        { provide: EnterpriseAccountService, useValue: service }, { provide: BillingService, useValue: billing },
        { provide: PrismaService, useValue: prisma }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    if (app) await app.close();
    if (!prisma) return;
    await prisma.tenant.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.billingAccount.deleteMany({ where: { verificationId: { startsWith: prefix } } });
    await prisma.enterpriseProvisioningTombstone.deleteMany({ where: { verificationId: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
    await second.$disconnect();
    await prisma.$disconnect();
  });
  async function expectCode(operation: Promise<unknown>, code: string) {
    await expect(operation).rejects.toMatchObject({ response: expect.objectContaining({ code }), status: 409 });
  }
  it('creates only an enterprise account, zero wallet, one Owner and replays the same verification', async () => {
    const request = input();
    const fresh = await service.createEnterpriseAccount(request);
    const replay = await service.createEnterpriseAccount(request);
    expect(replay).toMatchObject({ id: fresh.id, idempotent: true, walletCreated: false, ownerMemberCreated: false, attached: false });
    expect(await prisma.billingAccount.count({ where: { verificationId: request.verificationId } })).toBe(1);
    expect((await prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId: fresh.id } })).balanceUsd.toString()).toBe('0');
    expect(await prisma.billingAccountMember.count({ where: { billingAccountId: fresh.id, role: 'owner', userId: owner } })).toBe(1);
    await expectCode(service.createEnterpriseAccount({ ...request, userId: other }), 'enterprise_account_owner_changed');
  });
  it('enforces the actual raw-USCC partial unique index and returns a structured conflict', async () => {
    const request = input();
    await service.createEnterpriseAccount(request);
    await expectCode(service.createEnterpriseAccount({ ...request, verificationId: `${request.verificationId}-other` }), 'enterprise_uscc_conflict');
    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'billing_accounts_uscc_active_uk'`;
    expect(indexes[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0].indexdef).toContain('deleted_at IS NULL');
  });
  async function concurrentRequests(a: ReturnType<typeof input>, b: ReturnType<typeof input>) {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const withBarrier = (db: PrismaClient) => new Proxy(db, { get(target, property) {
      if (property === '$transaction') return (callback: (tx: unknown) => unknown) => target.$transaction(async (tx) => {
        arrived++;
        if (arrived === 2) release();
        await both;
        return callback(tx);
      }, { timeout: 15_000 });
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return Promise.allSettled([build(withBarrier(prisma)).createEnterpriseAccount(a), build(withBarrier(second)).createEnterpriseAccount(b)]);
  }
  it('serializes concurrent same-verification replays on two independent DB connections', async () => {
    const request = input();
    const results = await concurrentRequests(request, request);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(new Set(results.map((r) => r.status === 'fulfilled' ? r.value.id : null)).size).toBe(1);
    expect(await prisma.billingAccount.count({ where: { verificationId: request.verificationId } })).toBe(1);
  });
  it('allows at most one concurrent account for one USCC with different verifications', async () => {
    const request = input();
    const results = await concurrentRequests(request, { ...request, verificationId: `${request.verificationId}-other` });
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason.response.code).toBe('enterprise_uscc_conflict');
    expect(await prisma.billingAccount.count({ where: { uscc: request.uscc } })).toBe(1);
  });
  it('rejects suspended, quarantined and zero-account tombstoned replays', async () => {
    const request = input();
    const account = await service.createEnterpriseAccount(request);
    await prisma.billingAccount.update({ where: { id: account.id }, data: { status: 'suspended' } });
    await expectCode(service.createEnterpriseAccount(request), 'enterprise_account_suspended');
    await prisma.billingAccount.update({ where: { id: account.id }, data: { status: 'active', provisioningQuarantinedAt: new Date() } });
    await expectCode(service.createEnterpriseAccount(request), 'enterprise_account_quarantined');
    const tombstone = input();
    await prisma.enterpriseProvisioningTombstone.create({ data: { verificationId: tombstone.verificationId, reason: 'fixture' } });
    await expectCode(service.createEnterpriseAccount(tombstone), 'enterprise_provisioning_tombstoned');
    expect((await service.reconcileByVerification(tombstone.verificationId))).toMatchObject({ tombstoned: true, accountCount: 0 });
  });
  it('rejects wrong tenant ownership and existing other-account bindings and rolls back fresh resources', async () => {
    const request = input();
    const tenant = await prisma.tenant.create({ data: { id: `${prefix}-wrong`, name: 'fixture', type: 'enterprise', ownerUserId: other } });
    await expectCode(service.createEnterpriseAccount({ ...request, tenantId: tenant.id }), 'enterprise_tenant_owner_mismatch');
    expect(await prisma.billingAccount.count({ where: { verificationId: request.verificationId } })).toBe(0);
    const original = await service.createEnterpriseAccount(input());
    await prisma.tenant.update({ where: { id: tenant.id }, data: { ownerUserId: owner, billingAccountId: original.id } });
    await expectCode(service.createEnterpriseAccount({ ...request, tenantId: tenant.id }), 'tenant_attach_conflict');
    expect(await prisma.billingAccount.count({ where: { verificationId: request.verificationId } })).toBe(0);
  });
  it('rechecks Owner after acquiring the wallet/account lock, stopping a stale member initialization', async () => {
    const account = await service.createEnterpriseAccount(input());
    let release!: () => void;
    let held!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { held = resolve; });
    const locker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT billing_account_id FROM account_wallets WHERE billing_account_id = ${account.id} FOR UPDATE`;
      held();
      await hold;
      await tx.billingAccount.update({ where: { id: account.id }, data: { ownerUserId: other } });
    }, { timeout: 15_000 });
    await ready;
    const stale = build(second).upsertOwnerMember(account.id, { userId: owner });
    // Attach a rejection handler before releasing the held transaction.
    const assertion = expectCode(stale, 'enterprise_account_owner_changed');
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%account_wallets%'`;
        if (Number(rows[0].count) > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    await locker;
    await assertion;
    expect(await prisma.billingAccountMember.count({ where: { billingAccountId: account.id, userId: other } })).toBe(0);
  });
  it('mirrors an enterprise workspace without creating or binding a personal account', async () => {
    const mirror = new BillingWorkspaceMirrorService(prisma as never, new BillingUserMirrorService(prisma as never), undefined, config);
    const id = `${prefix}-mirror`;
    await mirror.mirror({ user: { id: owner }, tenant: { id, name: 'fixture', type: 'enterprise', status: 'active', ownerUserId: owner }, membership: { userId: owner, role: 'owner', status: 'active' } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).billingAccountId).toBeNull();
    expect(await prisma.billingAccount.count({ where: { type: 'personal', ownerUserId: owner } })).toBe(0);
  });
  it('pins an attach request to its original Owner even when account and tenant were both transferred', async () => {
    const account = await service.createEnterpriseAccount(input());
    const tenantId = `${prefix}-transferred`;
    await prisma.tenant.create({ data: { id: tenantId, name: 'fixture', type: 'enterprise', ownerUserId: other } });
    await prisma.billingAccount.update({ where: { id: account.id }, data: { ownerUserId: other } });
    await expectCode(service.attachTenant(account.id, { tenantId, userId: owner }), 'enterprise_account_owner_changed');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).billingAccountId).toBeNull();
  });
  it('returns replay receipts without claiming that missing resources were repaired', async () => {
    const request = input();
    const account = await historicalAccount(request, false);
    expect(await service.createEnterpriseAccount(request)).toMatchObject({ id: account.id, idempotent: true, walletCreated: false });
    expect((await service.reconcileByVerification(request.verificationId)).accounts[0].balanceUsd).toBeNull();
  });
  it('the full V2 contract refuses deleting a clean runtime wallet and preserves its exact row', async () => {
    const account = await service.createEnterpriseAccount(input());
    const before = await prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId: account.id } });
    await expect(prisma.accountWallet.delete({ where: { billingAccountId: account.id } })).rejects.toThrow('clean account wallet cannot be deleted');
    expect(await prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId: account.id } })).toEqual(before);
  });
  it('bounds historical subject responses and explicitly reports truncation', async () => {
    const request = input();
    request.uscc = '91110000YYYYYYYYYY';
    await prisma.billingAccount.createMany({ data: Array.from({ length: 101 }, () => ({
      name: 'fixture', type: 'enterprise', currency: 'CNY', ownerUserId: owner, verificationId: request.verificationId,
      uscc: request.uscc, status: 'deleted', deletedAt: new Date(),
    })) });
    const result = await service.checkEnterpriseSubject(request.uscc);
    expect(result).toMatchObject({ occupied: true, truncated: true });
    expect(result.accounts).toHaveLength(100);
  });
  it('performs exact canonical HTTP checks including lowercase, whitespace, suspended and deleted rows', async () => {
    const request = input();
    request.uscc = '91110000AAAAAAAAAA';
    const historical = await prisma.billingAccount.create({ data: { name: 'fixture', type: 'enterprise', currency: 'CNY', ownerUserId: owner,
      verificationId: request.verificationId, uscc: `\t\u00a0 ${request.uscc.toLowerCase()} \ufeff\n`, status: 'suspended', deletedAt: new Date() } });
    const response = await fetch(`${await app.getUrl()}/internal/billing/admin/enterprise-accounts/subject-check`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ uscc: request.uscc }) });
    expect(response.status).toBe(201);
    const result = await response.json() as any;
    expect(result.data).toMatchObject({ occupied: true, truncated: false, accounts: [expect.objectContaining({ accountId: historical.id, status: 'suspended', deletedAt: expect.any(String) })] });
    expect(JSON.stringify(result)).not.toContain('balance');
    expect((await service.checkEnterpriseSubject('91110000XXXXXXXXXX')).occupied).toBe(false);
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE indexname = 'billing_accounts_uscc_canonical_lookup_idx'`;
    expect(indexes[0].indexdef).toContain('upper(btrim');
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw`EXPLAIN (FORMAT JSON) SELECT id FROM billing_accounts
        WHERE uscc IS NOT NULL AND upper(btrim(uscc, E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')) = ${request.uscc}`;
    });
    // Only proves the expression is indexable, not production performance.
    expect(JSON.stringify(plan)).toContain('billing_accounts_uscc_canonical_lookup_idx');
  });
  it('rejects noncanonical input and does not broaden User caller permissions or bypass token/version checks', async () => {
    const url = `${await app.getUrl()}/internal/billing/admin/enterprise-accounts`;
    expect((await fetch(url, { headers })).status).toBe(401);
    for (const supplied of [{ ...headers, 'x-internal-token': 'wrong' }, { ...headers, 'x-billing-api-version': '1900-01-01' }]) {
      expect((await fetch(`${url}/subject-check`, { method: 'POST', headers: { ...supplied, 'content-type': 'application/json' }, body: JSON.stringify({ uscc: input().uscc }) })).ok).toBe(false);
    }
    const response = await fetch(`${url}/subject-check`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ uscc: 'invalid' }) });
    expect(response.status).toBe(400);
    expect((await response.json() as any).code).toBe('enterprise_uscc_invalid');
  });
  async function proofFixture(historical = false) {
    const request = input(), tenantId = `${prefix}-proof-${sequence}`;
    await prisma.tenant.create({ data: { id: tenantId, name: 'proof', type: 'enterprise', ownerUserId: owner } });
    await prisma.tenantMember.create({ data: { tenantId, userId: owner, role: 'owner', status: 'active' } });
    const account = historical ? await historicalAccount(request) : await service.createEnterpriseAccount({ ...request, tenantId });
    if (historical) {
      await prisma.billingAccountMember.create({ data: { billingAccountId: account.id, userId: owner, role: 'owner', status: 'active' } });
      await prisma.tenant.update({ where: { id: tenantId }, data: { billingAccountId: account.id } });
    }
    return { request, proof: { verificationId: request.verificationId, accountId: account.id, tenantId, ownerUserId: owner } };
  }
  it('proves specified wallet, Owner and Tenant facts over real authenticated HTTP without exposing funds or broadening GET details', async () => {
    const f = await proofFixture(), base = `${await app.getUrl()}/internal/billing/admin/enterprise-accounts`;
    const response = await fetch(`${base}/provisioning-proof`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(f.proof) });
    expect(response.status).toBe(201); const body = await response.json() as any;
    expect(body.data).toMatchObject({ ...f.proof, accountCount: 1, tombstoned: false, walletExists: true,
      account: { ownerUserId: owner, verificationId: f.request.verificationId }, ownerMember: { userId: owner, role: 'owner', status: 'active' },
      tenant: { id: f.proof.tenantId, billingAccountId: f.proof.accountId }, tenantMember: { userId: owner, role: 'owner', status: 'active' } });
    expect(JSON.stringify(body)).not.toMatch(/balance|email|phone|credit/i);
    expect((await fetch(`${base}/${f.proof.accountId}`, { headers })).status).toBe(401);
    for (const [auth, status] of [[{ ...headers, 'x-internal-caller': 'finance-api' }, 401], [{ ...headers, 'x-internal-token': 'wrong' }, 401], [{ ...headers, 'x-billing-api-version': 'wrong' }, 400]] as const) {
      expect((await fetch(`${base}/provisioning-proof`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(f.proof) })).status).toBe(status);
    }
    for (const invalid of [{ ...f.proof, operatorId: 'forged' }, { ...f.proof, accountId: '' }, { verificationId: f.proof.verificationId }]) {
      expect((await fetch(`${base}/provisioning-proof`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(invalid) })).status).toBe(400);
    }
  });
  it('reports missing resources, all historical accounts and independent tombstones without repairing anything', async () => {
    const f = await proofFixture(true);
    await prisma.accountWallet.delete({ where: { billingAccountId: f.proof.accountId } });
    await prisma.billingAccountMember.deleteMany({ where: { billingAccountId: f.proof.accountId } });
    await prisma.tenant.update({ where: { id: f.proof.tenantId }, data: { status: 'suspended', billingAccountId: null } });
    await prisma.billingAccount.create({ data: { name: 'old', type: 'enterprise', currency: 'CNY', verificationId: f.proof.verificationId, deletedAt: new Date(), status: 'deleted', ownerUserId: other } });
    await prisma.enterpriseProvisioningTombstone.create({ data: { verificationId: f.proof.verificationId, reason: 'proof fixture' } });
    expect(await service.provisioningProof(f.proof)).toMatchObject({ accountCount: 2, tombstoned: true, walletExists: false, ownerMember: null, tenant: { status: 'suspended', billingAccountId: null } });
    expect(await prisma.accountWallet.count({ where: { billingAccountId: f.proof.accountId } })).toBe(0);
    expect((await service.provisioningProof({ ...f.proof, accountId: randomUUID(), tenantId: randomUUID() }))).toMatchObject({ account: null, tenant: null, walletExists: false });
  });
  it('uses one read-only repeatable snapshot across an actual second connection resource deletion', async () => {
    const f = await proofFixture(true); let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const wrapped = new Proxy(prisma, { get(target, property) {
      if (property === '$transaction') return (callback: Function, options: unknown) => target.$transaction(async tx => {
        const ro = await tx.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
        // service sets READ ONLY before its first resource query; inspect at that query.
        expect(ro[0].transaction_read_only).toBe('off');
        const instrumented = new Proxy(tx, { get(client, key) {
          if (key === '$queryRaw') return async (...args: any[]) => {
            const result = await (tx.$queryRaw as Function)(...args);
            if (String(args[0]).includes('enterprise_provisioning_tombstones')) {
              expect((await tx.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`)[0].transaction_read_only).toBe('on');
              entered(); await hold;
            }
            return result;
          };
          const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value;
        } }); return callback(instrumented);
      }, options as any);
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const snapshot = build(wrapped).provisioningProof(f.proof);
    try { await ready; await second.accountWallet.delete({ where: { billingAccountId: f.proof.accountId } }); } finally { release(); }
    expect((await snapshot).walletExists).toBe(true); expect((await service.provisioningProof(f.proof)).walletExists).toBe(false);
  });
});

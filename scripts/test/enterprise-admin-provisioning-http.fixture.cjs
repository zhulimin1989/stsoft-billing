// Test-only host of real Billing services/controllers, against an owned scratch DB.
const {createRequire}=require('module'),fs=require('fs'),path=require('path');
const apiRoot=path.resolve(__dirname,'../../apps/api'); const r=createRequire(path.join(apiRoot,'package.json')); const outputRoot=process.env.EAC_BILLING_FIXTURE_OUTPUT_ROOT; if(!outputRoot)throw Error('EAC_BILLING_FIXTURE_OUTPUT_ROOT required');
r('ts-node').register({project:path.join(apiRoot,'tsconfig.json'),transpileOnly:true});r('reflect-metadata');
const {PrismaClient}=r('@prisma/client'),{ConfigService}=r('@nestjs/config'),{Test}=r('@nestjs/testing'),{FastifyAdapter}=r('@nestjs/platform-fastify');
const {HttpException}=r('@nestjs/common');const src=path.join(apiRoot,'src')+path.sep;
const {EnterpriseAccountService}=r(src+'billing/enterprise-account.service.ts');
const {EnterpriseAccountInternalController}=r(src+'billing-runtime/enterprise-account-internal.controller.ts');
const {BillingInternalGuard}=r(src+'billing-runtime/billing-internal.guard.ts');
const {BillingService}=r(src+'billing/billing.service.ts'),{PrismaService}=r(src+'prisma/prisma.service.ts');
const {BillingUserMirrorService}=r(src+'billing-runtime/billing-user-mirror.service.ts');
const {BillingWorkspaceMirrorService}=r(src+'billing-runtime/billing-workspace-mirror.service.ts');
const {BillingWorkspaceMirrorController}=r(src+'billing-runtime/billing-workspace-mirror.controller.ts');
const {HttpExceptionFilter}=r(src+'common/filters/http-exception.filter.ts');
let app,prisma;
async function main(){
 if(new URL(process.env.DATABASE_URL).pathname!='/eac_billing_contract_test')throw Error('owned scratch DB required');
 prisma=new PrismaClient(); const config=new ConfigService({PLATFORM_REGION:'domestic',USER_TO_BILLING_TOKEN:'eac5-billing-token',ADMIN_TO_BILLING_TOKEN:'eac11-admin-billing-token',ADMIN_TO_BILLING_CONTEXT_SECRET:'eac11-admin-billing-context'});
 const billing={syncTenantBalanceCacheForCurrentBinding:async()=>{}};
 const service=new EnterpriseAccountService(prisma,{syncBillingAccountKeyBalances:async()=>{}},billing,config);
 const mirrors=new BillingWorkspaceMirrorService(prisma,new BillingUserMirrorService(prisma),undefined,config);
 let mode=null,hold=null,entered=null,resume=null;
 const wait=async(stage,verificationId)=>{if(hold!==stage)return;hold=null;entered={stage,verificationId};await new Promise(resolve=>{resume=resolve});entered=null;};
 const fail=()=>{throw new HttpException({code:'fixture_dependency_unavailable',message:'fixture unavailable'},503)};
 const wrapped=new Proxy(service,{get(target,property){const fn=Reflect.get(target,property);if(typeof fn!=='function')return fn;return async(...args)=>{
   if((mode==='proof_down'&&property==='provisioningProof')||(mode==='create_down'&&property==='createEnterpriseAccount')||(mode==='owner_down'&&property==='upsertOwnerMember')||(['attach_down','legacy_attach_down'].includes(mode)&&property==='attachTenant')||(mode==='check_down'&&property==='checkEnterpriseSubject')||(mode==='reconcile_down'&&property==='reconcileByVerification'))fail();
   if(property==='reconcileByVerification'&&mode==='reconcile_bad')return {accountCount:0,accounts:[]};
   if(property==='provisioningProof'&&mode==='proof_404')throw new HttpException({code:'fixture_old_version',message:'unavailable'},404);
   if(property==='provisioningProof'){
     const input=args[0];
     if(mode==='wallet_missing')await prisma.accountWallet.deleteMany({where:{billingAccountId:input.accountId}});
     if(mode==='owner_missing')await prisma.billingAccountMember.deleteMany({where:{billingAccountId:input.accountId,userId:input.ownerUserId}});
     if(mode==='owner_inactive')await prisma.billingAccountMember.updateMany({where:{billingAccountId:input.accountId,userId:input.ownerUserId},data:{status:'inactive'}});
     if(mode==='tenant_member_missing')await prisma.tenantMember.deleteMany({where:{tenantId:input.tenantId,userId:input.ownerUserId}});
     if(mode==='tenant_unbound')await prisma.tenant.update({where:{id:input.tenantId},data:{billingAccountId:null}});
     if(mode==='tenant_inactive')await prisma.tenant.update({where:{id:input.tenantId},data:{status:'suspended'}});
     if(mode==='account_suspended')await prisma.billingAccount.update({where:{id:input.accountId},data:{status:'suspended'}});
     if(mode==='account_deleted')await prisma.billingAccount.update({where:{id:input.accountId},data:{deletedAt:new Date()}});
     if(mode==='quarantine')await prisma.billingAccount.update({where:{id:input.accountId},data:{provisioningQuarantinedAt:new Date()}});
     const data=await fn.apply(target,args);await wait('proof',input.verificationId);
     if(mode==='proof_bad')return {...data,walletExists:'true'};
     if(mode==='proof_contradiction')return {...data,accountCount:data.accountCount+1};return data;
   }
   if(property==='checkEnterpriseSubject')await wait('check',null);
   if(property==='createEnterpriseAccount'&&mode==='create_tombstoned')await prisma.enterpriseProvisioningTombstone.upsert({where:{verificationId:args[0].verificationId},create:{verificationId:args[0].verificationId,reason:'eac5 fixture'},update:{}});
   if(property==='createEnterpriseAccount'&&mode==='create_owner_changed'){
     const account=await fn.apply(target,args),otherId=args[0].userId+'-other';
     await prisma.user.upsert({where:{id:otherId},create:{id:otherId},update:{}});
     await prisma.billingAccount.update({where:{id:account.id},data:{ownerUserId:otherId}});return account;
   }
   if(property==='createEnterpriseAccount'&&['legacy_account','legacy_attach_down','wallet_missing'].includes(mode)){
     const input=args[0];const existing=await prisma.billingAccount.findFirst({where:{verificationId:input.verificationId}});
     if(!existing){const legacy=await prisma.billingAccount.create({data:{name:input.enterpriseName,enterpriseName:input.enterpriseName,type:'enterprise',currency:'CNY',ownerUserId:input.userId,verificationId:input.verificationId,uscc:input.uscc,balanceGrantLedgerStatus:'LEGACY_DIRTY'}});await prisma.accountWallet.create({data:{billingAccountId:legacy.id,balanceUsd:0}});}
   }
   const result=await fn.apply(target,args);
   if(property==='checkEnterpriseSubject'&&mode==='subject_truncated')return {...result,truncated:true};
   if(property==='createEnterpriseAccount')await wait('create',args[0].verificationId);
   if(property==='upsertOwnerMember')await wait('owner',args[0]);
   if(property==='attachTenant')await wait('attach',args[0]);
   return result;
 };}});
 const module=await Test.createTestingModule({controllers:[EnterpriseAccountInternalController,BillingWorkspaceMirrorController],providers:[BillingInternalGuard,
  {provide:ConfigService,useValue:config},{provide:EnterpriseAccountService,useValue:wrapped},{provide:BillingWorkspaceMirrorService,useValue:{mirror:async input=>{if(mode==='mirror_down')fail();const result=await mirrors.mirror(input);await wait('mirror',input.tenant.id);return result}}},
  {provide:BillingService,useValue:billing},{provide:PrismaService,useValue:prisma}]}).compile();
 app=module.createNestApplication(new FastifyAdapter({forceCloseConnections:true}),{logger:false});app.setGlobalPrefix('api');app.useGlobalFilters(new HttpExceptionFilter());
 const fastify=app.getHttpAdapter().getInstance();
 require('./enterprise-admin-personal-assets.fixture.cjs').registerPersonalAssets(fastify,prisma,mirrors);
 fastify.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/_fixture/')&&req.headers['x-fixture-token']!=='eac5-fixture-control')reply.code(403).send({error:'forbidden'});});
 fastify.post('/_fixture/config',async req=>{mode=req.body.mode??null;hold=req.body.hold??null;return {ok:true};});
 fastify.get('/_fixture/barrier',async()=>({entered}));
 fastify.post('/_fixture/resume',async()=>{resume?.();resume=null;return{ok:true};});
 fastify.post('/_fixture/stats',async req=>{
  const rows=await prisma.billingAccount.findMany({where:{verificationId:req.body.verificationId},select:{id:true,type:true,ownerUserId:true,verificationId:true,status:true,wallet:{select:{balanceUsd:true}},creditConfig:{select:{status:true,limitUsd:true}},members:{select:{userId:true,role:true,status:true}},tenants:{select:{id:true,billingAccountId:true,ownerUserId:true,status:true}}}});
  return {accounts:rows.map(row=>({...row,wallet:row.wallet?{balanceUsd:row.wallet.balanceUsd.toString()}:null}))};
 });
 await app.listen(0,'127.0.0.1');fs.writeFileSync(path.join(outputRoot,'billing-http-endpoint.json'),JSON.stringify({url:await app.getUrl()}));console.log('Owned Billing HTTP fixture ready');
 const timer=setInterval(async()=>{if(!fs.existsSync(path.join(outputRoot,'stop-billing-http')))return;clearInterval(timer);resume?.();await app.close();await prisma.$disconnect();},200);
}
main().catch(()=>{console.error('Owned Billing HTTP fixture failed');process.exitCode=1;});

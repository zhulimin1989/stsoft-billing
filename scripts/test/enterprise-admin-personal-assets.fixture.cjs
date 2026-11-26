// Existing personal data fixture only; called by the owned Billing HTTP host after its token guard.
const {createHash}=require('crypto');
function registerPersonalAssets(fastify,prisma,mirrors){
 const owned=new Map(),uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
 fastify.post('/_fixture/seed-personal-assets',async req=>{
  const {userId,tenantId,keyId}=req.body;if(![userId,tenantId,keyId].every(uuid)||owned.has(userId))throw Error('new owned UUIDs required');
  if(await prisma.user.findUnique({where:{id:userId}}))throw Error('cannot overwrite a pre-existing fixture user');
  // Pre-existing personal assets are an explicit imported legacy cohort. Never
  // downgrade a clean runtime account to bypass its wallet conservation guard.
  await prisma.user.create({data:{id:userId,nickname:'未个人实名',isActive:true}});
  const legacyAccountId='ba_personal_'+userId;
  await prisma.billingAccount.create({data:{id:legacyAccountId,ownerUserId:userId,name:'未个人实名',type:'personal',currency:await mirrors.platformCurrencyCode(),balanceGrantLedgerStatus:'LEGACY_DIRTY'}});
  await prisma.accountWallet.create({data:{billingAccountId:legacyAccountId,balanceUsd:'123.456789012345'}});
  await prisma.billingAccountMember.create({data:{billingAccountId:legacyAccountId,userId,role:'owner',status:'active'}});
  await mirrors.mirror({user:{id:userId,nickname:'未个人实名',isActive:true},tenant:{id:tenantId,name:'个人原主区',slug:'personal-'+userId,type:'personal',status:'active',ownerUserId:userId},membership:{userId,role:'owner',status:'active'}});
  const tenant=await prisma.tenant.findUniqueOrThrow({where:{id:tenantId}});if(!tenant.billingAccountId)throw Error('personal mirror did not bind account');
  const accountId=tenant.billingAccountId;
  if(accountId!==legacyAccountId)throw Error('personal mirror replaced the historical account');
  await prisma.balanceGrant.create({data:{userId,tenantId,billingAccountId:accountId,source:'RECHARGE',paidAmountUsd:'37.25',bonusAmountUsd:'12.5',grantedAmountUsd:'49.75',remainingAmountUsd:'49.75',remainingPaidAmountUsd:'37.25',remainingBonusAmountUsd:'12.5',validFrom:new Date('2026-01-01T00:00:00Z'),expiresAt:new Date('2030-01-01T00:00:00Z')}});
  const product=await prisma.product.create({data:{name:'既有个人订阅',slug:'owned-personal-'+userId,billingMode:'SUBSCRIPTION'}});
  const plan=await prisma.plan.create({data:{productId:product.id,name:'既有个人套餐'}});
  const subscription=await prisma.userSubscription.create({data:{userId,tenantId,productId:product.id,planId:plan.id,startedAt:new Date('2026-01-01T00:00:00Z'),expiresAt:new Date('2030-01-01T00:00:00Z')}});
  await prisma.creditBalanceState.create({data:{subscriptionId:subscription.id,userId,quota:8765,bonus:234,version:7n}});
  await prisma.creditTransaction.create({data:{userId,tenantId,productId:product.id,subscriptionId:subscription.id,type:'GRANT',creditsAmount:234,source:'owned-existing-grant',quotaAfter:8765,bonusAfter:234}});
  await prisma.tenantProductEntitlement.create({data:{tenantId,productId:product.id,planId:plan.id,source:'owned-existing',status:'active'}});
  await prisma.apiKey.create({data:{id:keyId,userId,tenantId,name:'既有个人Key',prefix:'owned_existing',keyHash:createHash('sha256').update(userId).digest('hex'),mirrorStatus:'ACTIVE',isActive:true,budgetUsd:'99.125',rateLimitRpm:42}});
  if(req.body.tokenPlanKeyId){
   const {tokenPlanKeyId,tokenPlanEntitlementId}=req.body;if(![tokenPlanKeyId,tokenPlanEntitlementId].every(uuid))throw Error('owned TokenPlan UUIDs required');
   const order=await prisma.order.create({data:{userId,tenantId,billingAccountId:accountId,orderType:'SUBSCRIPTION',productId:product.id,planId:plan.id,amountCents:1250,status:'COMPLETED',paidAt:new Date('2026-01-01T00:00:00Z')}});
   await prisma.codingPlanEntitlement.create({data:{id:tokenPlanEntitlementId,orderId:order.id,userId,tenantId,productId:product.id,planId:plan.id,status:'ACTIVE',startedAt:new Date('2026-01-01T00:00:00Z'),expiresAt:new Date('2030-01-01T00:00:00Z')}});
   await prisma.apiKey.create({data:{id:tokenPlanKeyId,userId,tenantId,codingPlanEntitlementId:tokenPlanEntitlementId,name:'既有TokenPlan Key',prefix:'owned_tokenplan',keyHash:createHash('sha256').update(userId+'-tokenplan').digest('hex'),mirrorStatus:'ACTIVE',isActive:true,budgetUsd:'55.5',rateLimitRpm:21}});
   const coupon=await prisma.discountCode.create({data:{code:'OWNED'+userId.replace(/-/g,'').toUpperCase(),name:'既有个人优惠券',discountType:'percent_off',discountValue:20,currentUses:1}});
   await prisma.discountCodeRedemption.create({data:{discountCodeId:coupon.id,userId,orderId:order.id,amountSavedCents:250}});
  }
  owned.set(userId,{tenantId,accountId});return {userId,tenantId,accountId,subscriptionId:subscription.id};
 });
 fastify.post('/_fixture/personal-assets',async req=>{
  const userId=req.body.userId,scope=owned.get(userId);if(!scope)throw Error('unowned assets');
  const account=await prisma.billingAccount.findUniqueOrThrow({where:{id:scope.accountId}});
  const result={account,wallet:await prisma.accountWallet.findUniqueOrThrow({where:{billingAccountId:scope.accountId}}),
   tenant:await prisma.tenant.findUniqueOrThrow({where:{id:scope.tenantId}}),members:await prisma.billingAccountMember.findMany({where:{billingAccountId:scope.accountId},orderBy:{id:'asc'}}),
   grants:await prisma.balanceGrant.findMany({where:{userId},orderBy:{id:'asc'}}),creditStates:await prisma.creditBalanceState.findMany({where:{userId},orderBy:{subscriptionId:'asc'}}),
   creditTransactions:await prisma.creditTransaction.findMany({where:{userId},orderBy:{id:'asc'}}),subscriptions:await prisma.userSubscription.findMany({where:{userId},orderBy:{id:'asc'}}),
   entitlements:await prisma.tenantProductEntitlement.findMany({where:{tenantId:scope.tenantId},orderBy:{id:'asc'}}),apiKeys:await prisma.apiKey.findMany({where:{userId},orderBy:{id:'asc'},select:{id:true,tenantId:true,codingPlanEntitlementId:true,name:true,prefix:true,keyHash:true,isActive:true,mirrorStatus:true,budgetUsd:true,rateLimitRpm:true,createdAt:true}}),
   tokenPlans:await prisma.codingPlanEntitlement.findMany({where:{userId},orderBy:{id:'asc'}}),orders:await prisma.order.findMany({where:{userId},orderBy:{id:'asc'}}),couponRedemptions:await prisma.discountCodeRedemption.findMany({where:{userId},include:{discountCode:true},orderBy:{id:'asc'}}),giftRedemptions:await prisma.grantRedemption.findMany({where:{userId}}),
   personalAccountCount:await prisma.billingAccount.count({where:{ownerUserId:userId,type:'personal'}}),creditConfigs:await prisma.billingAccountCreditConfig.findMany({where:{billingAccountId:scope.accountId}}),creditEvents:await prisma.billingAccountCreditEvent.count({where:{billingAccount:{ownerUserId:userId}}})};
  return JSON.parse(JSON.stringify(result,(_key,value)=>typeof value==='bigint'?value.toString():value));
 });
}
module.exports={registerPersonalAssets};

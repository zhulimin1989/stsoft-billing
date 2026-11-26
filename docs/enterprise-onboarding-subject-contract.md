# 企业开户主体查询及归属补齐（EAC13）

2026-09-30 本地交付；原账户、钱包、授信、资金、账单和Finance路由保持原契约。

User新受理和历史扫描需要读取所有占用生命周期，但原企业列表仅允许admin-api、排除deletedAt非空记录。因此新增 `POST /internal/billing/admin/enterprise-accounts/subject-check`，沿用BillingInternalGuard的caller/token/API版本；只为user-api白名单添加此POST，不放行原GET列表、detail、快照更新、资金入口。admin-api仍需原签名管理上下文。

body仅允许uscc，必须规范大写18位集合 `0-9A-HJ-NP-RTUWXY`，否则HTTP400结构化码enterprise_uscc_invalid。代码放请求体，不放URL或日志。按参数化SQL精确规范值查找，不做substring/ILIKE；历史大小写和空白集合与ECMAScript String.trim一致。新非唯一表达式索引 `billing_accounts_uscc_canonical_lookup_idx` 包括全部非空USCC，不改原值，不替换 `billing_accounts_uscc_active_uk`。原唯一索引是原始字符串+deleted_at IS NULL，不能单独证明大小写变体跨旧writer唯一；User共同claim与历史对账仍是启用前提。

响应成功code=0，data包含uscc、occupied、truncated、accounts。account字段仅accountId/type/ownerUserId/verificationId/status/deletedAt/quarantinedAt；无企业名、余额或资金详情。最多100条，101条探测截断。停用、软删、quarantine、异常非企业类型也返回，不能把历史记录直接视为自由代码。只读预查不是跨服务事务或代替最终约束。verification级零账户墓碑用原reconcile查询，subject-check无法按USCC找到无回链墓碑。

建账相同verification重放维持幂等ID和不重建资源；在verification锁内处理tombstone→quarantine→suspended后，拒绝Owner不符（enterprise_account_owner_changed）。唯一冲突的同verification重查也做相同归属校验。Owner成员初始化在wallet→account锁内再查归属，防控制器预查后转让的陈旧请求。User attach控制器将原观察Owner传给事务内核，老调用方省略userId时也固定该身份；已有tenant归属/绑定冲突守卫继续生效。管理侧允许不传userId的attach保留原语义。

walletCreated、ownerMemberCreated、attached表示本次新建/挂载动作；重放false不表示缺失。重放不会自动修复丢失钱包或补挂tenant，最终成功必须由User EAC10核对真实资源，EAC12在原verification安全恢复。

新增迁移是单语句CREATE INDEX CONCURRENTLY，Prisma migrate deploy不得人为包事务。中断可能留下invalid索引，发布恢复要检查pg_index.indisvalid/indisready及原迁移记录；不能加IF NOT EXISTS掩盖无效索引，不能自动删除生产索引。按已有发布流程对DDL会话设置适当锁/语句上限，先迁索引及部署兼容Billing，再启用User调用。

隔离PostgreSQL16真实测试覆盖：零钱包/Owner、重放回执、两个独立连接并发同verification/同USCC、Owner变化、wallet锁等待后的成员拒绝、tenant冲突整笔回滚、停用/quarantine/零账户墓碑、企业镜像不产生个人账户、部分资源回执、截断、HTTP权限/版本/格式、Unicode空白规范化及索引可用性。EXPLAIN在enable_seqscan=off的小夹具只证明表达式可使用索引，不代表生产性能。外部Publisher和余额缓存副作用为测试替身，没有启动业务worker。

全历史迁移在PG16的既有 `20260715000100_personal_negative_balance_settlement` 函数指纹校验失败，本批没有改该迁移。企业契约测试使用独立当前schema夹具、原USCC partial unique语句及本批真实迁移；本批索引另在最小空库通过真实Prisma migrate deploy。不能把这些称为Billing全部迁移通过。详细跨仓记录保存在需求目录execution/batch-02。

## EAC10资源证明补充（2026-10-07）

原reconcile没有指定Owner成员/指定Tenant成员、挂载有效性及独立钱包存在性，User caller亦不能GET详情，因此只添加POST enterprise-accounts/provisioning-proof白名单。原GET/资金路由不扩权，没有改建账或资金算法。

body仅verificationId/accountId/tenantId/ownerUserId，非空有界128字符。READ ONLY REPEATABLE READ一次快照返回四引用回显、observedAt、verification墓碑、包括软删/异常类型的账户总数、指定账户类型/状态/Owner/verification/规范USCC/软删/quarantine、钱包存在、指定账户Owner成员、指定Tenant与Owner成员/挂载。无资金余额、电话/邮箱或资源修复。缺资源如实返回null/false，User据事实判断成功；旧建账回执不能代替该证明。

真实Billing HTTP/PG契约验证包括token/caller/版本/strict body、钱包/成员/挂载缺失、历史多账户及墓碑、独立连接删除钱包时快照内保持一致；专属库上的联合宿主复用真实Billing controller/service/DAL。Publisher/cache是替身，当前schema夹具不等于全迁移成功；本批全历史部署再次在既有20260715000100失败，未resolve/改指纹或生产操作。

联合HTTP测试宿主保存于scripts/test/enterprise-admin-provisioning-http.fixture.cjs。仅对显式DATABASE_URL的eac_billing_contract_test专属库运行，先部署当前schema夹具及原/新增USCC索引；EAC_BILLING_FIXTURE_OUTPUT_ROOT指定本批独占输出目录。该目录billing-http-endpoint.json返回随机loopback端口，User测试显式设置EAC_BILLING_HTTP_URL及自己的USER_DB_TEST_URL；CI缺依赖直接失败，不静默跳过。写stop-billing-http结束拥有的宿主后删除自己的库/对象，不用于生产。故障控制token及服务token均固定测试值，宿主不是生产入口。

## EAC19/EAC20本地验证补充（2026-10-08）

新建PG16合同库上的6组111项回归，以及真实三服务/浏览器五组非零个人资产快照通过。新 test-only personal-assets 宿主预置钱包123.456789012345、cash/bonus grant、订阅/entitlement、积分和已有个人Key，严格限定新owned UUID及loopback专属库。成功及create/Owner/attach/proof故障后原记录retry均逐字段比较，包括个人账户/成员updatedAt。

首轮发现企业workspace镜像重复将已active的个人账户及Owner成员写回active，造成updatedAt漂移。BillingUserMirrorService写条件仅增加“status不等于目标状态”，避免无变化写入；实际停用/恢复仍同步个人状态，企业账户不在同步范围。真实PG用例同时验证完整行相等、停用/恢复、原wallet及企业资源不变。原失败报告和截图保留，未删除时间戳断言。

API类型检查和构建通过。全历史迁移另库再次在20260715000100函数指纹count45/fingerprint16d8b08eb2b052fbd5c99a943991ad19失败，边界检查原enterprise-bills.service.ts:2355/2356也仍失败；没有resolve、改旧指纹或跳SQL。规范USCC索引是查询索引，不称规范化唯一约束；原raw-USCC partial unique与User独立HMAC claim唯一约束另有真实竞争证据。未执行EAC21/22、实网对象/UAT、生产数据或发布。

## EAC21/EAC22补充（2026-10-08）

owned资产夹具增已有TokenPlan entitlement/Key/完成订单及已兑换优惠券，严格before/after保留。真实自助payment/review、旧manage补救、原Worker及原UI回归见需求第十一批；公开支付/实网通知/IdP仍未验证。

原enterprise-bills月结session advisory专用连接创建移动到所属Prisma模块createBillingAdvisoryLockClient，保持同datasource、connection_limit=1及原URL fallback。guard规则未放宽；实际两backend PID858/859证明同session持锁、其它连接拒绝、原session解锁后另连接取得。相关合同18、bills43、Prisma8通过；根边界/锁检查、typecheck和build通过。没有改账单/资金算法。

全量214文件4374通过92失败，专属Redis补齐及相关复验91通过32失败，原报告保留。源码与精确Git归档SQL都是CRLF，函数prosrc参与指纹，原20260715000100仍失败；仅LF化scratch副本且保留全部SQL/guard的全历史部署通过，副本checksum不同，原源码/指纹未改。不能将诊断库称正式迁移通过。

完整迁移诊断库phase仍EXPANDED，V2_CONTRACT未激活：实际企业建账合同5通过13失败，PostgreSQL23514明确拒绝新RECONCILED_V2账户。schema合同库没有这些发布阶段trigger，先前本地链路通过不能替代该依赖。财务阶段/数据库绑定及其它旧全量失败须独立收口；本批未启动财务激活/数据修复或生产操作。

## EAC22阻塞收口（2026-10-08，第十二批）

用户授权仅SQL行尾归一化及Git eol约束。新增 `.gitattributes` 的 `apps/api/prisma/**/*.sql text eol=lf`；190个SQL工作文件最终逐一与HEAD Git blob字节等同，SQL内容/硬编码函数MD5/guard无提交diff。纠正第十一批“Git archive含CRLF，故canonical HEAD为CRLF”的推断：实际直接读取Git blob已经是LF，问题来自Windows检出/归档时的行尾转换；原失败及原档案保留。没有改历史迁移语义、fingerprint、已部署数据库或历史记录。

实际Prisma6.19.2引擎在两套合成数据库通过 diagnoseMigrationHistory 验证CRLF↔LF可接受、原migration完整行不变、真实DDL编辑仍报editedMigration。正常源码空库178条通过；另库从81条实际CRLF前缀升级到授权后LF源码178条，81条旧记录完整行不变。已部署环境checksum/数据库状态仍未读取，不能推广为生产历史已核对。

新专属空库按原Release A正常迁移，再执行原rollouts/20260717000100文件的空库self-prepare、数据库locator/SHARE锁/严格trigger安装及审计CAS，实际达到V2_CONTRACT并保留15个strict trigger。没有手工UPDATE phase或禁用trigger；仅本地测试前置，不是生产财务activation授权。错误数据库名/identity、只读角色prepare、非owner contract DDL真库拒绝，phase保持不变。prepare权限依赖实际数据库ACL，不能仅凭使用owner执行就称函数本身为owner-only；生产权限另行核对。

六组SQL文本合同只将读取的CRLF规范为LF，原语义断言保留。资金并发测试同100请求、同原事务与test预算，测试连接显式connection_limit=32；补齐BillingAdminService真实部署配置依赖mock，不改资金算法。破坏钱包/快照竞争夹具声明导入合成LEGACY_DIRTY资源，正常新账户保持clean V2；新增clean钱包删除拒绝/原行不变断言，企业合同由18增至19项。非零个人资产夹具明确导入既有历史账户及owner成员，使用实际平台货币再走真实mirror，原资产全行比较保留，不声称该历史wallet与grants为clean资金基线。

三仓真实HTTP及17项代办/6项旧流程浏览器在完整178迁移及合法V2_CONTRACT前置上通过。全量、根脚本、全部原失败、环境/角色/locator/资源/操作UUID证据以需求目录第十二批及batch-12为准。无生产数据、外部真实支付/通知或发布。

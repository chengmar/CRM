# 外贸获客 Agent 产品架构

## 产品边界

自动化链路固定为：

```text
市场研究 -> 找客户 -> 公司适配与直接需求证据评估 -> 联系人补全 -> 审批 -> 个性化触达
-> 识别客户回复 -> 发现询价 -> 飞书即时告警 -> HUMAN_TAKEOVER
```

进入 `HUMAN_TAKEOVER` 后，系统必须取消该客户所有待发送消息，不再自动回复、跟进或报价。

## 控制面

- 飞书机器人：自然语言命令、审批、暂停、人工接管、询价告警。
- 飞书多维表格：线索、联系人、消息、回复、询价和运行指标。
- VPS：常驻 Agent、任务调度、邮件监听、WhatsApp Webhook 和 SQLite 主状态库。
- Codex：仅用于开发维护，不作为日常操作入口。

SQLite 是权威状态库。飞书不可用时任务继续安全排队，恢复后再同步，避免因表格写入失败造成重复发送。

## v10-v13 获客控制层

schema v10-v13 在旧 `campaigns/leads/contacts/outbound_messages` 链路之外增加了一套可审计的获客控制层，但 SQLite 仍是唯一权威状态：

- canonical accounts、people、employments、contact points、不可变 play/version/enrollment，以及 ACTIVE_INTENT、ICP_FIT、WATCHLIST 分轨资格。排序分数只决定研究顺序，不能替代资格、任职、邮箱或 DNC 门槛。
- provider registry/runs/assertions、资源成本和预算账本。Provider 只能提交带来源和时效的 assertion，本地 resolver 决定最终状态；API Key 的存在不构成调用授权。
- Campaign Brief/version、预测、市场 evidence/allocation、实验分配、signal/manual task、入站 quarantine、opportunity/quote、approved claim/content/localization 和商业归因。
- `DISCOVER_CAMPAIGN` 与 `ENRICH_CONTACTS` 在进入旧发现实现前执行严格 preflight。Serper、Exa、SearXNG、Hunter 和 live crawl 默认 fail closed；只有显式 no-network fixture contract 可以在本地 shadow 中运行。
- `STAGE_GROUNDED_MESSAGE` 从版本化 seller facts、buyer facts、Offer 和资格材料确定性生成审核版本。schema v13 固化不可变 review card/decision；内容批准或要求改写都不授予发送权限，也不创建 outbound 记录。

飞书审核人和审核目标使用不同 allowlist。grounded review 通知先与业务状态一起写入 notification outbox，再异步投递；失败重试复用稳定材料，不能重新生成不同正文。四张获客 Bitable 控制表仅是 SQLite 的只读运营镜像，同步默认关闭，详见 `agent_service/ACQUISITION_CONTROL_BITABLE.md`。

## 审核与发送硬门槛

自动进入 `READY_FOR_REVIEW` 必须同时满足：

- 公司总分不低于 `LEAD_SEND_SCORE_MIN`，当前默认 90。
- 最近活跃时间在 `COMPANY_ACTIVITY_MAX_AGE_DAYS` 内，默认 548 天。
- 至少两个独立公开来源。
- 存在按当前 `DEMAND_POLICY_VERSION` 计算且已通过的直接需求证据；策略缺失、过期或版本不一致时 fail closed。
- 存在具名且当前任职的采购、工程、项目或管理联系人。
- 正式生产邮箱验证结果为 `VALID`；Gmail pilot 仅在审批卡明确展示风险时允许 MX 有效的 `RISKY` 地址。角色邮箱、一次性邮箱、catch-all 和已退信地址始终禁止。
- 未命中公司、域名、邮箱或号码级 DNC。

实际发送还必须由授权用户批准该联系人对应的消息内容，并在领取发送任务时重新通过全局暂停、DNC、所有权、需求证据、联系人、邮箱、限流和退信率检查。当前 Gmail pilot 只允许审核卡中明确批准的首封邮件，不自动发送跟进。

## 需求证据模型

`src/search/demand-evidence.ts` 用确定性规则把公司适配与当前需求分开。单条搜索摘要最高只能得到 12 分，仅作为研究线索，永远不能直接获得发送资格；合格证据必须来自候选公司官方页面，同时能对应公司主体、目标产品和明确需求动作，并具有可验证的有效日期。

- `RECENT_PROCUREMENT` 和 `SUPPLIER_REPLACEMENT` 最长接受 180 天内证据。
- `CURRENT_PROJECT` 最长接受 365 天内证据。
- 过期或取消招标、卖方 CTA、供应商获奖、招聘、案例、SEO/编辑指南、服务商建议、非法或未来日期以及转载加分均被拒绝。
- 联系人补全阶段从已存来源和新抓取的官方页面重新计算需求资格，不复用旧 `lead.intent_score`；旧版导入数据的 intent 归零。
- 需求策略版本、阶段、是否合格和证据列表持久化到 lead，供审核、生成、批准和发送时重复核验。

## 后台任务与调度

`JobWorker` 将任务分到 `REALTIME`、`OPERATIONS`、`RESEARCH` 三条独立 lane，默认并发分别为 2、1、1。任务按优先级领取并持有带 token 和过期时间的租约；心跳续租，仅过期租约可回收，旧 owner 不能完成或失败已被新 owner 领取的任务。停机时停止新领取并等待在途任务排空后再关闭数据库。

联系人补全按 lead 持久化 `enrichment_attempts` 和 `enrichment_next_at`。同一活动必须先让所有待补全 lead 完成当前 pass，再进入下一 pass；固定 25 家批次不会反复处理高分前 25 家而遗漏其余客户。每家最多三轮，轮次在重启后保留，陈旧完成写回被拒绝；第三轮仍失败时进入 `ENRICHMENT_EXHAUSTED` 并停止自动补全。schema v9 让同一 campaign 的活动补全任务跨 pass 互斥，并在同一事务内完成当前任务和排入后续任务。

每日研究调度把运行标记、市场轮换、活动创建和研究任务入队放在同一 SQLite 事务中原子预留，避免并发 scheduler 重复创建。缺少活动模板时每个本地自然日最多告警一次。启动通知在事务提交后发送，因此原子性只覆盖数据库预留，不覆盖通知必达。

## 发送事务与数据完整性

外发消息必须同时满足活动、lead、contact、channel 和真实目标地址的所有权一致性。schema v7 在数据库层使用触发器拒绝跨客户或目标地址不一致的写入，消息生成、审核和批准路径也会重复检查；审核卡逐封展示实际 destination。

Dispatcher 不直接发送旧查询结果。它在 `BEGIN IMMEDIATE` 事务内调用 `claimMessageForSending()`，重新加载消息及其 owner，并检查批准、全局暂停、DNC、联系人有效性、收件人所有权、当前需求策略、发送限额、最小间隔和退信率。领取成功后消息原子进入 `SENDING`，该状态立即占用限流名额，实际发送只使用本次领取返回的记录。该事务只保证本地资格检查和配额预留；外部渠道投递与本地 `markMessageSent` 之间仍存在崩溃时的模糊投递窗口，不能声称端到端 exactly-once。

## 漏斗报告

飞书命令 `今日漏斗` 和 `漏斗报告` 生成只读 cohort 报告，可按活动、市场和来源归因拆分。时间窗按 candidate/lead 的 `created_at` 选择 cohort，下游阶段按报告生成时的历史曾到达状态累计；每项按独立 lead 去重，排除 `REJECTED` lead、未匹配入站和非人工回复。来源拆分属于多重归因，跨来源不可直接相加。

新增 `commercial-funnel` CLI 以 SQLite read-only/query-only 模式在迁移前打开数据库，拒绝高于本地 `LATEST_SCHEMA_VERSION` 的 migration history 或 `PRAGMA user_version`，并按 market/play/track/provider/channel/offer/experiment 输出 delivered-evidence cohort、询价、报价、成交、收入、毛利和成本。`SENT` 不算 delivered；多币种金额不换算、不合并，归因只作 first/last/assist 描述，不能宣称因果。

## 联系人和邮箱证据

联系人必须由公开来源同时证明姓名、当前职位和公司归属。官网页面保存精确邮箱、提取方式和局部 DOM 上下文；编码 `mailto:` 与 Cloudflare 保护地址可以确定性解码，但姓名、职位和邮箱必须在同一可靠局部上下文中关联。完整邮箱 token、候选域和私有后缀租户必须一致；重定向目标正文抓取前先校验同一注册域和目标 robots 规则，跨域重定向页不能成为官网证据。每页最多保留 12 个证据 scope、合计 4000 字符；联系人研究的 system+user 消息内容合计最多 96 KB，响应验收只使用实际发送给模型的证据子集。

公开地址首先经过语法、角色地址、一次性域、MX 和可选 Reacher 检查。没有深度验证时保持 `RISKY`。可选 Hunter Finder/Verifier 仅在已有具名任职联系人后调用；缺 Key 时零请求，限流和临时错误有界重试，相同请求短期去重，来源 URI 保留。第三方 `valid` 不能覆盖本地 `INVALID`/`UNKNOWN`、Catch-all、角色地址、一次性地址、邮箱不一致或 DNC。

## 回复与询价

入站消息分类：

- `P1_INQUIRY`：价格、报价、MOQ、交期、参数、样品、图纸或具体采购问题。
- `P2_INTEREST`：索要目录、表示兴趣、介绍负责人或要求进一步沟通。
- `OTHER_REPLY`：普通人工回复。
- `AUTO_REPLY`：休假或自动通知。
- `NEGATIVE`：拒绝、无需求或不希望继续联系。
- `UNSUBSCRIBE`：明确退订。
- `BOUNCE`：硬退信或投递失败。

`P1_INQUIRY` 和 `P2_INTEREST` 都触发飞书即时告警及 `HUMAN_TAKEOVER`。任何人工回复都会停止自动跟进，避免机器人覆盖真实销售沟通。

## 安全与可观测性

- 源码默认 `AGENT_MODE=dry_run`、`OUTBOUND_ENABLED=false`；Gmail 一键安装版部署为可发送但数据库全局暂停。
- Gmail 必须先自发测试成功，再由已授权飞书用户点击确认卡片启用；普通恢复命令不能绕过首次授权。
- Gmail 账号、应用密码或受保护配置变化时，旧自测和启用状态自动失效并重新暂停。
- 所有状态变化写入不可变审计事件表。
- 每小时、每日和每个活动都有真实数据库计数限流。
- `SENDING` 计入限流预留，避免并发 dispatcher 超发。
- 硬退信率达到阈值时自动暂停外发。
- 所有任务有最大搜索结果、抓取页面、LLM 调用和每日 token 预算。
- 每个搜索域名记录 `IN_PROGRESS`、`REJECTED`、`ENRICHMENT_PENDING`、`SEND_READY` 或 `DUPLICATE_EXISTING` 及原因。
- Hermes 实际参与市场关键词规划和高匹配公司的联系人搜索矩阵；失败会记录日志并明确回退，不再静默假装调用成功。
- `/health`、`/metrics` 和飞书 `/status` 提供运行状态。
- `今日漏斗` / `漏斗报告` 提供按活动、市场和来源拆分的阶段转化视图。
- 私钥、Token 和密码只放私有 `.env`，不得进入部署包、日志或飞书。

## 版本边界

本地源码当前为 SQLite schema v13/13。v5-v9 保留需求证据、任务租约、外发所有权和补全互斥；v10 增加 canonical acquisition/provider/inbound/commercial 基础；v11 增加 claims/content/localization/quarantine/opportunity 工作流；v12 增加 Campaign Brief、分轨资格、市场/实验/signal/manual、不可变 personalization/message 和原子预算；v13 增加不可变消息审核卡与决定。

2026-07-20 本地实际数据库及迁移前备份均为 `quick_check=ok`、零外键违规，代码门禁为 81/81 测试文件、537/537 测试并通过 typecheck/build。这只是本地基线。文档中此前记录的 VPS `commercial-v3` / schema v3 状态是历史快照；任何生产、VPS、飞书、邮箱或 Provider 状态都必须在另行授权后只读重验，不能从本地结果推断。

## 外部配置依赖

- 飞书机器人接收消息权限、事件订阅、发布和成员白名单。
- 飞书多维表格 app token、table id 和字段。
- 企业域名邮箱、SPF、DKIM、DMARC、SMTP、IMAP。
- 搜索服务：Serper、Exa 或自建 SearXNG 三选一。
- 邮箱深度验证：Reacher 或兼容验证服务。
- 具名联系人邮箱补全：可选 Hunter Email Finder/Verifier；只接受高置信度且验证为 `valid` 的结果。
- WhatsApp Cloud API、合规模板、Webhook 域名和用户授权记录。

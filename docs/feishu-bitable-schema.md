# 飞书多维表格生产 CRM

生产控制面使用客户在安装器中填写的 CRM 名称，由 Agent 通过飞书官方 API 创建和维护。

- `Leads`：当前客户状态、质量门槛、具名联系人和人工接管状态。
- `Events`：不可变审计事件，只追加，不覆盖和删除。
- SQLite：权威状态库。飞书不可用时不会改变发送状态，恢复后可幂等同步。

`Leads` / `Events` 是旧生产 CRM 视图。schema v12-v13 另有四张获客控制表镜像；两组表可以独立配置，开启旧同步不要求控制表存在。

自动创建或修复 schema：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-feishu-bitable.ps1
```

在线校验：

```powershell
Push-Location .\agent_service
npm run cli -- validate-bitable
Pop-Location
```

## Leads 字段

共 33 个正式字段：

```text
lead_id
campaign_id
company
domain
website
country
buyer_type
product
fit_score
intent_score
activity_score
contact_score
channel_score
score
grade
status
last_activity_at
last_verified_at
send_eligible
eligibility_reasons
contact_id
contact_name
title
email
email_status
whatsapp
linkedin
contact_source_url
source_count
human_takeover
owner
created_at
updated_at
```

`lead_id` 是唯一键。重复同步会更新原记录，不会重复新增。

## Events 字段

```text
event_id
entity_type
entity_id
event_type
actor
payload_json
created_at
```

`event_id` 是唯一键。Events 只追加，用于追溯搜索、验证、审批、发送、回复、询价、暂停和人工接管。

## 获客控制表（默认关闭）

控制表同步默认 `FEISHU_BITABLE_CONTROL_SYNC_ENABLED=false`。显式执行 bootstrap 后才创建/复用以下 Agent 自有表：

- `Agent Campaign Briefs`
- `Agent Market Allocations`
- `Agent Sales Tasks`
- `Agent Commercial Report`

启用同步前必须配置四个完整 table ID，或由显式 bootstrap 在本地 SQLite 写入四个 ownership marker；部分配置会被拒绝。系统不会按显示名称接管同名客户表。空、未知、旧版或被篡改的远端主键会阻断该表同步，已知并发重复键才会确定性对账、删除多余记录并复核。Bitable 只用于运营展示，远端业务字段不会反向覆盖 SQLite。

字段边界如下：

- Campaign Brief：完整展示市场、产品、buyer types、industries、role families、qualification tracks、required signals、exclusions、目标量、Provider/研究预算、Offers、transport、deadline、hypothesis、hash 和分 scope 授权；`SHADOW_PLAN` 不等于付费、外发或发布授权。
- Market Allocations：展示 evidence snapshot、exploration floor、cap 和建议；保持 `applied=false` / `requires_human_approval=true`，同步不会自动改预算或应用分配。
- Sales Tasks：展示 account/person/play，并包括 `enrollment_id` 与 `opportunity_id`；任务卡本身不执行 LinkedIn、电话、邮件或 WhatsApp 动作。
- Commercial Report：`FUNNEL_COUNTS` 每个维度切片只放 delivered 分母和漏斗计数，金额字段为空；`CURRENCY_MONEY` 每个币种只放收入/毛利 minor units 与 Provider `cost_micros`，漏斗字段为空。不同币种不换算、不合并，旧混合布局会被拒绝。

当前四张控制表仅通过本地 fake API/fixture 验证。真实飞书 Number/Date 字段用 `null` 清空、`batch_delete` 权限与响应语义仍未验证；在获得独立授权并完成真实 shadow 前，不得描述为生产兼容。详细字段和所有权规则见 `agent_service/ACQUISITION_CONTROL_BITABLE.md`。

## 建议视图

- `待审核`：`status = READY_FOR_REVIEW`
- `已批准待发送`：`status = APPROVED`
- `已触达`：`status = CONTACTED`
- `客户已回复`：`status = REPLIED`
- `询价与人工接管`：`human_takeover = true`
- `禁止联系`：`status = DO_NOT_CONTACT`
- `未通过门槛`：`send_eligible = false`

不要人工修改 `lead_id`、`event_id`、评分分项或状态机字段。销售人员可维护 `owner`，并在询价后从原邮箱或 WhatsApp 会话人工回复。

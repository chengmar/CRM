# CRM 外贸获客智能体

这是一个面向 B2B 外贸团队的 CRM 与获客自动化项目。系统覆盖公开信息采集、线索评分、联系人验证、飞书 CRM 同步、邮件与 WhatsApp 触达准备、回复归因、运营报表和 Windows 安装器。

本仓库是经过脱敏的协作版源码。真实客户数据、公司身份、账号密钥、服务器信息、数据库、日志、构建产物、安装包、压缩包、网站素材和运行输出均未提交。

仓库不预置任何产品名称、型号、规格、参数、目标市场、产品图片或营销文案。代码只保留可复用的数据结构和业务流程；新产品必须通过本地配置或经审核的数据导入流程提供。

## 当前状态

项目已具备较完整的核心代码、测试、部署脚本和技术文档，适合继续开发、联调和代码审查。外部发送默认关闭，写入 CRM、发送邮件或 WhatsApp 等高风险动作需要显式配置和人工确认。

这仍是技术预览版本。接入飞书、邮件、WhatsApp、搜索、模型或第三方验证服务时，需要使用者自行提供合规账号和密钥，并先在测试环境验证。

## 仓库结构

- `agent_service/`：Node.js/TypeScript 后端、命令行、任务队列、CRM 集成、获客和触达逻辑。
- `installer/`：Electron Windows 安装器源码及测试。
- `agents/skills/`：智能体技能定义。
- `scripts/`：部署、验收、回滚和运维脚本。
- `infra/`：本地辅助服务的 Docker Compose 配置。
- `config/`：非敏感权限范围示例。
- `website/`：已泛化的 WordPress 演示站源码，不包含原始图片与上传文件。
- `docs/`：架构、使用、数据结构和发布检查文档。

## 环境要求

- Node.js 22 或更高版本
- npm
- Git
- 可选：Docker Desktop 或 Docker Engine，用于本地搜索和验证服务
- 可选：PowerShell 7、Git Bash 或 Linux shell，用于部署和验收脚本

## 快速开始

先克隆仓库并创建本地环境文件：

```powershell
git clone https://github.com/chengmar/CRM.git
cd CRM
Copy-Item .env.example .env
```

`.env` 只保存在本机。第一次启动时请保持以下安全默认值：

```dotenv
AGENT_MODE=dry_run
OUTBOUND_ENABLED=false
EMAIL_OUTREACH_ENABLED=false
WHATSAPP_OUTREACH_ENABLED=false
EXTERNAL_SEND_REQUIRES_CONFIRMATION=true
REQUIRE_HUMAN_APPROVAL_BEFORE_SEND=true
```

安装并验证后端：

```powershell
cd agent_service
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

默认 HTTP 地址由 `.env` 中的 `AGENT_HTTP_HOST` 和 `AGENT_HTTP_PORT` 控制。不要把服务直接暴露到公网，除非已经配置身份认证、反向代理和访问控制。

## Windows 安装器

安装器可以单独开发和测试：

```powershell
cd installer
npm ci
npm run typecheck
npm test
npm run build
```

正式打包还需要在本地生成品牌资源并准备部署载荷。`installer/build/`、`installer/payload/`、`installer/release/` 和生成的安装包不会提交到 Git。具体流程见 `docs/windows-installer-guide.md` 和 `docs/release-checklist.md`。

## 本地辅助服务

仓库提供 SearXNG 和 Reacher 的 Compose 配置。先复制示例配置，并把占位密钥替换为本机生成的随机值：

```powershell
New-Item -ItemType Directory -Force infra/runtime/searxng
Copy-Item infra/searxng/settings.example.yml infra/runtime/searxng/settings.yml
docker compose -f infra/support-services.compose.yml up -d searxng
```

`infra/runtime/` 被 Git 忽略。Reacher 位于可选 profile 中，仅在确有需要时启动。

## 演示网站

`website/` 是产品中立的 WordPress 站点架构，默认产品目录为空。商品信息、图片、客户上传文件和权属材料均未进入仓库，需要协作者在发布前使用已审核且可公开的内容补齐。

```powershell
cd website
Copy-Item .env.example .env
docker compose up -d
```

## 配置原则

所有真实配置都放在未跟踪的 `.env` 或部署平台的密钥存储中。仓库中的 `.env.example` 只描述变量，不包含有效凭据。

配置时建议遵循以下顺序：

1. 先在 `dry_run` 模式完成本地验证。
2. 再配置一个外部服务，并运行对应测试。
3. CRM 写入和外部发送分别授权，不要一次性全部开启。
4. 在启用邮件或 WhatsApp 前，确认域名、退订、频率、隐私和当地法规要求。
5. 生产密钥不得写入代码、测试、截图、日志或问题单。

## 测试与协作

提交代码前至少运行受影响模块的类型检查和测试。推荐从短分支发起 Pull Request，并在说明中写清变更范围、验证方法、配置变化和安全影响。

完整协作约定见 `CONTRIBUTING.md`。发现安全问题时不要公开提交包含利用细节或真实数据的 Issue，请按 `SECURITY.md` 处理。

## 公开仓库说明

公开版的取舍和排除范围见 `docs/public-release-scope.md`。本仓库未附带开源许可证；在许可证确定前，默认保留全部权利。

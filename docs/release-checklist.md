# 商业安装器发布清单

## 当前自动化证据

- Agent TypeScript 类型检查和 32 项测试通过。
- Installer TypeScript 类型检查和 12 项测试通过。
- Windows x64/ARM64 Setup 与 Portable 均可生成。
- 基础部署载荷经过 SHA-256 校验，且不包含 `.env`、私有案例、生产线索或生产数据库。
- x64 unpacked、Portable、NSIS 安装版均通过隔离 AppData 自检。
- NSIS 静默安装和卸载通过。
- ARM64 解包应用 PE 架构已验证。
- GitHub Actions 工作流会在全新 Windows runner 重新测试、打包和上传校验清单，并在 Windows Server 2022/2025 上分别执行 Setup、Portable、自检和卸载兼容性验收。
- `v*` 正式标签构建会强制要求代码签名密钥；任一外层安装包、内层应用或卸载器签名无效时工作流失败，不会被当作商业发布版本。

## 公开销售前必须人工完成

### 1. Windows 代码签名

当前本地产物是未签名构建，会触发 Windows SmartScreen 警告，不应直接公开销售。

准备正规 Windows 代码签名证书后，在 GitHub 仓库 Secrets 中配置：

- `WINDOWS_CSC_LINK`：PFX 的 base64/data URI 或 electron-builder 支持的安全地址。
- `WINDOWS_CSC_KEY_PASSWORD`：PFX 密码。

重新运行 `Build Windows Agent Installer`，下载产物后用以下命令确认四个文件均为 `Valid`：

```powershell
Get-AuthenticodeSignature .\installer\release\*.exe | Select-Object Path,Status,SignerCertificate
```

### 2. 全新 Ubuntu 服务器验收

不得在客户生产服务器上做破坏性首测。准备一台空白 Ubuntu 22.04/24.04 VPS，使用真实但专门用于验收的平台账号运行完整安装：

- Docker Engine/Compose 自动安装。
- SearXNG 固定镜像拉取并返回搜索结果。
- Agent systemd 服务、备份 timer、数据库和健康端点通过。
- 飞书多维表格创建、私聊绑定、群绑定和询盘通知通过。
- SMTP/IMAP 只认证，不发送测试邮件。
- 中断 Windows 网络并重开安装器，确认继续同一个远程任务。
- 人为制造一次失败，确认 Retry 和服务器 previous release 回退有效。

验收后销毁测试 VPS，或清除测试账号和密钥。

### 3. GitHub 构建

当前工作区尚未绑定用户指定的 GitHub 仓库，因此没有自动推送。创建私有仓库后提交 `.github/workflows/build-windows-installer.yml`，先手动运行未签名开发构建，再通过 `v*` 标签运行正式签名构建。全新 runner 的 `Run clean Windows package acceptance` 以及 Windows Server 2022/2025 两个兼容性任务必须全部为绿色。

### 4. 发布检查

- 提升 `installer/package.json` 版本号，不覆盖已交付版本。
- 重新生成 `release-manifest.json` 和 `SHA256SUMS.txt`。
- 用 `scripts/run-windows-defender-scan.ps1` 或企业杀毒软件扫描四个 EXE，并保留 JSON 报告。
- 在一台从未运行过 CRM Agent 的 x64 电脑安装 Setup 版。
- 在真实 ARM64 Windows 设备或 ARM64 云 Windows 上启动 ARM64 版本。
- 检查应用图标、开始菜单、桌面快捷方式、卸载入口和中文显示。
- 将客户使用说明与对应架构安装包一起交付。

只有代码签名、全新 Windows workflow、全新 Ubuntu VPS 和 ARM64 真机/云机四项都通过后，才能把版本标记为正式商业发布。

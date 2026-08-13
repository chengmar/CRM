# 协作说明

感谢参与 CRM 项目。请保持改动小而清晰，并把数据安全视为合并条件。

## 开发流程

1. 从最新 `main` 创建短期分支。
2. 只修改当前任务需要的文件。
3. 使用 `.env.example` 了解配置，在本地 `.env` 中填写测试值。
4. 运行受影响模块的类型检查、测试和构建。
5. 提交 Pull Request，说明目的、实现、验证结果、兼容性和风险。

建议的提交信息使用简短动词开头，例如 `Fix lead scoring retry` 或 `Document Feishu setup`。

## 必做检查

后端改动：

```powershell
cd agent_service
npm ci
npm run typecheck
npm test
npm run build
```

安装器改动：

```powershell
cd installer
npm ci
npm run typecheck
npm test
npm run build
```

## 数据与安全

- 不要提交 `.env`、访问令牌、Cookie、SSH 密钥、邮箱密码或第三方凭据。
- 不要提交真实客户、联系人、订单、消息、网站访问数据或内部报表。
- 不要提交数据库、日志、截图、安装包、压缩包、缓存、依赖目录或运行输出。
- 测试数据使用 `example.com`、虚构姓名和明确的占位值。
- 外部发送功能必须保持默认关闭；任何默认值变化都要在 Pull Request 中单独说明。
- 怀疑凭据泄露时立即停止提交、轮换凭据，并按 `SECURITY.md` 报告。

## 代码风格

遵循现有 TypeScript、React、PowerShell、Shell 和 PHP 代码风格。优先增加针对行为的测试，不要把与任务无关的格式化混入同一次提交。

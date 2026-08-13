# Demo Manufacturer 独立站上线运行手册

这份手册用于本地验收完成后的 staging、正式上线和回滚。线上站点与 DNS 在验收前保持不变。

## 1. 自动上线门禁

在准备上线的 WordPress 环境运行：

```powershell
docker compose run --rm wpcli wp eval-file /opt/demo_manufacturer-tools/launch-readiness.php
```

检查是只读的，不会修改或删除数据。以下任一项会阻止通过：

- Demo Manufacturer 主题或必需插件未启用
- 正式 Logo 未配置，或首发产品仍是 bootstrap 占位记录
- 法律主体、公开地址、联系人、目标市场或 canonical 主机未填写
- 迁移图片尚未确认公开使用权
- 未经证据核验和公开授权的案例处于发布状态
- WP Mail SMTP 仍使用 PHP `mail`
- UpdraftPlus 未配置文件/数据库计划和异地目标

本地或 staging 中已有的测试询盘和 Rank Math 404 记录只会提示人工复核，不会被自动删除。

## 2. 上线前准备

1. 冻结内容变更，导出现网站完整文件、数据库和 DNS 记录。
2. 确认正式英文公司名、公开地址、联系人、首发产品、规格、图片、证书、下载文件和案例授权。
3. 在 staging 配置 HTTPS、固定链接、canonical 主机、SMTP、SPF、DKIM、DMARC、异地备份和安全规则。
4. 未确认的迁移图片保持 `Pending owner confirmation`；只有 `Owner confirmed for public use` 可以进入正式站。
5. 不把本地 `.env`、测试询盘、QA 404 日志或待确认图片作为正式数据交付。

## 3. 人工验收

- 从站外网络分别测试桌面和手机的首页、产品、文章、联系页、404 和下载页。
- 用真实外部邮箱提交一条询盘，确认表单入库、收件箱到达、Reply-To 正确且不进入垃圾邮件。
- 检查 WhatsApp 链接号码和预填文字。
- 检查页面标题、描述、canonical、Open Graph、Organization schema、robots.txt 和 sitemap。
- 抽查旧网址；保留的路径返回 200，迁移路径返回 301，不应公开的案例返回 404。
- 生成一次文件和数据库备份，并在隔离环境完成一次恢复测试。

## 4. 切换与回滚

1. 提前降低 DNS TTL，记录切换前解析值。
2. 在低流量时段切换 DNS，不删除原站或原数据库。
3. 切换后再次执行路由、询盘、HTTPS、sitemap 和邮件检查。
4. 若出现影响询盘或核心页面的问题，立即恢复原 DNS 记录；待 staging 修复并重新验收后再切换。
5. 稳定运行后再提交 Search Console/Bing sitemap，并保留原站备份至少一个完整业务周期。

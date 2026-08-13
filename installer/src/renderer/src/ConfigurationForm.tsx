import { KeyRound, Save, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { installerConfigSchema, type InstallerConfig, type SecretName, type SecretPresence } from "../../shared/contracts.js";

type Section = "business" | "integrations" | "server";

function ListInput({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  return (
    <label className="field field-wide">
      <span>{label}</span>
      <textarea
        rows={3}
        value={value.join("\n")}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))}
      />
    </label>
  );
}

function SecretInput({ name, label, configured, value, onChange, placeholder }: { name: SecretName; label: string; configured?: boolean; value: string; onChange: (name: SecretName, value: string) => void; placeholder?: string }) {
  return (
    <label className="field">
      <span>{label}{configured ? <em>已安全保存</em> : null}</span>
      <div className="secret-field">
        <KeyRound size={16} />
        <input type="password" autoComplete="new-password" value={value} placeholder={configured ? "留空表示不修改" : placeholder} onChange={(event) => onChange(name, event.target.value)} />
      </div>
    </label>
  );
}

export function ConfigurationForm({
  initial,
  secretPresence,
  busy,
  onSave,
}: {
  initial: InstallerConfig;
  secretPresence: SecretPresence;
  busy: boolean;
  onSave: (config: InstallerConfig, secrets: Partial<Record<SecretName, string>>, start: boolean) => Promise<void>;
}) {
  const [section, setSection] = useState<Section>("business");
  const [config, setConfig] = useState<InstallerConfig>(() => structuredClone(initial));
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const parsed = useMemo(() => installerConfigSchema.safeParse(config), [config]);

  const setSecret = (name: SecretName, value: string) => setSecrets((current) => ({ ...current, [name]: value }));
  const setEmailMode = (mode: InstallerConfig["email"]["mode"]) => {
    const email = { ...config.email, mode };
    if (mode === "gmail_pilot") {
      email.smtpHost = "smtp.gmail.com";
      email.smtpPort = 587;
      email.imapHost = "imap.gmail.com";
      email.imapPort = 993;
      email.dailyLimit = Math.min(email.dailyLimit, 100);
      email.hourlyLimit = Math.min(email.hourlyLimit, 20);
      email.domainAuthVerified = false;
      email.warmupComplete = false;
    }
    setConfig({ ...config, email });
  };
  const setSenderAddress = (fromAddress: string) => {
    const previous = config.email.fromAddress;
    setConfig({
      ...config,
      email: {
        ...config.email,
        fromAddress,
        replyTo: !config.email.replyTo || config.email.replyTo === previous ? fromAddress : config.email.replyTo,
        smtpUser: !config.email.smtpUser || config.email.smtpUser === previous ? fromAddress : config.email.smtpUser,
        imapUser: !config.email.imapUser || config.email.imapUser === previous ? fromAddress : config.email.imapUser,
      },
    });
  };
  const submit = async (start: boolean) => {
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    setErrors([]);
    await onSave(parsed.data, secrets, start);
    setSecrets({});
  };

  return (
    <div className="configuration-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">CONFIGURATION</span>
          <h1>安装信息</h1>
          <p>信息只保存在本机和目标服务器。密码与密钥使用 Windows 系统加密。</p>
        </div>
        <ShieldCheck size={28} />
      </div>

      <div className="segment-tabs" role="tablist">
        <button className={section === "business" ? "selected" : ""} onClick={() => setSection("business")}>公司与产品</button>
        <button className={section === "integrations" ? "selected" : ""} onClick={() => setSection("integrations")}>平台与邮箱</button>
        <button className={section === "server" ? "selected" : ""} onClick={() => setSection("server")}>服务器与安全</button>
      </div>

      {section === "business" && (
        <div className="form-section">
          <h2>公司身份</h2>
          <div className="form-grid">
            <label className="field"><span>英文法定名</span><input value={config.business.legalName} onChange={(e) => setConfig({ ...config, business: { ...config.business, legalName: e.target.value } })} /></label>
            <label className="field"><span>品牌名</span><input value={config.business.brandName} onChange={(e) => setConfig({ ...config, business: { ...config.business, brandName: e.target.value } })} /></label>
            <label className="field"><span>官网</span><input value={config.business.website} onChange={(e) => setConfig({ ...config, business: { ...config.business, website: e.target.value } })} /></label>
            <label className="field"><span>国家</span><input value={config.business.country} onChange={(e) => setConfig({ ...config, business: { ...config.business, country: e.target.value } })} /></label>
            <label className="field"><span>城市</span><input value={config.business.city} onChange={(e) => setConfig({ ...config, business: { ...config.business, city: e.target.value } })} /></label>
            <label className="field"><span>联系人</span><input value={config.business.contactName} onChange={(e) => setConfig({ ...config, business: { ...config.business, contactName: e.target.value } })} /></label>
            <label className="field"><span>职位</span><input value={config.business.contactTitle} onChange={(e) => setConfig({ ...config, business: { ...config.business, contactTitle: e.target.value } })} /></label>
            <label className="field"><span>联系邮箱</span><input value={config.business.contactEmail} onChange={(e) => setConfig({ ...config, business: { ...config.business, contactEmail: e.target.value } })} /></label>
            <label className="field"><span>WhatsApp</span><input value={config.business.whatsapp} onChange={(e) => setConfig({ ...config, business: { ...config.business, whatsapp: e.target.value } })} /></label>
            <label className="field field-wide"><span>英文公司地址</span><input value={config.business.postalAddress} onChange={(e) => setConfig({ ...config, business: { ...config.business, postalAddress: e.target.value } })} /></label>
            <label className="field field-wide"><span>英文公司介绍</span><textarea rows={3} value={config.business.introduction} onChange={(e) => setConfig({ ...config, business: { ...config.business, introduction: e.target.value } })} /></label>
          </div>
          <h2>产品与市场</h2>
          <div className="form-grid">
            <label className="field"><span>产品名称</span><input value={config.product.name} onChange={(e) => setConfig({ ...config, product: { ...config.product, name: e.target.value } })} /></label>
            <label className="field"><span>HS Code</span><input value={config.product.hsCode} onChange={(e) => setConfig({ ...config, product: { ...config.product, hsCode: e.target.value } })} /></label>
            <label className="field"><span>MOQ</span><input value={config.product.moq} onChange={(e) => setConfig({ ...config, product: { ...config.product, moq: e.target.value } })} /></label>
            <label className="field"><span>交期</span><input value={config.product.leadTime} onChange={(e) => setConfig({ ...config, product: { ...config.product, leadTime: e.target.value } })} /></label>
            <label className="field field-wide"><span>报价规则</span><input value={config.product.priceRule} onChange={(e) => setConfig({ ...config, product: { ...config.product, priceRule: e.target.value } })} /></label>
            <ListInput label="规格/型号，每行一个" value={config.product.specifications} onChange={(value) => setConfig({ ...config, product: { ...config.product, specifications: value } })} />
            <ListInput label="核心卖点，每行一个" value={config.product.sellingPoints} onChange={(value) => setConfig({ ...config, product: { ...config.product, sellingPoints: value } })} />
            <ListInput label="目标国家，每行一个" value={config.product.targetMarkets} onChange={(value) => setConfig({ ...config, product: { ...config.product, targetMarkets: value } })} />
            <ListInput label="目标买家类型，每行一个" value={config.product.buyerTypes} onChange={(value) => setConfig({ ...config, product: { ...config.product, buyerTypes: value } })} />
          </div>
        </div>
      )}

      {section === "integrations" && (
        <div className="form-section">
          <h2>AI 模型</h2>
          <div className="form-grid">
            <label className="field"><span>API Base URL</span><input value={config.ai.baseUrl} onChange={(e) => setConfig({ ...config, ai: { ...config.ai, baseUrl: e.target.value } })} /></label>
            <label className="field"><span>模型</span><input value={config.ai.model} onChange={(e) => setConfig({ ...config, ai: { ...config.ai, model: e.target.value } })} /></label>
            <SecretInput name="ai_api_key" label="API Key" configured={secretPresence.ai_api_key} value={secrets.ai_api_key ?? ""} onChange={setSecret} />
          </div>
          <h2>飞书</h2>
          <div className="form-grid">
            <label className="field"><span>平台</span><select value={config.feishu.domain} onChange={(e) => setConfig({ ...config, feishu: { ...config.feishu, domain: e.target.value as InstallerConfig["feishu"]["domain"] } })}><option value="feishu">飞书（中国）</option><option value="lark">Lark（国际）</option></select></label>
            <label className="field"><span>App ID</span><input value={config.feishu.appId} onChange={(e) => setConfig({ ...config, feishu: { ...config.feishu, appId: e.target.value } })} /></label>
            <SecretInput name="feishu_app_secret" label="App Secret" configured={secretPresence.feishu_app_secret} value={secrets.feishu_app_secret ?? ""} onChange={setSecret} />
            <label className="field"><span>CRM 名称</span><input value={config.feishu.crmName} onChange={(e) => setConfig({ ...config, feishu: { ...config.feishu, crmName: e.target.value } })} /></label>
            <label className="check-field"><input type="checkbox" checked={config.feishu.setupConfirmed} onChange={(e) => setConfig({ ...config, feishu: { ...config.feishu, setupConfirmed: e.target.checked } })} /><span>机器人、权限、长连接事件和应用发布已完成</span></label>
          </div>
          <h2>邮箱</h2>
          <div className="form-grid">
            <label className="field"><span>模式</span><select value={config.email.mode} onChange={(e) => setEmailMode(e.target.value as InstallerConfig["email"]["mode"])}><option value="gmail_pilot">Gmail 免费试运行</option><option value="enterprise">企业邮箱</option></select></label>
            <label className="field"><span>发件人名称</span><input value={config.email.fromName} onChange={(e) => setConfig({ ...config, email: { ...config.email, fromName: e.target.value } })} /></label>
            <label className="field"><span>发件邮箱</span><input value={config.email.fromAddress} onChange={(e) => setSenderAddress(e.target.value)} /></label>
            <label className="field"><span>回复邮箱</span><input value={config.email.replyTo} onChange={(e) => setConfig({ ...config, email: { ...config.email, replyTo: e.target.value } })} /></label>
            <label className="field"><span>SMTP Host</span><input value={config.email.smtpHost} onChange={(e) => setConfig({ ...config, email: { ...config.email, smtpHost: e.target.value } })} /></label>
            <label className="field"><span>SMTP Port</span><input type="number" value={config.email.smtpPort} onChange={(e) => setConfig({ ...config, email: { ...config.email, smtpPort: Number(e.target.value) } })} /></label>
            <label className="field"><span>SMTP User</span><input value={config.email.smtpUser} onChange={(e) => setConfig({ ...config, email: { ...config.email, smtpUser: e.target.value } })} /></label>
            <label className="field"><span>IMAP Host</span><input value={config.email.imapHost} onChange={(e) => setConfig({ ...config, email: { ...config.email, imapHost: e.target.value } })} /></label>
            <label className="field"><span>IMAP Port</span><input type="number" value={config.email.imapPort} onChange={(e) => setConfig({ ...config, email: { ...config.email, imapPort: Number(e.target.value) } })} /></label>
            <label className="field"><span>IMAP User</span><input value={config.email.imapUser} onChange={(e) => setConfig({ ...config, email: { ...config.email, imapUser: e.target.value } })} /></label>
            <SecretInput name="email_password" label="邮箱应用密码" configured={secretPresence.email_password} value={secrets.email_password ?? ""} onChange={setSecret} />
            <label className="field"><span>每日发送上限</span><input type="number" min="1" max="500" value={config.email.dailyLimit} onChange={(e) => setConfig({ ...config, email: { ...config.email, dailyLimit: Number(e.target.value) } })} /></label>
            <label className="field"><span>每小时发送上限</span><input type="number" min="1" max="100" value={config.email.hourlyLimit} onChange={(e) => setConfig({ ...config, email: { ...config.email, hourlyLimit: Number(e.target.value) } })} /></label>
            <label className="field field-wide"><span>退订文案</span><input value={config.email.unsubscribeText} onChange={(e) => setConfig({ ...config, email: { ...config.email, unsubscribeText: e.target.value } })} /></label>
            {config.email.mode === "enterprise" ? <label className="check-field"><input type="checkbox" checked={config.email.domainAuthVerified} onChange={(e) => setConfig({ ...config, email: { ...config.email, domainAuthVerified: e.target.checked } })} /><span>SPF、DKIM、DMARC 已验证</span></label> : null}
            {config.email.mode === "enterprise" ? <label className="check-field"><input type="checkbox" checked={config.email.warmupComplete} onChange={(e) => setConfig({ ...config, email: { ...config.email, warmupComplete: e.target.checked } })} /><span>邮箱预热已完成</span></label> : null}
          </div>
          <h2>搜索与 WhatsApp</h2>
          <div className="form-grid">
            <label className="field"><span>搜索来源</span><select value={config.search.provider} onChange={(e) => setConfig({ ...config, search: { ...config.search, provider: e.target.value as InstallerConfig["search"]["provider"] } })}><option value="searxng">自建 SearXNG</option><option value="serper">Serper</option><option value="exa">Exa</option></select></label>
            <SecretInput name="search_api_key" label="搜索 API Key" configured={secretPresence.search_api_key} value={secrets.search_api_key ?? ""} onChange={setSecret} />
            <label className="check-field"><input type="checkbox" checked={config.whatsapp.enabled} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, enabled: e.target.checked } })} /><span>启用 WhatsApp Business API</span></label>
            <label className="check-field"><input type="checkbox" checked={config.whatsapp.setupConfirmed} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, setupConfirmed: e.target.checked } })} /><span>Meta、号码、模板和 Webhook 已完成</span></label>
            <label className="field"><span>Graph API 版本</span><input value={config.whatsapp.graphApiVersion} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, graphApiVersion: e.target.value } })} /></label>
            <label className="field"><span>Phone Number ID</span><input value={config.whatsapp.phoneNumberId} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, phoneNumberId: e.target.value } })} /></label>
            <label className="field"><span>模板名称</span><input value={config.whatsapp.templateName} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, templateName: e.target.value } })} /></label>
            <label className="field"><span>模板语言代码</span><input value={config.whatsapp.templateLanguage} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, templateLanguage: e.target.value } })} /></label>
            <label className="field"><span>每日发送上限</span><input type="number" min="1" max="1000" value={config.whatsapp.dailyLimit} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, dailyLimit: Number(e.target.value) } })} /></label>
            <label className="field"><span>公网 HTTPS 地址</span><input value={config.whatsapp.publicBaseUrl} onChange={(e) => setConfig({ ...config, whatsapp: { ...config.whatsapp, publicBaseUrl: e.target.value } })} /></label>
            <SecretInput name="whatsapp_access_token" label="Access Token" configured={secretPresence.whatsapp_access_token} value={secrets.whatsapp_access_token ?? ""} onChange={setSecret} />
            <SecretInput name="whatsapp_app_secret" label="App Secret" configured={secretPresence.whatsapp_app_secret} value={secrets.whatsapp_app_secret ?? ""} onChange={setSecret} />
            <SecretInput name="whatsapp_verify_token" label="Verify Token" configured={secretPresence.whatsapp_verify_token} value={secrets.whatsapp_verify_token ?? ""} onChange={setSecret} />
          </div>
        </div>
      )}

      {section === "server" && (
        <div className="form-section">
          <h2>Ubuntu VPS</h2>
          <div className="form-grid">
            <label className="field"><span>IP / Host</span><input value={config.server.host} onChange={(e) => setConfig({ ...config, server: { ...config.server, host: e.target.value } })} /></label>
            <label className="field"><span>SSH Port</span><input type="number" value={config.server.port} onChange={(e) => setConfig({ ...config, server: { ...config.server, port: Number(e.target.value) } })} /></label>
            <label className="field"><span>SSH 用户</span><input value={config.server.user} onChange={(e) => setConfig({ ...config, server: { ...config.server, user: e.target.value } })} /></label>
            <label className="field"><span>认证方式</span><select value={config.server.authMode} onChange={(e) => setConfig({ ...config, server: { ...config.server, authMode: e.target.value as InstallerConfig["server"]["authMode"] } })}><option value="password">一次性密码</option><option value="private_key">SSH 私钥</option></select></label>
            {config.server.authMode === "password" ? <SecretInput name="server_password" label="SSH 密码" configured={secretPresence.server_password} value={secrets.server_password ?? ""} onChange={setSecret} /> : <SecretInput name="server_private_key" label="SSH 私钥内容" configured={secretPresence.server_private_key} value={secrets.server_private_key ?? ""} onChange={setSecret} />}
            <label className="field"><span>远程安装目录</span><input value={config.server.appDir} onChange={(e) => setConfig({ ...config, server: { ...config.server, appDir: e.target.value } })} /></label>
            <label className="check-field"><input type="checkbox" checked={config.server.replaceExistingEnv} onChange={(e) => setConfig({ ...config, server: { ...config.server, replaceExistingEnv: e.target.checked } })} /><span>升级时用本次填写内容覆盖服务器现有配置</span></label>
          </div>
          <h2>固定安全规则</h2>
          <div className="safety-list">
            <span><ShieldCheck size={18} />只使用公开数据并保留来源</span>
            <span><ShieldCheck size={18} />所有首轮触达必须人工审批</span>
            <span><ShieldCheck size={18} />安装完成后仍保持全局外发暂停</span>
          </div>
        </div>
      )}

      {errors.length > 0 && <div className="error-summary"><strong>请补全以下信息</strong>{errors.slice(0, 8).map((error) => <span key={error}>{error}</span>)}</div>}
      <div className="form-actions">
        <button className="secondary-button" disabled={busy} onClick={() => void submit(false)}><Save size={17} />仅保存</button>
        <button className="primary-button" disabled={busy} onClick={() => void submit(true)}><ShieldCheck size={17} />保存并开始安装</button>
      </div>
    </div>
  );
}

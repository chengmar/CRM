(() => {
  "use strict";

  const root = document.getElementById("operations-console");
  if (!root) return;

  const state = {
    snapshot: null,
    mailMode: "outbound",
    mailSearch: "",
    selectedMail: null,
    translations: new Map(),
    stream: null,
  };
  const titles = {
    overview: "智能体实时总览",
    messages: "发件与收件分析",
    sources: "客户与联系方式来源分析",
    pipeline: "获客漏斗",
    jobs: "后台任务队列",
    deliverability: "邮件投递安全",
    parameters: "运行参数",
  };
  const classificationLabels = {
    P1_INQUIRY: "P1 询盘",
    P2_INTEREST: "P2 有兴趣",
    OTHER_REPLY: "普通回复",
    NEGATIVE: "拒绝",
    UNSUBSCRIBE: "退订",
    BOUNCE: "硬退信",
    SOFT_BOUNCE: "软退信",
    AUTO_REPLY: "自动回复",
    REFERRAL: "转介绍",
    WRONG_PERSON: "联系人不符",
    NEEDS_INFO: "需要资料",
    NOT_FIT: "不匹配",
    SPAM: "垃圾邮件",
    DELIVERY_NOTICE: "投递通知",
    AMBIGUOUS: "待判断",
    UNCLASSIFIED: "未分类",
  };
  const sourceLabels = {
    official_website: "企业官网",
    search_index: "搜索索引",
    linkedin_public: "公开 LinkedIn",
    project_signal: "项目 / 招采信号",
    activity_signal: "新闻 / 活动信号",
    trade_show: "展会名录",
    directory: "行业目录",
    email_verification: "邮箱验证服务",
    seed_research: "种子研究",
    search: "公开搜索",
  };
  const statusLabels = {
    SENT: "已发送（邮件服务器已接受）",
    DELIVERED: "已确认送达",
    REPLIED: "已确认回复",
    BOUNCED: "硬退信",
    APPROVED: "已授权待发送",
    SENDING: "正在发送",
    FAILED: "失败",
    UNKNOWN: "发送结果待确认",
    COMPLETED: "已完成",
    QUEUED: "排队中",
    RUNNING: "运行中",
    SUPERSEDED: "已合并",
    BLOCKED: "已阻止",
    ALLOWED: "允许发送",
    HEALTHY: "健康",
    ACTIVE: "已启用",
    INACTIVE: "未启用",
    ENABLED: "已启用",
    DISABLED: "已停用",
    CONNECTED: "已连接",
    OFFLINE: "离线",
    PAUSED: "已暂停",
    VALID: "有效",
    INVALID: "无效",
    RISKY: "存在风险",
    PROCESSED: "已处理",
    QUARANTINED: "已隔离待复核",
    MATCHED: "已关联",
    UNMATCHED: "未关联",
    CONFIGURED: "已配置",
    NOT_CONFIGURED: "未配置",
    TRUE: "是",
    FALSE: "否",
    YES: "是",
    NO: "否",
    OK: "正常",
    CHECK: "需要检查",
  };
  const stageLabels = {
    deliverability_recovery: "投递信誉恢复期",
    configured: "正式发送配置",
    enterprise_initial_reputation_check: "企业邮箱初始信誉观察",
    enterprise_controlled_ramp: "企业邮箱受控增量期",
    enterprise_observation_required: "企业邮箱持续观察期",
    initial_reputation_check: "初始信誉观察",
    controlled_ramp: "受控增量期",
    normal: "正常发送期",
    INDUSTRY_FIT: "行业与产品适配",
    ACTIVE_INTENT: "明确需求信号",
    ICP_FIT: "理想客户适配",
    HIGH_ICP_FIT: "高匹配客户",
  };
  const modeLabels = { production: "生产模式", dry_run: "演练模式", adaptive: "自适应", fixed: "固定配置" };
  const jobTypeLabels = {
    DISCOVER_CAMPAIGN: "发现目标企业",
    ENRICH_CONTACTS: "补全联系人与联系方式",
    BUILD_EMAIL_SEQUENCE: "生成开发信",
    STAGE_GROUNDED_MESSAGE: "生成有证据的开发信",
    SYNC_BITABLE: "同步飞书多维表格",
    PROCESS_WHATSAPP_WEBHOOK: "处理 WhatsApp 消息",
    PROCESS_EMAIL_WEBHOOK: "处理邮件",
    PROCESS_INQUIRY_FORM: "处理网站询盘",
    SEND_OUTBOUND: "发送外联消息",
  };
  const entityLabels = {
    outbound_message: "开发信",
    inbound_message: "收到的邮件",
    lead: "客户线索",
    contact: "联系人",
    campaign: "获客任务",
    job: "后台任务",
    email_bounce_incident: "退信事件",
    deliverability_recovery: "投递恢复授权",
    notification: "通知",
  };
  const eventLabels = {
    MESSAGE_SENT: "开发信已发送",
    EMAIL_SENT: "开发信已发送",
    MESSAGE_BOUNCED: "开发信发生硬退信",
    EMAIL_HARD_BOUNCE: "发现硬退信",
    EMAIL_BOUNCE_INCIDENT_CREATED: "已建立退信审计事件",
    EMAIL_BOUNCE_INCIDENT_REVIEWED: "退信事件已复核",
    DELIVERABILITY_RECOVERY_AUTHORIZED: "已签发投递恢复授权",
    DELIVERABILITY_RECOVERY_CLAIMED: "已领取恢复发送额度",
    LEAD_CREATED: "发现新客户线索",
    CONTACT_CREATED: "发现新联系人",
    CONTACT_UPDATED: "联系人信息已更新",
    JOB_COMPLETED: "后台任务已完成",
    JOB_FAILED: "后台任务失败",
    JOB_ENQUEUED: "后台任务已排队",
    INBOUND_EMAIL_RECEIVED: "收到新邮件",
    INQUIRY_RECEIVED: "收到客户询盘",
  };
  const diagnosticLabels = {
    RECIPIENT_INVALID: "收件地址无效",
    REMOTE_FORWARDING_INFRASTRUCTURE: "收件方转发基础设施异常",
    MAILBOX_FULL: "收件箱已满",
    POLICY_REJECTION: "收件服务器策略拒绝",
    UNKNOWN: "退信原因待判断",
  };
  const dispositionLabels = {
    CONFIRMED_RECIPIENT_FAILURE: "已确认收件地址失效",
    REMOTE_INFRASTRUCTURE_FAILURE: "已确认收件方基础设施故障",
    UNRESOLVED: "等待人工复核",
  };
  const humanReplyClasses = new Set([
    "P1_INQUIRY", "P2_INTEREST", "OTHER_REPLY", "NEGATIVE", "UNSUBSCRIBE",
    "REFERRAL", "WRONG_PERSON", "NEEDS_INFO", "NOT_FIT",
  ]);

  const element = (id) => document.getElementById(id);
  const count = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const clip = (value, length = 180) => {
    const text = String(value ?? "").trim();
    return text.length > length ? `${text.slice(0, length)}...` : text;
  };
  const asArray = (value) => Array.isArray(value) ? value : [];
  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };
  const dateTime = (value, withSeconds = false) => {
    if (!value) return "--";
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return "--";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
      hour12: false,
    }).format(parsed);
  };
  const percent = (value, digits = 1) => `${(count(value) * 100).toFixed(digits)}%`;
  const safeUrl = (value) => {
    try {
      const parsed = new URL(String(value));
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch { return ""; }
  };
  const statusClass = (value) => {
    const status = String(value ?? "").toLowerCase();
    if (["sent", "delivered", "replied", "completed", "healthy", "ok", "allowed", "matched", "qualified", "processed"].includes(status)) return "ok";
    if (["approved", "queued", "scheduled", "superseded", "warning", "auto_reply"].includes(status)) return "warn";
    if (["bounced", "failed", "blocked", "error", "invalid", "quarantined", "unsubscribe"].includes(status)) return "fail";
    if (["running", "sending", "p1_inquiry", "p2_interest"].includes(status)) return "running";
    return "";
  };
  const chip = (label, status = label) => `<span class="status-chip ${statusClass(status)}">${escapeHtml(label)}</span>`;
  const classification = (value) => classificationLabels[String(value ?? "UNCLASSIFIED")] ?? "其他邮件";
  const sourceLabel = (value) => sourceLabels[String(value ?? "")] ?? "其他公开来源";
  const tokenLabels = {
    EMAIL: "邮件", MESSAGE: "消息", OUTBOUND: "外发", INBOUND: "收件", LEAD: "线索", CONTACT: "联系人",
    CAMPAIGN: "获客任务", JOB: "任务", CREATED: "已创建", UPDATED: "已更新", COMPLETED: "已完成",
    FAILED: "失败", QUEUED: "已排队", STARTED: "已开始", SENT: "已发送", BOUNCED: "已退信",
    RECEIVED: "已收到", PROCESSED: "已处理", AUTHORIZED: "已授权", CLAIMED: "已领取", REVIEWED: "已复核",
    DISCOVERED: "已发现", ENRICHED: "已补全", GENERATED: "已生成", SYNCED: "已同步", PAUSED: "已暂停",
    RESUMED: "已恢复", HARD: "硬", BOUNCE: "退信", INCIDENT: "事件", RECOVERY: "恢复", INQUIRY: "询盘",
  };
  const codeLabel = (value, dictionary, fallback = "系统记录") => {
    const raw = String(value ?? "").trim();
    if (!raw) return "--";
    if (dictionary[raw]) return dictionary[raw];
    const tokens = raw.toUpperCase().split(/[_\s-]+/).filter(Boolean);
    if (tokens.length && tokens.every((token) => tokenLabels[token])) return tokens.map((token) => tokenLabels[token]).join("");
    return fallback;
  };
  const statusLabel = (value) => codeLabel(value, statusLabels, "其他状态");
  const stageLabel = (value) => codeLabel(value, stageLabels, "其他业务阶段");
  const modeLabel = (value) => codeLabel(String(value ?? "").toLowerCase(), modeLabels, "其他模式");
  const jobTypeLabel = (value) => codeLabel(value, jobTypeLabels, "其他后台任务");
  const eventLabel = (value) => codeLabel(value, eventLabels, "系统运行事件");
  const entityLabel = (value) => codeLabel(value, entityLabels, "业务记录");
  const translatedField = (translation, field, fallback = "") => translation?.translation?.fields?.[field] || fallback;
  const mailTranslation = (kind, id) => state.translations.get(`${kind}:${id}`) ?? null;
  const mailSubjectSummary = (message) => `面向 ${message.company || "目标客户"} 的产品合作开发信`;
  const inboundSubjectSummary = (message) => `收到邮件：${classification(message.classification)}`;
  const policyBlockerLabel = (value) => {
    const blocker = String(value ?? "").toLowerCase();
    if (!blocker) return "全部发送门禁已经通过";
    if (blocker.includes("deliverability spacing")) return "投递恢复期最小发送间隔尚未到";
    if (blocker.includes("hard bounce")) return "滚动硬退信率超过安全阈值";
    if (blocker.includes("hourly")) return "本小时发送额度已用完";
    if (blocker.includes("daily")) return "今日发送额度已用完";
    if (blocker.includes("imap")) return "收件监控尚未达到发送就绪状态";
    if (blocker.includes("global outbound pause")) return "外发总开关已暂停";
    if (blocker.includes("authorization")) return "缺少有效的逐封发送授权";
    if (blocker.includes("invalid")) return "收件地址已标记无效";
    if (blocker.includes("dnc") || blocker.includes("unsubscribe")) return "客户已进入禁止联系或退订名单";
    if (blocker.includes("reply") || blocker.includes("human takeover")) return "客户已回复或进入人工接管";
    return "等待发送策略放行";
  };
  const incidentSummary = (incident) => {
    if (incident.enhanced_status_code === "5.1.1") return "收件服务器确认该用户不存在，系统已立即停发并将地址标记为无效。";
    if (incident.enhanced_status_code === "5.7.25") return "收件方转发网关的反向域名校验异常，原始退信保留并已完成基础设施故障复核。";
    return incident.review_disposition ? "退信事实和原始证据已保留，人工复核已经完成。" : "退信事实已保留，等待人工复核。";
  };
  const compactErrorLabel = (value) => {
    const raw = String(value ?? "");
    if (!raw || raw === "--") return "--";
    if (/RecordExceedLimit/i.test(raw)) return "飞书表格曾达到记录容量上限（历史记录）";
    if (/timeout/i.test(raw)) return "任务执行超时，系统将按策略重试";
    if (/rate.?limit/i.test(raw)) return "上游服务触发限流，系统将按策略重试";
    if (/NO_ALLOCATION_CANDIDATES/i.test(raw)) return "当前没有满足分配条件的获客任务";
    return "原始错误已保留，维护时可查看详细日志";
  };
  const metric = (label, value, note, tone = "") =>
    `<div class="metric ${tone ? `is-${tone}` : ""}"><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${escapeHtml(value)}</strong><span class="metric-note">${escapeHtml(note)}</span></div>`;

  function setStreamState(kind, label) {
    const dot = root.querySelector(".live-dot");
    dot?.classList.toggle("is-live", kind === "live");
    dot?.classList.toggle("is-error", kind === "error");
    if (element("stream-state")) element("stream-state").textContent = label;
  }

  function switchView(view) {
    root.querySelectorAll("[data-view]").forEach((button) =>
      button.classList.toggle("is-active", button.dataset.view === view));
    root.querySelectorAll("[data-view-panel]").forEach((panel) =>
      panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
    if (element("view-title")) element("view-title").textContent = titles[view] ?? titles.overview;
  }

  function renderAlert(snapshot) {
    const target = element("alert-banner");
    const runtime = snapshot.runtime ?? {};
    const recovery = snapshot.deliverability?.recovery ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    const notices = [];
    let critical = false;
    if (runtime.outboundPaused) {
      notices.push("外发总开关当前暂停");
      critical = true;
    }
    if (count(recovery.unresolvedIncidents) > 0) {
      notices.push(`${count(recovery.unresolvedIncidents)} 条硬退信尚未完成人工复核`);
      critical = true;
    } else if (recovery.required) {
      notices.push(`滚动硬退信率 ${percent(recovery.bounceStats?.rate, 2)}，恢复需要 ${count(recovery.requiredSuccessfulMessages)} 个无新硬退信样本，当前授权剩余 ${count(recovery.remainingMessages)}`);
      critical = true;
    }
    if (count(inbox.reply_review_queue) > 0) {
      notices.push(`${count(inbox.reply_review_queue)} 封疑似真人回复尚未关联客户，请在“邮件中心 / 收到邮件”中检查`);
    }
    if (!runtime.imap?.sendReady) {
      notices.push("收件监控未达到发送就绪状态");
      critical = true;
    }
    target.hidden = notices.length === 0;
    target.classList.toggle("is-critical", critical);
    target.textContent = notices.join("；");
  }

  function renderKpis(snapshot) {
    const summary = snapshot.summary ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    const attempts = count(summary.outboundAttempts);
    const dailyTarget = count(snapshot.deliverability?.policy?.dailyTarget);
    element("kpi-rail").innerHTML = [
      metric("邮件服务器已接受", attempts.toLocaleString("zh-CN"), `今日 ${count(summary.todaySent)} / ${dailyTarget} 封`, "accent"),
      metric("确认真人回复", count(inbox.confirmed_replies).toLocaleString("zh-CN"), `回复率 ${percent(inbox.replyRate)}`, count(inbox.confirmed_replies) > 0 ? "positive" : ""),
      metric("确认询盘", count(inbox.confirmed_inquiries).toLocaleString("zh-CN"), `询盘率 ${percent(inbox.inquiryRate)}`, count(inbox.confirmed_inquiries) > 0 ? "positive" : ""),
      metric("待关联回复", count(inbox.reply_review_queue).toLocaleString("zh-CN"), `${count(inbox.inquiry_review_queue)} 封疑似询盘`, count(inbox.reply_review_queue) > 0 ? "warning" : ""),
      metric("待发送", count(summary.approved).toLocaleString("zh-CN"), `${count(summary.message_authorizations)} 条逐封授权`),
      metric("硬退信", count(summary.bounced).toLocaleString("zh-CN"), `窗口 ${percent(snapshot.deliverability?.recovery?.bounceStats?.rate, 2)}`, count(summary.bounced) > 0 ? "alert" : ""),
    ].join("");
  }

  function renderFunnel(snapshot) {
    const summary = snapshot.summary ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    const stages = [
      ["获客任务", summary.campaigns, "已授权任务"],
      ["企业线索", summary.leads, "多源发现"],
      ["联系人", summary.contacts, "身份与渠道"],
      ["逐封授权", summary.message_authorizations, "正文绑定"],
      ["邮件服务器接受", summary.outboundAttempts, "真实外发"],
      ["确认回复", inbox.confirmed_replies, "客户关联"],
      ["确认询盘", inbox.confirmed_inquiries, "人工接管"],
    ];
    element("funnel-track").innerHTML = stages.map(([label, value, note]) =>
      `<div class="funnel-stage"><span>${escapeHtml(label)}</span><strong>${count(value).toLocaleString("zh-CN")}</strong><small>${escapeHtml(note)}</small></div>`).join("");
  }

  function renderRuntime(snapshot) {
    const runtime = snapshot.runtime ?? {};
    const imap = runtime.imap ?? {};
    const database = runtime.database ?? {};
    const schema = runtime.schema ?? {};
    const cells = [
      ["主模式", modeLabel(runtime.mode), runtime.mode === "production"],
      ["数据库", database.ok ? "完整性正常" : "需要检查", Boolean(database.ok)],
      ["数据库版本", `第 ${count(schema.currentVersion)} 版`, schema.currentVersion === schema.latestVersion],
      ["飞书连接", runtime.feishuConnected ? "已连接" : "离线", Boolean(runtime.feishuConnected)],
      ["收件监听", imap.sendReady ? "健康" : statusLabel(imap.state), Boolean(imap.sendReady)],
      ["邮件外发", runtime.outboundEnabled && !runtime.outboundPaused ? "运行中" : "已暂停", Boolean(runtime.outboundEnabled && !runtime.outboundPaused)],
      ["持续获客", runtime.dailyResearchEnabled ? "运行中" : "未启用", Boolean(runtime.dailyResearchEnabled)],
      ["数据时区", "北京时间", true],
    ];
    element("runtime-grid").innerHTML = cells.map(([label, value, ok]) =>
      `<div class="runtime-cell"><span>${escapeHtml(label)}</span><strong><i class="status-light ${ok ? "ok" : "warn"}"></i>${escapeHtml(value)}</strong></div>`).join("");
  }

  function renderDispatch(snapshot) {
    const plan = asArray(snapshot.deliverability?.dispatchPlan);
    element("dispatch-list").innerHTML = plan.length ? plan.slice(0, 8).map((item, index) => {
      const blockers = asArray(item.blockers);
      return `<div class="dispatch-row"><span class="dispatch-index">${String(index + 1).padStart(2, "0")}</span><div><strong>待发邮件 ${String(index + 1).padStart(2, "0")}</strong><small>${escapeHtml(policyBlockerLabel(blockers[0]))}</small></div>${chip(item.allowed ? "允许发送" : "暂未放行", item.allowed ? "allowed" : "blocked")}</div>`;
    }).join("") : '<div class="empty-state">当前没有到期邮件</div>';
  }

  function renderEvents(snapshot) {
    const events = asArray(snapshot.recentEvents);
    element("event-stream").innerHTML = events.length ? events.slice(0, 10).map((event) =>
      `<div class="event-row"><span class="event-time">${escapeHtml(dateTime(event.created_at))}</span><div><div class="event-type">${escapeHtml(eventLabel(event.event_type))}</div><div class="event-entity">${escapeHtml(entityLabel(event.entity_type))} / 对应记录已保留</div></div></div>`).join("") : '<div class="empty-state">暂无运行事件</div>';
  }

  function renderSourcePulse(snapshot) {
    const sources = asArray(snapshot.sources?.performance);
    element("source-pulse").innerHTML = sources.length ? sources.slice(0, 8).map((source) =>
      `<div class="source-pulse-row"><strong>${escapeHtml(sourceLabel(source.source_type))}</strong><span>${count(source.leads)} 线索</span><span>${count(source.replies)} 回复</span><span>${count(source.inquiries)} 询盘</span></div>`).join("") : '<div class="empty-state">暂无来源数据</div>';
  }

  function renderMailMetrics(snapshot) {
    const summary = snapshot.summary ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    element("mail-metrics").innerHTML = [
      metric("已发送记录", count(summary.outboundAttempts).toLocaleString("zh-CN"), "含退信与已回复状态", "accent"),
      metric("当前企业邮箱收件", count(inbox.inbox_total).toLocaleString("zh-CN"), `${count(inbox.matched_inbound)} 封已关联，${count(inbox.historical_other_mailboxes)} 条旧邮箱记录已隔离`),
      metric("确认回复", count(inbox.confirmed_replies).toLocaleString("zh-CN"), `回复率 ${percent(inbox.replyRate)}`, "positive"),
      metric("确认询盘", count(inbox.confirmed_inquiries).toLocaleString("zh-CN"), `询盘率 ${percent(inbox.inquiryRate)}`, "positive"),
      metric("待关联", count(inbox.unmatched_inbound).toLocaleString("zh-CN"), `${count(inbox.reply_review_queue)} 封疑似真人回复`, count(inbox.reply_review_queue) ? "warning" : ""),
      metric("自动 / 退订", `${count(inbox.auto_replies)} / ${count(inbox.unsubscribes)}`, `${count(inbox.bounces)} 封退信`),
    ].join("");
  }

  function matchesSearch(item, fields) {
    const query = state.mailSearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return true;
    return fields.some((field) => String(item[field] ?? "").toLocaleLowerCase("zh-CN").includes(query));
  }

  function renderMailTable(snapshot) {
    renderMailMetrics(snapshot);
    const outbound = state.mailMode === "outbound";
    const items = outbound
      ? asArray(snapshot.messages).filter((item) => matchesSearch(item, ["company", "subject", "body", "contact_name", "title", "lead_product"]))
      : asArray(snapshot.inbox?.messages).filter((item) => matchesSearch(item, ["company", "subject", "body_text", "from_address", "contact_name", "classification"]));
    element("mail-count").textContent = `${items.length} 条`;
    element("mail-table-head").innerHTML = outbound
      ? "<tr><th>状态</th><th>公司 / 主题</th><th>联系人 / 职位</th><th>时间</th><th>回复</th></tr>"
      : "<tr><th>分类</th><th>发件人 / 主题</th><th>关联客户</th><th>收件时间</th><th>处理</th></tr>";
    if (outbound) {
      element("mail-rows").innerHTML = items.length ? items.map((message) => {
        const hasReply = count(message.reply_count) > 0;
        const translated = mailTranslation("outbound", message.id);
        const subject = translated?.translation?.subject || mailSubjectSummary(message);
        const title = translatedField(translated, "contactTitle", message.title ? "职位中文信息待加载" : `${message.recipient_tier || "未分级"} 类联系方式`);
        return `<tr tabindex="0" role="button" data-mail-kind="outbound" data-mail-id="${escapeHtml(message.id)}"><td>${chip(statusLabel(message.status), message.status)}</td><td><span class="table-primary">${escapeHtml(message.company)}</span><span class="table-secondary">${escapeHtml(subject)}</span></td><td><span class="table-primary">${escapeHtml(message.contact_name || "企业公开邮箱")}</span><span class="table-secondary">${escapeHtml(title)}</span></td><td>${escapeHtml(dateTime(message.sent_at))}</td><td><span class="reply-indicator ${hasReply ? "has-reply" : ""}"><i></i>${hasReply ? `${count(message.reply_count)} 封` : "未确认"}</span></td></tr>`;
      }).join("") : '<tr><td colspan="5"><div class="empty-state">没有符合条件的已发送邮件</div></td></tr>';
    } else {
      element("mail-rows").innerHTML = items.length ? items.map((message) => {
        const matched = Boolean(message.lead_id);
        const needsReview = !matched && humanReplyClasses.has(String(message.classification));
        const translated = mailTranslation("inbound", message.id);
        const subject = translated?.translation?.subject || inboundSubjectSummary(message);
        return `<tr tabindex="0" role="button" data-mail-kind="inbound" data-mail-id="${escapeHtml(message.id)}"><td>${chip(classification(message.classification), message.classification)}</td><td><span class="table-primary">${escapeHtml(message.from_address || "未知发件人")}</span><span class="table-secondary">${escapeHtml(subject)}</span></td><td><span class="table-primary">${escapeHtml(message.company || "未关联客户")}</span><span class="table-secondary">${escapeHtml(message.contact_name || translatedField(translated, "correlationMethod", "需要人工核对"))}</span></td><td>${escapeHtml(dateTime(message.received_at))}</td><td><span class="reply-indicator ${matched ? "has-reply" : needsReview ? "needs-review" : ""}"><i></i>${matched ? "已关联" : needsReview ? "待复核" : "未关联"}</span></td></tr>`;
      }).join("") : '<tr><td colspan="5"><div class="empty-state">没有符合条件的收到邮件</div></td></tr>';
    }
  }

  function detailField(label, value, href = "") {
    const content = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(value || "--")}</a>`
      : `<strong>${escapeHtml(value || "--")}</strong>`;
    return `<div class="detail-field"><span>${escapeHtml(label)}</span>${content}</div>`;
  }

  function relatedInbound(message) {
    const ids = new Set(asArray(message.related_inbound_ids).map(String));
    return asArray(state.snapshot?.inbox?.messages).filter((item) => ids.has(String(item.id)));
  }

  function conversationItems(items) {
    return items.length ? items.map((item) =>
      `<article class="conversation-item"><div class="conversation-head"><strong>${escapeHtml(classification(item.classification))}</strong>${chip(item.lead_id ? "已关联" : "待关联", item.lead_id ? "matched" : "quarantined")}</div><p>${escapeHtml(dateTime(item.received_at))} / ${escapeHtml(item.from_address || "未知发件人")}</p><p>${escapeHtml(inboundSubjectSummary(item))}</p><p>请在“收到邮件”中打开该记录查看完整中文译文。</p></article>`).join("") : '<div class="empty-state">尚未确认客户回复</div>';
  }

  function renderOutboundDetail(message) {
    const sources = asArray(message.acquisition_sources);
    const replies = relatedInbound(message);
    const demand = parseArray(message.demand_evidence_json);
    const contactUrl = safeUrl(message.source_url || message.recipient_evidence_url);
    const replyState = count(message.inquiry_count) > 0 ? "确认询盘" : count(message.reply_count) > 0 ? "已回复" : "未确认回复";
    const translated = mailTranslation("outbound", message.id);
    const translation = translated?.translation;
    const fields = translation?.fields ?? {};
    const translatedSubject = translation?.subject || "正在生成中文主题...";
    const translatedBody = translation?.body || (translated?.status === "error" ? "中文译文暂时生成失败，请稍后重新打开。" : "正在生成中文译文，请稍候...");
    const gradeLabels = { GOLD: "金牌", SILVER: "银牌", BRONZE: "铜牌" };
    element("mail-dialog-kicker").textContent = `已发送开发信 / ${statusLabel(message.status)}`;
    element("mail-dialog-title").textContent = translation?.subject || "开发信中文详情";
    element("mail-detail").innerHTML = `
      <div class="detail-summary"><div class="detail-summary-main"><span>客户</span><strong>${escapeHtml(message.company || "--")}</strong></div><div class="detail-summary-cell"><span>发送时间</span><strong>${escapeHtml(dateTime(message.sent_at))}</strong></div><div class="detail-summary-cell"><span>投递状态</span><strong>${escapeHtml(statusLabel(message.status))}</strong></div><div class="detail-summary-cell"><span>回复状态</span><strong>${escapeHtml(replyState)}</strong></div></div>
      <div class="detail-columns">
        <div class="detail-column">
          <section class="detail-section"><h3>客户与职业</h3><div class="detail-grid">${detailField("公司", message.company)}${detailField("国家或地区", fields.country || "中文信息生成中")}${detailField("联系人", message.contact_name || "企业公开邮箱")}${detailField("职位", fields.contactTitle || (message.title ? "中文职位生成中" : "企业职能邮箱"))}${detailField("客户类型", fields.buyerType || "中文信息生成中")}${detailField("适配等级", `${gradeLabels[message.grade] || "待评估"} / ${count(message.total_score)} 分`)}</div></section>
          <section class="detail-section"><h3>为什么判断需要产品</h3><div class="detail-grid">${detailField("需求阶段", fields.demandStage || stageLabel(message.demand_stage))}${detailField("资格路径", fields.qualificationTrack || stageLabel(message.outreach_qualification_track))}${detailField("推广产品", fields.product || "产品中文名称生成中")}${detailField("获客任务", fields.campaignName || "任务名称中文生成中")}</div>${demand.length ? demand.map((item, index) => `<div class="evidence-item"><strong>${escapeHtml(stageLabel(item.stage || ""))}</strong><p>${escapeHtml(translation?.demandEvidence?.[index] || "需求证据中文译文生成中")}</p></div>`).join("") : '<div class="empty-state">当前没有结构化需求证据</div>'}</section>
          <section class="detail-section"><h3>联系方式与获取途径</h3><div class="detail-grid">${detailField("邮箱", message.email)}${detailField("邮箱级别", `${message.recipient_tier || "未分级"} 类`)}${detailField("邮箱状态", statusLabel(message.email_status))}${detailField("WhatsApp", message.whatsapp)}${detailField("领英公开主页", message.linkedin, safeUrl(message.linkedin))}${detailField("官网证据页面", message.source_url || message.recipient_evidence_url, contactUrl)}</div>${message.verification_notes ? `<div class="evidence-item"><strong>验证记录</strong><p>${escapeHtml(fields.verificationNotes || "验证记录中文译文生成中")}</p></div>` : ""}</section>
        </div>
        <div class="detail-column">
          <section class="detail-section"><h3>开发信中文译文 / 推广产品：${escapeHtml(fields.product || "中文名称生成中")}</h3><div class="detail-field"><span>中文主题</span><strong>${escapeHtml(translatedSubject)}</strong></div><pre class="mail-content is-translated">${escapeHtml(translatedBody)}</pre><details class="audit-original"><summary>查看英文审计原文</summary><div class="detail-field"><span>英文主题</span><strong>${escapeHtml(message.subject || "--")}</strong></div><pre class="mail-content">${escapeHtml(message.body || "")}</pre></details></section>
          <section class="detail-section"><h3>收到的回复与投递反馈</h3>${conversationItems(replies)}</section>
          <section class="detail-section"><h3>客户发现来源</h3>${sources.length ? sources.map((source, index) => { const url = safeUrl(source.source_url); return `<div class="evidence-item">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(sourceLabel(source.source_type))}</a>` : `<strong>${escapeHtml(sourceLabel(source.source_type))}</strong>`}<p>${escapeHtml(translation?.sourceEvidence?.[index] || "来源证据中文译文生成中")}</p><p>证据日期：${escapeHtml(source.source_date || "--")}</p></div>`; }).join("") : '<div class="empty-state">暂无企业发现来源</div>'}</section>
        </div>
      </div>`;
  }

  function renderInboundDetail(message) {
    const matched = Boolean(message.lead_id);
    const demand = parseArray(message.demand_evidence_json);
    const translated = mailTranslation("inbound", message.id);
    const translation = translated?.translation;
    const fields = translation?.fields ?? {};
    const translatedSubject = translation?.subject || "正在生成中文主题...";
    const translatedBody = translation?.body || (translated?.status === "error" ? "中文译文暂时生成失败，请稍后重新打开。" : "正在生成中文译文，请稍候...");
    element("mail-dialog-kicker").textContent = `收到的邮件 / ${classification(message.classification)}`;
    element("mail-dialog-title").textContent = translation?.subject || "收到邮件中文详情";
    element("mail-detail").innerHTML = `
      <div class="detail-summary"><div class="detail-summary-main"><span>发件人</span><strong>${escapeHtml(message.from_address || "--")}</strong></div><div class="detail-summary-cell"><span>收件时间</span><strong>${escapeHtml(dateTime(message.received_at))}</strong></div><div class="detail-summary-cell"><span>分类</span><strong>${escapeHtml(classification(message.classification))}</strong></div><div class="detail-summary-cell"><span>关联状态</span><strong>${matched ? "已关联客户" : "待人工关联"}</strong></div></div>
      <div class="detail-columns">
        <div class="detail-column">
          <section class="detail-section"><h3>客户关联</h3><div class="detail-grid">${detailField("公司", message.company || "未关联")}${detailField("联系人", message.contact_name || "未关联")}${detailField("职位", fields.contactTitle || (message.title ? "中文职位生成中" : "未关联"))}${detailField("客户类型", fields.buyerType || (matched ? "中文信息生成中" : "未关联"))}${detailField("推广产品", fields.product || (matched ? "产品中文名称生成中" : "未关联"))}${detailField("机会阶段", fields.opportunityStage || (message.opportunity_stage ? "中文阶段生成中" : "尚未创建"))}</div></section>
          <section class="detail-section"><h3>分类与处理</h3><div class="detail-grid">${detailField("收件分类", classification(message.classification))}${detailField("处理状态", fields.intakeStatus || statusLabel(message.intake_status || (matched ? "PROCESSED" : "QUARANTINED")))}${detailField("置信度", message.confidence === null ? "--" : `${(count(message.confidence) * 100).toFixed(0)}%`)}${detailField("关联方式", fields.correlationMethod || (matched ? "按邮件线程精确关联" : "等待人工核对"))}${detailField("收件地址", message.to_address)}${detailField("原始线程", clip(message.thread_id, 80))}</div><div class="evidence-item"><strong>分类理由</strong><p>${escapeHtml(fields.reason || "分类理由中文译文生成中")}</p></div></section>
          <section class="detail-section"><h3>客户需求依据</h3>${demand.length ? demand.map((item, index) => `<div class="evidence-item"><strong>${escapeHtml(stageLabel(item.stage || ""))}</strong><p>${escapeHtml(translation?.demandEvidence?.[index] || "需求证据中文译文生成中")}</p></div>`).join("") : `<div class="empty-state">${matched ? "当前客户暂无结构化需求依据" : "未关联客户时无法显示需求依据"}</div>`}</section>
        </div>
        <div class="detail-column">
          <section class="detail-section"><h3>收到邮件的中文译文</h3><div class="detail-field"><span>中文主题</span><strong>${escapeHtml(translatedSubject)}</strong></div><pre class="mail-content is-translated">${escapeHtml(translatedBody)}${message.body_truncated ? "\n\n[原始正文过长，监测页只翻译当前可见部分]" : ""}</pre><details class="audit-original"><summary>查看英文审计原文</summary><div class="detail-field"><span>英文主题</span><strong>${escapeHtml(message.subject || "无主题")}</strong></div><pre class="mail-content">${escapeHtml(message.body_text || "无纯文本正文")}${message.body_truncated ? "\n\n[正文过长，监测页已截断]" : ""}</pre></details></section>
          <section class="detail-section"><h3>对应发出的开发信</h3>${message.outbound_subject ? `<div class="detail-field"><span>发送时间</span><strong>${escapeHtml(dateTime(message.outbound_sent_at))}</strong></div><div class="detail-field"><span>中文主题</span><strong>${escapeHtml(fields.outboundSubject || "中文主题生成中")}</strong></div><pre class="mail-content is-translated">${escapeHtml(fields.outboundBody || "中文译文生成中")}</pre><details class="audit-original"><summary>查看对应开发信的英文审计原文</summary><div class="detail-field"><span>英文主题</span><strong>${escapeHtml(message.outbound_subject)}</strong></div><pre class="mail-content">${escapeHtml(message.outbound_body || "")}</pre></details>` : '<div class="empty-state">当前收件尚未精确关联到某一封开发信</div>'}</section>
        </div>
      </div>`;
  }

  async function loadMailTranslation(kind, id) {
    const key = `${kind}:${id}`;
    const existing = state.translations.get(key);
    if (existing?.translation || existing?.status === "loading") return;
    state.translations.set(key, { status: "loading" });
    try {
      const response = await fetch("/api/dashboard/mail-translation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, messageId: id }),
      });
      if (!response.ok) throw new Error("translation unavailable");
      state.translations.set(key, await response.json());
    } catch {
      state.translations.set(key, { status: "error" });
    }
    if (state.snapshot) renderMailTable(state.snapshot);
    if (!state.selectedMail || state.selectedMail.kind !== kind || String(state.selectedMail.id) !== String(id)) return;
    const item = kind === "outbound"
      ? asArray(state.snapshot?.messages).find((message) => String(message.id) === String(id))
      : asArray(state.snapshot?.inbox?.messages).find((message) => String(message.id) === String(id));
    if (!item) return;
    if (kind === "outbound") renderOutboundDetail(item);
    else renderInboundDetail(item);
  }

  function openMail(kind, id) {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const item = kind === "outbound"
      ? asArray(snapshot.messages).find((message) => String(message.id) === String(id))
      : asArray(snapshot.inbox?.messages).find((message) => String(message.id) === String(id));
    if (!item) return;
    state.selectedMail = { kind, id };
    if (kind === "outbound") renderOutboundDetail(item);
    else renderInboundDetail(item);
    const dialog = element("mail-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    void loadMailTranslation(kind, id);
  }

  function renderSources(snapshot) {
    const sources = asArray(snapshot.sources?.performance);
    const coverage = snapshot.sources?.evidenceCoverage ?? {};
    const channels = snapshot.sources?.channels ?? {};
    const methods = asArray(snapshot.sources?.contactMethods);
    const official = sources.find((item) => item.source_type === "official_website");
    const linkedin = sources.find((item) => item.source_type === "linkedin_public");
    element("source-metrics").innerHTML = [
      metric("来源类型", sources.length.toLocaleString("zh-CN"), "公开渠道分类"),
      metric("官网核实企业", count(official?.leads).toLocaleString("zh-CN"), "最终事实来源", "accent"),
      metric("公开 LinkedIn", count(linkedin?.leads).toLocaleString("zh-CN"), "公司与职业线索"),
      metric("精确邮箱证据", count(coverage.exact_evidence).toLocaleString("zh-CN"), `${count(coverage.tier_b)} 个 B 类邮箱`),
      metric("WhatsApp 号码", count(coverage.whatsapp).toLocaleString("zh-CN"), "仅有同意记录才可触达"),
      metric("具名联系人", count(coverage.named).toLocaleString("zh-CN"), `${count(coverage.titled)} 个有职位`),
    ].join("");
    element("source-rows").innerHTML = sources.length ? sources.map((source) =>
      `<tr><td><span class="table-primary">${escapeHtml(sourceLabel(source.source_type))}</span><span class="table-secondary">公开且可追溯</span></td><td>${count(source.leads)}</td><td>${count(source.replies)}</td><td>${count(source.inquiries)}</td><td>${count(source.bounces)}</td><td>${count(source.leads) ? percent(count(source.replies) / count(source.leads)) : "0.0%"}</td></tr>`).join("") : '<tr><td colspan="6"><div class="empty-state">暂无来源统计</div></td></tr>';
    const methodNames = { A: "具名联系人 + 独立验证有效邮箱", B: "企业官网精确公开邮箱", C: "未达到自动发送标准", UNSET: "待分级联系方式" };
    element("contact-methods").innerHTML = methods.length ? methods.map((method) =>
      `<div class="method-row"><div><strong>${escapeHtml(methodNames[method.recipient_tier] || "其他联系方式")}</strong><small>${escapeHtml(method.recipient_tier || "未分级")} 类 / ${count(method.email_contacts)} 个邮箱</small></div><span class="method-stat">${count(method.contacts)}<br>联系人</span><span class="method-stat">${count(method.reached_contacts)}<br>触达</span><span class="method-stat">${count(method.bounced_contacts)}<br>退信</span></div>`).join("") : '<div class="empty-state">暂无联系方式统计</div>';
    const total = Math.max(1, count(coverage.contacts));
    const coverageRows = [
      ["邮箱", coverage.email], ["精确来源证据", coverage.exact_evidence], ["具名联系人", coverage.named],
      ["职位", coverage.titled], ["LinkedIn", coverage.linkedin], ["WhatsApp", coverage.whatsapp],
    ];
    element("evidence-coverage").innerHTML = coverageRows.map(([label, value]) => {
      const ratio = Math.min(100, count(value) / total * 100);
      return `<div class="coverage-row"><span>${escapeHtml(label)}</span><div class="coverage-track"><i style="width:${ratio.toFixed(1)}%"></i></div><strong class="coverage-value">${count(value)} / ${count(coverage.contacts)}</strong></div>`;
    }).join("");
    const channelRows = [
      ["企业邮箱发送", channels.emailOutbound], ["企业邮箱收件", channels.emailInbound],
      ["WhatsApp Business", channels.whatsappBusiness], ["WhatsApp 外发", channels.whatsappOutbound],
      ["网站询盘表单", channels.inquiryForm], ["LinkedIn 公开研究", count(linkedin?.leads) > 0],
    ];
    element("channel-status").innerHTML = channelRows.map(([label, active]) =>
      `<div class="channel-cell ${active ? "is-active" : "is-inactive"}"><span>${escapeHtml(label)}</span><strong>${active ? "已接入" : "尚未接入"}</strong></div>`).join("");
  }

  function renderPipeline(snapshot) {
    const lead = snapshot.pipeline?.leadStatuses ?? {};
    const message = snapshot.pipeline?.messageStatuses ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    const columns = [
      ["企业线索", snapshot.summary?.leads, "公开搜索、官网、LinkedIn、项目、展会和目录形成的企业库存。", ""],
      ["联系人", snapshot.summary?.contacts, "具名联系人、企业邮箱、LinkedIn 和 WhatsApp 证据。", ""],
      ["待发送", message.APPROVED, "已具备逐封授权，等待投递策略放行。", "is-active"],
      ["邮件服务器接受", snapshot.summary?.outboundAttempts, "服务器接受不等于进入收件箱或已读。", "is-active"],
      ["待关联收件", inbox.unmatched_inbound, "尚未精确关联客户的收件，需要人工复核。", ""],
      ["确认回复", inbox.confirmed_replies, "已关联客户的真人回复，自动停止后续营销。", "is-positive"],
      ["确认询盘", inbox.confirmed_inquiries, "P1/P2 客户意向，进入人工接管。", "is-positive"],
      ["销售机会", snapshot.summary?.opportunities, "询盘确认后形成机会和跟进任务。", "is-positive"],
      ["硬退信", message.BOUNCED, "退信事实永久保留并抑制失效地址。", "is-alert"],
    ];
    element("pipeline-board").innerHTML = columns.map(([label, value, description, tone]) =>
      `<section class="pipeline-column ${tone}"><span>${escapeHtml(label)}</span><strong>${count(value).toLocaleString("zh-CN")}</strong><p>${escapeHtml(description)}</p></section>`).join("");
  }

  function renderJobs(snapshot) {
    const statuses = snapshot.jobs?.statuses ?? {};
    element("job-metrics").innerHTML = [
      metric("运行中", count(statuses.RUNNING).toLocaleString("zh-CN"), "持有任务租约", "accent"),
      metric("排队", count(statuses.QUEUED).toLocaleString("zh-CN"), "等待后台执行器"),
      metric("已完成", count(statuses.COMPLETED).toLocaleString("zh-CN"), "历史累计", "positive"),
      metric("失败", count(statuses.FAILED).toLocaleString("zh-CN"), "保留审计", count(statuses.FAILED) ? "alert" : ""),
      metric("已合并", count(statuses.SUPERSEDED).toLocaleString("zh-CN"), "重复同步任务"),
      metric("客户管理同步", `${count(snapshot.crm?.sync?.queued)} / ${count(snapshot.crm?.sync?.running)}`, "排队 / 运行"),
    ].join("");
    const jobs = asArray(snapshot.jobs?.recent);
    element("job-rows").innerHTML = jobs.length ? jobs.map((job) =>
      `<tr><td><span class="table-primary">后台任务</span><span class="table-secondary">编号 ${escapeHtml(clip(job.id, 18))}</span></td><td>${escapeHtml(jobTypeLabel(job.job_type))}</td><td>${chip(statusLabel(job.status), job.status)}</td><td>${count(job.attempts)} / ${count(job.max_attempts)}</td><td><span class="table-primary">${escapeHtml(dateTime(job.run_after))}</span><span class="table-secondary">更新 ${escapeHtml(dateTime(job.updated_at))}</span></td><td>${escapeHtml(compactErrorLabel(job.last_error || "--"))}</td></tr>`).join("") : '<tr><td colspan="6"><div class="empty-state">暂无任务</div></td></tr>';
  }

  function policyCells(items) {
    return `<div class="policy-grid">${items.map(([label, value]) => `<div class="policy-cell"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>`;
  }

  function renderDeliverability(snapshot) {
    const policy = snapshot.deliverability?.policy ?? {};
    const recovery = snapshot.deliverability?.recovery ?? {};
    const bounce = recovery.bounceStats ?? {};
    element("policy-panel").innerHTML = policyCells([
      ["策略阶段", stageLabel(policy.stage)], ["模式", modeLabel(policy.mode)],
      ["每日目标 / 上限", `${count(policy.dailyTarget)} 封`], ["每小时上限", `${count(policy.hourlyCeiling)} 封`],
      ["最小间隔", `${count(policy.minimumIntervalSeconds)} 秒`], ["退信阈值", percent(snapshot.deliverability?.maxHardBounceRate, 1)],
    ]);
    element("recovery-panel").innerHTML = policyCells([
      ["是否需要恢复", recovery.required ? "需要" : "不需要"], ["滚动窗口", `${count(bounce.bounced)} 封退信 / ${count(bounce.sent)} 个结果`],
      ["当前退信率", percent(bounce.rate, 2)], ["所需成功样本", `${count(recovery.requiredSuccessfulMessages)} 封`],
      ["授权剩余", `${count(recovery.remainingMessages)} 封`], ["未复核事件", `${count(recovery.unresolvedIncidents)} 条`],
    ]);
    const incidents = asArray(snapshot.bounceIncidents);
    element("incident-list").innerHTML = incidents.length ? incidents.map((incident) =>
      `<div class="incident-row"><div><strong>${escapeHtml(dateTime(incident.created_at))}</strong><span>邮件状态码 ${escapeHtml(incident.enhanced_status_code || "未提供")}</span></div><div><strong>${escapeHtml(codeLabel(incident.diagnostic_category, diagnosticLabels, "其他退信原因"))}</strong><span>${escapeHtml(incidentSummary(incident))}</span></div><div>${chip(codeLabel(incident.review_disposition || "UNRESOLVED", dispositionLabels, "已完成复核"), incident.review_disposition ? "completed" : "blocked")}<span>${incident.review_disposition ? "复核记录已保留" : "等待复核"}</span></div></div>`).join("") : '<div class="empty-state">暂无硬退信事件</div>';
  }

  function parameterGroup(title, rows) {
    return `<section class="parameter-group"><h3>${escapeHtml(title)}</h3>${rows.map(([label, value]) => `<div class="parameter-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</section>`;
  }

  function renderParameters(snapshot) {
    const runtime = snapshot.runtime ?? {};
    const policy = snapshot.deliverability?.policy ?? {};
    const recovery = snapshot.deliverability?.recovery ?? {};
    const crm = snapshot.crm ?? {};
    const inbox = snapshot.inbox?.metrics ?? {};
    element("parameter-grid").innerHTML = [
      parameterGroup("邮件外发", [["总开关", runtime.outboundEnabled ? "已启用" : "已停用"], ["全局暂停", runtime.outboundPaused ? "是" : "否"], ["当前阶段", stageLabel(policy.stage)], ["每日目标", `${count(policy.dailyTarget)} 封`], ["每小时上限", `${count(policy.hourlyCeiling)} 封`], ["最小间隔", `${count(policy.minimumIntervalSeconds)} 秒`]]),
      parameterGroup("邮件收取", [["收件监控状态", statusLabel(runtime.imap?.state)], ["当前企业邮箱", inbox.mailbox_domain ? `@${inbox.mailbox_domain}` : "未配置"], ["发送就绪", runtime.imap?.sendReady ? "是" : "否"], ["当前邮箱收件", String(count(inbox.inbox_total))], ["历史其他邮箱", String(count(inbox.historical_other_mailboxes))], ["待关联", String(count(inbox.unmatched_inbound))]]),
      parameterGroup("投递安全", [["滚动窗口", `${count(recovery.bounceStats?.bounced)} 封退信 / ${count(recovery.bounceStats?.sent)} 个结果`], ["退信率", percent(recovery.bounceStats?.rate, 2)], ["所需成功样本", `${count(recovery.requiredSuccessfulMessages)} 封`], ["授权额度", `${count(recovery.authorizedMessages)} 封`], ["已领取", `${count(recovery.claimedMessages)} 封`], ["剩余", `${count(recovery.remainingMessages)} 封`]]),
      parameterGroup("自动化", [["持续获客", runtime.dailyResearchEnabled ? "运行中" : "未启用"], ["待发送", String(count(snapshot.pipeline?.messageStatuses?.APPROVED))], ["当前允许", String(asArray(snapshot.deliverability?.dispatchPlan).filter((item) => item.allowed).length)], ["确认回复", String(count(inbox.confirmed_replies))], ["确认询盘", String(count(inbox.confirmed_inquiries))], ["待关联回复", String(count(inbox.reply_review_queue))]]),
      parameterGroup("飞书客户管理", [["多维表格", crm.configured ? "已配置" : "未配置"], ["排队", String(count(crm.sync?.queued))], ["运行", String(count(crm.sync?.running))], ["完成", String(count(crm.sync?.completed))], ["历史失败", String(count(crm.sync?.failed))], ["事件表分区", crm.rollover?.active ? "已启用" : "默认表"]]),
      parameterGroup("数据库", [["完整性", runtime.database?.ok ? "正常" : "需要检查"], ["快速检查", asArray(runtime.database?.quickCheck).includes("ok") ? "正常" : "需要检查"], ["外键违规", String(count(runtime.database?.foreignKeyViolations))], ["数据库版本", `${count(runtime.schema?.currentVersion)} / ${count(runtime.schema?.latestVersion)}`], ["生成时间", dateTime(snapshot.generatedAt, true)], ["时区", "北京时间"]]),
    ].join("");
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    renderAlert(snapshot);
    renderKpis(snapshot);
    renderFunnel(snapshot);
    renderRuntime(snapshot);
    renderDispatch(snapshot);
    renderEvents(snapshot);
    renderSourcePulse(snapshot);
    renderMailTable(snapshot);
    renderSources(snapshot);
    renderPipeline(snapshot);
    renderJobs(snapshot);
    renderDeliverability(snapshot);
    renderParameters(snapshot);
    element("snapshot-time").textContent = `快照 ${dateTime(snapshot.generatedAt, true)}`;
    setStreamState("live", "实时数据已连接");
  }

  async function refresh() {
    setStreamState("loading", "正在刷新快照");
    try {
      const response = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error("snapshot unavailable");
      render(await response.json());
    } catch {
      setStreamState("error", "快照获取失败，正在重试");
    }
  }

  function connectStream() {
    if (state.stream) state.stream.close();
    const stream = new EventSource("/api/dashboard/stream");
    state.stream = stream;
    stream.addEventListener("snapshot", (event) => {
      try { render(JSON.parse(event.data)); } catch { setStreamState("error", "实时快照解析失败"); }
    });
    stream.addEventListener("unavailable", () => setStreamState("error", "快照暂不可用，自动重试中"));
    stream.onerror = () => setStreamState("error", "实时连接中断，浏览器正在重连");
  }

  root.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  root.querySelectorAll("[data-mail-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mailMode = button.dataset.mailMode;
    root.querySelectorAll("[data-mail-mode]").forEach((candidate) => {
      const active = candidate.dataset.mailMode === state.mailMode;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    if (state.snapshot) renderMailTable(state.snapshot);
  }));
  element("mail-search")?.addEventListener("input", (event) => {
    state.mailSearch = event.target.value;
    if (state.snapshot) renderMailTable(state.snapshot);
  });
  element("mail-rows")?.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-mail-id]");
    if (row) openMail(row.dataset.mailKind, row.dataset.mailId);
  });
  element("mail-rows")?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const row = event.target.closest("tr[data-mail-id]");
    if (!row) return;
    event.preventDefault();
    openMail(row.dataset.mailKind, row.dataset.mailId);
  });
  element("refresh-button")?.addEventListener("click", refresh);
  setInterval(() => {
    if (element("current-time")) element("current-time").textContent = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  }, 1000);
  refresh();
  connectStream();
})();

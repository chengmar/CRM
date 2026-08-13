import { AlertTriangle, CheckCircle2, ExternalLink, FileDown, LoaderCircle, Play, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { InstallerSnapshot } from "../../shared/contracts.js";

export function StatusWorkspace({ snapshot, busy, onResume, onRetry, onRollback, onEdit, onExport }: { snapshot: InstallerSnapshot; busy: boolean; onResume: () => Promise<void>; onRetry: () => Promise<void>; onRollback: () => Promise<void>; onEdit: () => void; onExport: () => Promise<void> }) {
  const { state } = snapshot;
  const [pairingCode, setPairingCode] = useState("");
  const current = state.steps.find((step) => step.id === state.currentStepId);
  const done = state.steps.filter((step) => ["COMPLETED", "SKIPPED"].includes(step.status)).length;
  const progress = Math.round((done / state.steps.length) * 100);
  const blocker = current?.blocker;

  useEffect(() => {
    if (blocker?.code === "FEISHU_PAIRING_REQUIRED") void window.installer.getPairingCode().then(setPairingCode);
  }, [blocker?.code]);

  return (
    <div className="status-view">
      <div className="view-heading">
        <div>
          <span className="eyebrow">INSTALLATION</span>
          <h1>{state.status === "COMPLETED" ? "Agent 已安装" : state.status === "BLOCKED" ? "等待人工操作" : state.status === "FAILED" ? "安装需要处理" : "正在部署 Agent"}</h1>
          <p>安装编号 {state.installationId.slice(0, 8)} · 进度 {progress}%</p>
        </div>
        {state.status === "RUNNING" ? <LoaderCircle className="spin" size={30} /> : state.status === "COMPLETED" ? <CheckCircle2 className="success-icon" size={30} /> : <ShieldAlert size={30} />}
      </div>

      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>

      {blocker && (
        <section className="blocker-panel">
          <div className="blocker-icon"><AlertTriangle size={22} /></div>
          <div className="blocker-copy">
            <span className="eyebrow">BLOCKED</span>
            <h2>{blocker.title}</h2>
            <p>{blocker.message}</p>
            {blocker.code === "HOST_FINGERPRINT_CONFIRMATION" && <code>{String(state.metadata.pendingHostFingerprint ?? "")}</code>}
            {blocker.code === "FEISHU_PAIRING_REQUIRED" && pairingCode && <div className="pairing-code"><span>一次性配对码</span><code>{pairingCode}</code></div>}
            <div className="inline-actions">
              {blocker.externalUrl && <button className="secondary-button" onClick={() => void window.installer.openExternal(blocker.externalUrl!)}><ExternalLink size={17} />打开平台</button>}
              <button className="primary-button" disabled={busy} onClick={() => void onResume()}><Play size={17} />我已完成，继续</button>
              <button className="ghost-button" onClick={onEdit}>修改配置</button>
            </div>
          </div>
        </section>
      )}

      {state.status === "FAILED" && (
        <section className="failure-panel">
          <AlertTriangle size={22} />
          <div><h2>{current?.error ?? "当前步骤失败"}</h2><p>修正网络、凭证或平台配置后可从当前步骤重试。已完成步骤和远程检查点不会丢失。</p></div>
          <button className="primary-button" disabled={busy} onClick={() => void onRetry()}><RefreshCw size={17} />重试当前步骤</button>
        </section>
      )}

      {state.status === "COMPLETED" && (
        <section className="completion-band">
          <CheckCircle2 size={24} />
          <div><h2>服务器验收通过</h2><p>Agent、CRM、飞书入口、邮箱监听和备份服务已就绪。全局外发仍保持暂停。</p></div>
        </section>
      )}

      <section className="activity-section">
        <div className="section-heading"><div><span className="eyebrow">ACTIVITY</span><h2>安装记录</h2></div><button className="icon-button" title="导出诊断" onClick={() => void onExport()}><FileDown size={18} /></button></div>
        <div className="log-view">
          {state.events.length === 0 ? <span className="empty-log">尚未开始</span> : state.events.slice(-200).map((event, index) => <div key={`${event.at}-${index}`} data-level={event.level}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.message}</span></div>)}
        </div>
      </section>

      <div className="bottom-actions">
        <button className="ghost-button" disabled={busy || state.status === "RUNNING"} onClick={onEdit}>编辑配置</button>
        <button className="danger-button" disabled={busy || !snapshot.canRollback} onClick={() => void onRollback()}><RotateCcw size={17} />回退已安装变更</button>
      </div>
    </div>
  );
}

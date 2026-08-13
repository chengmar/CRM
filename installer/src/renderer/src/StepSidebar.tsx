import {
  Bot,
  Check,
  Circle,
  CloudCog,
  Database,
  KeyRound,
  MailCheck,
  MessageSquareText,
  PackageCheck,
  SearchCheck,
  ServerCog,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import type { InstallStepId, StepRecord } from "../../shared/contracts.js";

const labels: Record<InstallStepId, string> = {
  collect_configuration: "安装信息",
  check_windows: "电脑检查",
  confirm_feishu: "飞书应用",
  confirm_email: "邮箱验证",
  confirm_search: "AI 与搜索",
  confirm_whatsapp: "WhatsApp",
  verify_server: "服务器连接",
  verify_payload: "部署包校验",
  deploy_release: "安装 Agent",
  bootstrap_bitable: "创建 CRM",
  pair_feishu: "绑定飞书",
  final_acceptance: "最终验收",
};

const icons: Record<InstallStepId, typeof Circle> = {
  collect_configuration: Settings2,
  check_windows: ShieldCheck,
  confirm_feishu: Bot,
  confirm_email: MailCheck,
  confirm_search: SearchCheck,
  confirm_whatsapp: MessageSquareText,
  verify_server: ServerCog,
  verify_payload: PackageCheck,
  deploy_release: CloudCog,
  bootstrap_bitable: Database,
  pair_feishu: KeyRound,
  final_acceptance: Check,
};

export function StepSidebar({ steps, currentStepId }: { steps: StepRecord[]; currentStepId: InstallStepId | null }) {
  return (
    <aside className="step-sidebar">
      <div className="brand-block">
        <div className="brand-mark"><Bot size={22} /></div>
        <div>
          <strong>CRM Agent</strong>
          <span>Customer Installer</span>
        </div>
      </div>
      <nav className="step-list" aria-label="安装步骤">
        {steps.map((step) => {
          const Icon = icons[step.id];
          const active = step.id === currentStepId;
          return (
            <div key={step.id} className={`step-row ${active ? "active" : ""}`} data-status={step.status}>
              <span className="step-icon"><Icon size={17} /></span>
              <span className="step-copy">
                <strong>{labels[step.id]}</strong>
                <small>{step.status === "RUNNING" ? "正在执行" : step.status === "BLOCKED" ? "等待人工" : step.status === "FAILED" ? "需要处理" : step.status === "COMPLETED" ? "已完成" : step.status === "SKIPPED" ? "已跳过" : "待执行"}</small>
              </span>
              <span className="status-dot" aria-hidden="true" />
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

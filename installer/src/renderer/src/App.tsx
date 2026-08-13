import { useEffect, useState } from "react";
import type { InstallerConfig, InstallerSnapshot, SecretName } from "../../shared/contracts.js";
import { defaultInstallerConfig } from "../../shared/defaults.js";
import { ConfigurationForm } from "./ConfigurationForm.js";
import { StatusWorkspace } from "./StatusWorkspace.js";
import { StepSidebar } from "./StepSidebar.js";

export default function App() {
  const [snapshot, setSnapshot] = useState<InstallerSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState("");

  useEffect(() => {
    void window.installer.getSnapshot().then((value) => {
      setSnapshot(value);
      setEditing(!value.state.config || value.state.status === "DRAFT");
    }).catch((error) => setFatal(error instanceof Error ? error.message : String(error)));
    return window.installer.onSnapshot(setSnapshot);
  }, []);

  const execute = async (action: () => Promise<InstallerSnapshot>) => {
    setBusy(true);
    setFatal("");
    try {
      setSnapshot(await action());
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return <div className="boot-screen">{fatal || "正在读取安装状态..."}</div>;

  const initial = snapshot.state.config ?? {
    ...structuredClone(defaultInstallerConfig),
    email: { ...defaultInstallerConfig.email, fromName: "" },
  };

  const save = async (config: InstallerConfig, secrets: Partial<Record<SecretName, string>>, start: boolean) => {
    setBusy(true);
    setFatal("");
    try {
      const saved = await window.installer.saveConfiguration({ config, secrets });
      setSnapshot(saved);
      setEditing(false);
      if (start) setSnapshot(await window.installer.start());
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <StepSidebar steps={snapshot.state.steps} currentStepId={snapshot.state.currentStepId} />
      <main className="main-workspace">
        {fatal && <div className="fatal-banner">{fatal}</div>}
        {editing ? (
          <ConfigurationForm initial={initial} secretPresence={snapshot.state.secretPresence} busy={busy} onSave={save} />
        ) : (
          <StatusWorkspace
            snapshot={snapshot}
            busy={busy}
            onResume={() => execute(() => window.installer.resume())}
            onRetry={() => execute(() => window.installer.retry())}
            onRollback={async () => {
              if (window.confirm("确认回退安装器拥有的可逆变更？服务器会优先恢复上一版本。")) await execute(() => window.installer.rollback());
            }}
            onEdit={() => setEditing(true)}
            onExport={async () => { await window.installer.exportDiagnostics(); }}
          />
        )}
      </main>
    </div>
  );
}

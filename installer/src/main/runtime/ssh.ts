import fs from "node:fs/promises";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { InstallerConfig } from "../../shared/contracts.js";

export interface SshCredentials {
  password?: string;
  privateKey?: string;
}

export interface RemoteCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServerProbe {
  fingerprint: string;
  osId: string;
  osVersion: string;
  architecture: string;
  sudoReady: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function resolveSshCredentials(
  config: InstallerConfig,
  password: string,
  pastedPrivateKey: string,
): Promise<SshCredentials> {
  if (config.server.authMode === "password") return { password };
  if (pastedPrivateKey) return { privateKey: pastedPrivateKey };
  if (!config.server.privateKeyPath) throw new Error("SSH private key is missing.");
  return { privateKey: await fs.readFile(config.server.privateKeyPath, "utf8") };
}

export class SshSession {
  private readonly client = new Client();
  private connected = false;
  fingerprint = "";

  async connect(
    config: InstallerConfig,
    credentials: SshCredentials,
    expectedFingerprint = "",
  ): Promise<void> {
    const connection: ConnectConfig = {
      host: config.server.host,
      port: config.server.port,
      username: config.server.user,
      readyTimeout: 25_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
      hostHash: "sha256",
      hostVerifier: (hashedKey: string) => {
        this.fingerprint = `sha256:${hashedKey}`;
        return !expectedFingerprint || this.fingerprint === expectedFingerprint;
      },
      ...credentials,
    };
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.client.once("error", onError);
      this.client.once("ready", () => {
        this.client.off("error", onError);
        this.connected = true;
        resolve();
      });
      this.client.connect(connection);
    });
  }

  async exec(
    command: string,
    options: { timeoutMs?: number; onOutput?: (text: string) => void } = {},
  ): Promise<RemoteCommandResult> {
    if (!this.connected) throw new Error("SSH session is not connected.");
    return new Promise<RemoteCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Remote command timed out.")), options.timeoutMs ?? 60_000);
      this.client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timeout);
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          options.onOutput?.(text);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          options.onOutput?.(text);
        });
        stream.on("error", (streamError: Error) => {
          clearTimeout(timeout);
          reject(streamError);
        });
        stream.on("close", (code: number | null) => {
          clearTimeout(timeout);
          resolve({ code: code ?? 255, stdout, stderr });
        });
      });
    });
  }

  async uploadBuffer(remotePath: string, data: Buffer, mode = 0o600): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, data, { mode }, (error) => (error ? reject(error) : resolve()));
    });
    sftp.end();
  }

  async uploadFile(localPath: string, remotePath: string, mode = 0o600): Promise<void> {
    const data = await fs.readFile(localPath);
    await this.uploadBuffer(remotePath, data, mode);
  }

  async readRemoteFile(remotePath: string): Promise<string | null> {
    const sftp = await this.sftp();
    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(remotePath, (error, value) => (error ? reject(error) : resolve(value)));
      });
      return data.toString("utf8");
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      if (code === "ENOENT" || code === 2) return null;
      throw error;
    } finally {
      sftp.end();
    }
  }

  close(): void {
    if (this.connected) this.client.end();
    this.connected = false;
  }

  private async sftp(): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
    });
  }
}

export async function probeServer(
  config: InstallerConfig,
  credentials: SshCredentials,
  expectedFingerprint = "",
): Promise<ServerProbe> {
  const session = new SshSession();
  try {
    await session.connect(config, credentials, expectedFingerprint);
    if (!expectedFingerprint) {
      return {
        fingerprint: session.fingerprint,
        osId: "",
        osVersion: "",
        architecture: "",
        sudoReady: false,
      };
    }
    const result = await session.exec(
      "set -eu; . /etc/os-release; printf '__OS_ID__=%s\\n__OS_VERSION__=%s\\n__ARCH__=%s\\n' \"$ID\" \"$VERSION_ID\" \"$(uname -m)\"; if [ \"$(id -u)\" = 0 ] || sudo -n true >/dev/null 2>&1; then echo '__SUDO__=ok'; else echo '__SUDO__=blocked'; fi",
    );
    if (result.code !== 0) throw new Error(result.stderr || "Unable to inspect the VPS.");
    const value = (name: string) => result.stdout.match(new RegExp(`^__${name}__=(.*)$`, "m"))?.[1]?.trim() ?? "";
    return {
      fingerprint: session.fingerprint,
      osId: value("OS_ID"),
      osVersion: value("OS_VERSION"),
      architecture: value("ARCH"),
      sudoReady: value("SUDO") === "ok",
    };
  } finally {
    session.close();
  }
}

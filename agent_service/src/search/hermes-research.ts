import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import type { AgentConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export interface HermesResearchHome {
  home: string;
  configPath: string;
  configured: boolean;
}

export function configureHermesResearchHome(config: AgentConfig): HermesResearchHome {
  const home = config.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const configPath = path.join(home, "config.yaml");
  if (!config.HERMES_RESEARCH_ENABLED) return { home, configPath, configured: false };
  if (!config.OPENAI_BASE_URL || !config.OPENAI_MODEL || !config.OPENAI_API_KEY) {
    throw new Error("Hermes research requires OPENAI_BASE_URL, OPENAI_MODEL and OPENAI_API_KEY");
  }

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const document = YAML.parseDocument(existing || "{}", { keepSourceTokens: true });
  document.setIn(["model", "default"], config.OPENAI_MODEL);
  document.setIn(["model", "provider"], "custom");
  document.setIn(["model", "base_url"], config.OPENAI_BASE_URL);
  document.setIn(["model", "api_key"], "${OPENAI_API_KEY}");
  const next = String(document);
  if (next !== existing) fs.writeFileSync(configPath, next, { encoding: "utf8", mode: 0o600 });
  else fs.chmodSync(configPath, 0o600);
  return { home, configPath, configured: true };
}

function parseJsonOutput<T>(raw: string): T {
  const cleaned = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? cleaned;
  for (let index = candidate.indexOf("{"); index >= 0; index = candidate.indexOf("{", index + 1)) {
    for (let end = candidate.lastIndexOf("}"); end > index; end = candidate.lastIndexOf("}", end - 1)) {
      try {
        return JSON.parse(candidate.slice(index, end + 1)) as T;
      } catch {
        // Hermes may print progress before the final JSON object.
      }
    }
  }
  throw new Error("Hermes output did not contain valid JSON");
}

export class HermesResearchClient {
  constructor(private readonly config: AgentConfig) {}

  isEnabled(): boolean {
    return this.config.HERMES_RESEARCH_ENABLED && Boolean(this.config.HERMES_COMMAND);
  }

  async json<T>(skills: string[], prompt: string): Promise<T> {
    if (!this.isEnabled()) throw new Error("Hermes research is disabled");
    const researchHome = configureHermesResearchHome(this.config);
    const args = [
      "-z",
      prompt,
      "--safe-mode",
      "--skills",
      skills.join(","),
    ];
    const result = await execFileAsync(this.config.HERMES_COMMAND, args, {
      timeout: this.config.HERMES_RESEARCH_TIMEOUT_SECONDS * 1000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: researchHome.home,
      },
    });
    return parseJsonOutput<T>(result.stdout);
  }
}

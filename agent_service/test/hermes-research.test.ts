import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { configureHermesResearchHome } from "../src/search/hermes-research.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Hermes research provider configuration", () => {
  it("uses the application OpenAI-compatible endpoint without persisting its secret", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-research-"));
    tempDirs.push(home);
    const config = loadConfig({
      HERMES_RESEARCH_ENABLED: "true",
      HERMES_HOME: home,
      OPENAI_BASE_URL: "https://provider.example/v1",
      OPENAI_MODEL: "research-model",
      OPENAI_API_KEY: "private-test-key",
    });

    const result = configureHermesResearchHome(config);
    const text = fs.readFileSync(result.configPath, "utf8");
    const parsed = YAML.parse(text) as { model: Record<string, string> };

    expect(parsed.model).toMatchObject({
      default: "research-model",
      provider: "custom",
      base_url: "https://provider.example/v1",
      api_key: "${OPENAI_API_KEY}",
    });
    expect(text).not.toContain("private-test-key");
    expect(result.configured).toBe(true);
  });
});

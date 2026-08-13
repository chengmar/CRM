import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentDatabase } from "../src/db.js";
import { AgentLlm } from "../src/llm.js";
import { LlmCallBudget } from "../src/search/discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

describe("LLM cost budgets", () => {
  it("atomically refuses calls beyond the per-job limit", () => {
    const budget = new LlmCallBudget(2);
    expect(budget.tryTake()).toBe(true);
    expect(budget.tryTake()).toBe(true);
    expect(budget.tryTake()).toBe(false);
    expect(budget.usedCalls).toBe(2);
  });

  it("sends a hard response-token ceiling to the model gateway", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-llm-budget-"));
    tempDirs.push(dir);
    const db = new AgentDatabase(path.join(dir, "agent.db"));
    const config = loadConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://model.invalid/v1",
      OPENAI_MODEL: "test-model",
      MAX_LLM_RESPONSE_TOKENS: "321",
    });
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await new AgentLlm(config, db).json<{ ok: boolean }>("test", "system", "user");
    expect(result.ok).toBe(true);
    expect(requestBody.max_tokens).toBe(321);
    db.close();
  });
});

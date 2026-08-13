import type { AgentConfig } from "./config.js";
import type { AgentDatabase } from "./db.js";

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function startOfUtcDay(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function parseJsonContent<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf("{");
  const arrayStart = candidate.indexOf("[");
  const first = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  if (first < 0) throw new Error("LLM response did not contain JSON");
  return JSON.parse(candidate.slice(first)) as T;
}

export class AgentLlm {
  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.OPENAI_API_KEY && this.config.OPENAI_BASE_URL && this.config.OPENAI_MODEL,
    );
  }

  async json<T>(
    purpose: string,
    system: string,
    user: string,
    modelOverride?: string,
  ): Promise<T> {
    if (!this.isConfigured()) throw new Error("LLM is not configured");
    const used = this.db.getLlmTokensSince(startOfUtcDay());
    if (used >= this.config.MODEL_DAILY_TOKEN_BUDGET) {
      throw new Error(`Daily model token budget exhausted: ${used}`);
    }
    const model = modelOverride || this.config.OPENAI_MODEL;
    const base = this.config.OPENAI_BASE_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: this.config.MAX_LLM_RESPONSE_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 1000);
      throw new Error(`LLM request failed ${response.status}: ${text}`);
    }
    const body = (await response.json()) as ChatResponse;
    const content = body.choices?.[0]?.message?.content ?? "";
    this.db.recordLlmUsage(
      purpose,
      model,
      body.usage?.prompt_tokens ?? 0,
      body.usage?.completion_tokens ?? 0,
    );
    return parseJsonContent<T>(content);
  }
}

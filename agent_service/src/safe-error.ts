const SAFE_ERROR_FIELDS = ["name", "message", "code", "errno", "syscall", "hostname", "status"] as const;

function redactText(value: string, secrets: string[]): string {
  let redacted = value.replace(
    /((?:app_secret|appSecret|authorization|access_token|password|api_key)\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,}]+)/gi,
    "$1[REDACTED]",
  );
  for (const secret of secrets.filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function summarizeValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeValue(item, secrets, depth + 1));
  }
  if (typeof value !== "object") return redactText(String(value), secrets);

  const source = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of SAFE_ERROR_FIELDS) {
    if (source[field] !== undefined) summary[field] = summarizeValue(source[field], secrets, depth + 1);
  }
  if (value instanceof Error && value.stack) summary.stack = redactText(value.stack, secrets);
  if (depth < 2 && source.cause !== undefined) {
    summary.cause = summarizeValue(source.cause, secrets, depth + 1);
  }
  return Object.keys(summary).length > 0 ? summary : { type: value.constructor?.name ?? "Object" };
}

export function safeError(error: unknown, secrets: string[] = []): Record<string, unknown> {
  const summarized = summarizeValue(error, secrets);
  if (summarized && typeof summarized === "object" && !Array.isArray(summarized)) {
    return summarized as Record<string, unknown>;
  }
  return { message: summarized };
}

export function safeLogArguments(values: unknown[], secrets: string[] = []): unknown[] {
  return values.map((value) => summarizeValue(value, secrets));
}

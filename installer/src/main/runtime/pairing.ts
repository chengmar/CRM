export function hasAuthorizedFeishuOperator(statusOutput: string): boolean {
  try {
    const parsed = JSON.parse(statusOutput) as {
      config?: { feishuAuthorizedUserCount?: number };
    };
    return Number(parsed.config?.feishuAuthorizedUserCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface JobFailureState {
  retry: boolean;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
}

export interface JobFailurePlan {
  retryScheduled: boolean;
  logMessage: "Background job failed; retry scheduled" | "Background job failed permanently";
  notification?: {
    destination: string;
    text: string;
  };
}

export function planJobFailure(input: {
  jobType: string;
  replyChatId?: unknown;
  error: unknown;
  failure: JobFailureState | null;
}): JobFailurePlan {
  const retryScheduled = input.failure?.retry ?? false;
  const plan: JobFailurePlan = {
    retryScheduled,
    logMessage: retryScheduled
      ? "Background job failed; retry scheduled"
      : "Background job failed permanently",
  };
  const destination = String(input.replyChatId ?? "").trim();
  if (!destination || !input.failure || input.failure.retry) return plan;
  plan.notification = {
    destination,
    text: [
      `后台任务最终失败（已重试 ${input.failure.attempts}/${input.failure.maxAttempts} 次）：${input.jobType}`,
      String(input.error).slice(0, 1200),
    ].join("\n"),
  };
  return plan;
}

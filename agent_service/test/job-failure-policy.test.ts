import { describe, expect, it } from "vitest";
import { planJobFailure } from "../src/jobs/failure-policy.js";

describe("job failure policy", () => {
  it("does not notify while a retry is scheduled", () => {
    const plan = planJobFailure({
      jobType: "SYNC_BITABLE",
      replyChatId: "oc_sales",
      error: new Error("temporary failure"),
      failure: { retry: true, attempts: 1, maxAttempts: 3, runAfter: "later" },
    });

    expect(plan.retryScheduled).toBe(true);
    expect(plan.notification).toBeUndefined();
    expect(plan.logMessage).toContain("retry scheduled");
  });

  it("notifies the requesting chat only after the final attempt", () => {
    const plan = planJobFailure({
      jobType: "DISCOVER_CAMPAIGN",
      replyChatId: "oc_sales",
      error: "permanent failure",
      failure: { retry: false, attempts: 3, maxAttempts: 3, runAfter: "unused" },
    });

    expect(plan.retryScheduled).toBe(false);
    expect(plan.notification).toEqual({
      destination: "oc_sales",
      text: "后台任务最终失败（已重试 3/3 次）：DISCOVER_CAMPAIGN\npermanent failure",
    });
  });

  it("does not create a notification without a requesting chat", () => {
    const plan = planJobFailure({
      jobType: "PROCESS_WHATSAPP_WEBHOOK",
      error: "failure",
      failure: { retry: false, attempts: 3, maxAttempts: 3, runAfter: "unused" },
    });

    expect(plan.notification).toBeUndefined();
  });
});

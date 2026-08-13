import { DEMAND_POLICY_VERSION, type ScoreInput, type ScoreResult } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function scoreLead(
  input: ScoreInput,
  minimumScore = 80,
  activityMaxAgeDays = 548,
  now = new Date(),
  allowRiskyEmail = false,
): ScoreResult {
  const reasons: string[] = [];
  const demandPolicyCurrent = input.demandPolicyVersion === DEMAND_POLICY_VERSION;
  const demandGatePassed = input.demandEvidenceQualified && demandPolicyCurrent;
  const fit = clamp(input.fitScore, 0, 30);
  const intent = demandGatePassed ? clamp(input.intentScore, 0, 25) : 0;
  const activity = clamp(input.activityScore, 0, 20);
  const contact = clamp(input.contactScore, 0, 20);
  const channel = clamp(input.channelScore, 0, 5);
  const totalScore = fit + intent + activity + contact + channel;

  let activityFresh = false;
  if (input.lastActivityAt) {
    const activityDate = new Date(input.lastActivityAt);
    if (!Number.isNaN(activityDate.getTime())) {
      const ageDays = (now.getTime() - activityDate.getTime()) / 86_400_000;
      activityFresh = ageDays >= 0 && ageDays <= activityMaxAgeDays;
    }
  }

  if (totalScore < minimumScore) reasons.push(`score ${totalScore} below ${minimumScore}`);
  if (!demandPolicyCurrent) {
    reasons.push("demand evidence policy is missing or stale");
  }
  if (!input.demandEvidenceQualified) reasons.push("no qualifying direct demand evidence");
  if (input.independentSourceCount < 2) reasons.push("fewer than two independent sources");
  if (!activityFresh) reasons.push("no recent company activity signal");
  if (!input.namedContact) reasons.push("no named contact");
  if (!input.employmentVerified) reasons.push("contact employment not verified");
  if (input.emailStatus !== "VALID" && !(allowRiskyEmail && input.emailStatus === "RISKY")) {
    reasons.push(`email status is ${input.emailStatus}`);
  }
  if (input.roleAddress) reasons.push("role-based mailbox");
  if (input.disposableAddress) reasons.push("disposable mailbox");
  if (input.catchAll) reasons.push("catch-all mailbox");
  if (input.dncMatch) reasons.push("do-not-contact match");

  const eligibleForReview = reasons.length === 0;
  const grade = eligibleForReview
    ? "GOLD"
    : totalScore >= 80
      ? "SILVER"
      : totalScore >= 65
        ? "BRONZE"
        : "REJECT";

  return { totalScore, grade, eligibleForReview, reasons };
}

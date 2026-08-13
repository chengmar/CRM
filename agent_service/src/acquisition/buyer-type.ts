import type { BuyerType } from "./models.js";

const BUYER_TYPE_RULES: ReadonlyArray<{
  type: BuyerType;
  pattern: RegExp;
}> = [
  {
    type: "SYSTEM_INTEGRATOR_EPC",
    pattern: /\b(?:system\s+integrat\w*|solution\s+integrat\w*|epc|engineering\s+(?:company|contractor|services?)|project\s+contractor|turnkey\s+(?:engineering|project|system))\b/,
  },
  {
    type: "DISTRIBUTOR",
    pattern: /\b(?:distribut\w*|dealer|reseller|stockist|wholesal\w*|supplier|trading\s+compan\w*)\b/,
  },
  {
    type: "END_USER_FACTORY",
    pattern: /\b(?:end\s+user(?:\s+factory)?|factor(?:y|ies)|plant|manufactur\w*|operator|producer|production\s+facilit\w*|mill|foundry)\b/,
  },
];

function normalizedBuyerType(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[_/\-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function normalizeBuyerType(value: unknown): BuyerType | null {
  const normalized = normalizedBuyerType(value);
  if (!normalized) return null;
  if (normalized === "system integrator epc") return "SYSTEM_INTEGRATOR_EPC";
  if (normalized === "distributor") return "DISTRIBUTOR";
  if (normalized === "end user factory") return "END_USER_FACTORY";
  return BUYER_TYPE_RULES.find((rule) => rule.pattern.test(normalized))?.type ?? null;
}

export function normalizeBuyerTypes(values: readonly unknown[]): BuyerType[] {
  const normalized = values.flatMap((value): BuyerType[] => {
    const buyerType = normalizeBuyerType(value);
    return buyerType ? [buyerType] : [];
  });
  return [...new Set(normalized)];
}

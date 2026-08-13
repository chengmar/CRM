import { z } from "zod";
import {
  CampaignBriefSchema,
  campaignBriefHash,
  type CampaignBrief,
} from "./campaign-brief.js";

export const CAMPAIGN_FORECAST_SCHEMA_VERSION = "campaign-forecast-v2" as const;

const IdSchema = z.string().trim().min(1).max(200);
const TextSchema = z.string().trim().min(1).max(2_000);
const IsoDateTimeSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be an ISO date-time",
);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const HistoricalFunnelSampleSchema = z.object({
  id: IdSchema,
  market: TextSchema.max(120),
  productFamily: TextSchema.max(300),
  observedAt: IsoDateTimeSchema,
  accountsResearched: z.number().int().positive(),
  qualifiedAccounts: z.number().int().nonnegative(),
  namedContacts: z.number().int().nonnegative(),
  validContacts: z.number().int().nonnegative(),
  readyForReview: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
}).strict().superRefine((sample, context) => {
  if (sample.qualifiedAccounts > sample.accountsResearched) {
    context.addIssue({
      code: "custom",
      path: ["qualifiedAccounts"],
      message: "cannot exceed accountsResearched",
    });
  }
  if (sample.validContacts > sample.namedContacts) {
    context.addIssue({ code: "custom", path: ["validContacts"], message: "cannot exceed namedContacts" });
  }
  if (sample.readyForReview > sample.validContacts) {
    context.addIssue({ code: "custom", path: ["readyForReview"], message: "cannot exceed validContacts" });
  }
  if (sample.delivered > sample.readyForReview) {
    context.addIssue({ code: "custom", path: ["delivered"], message: "cannot exceed readyForReview" });
  }
});

export type HistoricalFunnelSample = z.infer<typeof HistoricalFunnelSampleSchema>;

const ForecastRangeSchema = z.object({
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
}).strict().refine((range) => range.min <= range.max, "min must not exceed max");

const ForecastRangesSchema = z.object({
  accountsResearched: ForecastRangeSchema.nullable(),
  namedContacts: ForecastRangeSchema.nullable(),
  validContacts: ForecastRangeSchema.nullable(),
  readyForReview: ForecastRangeSchema.nullable(),
  costUsd: ForecastRangeSchema.nullable(),
}).strict();

export const CampaignForecastSchema = z.object({
  schemaVersion: z.literal(CAMPAIGN_FORECAST_SCHEMA_VERSION),
  briefId: IdSchema,
  briefVersion: z.number().int().positive(),
  briefHash: HashSchema,
  status: z.enum(["NO_RELIABLE_FORECAST", "HISTORICAL_RANGE"]),
  basis: z.array(TextSchema).min(1).max(100),
  sampleCount: z.number().int().nonnegative(),
  historicalAccounts: z.number().int().nonnegative(),
  uncertainty: z.enum(["HIGH", "MEDIUM"]),
  ranges: ForecastRangesSchema,
  message: TextSchema,
  generatedAt: IsoDateTimeSchema,
}).strict().superRefine((forecast, context) => {
  const values = Object.values(forecast.ranges);
  if (forecast.status === "NO_RELIABLE_FORECAST" && values.some((range) => range !== null)) {
    context.addIssue({
      code: "custom",
      path: ["ranges"],
      message: "unreliable forecasts must not contain numeric ranges",
    });
  }
  if (forecast.status === "HISTORICAL_RANGE" && values.some((range) => range === null)) {
    context.addIssue({
      code: "custom",
      path: ["ranges"],
      message: "historical forecasts require every range",
    });
  }
});

export type CampaignForecast = z.infer<typeof CampaignForecastSchema>;

export interface CampaignForecastResult {
  forecast: CampaignForecast | null;
  blockers: string[];
}

const EMPTY_RANGES = {
  accountsResearched: null,
  namedContacts: null,
  validContacts: null,
  readyForReview: null,
  costUsd: null,
} as const;

function noReliableForecast(input: {
  brief: CampaignBrief;
  sampleCount: number;
  historicalAccounts: number;
  reason: string;
  now: Date;
}): CampaignForecast {
  return CampaignForecastSchema.parse({
    schemaVersion: CAMPAIGN_FORECAST_SCHEMA_VERSION,
    briefId: input.brief.id,
    briefVersion: input.brief.version,
    briefHash: campaignBriefHash(input.brief),
    status: "NO_RELIABLE_FORECAST",
    basis: [input.reason],
    sampleCount: input.sampleCount,
    historicalAccounts: input.historicalAccounts,
    uncertainty: "HIGH",
    ranges: EMPTY_RANGES,
    message: "无可靠预测；不得用模型或默认承诺替代可比历史漏斗。",
    generatedAt: input.now.toISOString(),
  });
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countRange(
  accountsRange: { min: number; max: number },
  rateRange: { min: number; max: number },
): { min: number; max: number } {
  return {
    min: Math.max(0, Math.floor(accountsRange.min * rateRange.min)),
    max: Math.max(0, Math.ceil(accountsRange.max * rateRange.max)),
  };
}

function sum(samples: readonly HistoricalFunnelSample[], field: keyof HistoricalFunnelSample): number {
  return samples.reduce((total, sample) => {
    const value = sample[field];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function targetField(brief: CampaignBrief): keyof HistoricalFunnelSample {
  switch (brief.targetMetric) {
    case "ACCOUNTS_RESEARCHED": return "accountsResearched";
    case "QUALIFIED_ACCOUNTS": return "qualifiedAccounts";
    case "VALID_CONTACTS": return "validContacts";
    case "READY_FOR_REVIEW": return "readyForReview";
    case "DELIVERED": return "delivered";
  }
}

function observedPerAccountRange(
  samples: readonly HistoricalFunnelSample[],
  field: keyof HistoricalFunnelSample,
): { min: number; max: number } {
  const rates = samples.map((sample) => {
    const value = sample[field];
    return (typeof value === "number" ? value : 0) / sample.accountsResearched;
  });
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

export function createCampaignForecast(input: {
  brief: unknown;
  history: readonly unknown[];
  now?: Date;
  minimumSamples?: number;
  minimumAccounts?: number;
}): CampaignForecastResult {
  const briefResult = CampaignBriefSchema.safeParse(input.brief);
  if (!briefResult.success) {
    return {
      forecast: null,
      blockers: briefResult.error.issues.map((issue) =>
        `FORECAST_BRIEF_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
    };
  }
  const samples: HistoricalFunnelSample[] = [];
  const blockers: string[] = [];
  input.history.forEach((raw, index) => {
    const result = HistoricalFunnelSampleSchema.safeParse(raw);
    if (result.success) samples.push(result.data);
    else blockers.push(...result.error.issues.map((issue) =>
      `FORECAST_HISTORY_INVALID:${index}:${issue.path.join(".") || "$root"}:${issue.message}`));
  });
  if (blockers.length > 0) return { forecast: null, blockers: [...new Set(blockers)].sort() };

  const brief = briefResult.data;
  const now = input.now ?? new Date();
  const matching = samples.filter((sample) =>
    normalized(sample.market) === normalized(brief.market)
    && normalized(sample.productFamily) === normalized(brief.productFamily));
  const historicalAccounts = sum(matching, "accountsResearched");
  if (matching.length === 0) {
    return {
      forecast: noReliableForecast({
        brief,
        sampleCount: 0,
        historicalAccounts: 0,
        reason: "NO_COMPARABLE_HISTORY",
        now,
      }),
      blockers: [],
    };
  }
  const minimumSamples = input.minimumSamples ?? 3;
  const minimumAccounts = input.minimumAccounts ?? 30;
  if (matching.length < minimumSamples || historicalAccounts < minimumAccounts) {
    return {
      forecast: noReliableForecast({
        brief,
        sampleCount: matching.length,
        historicalAccounts,
        reason: "INSUFFICIENT_COMPARABLE_HISTORY",
        now,
      }),
      blockers: [],
    };
  }

  const targetObserved = sum(matching, targetField(brief));
  const targetRate = brief.targetMetric === "ACCOUNTS_RESEARCHED"
    ? { min: 1, max: 1 }
    : observedPerAccountRange(matching, targetField(brief));
  if (targetObserved === 0 || targetRate.min <= 0 || targetRate.max <= 0) {
    return {
      forecast: noReliableForecast({
        brief,
        sampleCount: matching.length,
        historicalAccounts,
        reason: "TARGET_STAGE_HAS_NO_RELIABLE_HISTORY",
        now,
      }),
      blockers: [],
    };
  }

  const accountsRange = {
    min: Math.max(brief.targetMetric === "ACCOUNTS_RESEARCHED" ? brief.targetCount : 1,
      Math.ceil(brief.targetCount / targetRate.max)),
    max: Math.ceil(brief.targetCount / targetRate.min),
  };
  const namedRate = observedPerAccountRange(matching, "namedContacts");
  const validRate = observedPerAccountRange(matching, "validContacts");
  const readyRate = observedPerAccountRange(matching, "readyForReview");
  const costsPerAccount = matching.map((sample) => sample.costUsd / sample.accountsResearched);
  const costRate = { min: Math.min(...costsPerAccount), max: Math.max(...costsPerAccount) };

  const forecast = CampaignForecastSchema.parse({
    schemaVersion: CAMPAIGN_FORECAST_SCHEMA_VERSION,
    briefId: brief.id,
    briefVersion: brief.version,
    briefHash: campaignBriefHash(brief),
    status: "HISTORICAL_RANGE",
    basis: [
      "MATCHED_MARKET_AND_PRODUCT_HISTORY",
      `TARGET_STAGE:${brief.targetMetric}`,
      "EMPIRICAL_OBSERVED_RANGE",
    ],
    sampleCount: matching.length,
    historicalAccounts,
    uncertainty: historicalAccounts >= 100 ? "MEDIUM" : "HIGH",
    ranges: {
      accountsResearched: accountsRange,
      namedContacts: countRange(accountsRange, namedRate),
      validContacts: countRange(accountsRange, validRate),
      readyForReview: countRange(accountsRange, readyRate),
      costUsd: {
        min: rounded(accountsRange.min * costRate.min),
        max: rounded(accountsRange.max * costRate.max),
      },
    },
    message: "基于同市场同产品的历史区间，仅用于资源规划，不承诺客户、询价或成交数量。",
    generatedAt: now.toISOString(),
  });
  return { forecast, blockers: [] };
}

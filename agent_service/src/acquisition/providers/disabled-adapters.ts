import {
  ProviderManifestSchema,
  ProviderRequestSchema,
  ProviderResponseSchema,
  type ProviderAdapterExecution,
  type ProviderCapability,
  type ProviderDataClassSchema,
  type ProviderId,
  type ProviderManifest,
  type ProviderRequest,
  type StrictProviderAdapter,
} from "./contracts.js";
import type { ProviderCost, ProviderHealth } from "../provider-runtime.js";
import type { z } from "zod";

type ProviderDataClass = z.infer<typeof ProviderDataClassSchema>;

const prohibitedFields = [
  "API_CREDENTIAL",
  "DNC_DATABASE",
  "REPLY_BODY",
  "PRIVATE_CASE",
  "QUOTE",
  "CUSTOMER_NOTE",
  "UNPUBLISHED_PRODUCT_DATA",
  "FULL_CRM",
  "PERSONAL_EMAIL",
  "PHONE_NUMBER",
] as const;

interface DisabledProviderSpec {
  providerId: ProviderId;
  displayName: string;
  featureFlag: string;
  capabilities: ProviderCapability[];
  allowedDataClasses: ProviderDataClass[];
}

const disabledProviderSpecs: DisabledProviderSpec[] = [
  {
    providerId: "SERPER",
    displayName: "Serper official search API",
    featureFlag: "ACQ_SERPER_V2_ENABLED",
    capabilities: ["EVIDENCE_SEARCH"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
  },
  {
    providerId: "EXA",
    displayName: "Exa official search API",
    featureFlag: "ACQ_EXA_V2_ENABLED",
    capabilities: ["EVIDENCE_SEARCH"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
  },
  {
    providerId: "SEARXNG",
    displayName: "SearXNG search endpoint",
    featureFlag: "ACQ_SEARXNG_V2_ENABLED",
    capabilities: ["EVIDENCE_SEARCH"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
  },
  {
    providerId: "APOLLO_OFFICIAL",
    displayName: "Apollo official API",
    featureFlag: "ACQ_APOLLO_OFFICIAL_ENABLED",
    capabilities: ["ACCOUNT_DISCOVERY", "CONTACT_SEARCH", "PERSON_ENRICHMENT", "WORK_EMAIL_DISCOVERY"],
    allowedDataClasses: [
      "PUBLIC_COMPANY_IDENTITY",
      "PUBLIC_PERSON_IDENTITY",
      "CURRENT_EMPLOYMENT_ASSERTION",
      "B2B_WORK_EMAIL",
    ],
  },
  {
    providerId: "APIFY_WEBSITE",
    displayName: "Apify maintained website crawler",
    featureFlag: "ACQ_APIFY_WEBSITE_ENABLED",
    capabilities: ["WEBSITE_CRAWL"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
  },
  {
    providerId: "APIFY_PLACES",
    displayName: "Apify licensed places actor",
    featureFlag: "ACQ_APIFY_PLACES_ENABLED",
    capabilities: ["ACCOUNT_DISCOVERY"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_LOCATION"],
  },
  {
    providerId: "GOOGLE_PLACES",
    displayName: "Google Places official API",
    featureFlag: "ACQ_GOOGLE_PLACES_ENABLED",
    capabilities: ["ACCOUNT_DISCOVERY"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_LOCATION"],
  },
  {
    providerId: "INSTANTLY",
    displayName: "Instantly transport",
    featureFlag: "ACQ_INSTANTLY_ENABLED",
    capabilities: ["OUTREACH_DRAFT", "OUTREACH_RECONCILE", "OUTREACH_CANCEL"],
    allowedDataClasses: ["APPROVED_MESSAGE", "B2B_WORK_EMAIL", "LOCAL_LINKAGE_IDS"],
  },
  {
    providerId: "ANYMAIL_FINDER",
    displayName: "AnyMail Finder official API",
    featureFlag: "ACQ_ANYMAIL_FINDER_ENABLED",
    capabilities: ["WORK_EMAIL_DISCOVERY"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_PERSON_IDENTITY", "B2B_WORK_EMAIL"],
  },
  {
    providerId: "WIZA",
    displayName: "Wiza official API",
    featureFlag: "ACQ_WIZA_ENABLED",
    capabilities: ["CONTACT_SEARCH", "PERSON_ENRICHMENT", "WORK_EMAIL_DISCOVERY"],
    allowedDataClasses: [
      "PUBLIC_COMPANY_IDENTITY",
      "PUBLIC_PERSON_IDENTITY",
      "CURRENT_EMPLOYMENT_ASSERTION",
      "B2B_WORK_EMAIL",
    ],
  },
  {
    providerId: "HUNTER",
    displayName: "Hunter official API",
    featureFlag: "ACQ_HUNTER_V2_ENABLED",
    capabilities: ["WORK_EMAIL_DISCOVERY", "EMAIL_VERIFICATION"],
    allowedDataClasses: ["PUBLIC_PERSON_IDENTITY", "B2B_WORK_EMAIL", "HASHED_EMAIL"],
  },
  {
    providerId: "CLAY",
    displayName: "Clay licensed provider API",
    featureFlag: "ACQ_CLAY_ENABLED",
    capabilities: ["CONTACT_SEARCH", "PERSON_ENRICHMENT", "WORK_EMAIL_DISCOVERY", "EMAIL_VERIFICATION"],
    allowedDataClasses: [
      "PUBLIC_COMPANY_IDENTITY",
      "PUBLIC_PERSON_IDENTITY",
      "CURRENT_EMPLOYMENT_ASSERTION",
      "B2B_WORK_EMAIL",
      "HASHED_EMAIL",
    ],
  },
  {
    providerId: "LEMLIST",
    displayName: "Lemlist transport",
    featureFlag: "ACQ_LEMLIST_ENABLED",
    capabilities: ["OUTREACH_DRAFT", "OUTREACH_RECONCILE", "OUTREACH_CANCEL"],
    allowedDataClasses: ["APPROVED_MESSAGE", "B2B_WORK_EMAIL", "LOCAL_LINKAGE_IDS"],
  },
  {
    providerId: "PERPLEXITY_EVIDENCE",
    displayName: "Perplexity evidence search",
    featureFlag: "ACQ_PERPLEXITY_EVIDENCE_ENABLED",
    capabilities: ["EVIDENCE_SEARCH"],
    allowedDataClasses: ["PUBLIC_COMPANY_IDENTITY", "PUBLIC_WEBSITE_CONTENT"],
  },
];

export class DisabledProviderAdapter implements StrictProviderAdapter {
  readonly requestSchema = ProviderRequestSchema;
  readonly responseSchema = ProviderResponseSchema;
  readonly manifest: ProviderManifest;

  constructor(spec: DisabledProviderSpec) {
    this.manifest = ProviderManifestSchema.parse({
      providerId: spec.providerId,
      displayName: spec.displayName,
      capabilities: spec.capabilities,
      implementationState: "DISABLED_STUB",
      featureFlag: spec.featureFlag,
      activation: {
        featureFlagEnabled: false,
        configured: false,
        authorization: "NOT_GRANTED",
      },
      networkPolicy: "DENY",
      officialApiOnly: true,
      externalWriteAllowed: false,
      dataBoundary: {
        allowedDataClasses: spec.allowedDataClasses,
        prohibitedFields,
        personalEmailAllowed: false,
        phoneAllowed: false,
      },
    });
  }

  async health(): Promise<ProviderHealth> {
    return {
      state: "DISABLED",
      checkedAt: new Date().toISOString(),
      detail: "BLOCKED_DISABLED: no feature flag, configuration, budget, or user authorization",
    };
  }

  estimateCost(_request: ProviderRequest): ProviderCost {
    return { costUnits: 0, usd: 0, currency: "USD" };
  }

  async execute(_request: ProviderRequest, _signal: AbortSignal): Promise<ProviderAdapterExecution> {
    throw new Error(`Disabled provider stub ${this.manifest.providerId} cannot execute`);
  }
}

export function createDisabledProviderRegistry(): ReadonlyMap<ProviderId, StrictProviderAdapter> {
  return new Map(
    disabledProviderSpecs.map((spec) => [spec.providerId, new DisabledProviderAdapter(spec)]),
  );
}

export function disabledProviderManifests(): ProviderManifest[] {
  return [...createDisabledProviderRegistry().values()].map((adapter) => adapter.manifest);
}

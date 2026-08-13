import { z } from "zod";
import type { AgentDatabase } from "../db.js";
import {
  ApprovedClaimSchema,
  HighIntentContentPackageDraftSchema,
  evaluateApprovedClaimForExternalUse,
  type ApprovedClaim,
  type HighIntentContentPackageDraft,
} from "./content-safety.js";
import { extractProtectedTranslationTokens } from "./locale-safety.js";
import { PrivateCaseSchema } from "./seller-knowledge.js";

export const CONTENT_PILOT_CATALOG_SCHEMA_VERSION = "content-pilot-catalog-v2" as const;

const IdSchema = z.string().trim().min(1).max(200);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const MarketCodeSchema = z.string().trim().regex(/^[A-Z]{2}$/);

export const ContentPilotAssetRoleSchema = z.enum([
  "CORE_LANDING_PAGE",
  "TECHNICAL_ASSET",
  "RFQ_CHECKLIST",
]);

export const ContentPilotArtifactSchema = z.object({
  id: IdSchema,
  role: ContentPilotAssetRoleSchema,
  marketCode: MarketCodeSchema,
  publicationAuthorized: z.literal(false),
  draft: HighIntentContentPackageDraftSchema,
}).strict().superRefine((artifact, context) => {
  if (artifact.id !== artifact.draft.id) {
    context.addIssue({ code: "custom", path: ["draft", "id"], message: "must match the artifact ID" });
  }
  if (artifact.role === "RFQ_CHECKLIST" && artifact.draft.assetType !== "RFQ_CHECKLIST") {
    context.addIssue({
      code: "custom",
      path: ["draft", "assetType"],
      message: "RFQ_CHECKLIST role requires the RFQ_CHECKLIST asset type",
    });
  }
  if (artifact.role === "CORE_LANDING_PAGE" && artifact.draft.assetType !== "APPLICATION_GUIDE") {
    context.addIssue({
      code: "custom",
      path: ["draft", "assetType"],
      message: "core landing pages must use APPLICATION_GUIDE",
    });
  }
});

export const TargetMarketContentPackageSchema = z.object({
  marketCode: MarketCodeSchema,
  marketName: z.string().trim().min(1).max(200),
  locale: z.string().trim().min(2).max(40),
  status: z.literal("DRAFT"),
  publicationState: z.literal("NOT_PUBLISHED"),
  externalReady: z.literal(false),
  publicationAuthorized: z.literal(false),
  localeReviewStatus: z.literal("PENDING"),
  coreLandingPageId: IdSchema,
  technicalAssetIds: z.array(IdSchema).max(20),
  rfqChecklistIds: z.array(IdSchema).max(10),
}).strict().superRefine((marketPackage, context) => {
  const references = [
    marketPackage.coreLandingPageId,
    ...marketPackage.technicalAssetIds,
    ...marketPackage.rfqChecklistIds,
  ];
  if (new Set(references).size !== references.length) {
    context.addIssue({ code: "custom", path: ["technicalAssetIds"], message: "asset references must be unique" });
  }
});

export const ContentPilotCatalogSchema = z.object({
  schemaVersion: z.literal(CONTENT_PILOT_CATALOG_SCHEMA_VERSION),
  generatedAt: IsoDateTimeSchema,
  status: z.literal("DRAFT"),
  publicationState: z.literal("NOT_PUBLISHED"),
  externalReady: z.literal(false),
  publicationAuthorized: z.literal(false),
  claimPolicy: z.literal("REFERENCED_APPROVED_PUBLIC_CURRENT_ONLY"),
  privateCasePolicy: z.literal("DENY_KNOWN_PRIVATE_CASE_FRAGMENTS"),
  marketPackages: z.array(TargetMarketContentPackageSchema).max(100),
  artifacts: z.array(ContentPilotArtifactSchema).max(100),
  executionSafety: z.object({
    networkCalls: z.literal(0),
    paidApiCalls: z.literal(0),
    externalWrites: z.literal(0),
    messagesSent: z.literal(0),
    websitesPublished: z.literal(0),
  }).strict(),
}).strict().superRefine((catalog, context) => {
  const packageCodes = catalog.marketPackages.map((entry) => entry.marketCode);
  if (new Set(packageCodes).size !== packageCodes.length) {
    context.addIssue({ code: "custom", path: ["marketPackages"], message: "market codes must be unique" });
  }

  const artifactById = new Map<string, z.infer<typeof ContentPilotArtifactSchema>>();
  for (const artifact of catalog.artifacts) {
    if (artifactById.has(artifact.id)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: `duplicate artifact ID ${artifact.id}` });
    }
    artifactById.set(artifact.id, artifact);
  }

  const referenced = new Set<string>();
  const assertReference = (
    id: string,
    role: z.infer<typeof ContentPilotAssetRoleSchema>,
    marketPackage: z.infer<typeof TargetMarketContentPackageSchema>,
  ): void => {
    const artifact = artifactById.get(id);
    if (!artifact) {
      context.addIssue({ code: "custom", path: ["marketPackages"], message: `unknown artifact reference ${id}` });
      return;
    }
    if (referenced.has(id)) {
      context.addIssue({ code: "custom", path: ["marketPackages"], message: `${id} is referenced more than once` });
    }
    referenced.add(id);
    if (artifact.role !== role) {
      context.addIssue({ code: "custom", path: ["marketPackages"], message: `${id} has the wrong role` });
    }
    if (artifact.marketCode !== marketPackage.marketCode
      || artifact.draft.market !== marketPackage.marketName
      || artifact.draft.locale !== marketPackage.locale) {
      context.addIssue({ code: "custom", path: ["marketPackages"], message: `${id} has inconsistent market metadata` });
    }
  };

  for (const marketPackage of catalog.marketPackages) {
    assertReference(marketPackage.coreLandingPageId, "CORE_LANDING_PAGE", marketPackage);
    for (const id of marketPackage.technicalAssetIds) assertReference(id, "TECHNICAL_ASSET", marketPackage);
    for (const id of marketPackage.rfqChecklistIds) assertReference(id, "RFQ_CHECKLIST", marketPackage);
  }
  for (const artifact of catalog.artifacts) {
    if (!referenced.has(artifact.id)) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: `${artifact.id} is not assigned to a market package` });
    }
  }
});

export type ContentPilotCatalog = z.infer<typeof ContentPilotCatalogSchema>;
export type ContentPilotArtifact = z.infer<typeof ContentPilotArtifactSchema>;

/**
 * Return an intentionally empty catalog. New product content must be supplied
 * after product-owner approval; this repository never ships a built-in line.
 */
export function buildContentPilotCatalog(now: Date = new Date()): ContentPilotCatalog {
  return ContentPilotCatalogSchema.parse({
    schemaVersion: CONTENT_PILOT_CATALOG_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    status: "DRAFT",
    publicationState: "NOT_PUBLISHED",
    externalReady: false,
    publicationAuthorized: false,
    claimPolicy: "REFERENCED_APPROVED_PUBLIC_CURRENT_ONLY",
    privateCasePolicy: "DENY_KNOWN_PRIVATE_CASE_FRAGMENTS",
    marketPackages: [],
    artifacts: [],
    executionSafety: {
      networkCalls: 0,
      paidApiCalls: 0,
      externalWrites: 0,
      messagesSent: 0,
      websitesPublished: 0,
    },
  });
}

const unboundEditorialPatterns: Array<{ code: string; pattern: RegExp }> = [
  { code: "CERTIFICATION", pattern: /\b(?:certifi(?:ed|cation)|complies?\s+with|approved\s+to|listed\s+to)\b/iu },
  { code: "CUSTOMER_CASE", pattern: /\b(?:customer|client|case\s+study|installed\s+(?:at|for)|supplied\s+to|trusted\s+by)\b/iu },
  { code: "PERFORMANCE", pattern: /\b(?:efficiency|performance guarantee|guarantee(?:d)?|up\s+to)\b/iu },
  { code: "REGULATORY", pattern: /\b(?:regulation|legally\s+compliant)\b/iu },
  { code: "COMMERCIAL", pattern: /\b(?:MOQ|lead\s+time|payment\s+terms?|price|pricing|delivery\s+within|OEM\s+available)\b/iu },
];

function contentBlocks(draft: HighIntentContentPackageDraft) {
  return [
    ...draft.sections.flatMap((section) => section.blocks),
    ...draft.faqDraft.flatMap((faq) => faq.answerBlocks),
    ...(draft.jsonLdDraft.product?.descriptionBlocks ?? []),
  ];
}

function editorialTexts(draft: HighIntentContentPackageDraft): string[] {
  return [
    draft.title,
    draft.audience,
    draft.productFamily,
    draft.application,
    draft.seoDraft.titleSuggestion,
    draft.seoDraft.descriptionSuggestion,
    draft.jsonLdDraft.organization.name,
    draft.jsonLdDraft.product?.name ?? "",
    ...draft.sections.flatMap((section) => [
      section.heading,
      ...section.blocks.flatMap((block) => block.kind === "COPY" ? [block.text] : []),
    ]),
    ...draft.faqDraft.flatMap((faq) => [
      faq.question,
      ...faq.answerBlocks.flatMap((block) => block.kind === "COPY" ? [block.text] : []),
    ]),
    ...(draft.jsonLdDraft.product?.descriptionBlocks.flatMap((block) =>
      block.kind === "COPY" ? [block.text] : []) ?? []),
  ].filter(Boolean);
}

function allVisibleText(draft: HighIntentContentPackageDraft): string {
  return [
    ...editorialTexts(draft),
    ...contentBlocks(draft).flatMap((block) => block.kind === "APPROVED_CLAIM" ? [block.statement] : []),
  ].join("\n");
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export interface ContentPilotAuditResult {
  accepted: boolean;
  catalog: ContentPilotCatalog | null;
  blockers: string[];
  counts: { markets: number; coreLandingPages: number; technicalAssets: number; rfqChecklists: number };
}

export function auditContentPilotCatalog(input: {
  catalog: unknown;
  claims: readonly unknown[];
  privateCases: readonly unknown[];
  now?: Date;
}): ContentPilotAuditResult {
  const parsed = ContentPilotCatalogSchema.safeParse(input.catalog);
  if (!parsed.success) {
    return {
      accepted: false,
      catalog: null,
      blockers: parsed.error.issues.map((issue) =>
        `CONTENT_CATALOG_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`).sort(),
      counts: { markets: 0, coreLandingPages: 0, technicalAssets: 0, rfqChecklists: 0 },
    };
  }
  const catalog = parsed.data;
  const blockers: string[] = [];
  const now = input.now ?? new Date();
  const claims = new Map<string, ApprovedClaim>();
  for (const rawClaim of input.claims) {
    const claimResult = ApprovedClaimSchema.safeParse(rawClaim);
    if (!claimResult.success) {
      blockers.push(...claimResult.error.issues.map((issue) =>
        `CONTENT_CATALOG_CLAIM_SCHEMA_INVALID:${issue.path.join(".") || "$root"}:${issue.message}`));
      continue;
    }
    if (claims.has(claimResult.data.id)) blockers.push(`CONTENT_CATALOG_DUPLICATE_CLAIM:${claimResult.data.id}`);
    claims.set(claimResult.data.id, claimResult.data);
  }

  const privateCaseResults = input.privateCases.map((privateCase) => PrivateCaseSchema.safeParse(privateCase));
  if (privateCaseResults.some((result) => !result.success)) blockers.push("CONTENT_CATALOG_PRIVATE_CASE_CORPUS_INVALID");
  const privateCases = privateCaseResults.flatMap((result) => result.success ? [result.data] : []);

  for (const artifact of catalog.artifacts) {
    const draft = artifact.draft;
    for (const text of editorialTexts(draft)) {
      const protectedTokens = extractProtectedTranslationTokens(text);
      if (protectedTokens.numbers.length > 0
        || protectedTokens.units.length > 0
        || protectedTokens.certifications.length > 0) {
        blockers.push(`CONTENT_CATALOG_UNBOUND_NUMBER_UNIT_OR_CERTIFICATION:${artifact.id}`);
      }
      for (const risk of unboundEditorialPatterns) {
        if (risk.pattern.test(text)) blockers.push(`CONTENT_CATALOG_UNBOUND_${risk.code}_ASSERTION:${artifact.id}`);
      }
    }

    const referencedClaimIds: string[] = [];
    for (const block of contentBlocks(draft)) {
      if (block.kind !== "APPROVED_CLAIM") continue;
      referencedClaimIds.push(block.claimId);
      const claim = claims.get(block.claimId);
      if (!claim) {
        blockers.push(`CONTENT_CATALOG_CLAIM_NOT_FOUND:${artifact.id}:${block.claimId}`);
        continue;
      }
      if (block.claimVersion !== claim.version) blockers.push(`CONTENT_CATALOG_CLAIM_VERSION_MISMATCH:${artifact.id}:${claim.id}`);
      if (block.statement !== claim.statement) blockers.push(`CONTENT_CATALOG_CLAIM_STATEMENT_CHANGED:${artifact.id}:${claim.id}`);
      const claimUse = evaluateApprovedClaimForExternalUse({
        claim,
        market: draft.market,
        channel: "WEBSITE",
        locale: draft.locale,
        now,
      });
      blockers.push(...claimUse.blockers.map((blocker) => `CONTENT_CATALOG_${blocker}:${artifact.id}:${claim.id}`));
    }
    if (JSON.stringify(normalizeIds(draft.approvedClaimIds)) !== JSON.stringify(normalizeIds(referencedClaimIds))) {
      blockers.push(`CONTENT_CATALOG_CLAIM_MANIFEST_MISMATCH:${artifact.id}`);
    }

    const visibleText = allVisibleText(draft).toLocaleLowerCase("en-US");
    for (const privateCase of privateCases) {
      const fragments = [privateCase.customerName, privateCase.location, privateCase.result, ...privateCase.metrics]
        .filter((fragment): fragment is string => Boolean(fragment && fragment.trim().length >= 4));
      if (fragments.some((fragment) => visibleText.includes(fragment.toLocaleLowerCase("en-US")))) {
        blockers.push(`CONTENT_CATALOG_PRIVATE_CASE_LEAKAGE:${artifact.id}:${privateCase.id}`);
      }
    }
  }

  const counts = {
    markets: catalog.marketPackages.length,
    coreLandingPages: catalog.artifacts.filter((artifact) => artifact.role === "CORE_LANDING_PAGE").length,
    technicalAssets: catalog.artifacts.filter((artifact) => artifact.role === "TECHNICAL_ASSET").length,
    rfqChecklists: catalog.artifacts.filter((artifact) => artifact.role === "RFQ_CHECKLIST").length,
  };
  const uniqueBlockers = [...new Set(blockers)].sort();
  return { accepted: uniqueBlockers.length === 0, catalog, blockers: uniqueBlockers, counts };
}

export function runContentPilotShadow(): {
  fixtureSet: "content-pilot-empty-v2";
  accepted: boolean;
  blockers: string[];
  counts: ContentPilotAuditResult["counts"];
  states: { draft: number; notPublished: number; publicationAuthorized: number };
  safety: { networkCalls: 0; paidApiCalls: 0; externalWrites: 0; messagesSent: 0; websitesPublished: 0 };
  verdict: "HOLD";
} {
  const catalog = buildContentPilotCatalog(new Date("2026-07-20T00:00:00.000Z"));
  const audit = auditContentPilotCatalog({ catalog, claims: [], privateCases: [] });
  return {
    fixtureSet: "content-pilot-empty-v2",
    accepted: audit.accepted,
    blockers: audit.blockers,
    counts: audit.counts,
    states: { draft: 0, notPublished: 0, publicationAuthorized: 0 },
    safety: catalog.executionSafety,
    verdict: "HOLD",
  };
}

export function stageContentPilotCatalog(input: {
  db: AgentDatabase;
  catalog: unknown;
  claims?: readonly unknown[];
  privateCases?: readonly unknown[];
  createdBy: string;
  now?: Date;
}): {
  assets: Array<{ catalogId: string; assetId: string; versionId: string; versionNumber: number }>;
  status: "DRAFT";
  publicationAuthorized: false;
  externalWrites: 0;
} {
  const audit = auditContentPilotCatalog({
    catalog: input.catalog,
    claims: input.claims ?? [],
    privateCases: input.privateCases ?? [],
    now: input.now,
  });
  if (!audit.accepted || !audit.catalog) {
    throw new Error(`Content pilot catalog failed audit: ${audit.blockers.join("; ")}`);
  }
  const assets = input.db.runInTransaction(() => audit.catalog!.artifacts.map((artifact) => {
    const asset = input.db.upsertContentAsset({
      assetKey: `content-pilot:${artifact.id}`,
      assetType: artifact.draft.assetType,
      title: artifact.draft.title,
      defaultLocale: artifact.draft.locale,
      visibility: "PRIVATE",
      targetMarkets: [artifact.marketCode],
      createdBy: input.createdBy,
      metadata: {
        catalogVersion: audit.catalog!.schemaVersion,
        role: artifact.role,
        publicationState: "NOT_PUBLISHED",
        publicationAuthorized: false,
      },
    });
    const version = input.db.upsertContentVersion({
      assetId: asset.id,
      locale: artifact.draft.locale,
      body: JSON.stringify(artifact.draft),
      approvedClaimIds: artifact.draft.approvedClaimIds,
      createdBy: input.createdBy,
      metadata: {
        catalogArtifactId: artifact.id,
        reviewChecklist: artifact.draft.reviewChecklist,
        publicationState: "NOT_PUBLISHED",
        publicationAuthorized: false,
      },
    });
    return {
      catalogId: artifact.id,
      assetId: asset.id,
      versionId: version.id,
      versionNumber: version.versionNumber,
    };
  }));
  return { assets, status: "DRAFT", publicationAuthorized: false, externalWrites: 0 };
}

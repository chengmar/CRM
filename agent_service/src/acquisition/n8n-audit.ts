import { createHash } from "node:crypto";
import { z } from "zod";

export const N8N_AUDIT_SCHEMA_VERSION = "n8n-static-audit-v2" as const;

const IdSchema = z.string().trim().min(1).max(500);
const TextSchema = z.string().trim().min(1).max(4_000);

const CredentialReferenceSchema = z.object({
  id: IdSchema.optional(),
  name: TextSchema.max(500).optional(),
}).strict().refine((reference) => Boolean(reference.id || reference.name), {
  message: "credential reference requires id or name",
});

export const N8nNodeSchema = z.object({
  id: IdSchema.optional(),
  name: TextSchema.max(500),
  type: TextSchema.max(500),
  typeVersion: z.number().finite().positive(),
  position: z.tuple([z.number().finite(), z.number().finite()]),
  parameters: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), CredentialReferenceSchema).optional(),
  webhookId: IdSchema.optional(),
  disabled: z.boolean().optional(),
  notes: z.string().max(20_000).optional(),
  notesInFlow: z.boolean().optional(),
  continueOnFail: z.boolean().optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(100).optional(),
  waitBetweenTries: z.number().int().nonnegative().max(86_400_000).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
}).strict();

export const N8nWorkflowSchema = z.object({
  id: IdSchema.optional(),
  name: TextSchema.max(500),
  nodes: z.array(N8nNodeSchema).min(1).max(2_000),
  connections: z.record(z.string(), z.unknown()),
  active: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  versionId: IdSchema.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  pinData: z.record(z.string(), z.unknown()).optional(),
  staticData: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.unknown()).optional(),
}).strict();

export type N8nWorkflow = z.infer<typeof N8nWorkflowSchema>;

const AllowedHttpTargetSchema = z.object({
  origin: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  pathPrefixes: z.array(z.string().trim().regex(/^\/(?!\/)/)).min(1).max(100),
  methods: z.array(z.enum(["GET", "POST"])).min(1).max(2),
}).strict();

export const N8nAuditPolicySchema = z.object({
  allowedHttpTargets: z.array(AllowedHttpTargetSchema).max(100),
  allowedOfficialNodePrefixes: z.array(TextSchema.max(500)).min(1).max(20),
  maximumBytes: z.number().int().positive().max(10_000_000),
}).strict();

export type N8nAuditPolicy = z.infer<typeof N8nAuditPolicySchema>;

const DEFAULT_POLICY: N8nAuditPolicy = {
  allowedHttpTargets: [],
  allowedOfficialNodePrefixes: ["n8n-nodes-base.", "@n8n/n8n-nodes-langchain."],
  maximumBytes: 1_000_000,
};

const AuditFindingSchema = z.object({
  severity: z.enum(["BLOCKER", "WARNING", "INFO"]),
  code: IdSchema,
  nodeName: z.string().max(500).nullable(),
  detail: TextSchema,
}).strict();

const CredentialInventorySchema = z.object({
  nodeName: TextSchema.max(500),
  credentialType: TextSchema.max(500),
  credentialId: z.string().max(500).nullable(),
  credentialName: z.string().max(500).nullable(),
}).strict();

const RetryInventorySchema = z.object({
  nodeName: TextSchema.max(500),
  retryOnFail: z.boolean(),
  maxTries: z.number().int().positive(),
  waitBetweenTries: z.number().int().nonnegative(),
  idempotencyMarkerFound: z.boolean(),
}).strict();

const N8nAuditInventorySchema = z.object({
  credentialReferences: z.array(CredentialInventorySchema),
  httpEndpoints: z.array(z.string()),
  webhooks: z.array(TextSchema.max(500)),
  sendNodes: z.array(TextSchema.max(500)),
  codeNodes: z.array(TextSchema.max(500)),
  communityNodes: z.array(TextSchema.max(500)),
  databaseNodes: z.array(TextSchema.max(500)),
  dataWriteDestinations: z.array(TextSchema.max(1_000)),
  retryConfiguration: z.array(RetryInventorySchema),
  plaintextCredentialPaths: z.array(TextSchema.max(1_000)),
  duplicateRiskNodes: z.array(TextSchema.max(500)),
}).strict();

export const N8nAuditReportSchema = z.object({
  schemaVersion: z.literal(N8N_AUDIT_SCHEMA_VERSION),
  status: z.enum(["BLOCKED", "SHADOW_ONLY_ALLOWED"]),
  workflowName: z.string().max(500).nullable(),
  workflowHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  shadowImportAllowed: z.boolean(),
  productionImportAllowed: z.literal(false),
  inventory: N8nAuditInventorySchema,
  findings: z.array(AuditFindingSchema),
}).strict();

export type N8nAuditReport = z.infer<typeof N8nAuditReportSchema>;
type AuditFinding = z.infer<typeof AuditFindingSchema>;
type N8nAuditInventory = z.infer<typeof N8nAuditInventorySchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function emptyInventory(): N8nAuditInventory {
  return {
    credentialReferences: [],
    httpEndpoints: [],
    webhooks: [],
    sendNodes: [],
    codeNodes: [],
    communityNodes: [],
    databaseNodes: [],
    dataWriteDestinations: [],
    retryConfiguration: [],
    plaintextCredentialPaths: [],
    duplicateRiskNodes: [],
  };
}

function blockedParseReport(code: string, detail: string): N8nAuditReport {
  return N8nAuditReportSchema.parse({
    schemaVersion: N8N_AUDIT_SCHEMA_VERSION,
    status: "BLOCKED",
    workflowName: null,
    workflowHash: null,
    shadowImportAllowed: false,
    productionImportAllowed: false,
    inventory: emptyInventory(),
    findings: [{ severity: "BLOCKER", code, nodeName: null, detail }],
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function literalSecret(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const normalized = value.trim();
  if (/^(?:\*+|x+|redacted|placeholder|example)$/i.test(normalized)) return false;
  return !/(?:=\{\{|\{\{|\$env\b|\$credentials\b|\$vars\b)/i.test(normalized);
}

const SENSITIVE_KEY_PATTERN = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|client[-_]?secret|private[-_]?key|authorization)$/i;
const SENSITIVE_HEADER_PATTERN = /^(?:authorization|proxy-authorization|x-api-key|api-key)$/i;

function scanPlaintextCredentials(value: unknown, path: string, findings: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanPlaintextCredentials(entry, `${path}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const headerName = typeof record.name === "string" ? record.name : null;
  if (headerName && SENSITIVE_HEADER_PATTERN.test(headerName) && literalSecret(record.value)) {
    findings.push(`${path}.value`);
  }
  for (const [key, nested] of Object.entries(record)) {
    const nestedPath = `${path}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key) && literalSecret(nested)) findings.push(nestedPath);
    scanPlaintextCredentials(nested, nestedPath, findings);
  }
}

function containsKey(value: unknown, pattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, pattern));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, nested]) => pattern.test(key) || containsKey(nested, pattern));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
  }
  return [];
}

function nodeTypeIncludes(node: N8nWorkflow["nodes"][number], patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(node.type) || pattern.test(node.name));
}

const SEND_NODE_PATTERNS = [
  /emailSend/i,
  /gmail/i,
  /smtp/i,
  /sendgrid/i,
  /mailgun/i,
  /microsoftOutlook/i,
  /instantly/i,
  /lemlist/i,
  /whatsapp/i,
  /twilio/i,
  /telegram/i,
  /slack/i,
] as const;
const CODE_NODE_PATTERNS = [/\.code$/i, /\.function(?:Item)?$/i, /executeCommand/i] as const;
const DATABASE_NODE_PATTERNS = [/sqlite/i, /postgres/i, /mysql/i, /mssql/i, /mongo(?:db)?/i] as const;
const WRITE_OPERATION_PATTERN = /^(?:create|insert|update|upsert|delete|executeQuery|write)$/i;
const SEND_OPERATION_PATTERN = /^(?:send|sendEmail|sendMessage|createCampaign|activate|publish)$/i;

function isSendNode(node: N8nWorkflow["nodes"][number]): boolean {
  const operation = typeof node.parameters.operation === "string" ? node.parameters.operation : "";
  return nodeTypeIncludes(node, SEND_NODE_PATTERNS) || SEND_OPERATION_PATTERN.test(operation);
}

function isCodeNode(node: N8nWorkflow["nodes"][number]): boolean {
  return nodeTypeIncludes(node, CODE_NODE_PATTERNS);
}

function isDatabaseNode(node: N8nWorkflow["nodes"][number]): boolean {
  return nodeTypeIncludes(node, DATABASE_NODE_PATTERNS)
    || stringsIn(node.parameters).some((value) => /(?:^|[\\/])[^\\/]+\.sqlite3?(?:$|\?)/i.test(value));
}

function isDatabaseWrite(node: N8nWorkflow["nodes"][number]): boolean {
  const operation = typeof node.parameters.operation === "string" ? node.parameters.operation : "";
  const queryText = stringsIn(node.parameters).join("\n");
  return isDatabaseNode(node)
    && (WRITE_OPERATION_PATTERN.test(operation) || /\b(?:insert|update|delete|replace|create|drop|alter)\b/i.test(queryText));
}

function isWebhookNode(node: N8nWorkflow["nodes"][number]): boolean {
  return /(?:^|\.)webhook$/i.test(node.type);
}

function isHttpNode(node: N8nWorkflow["nodes"][number]): boolean {
  return /(?:^|\.)httpRequest$/i.test(node.type);
}

function isCommunityNode(node: N8nWorkflow["nodes"][number], policy: N8nAuditPolicy): boolean {
  return !policy.allowedOfficialNodePrefixes.some((prefix) => node.type.startsWith(prefix));
}

function sanitizeEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function endpointAllowed(raw: string, method: string, policy: N8nAuditPolicy): boolean {
  try {
    const url = new URL(raw);
    return policy.allowedHttpTargets.some((target) => {
      const allowed = new URL(target.origin);
      return allowed.origin === url.origin
        && target.methods.includes(method as "GET" | "POST")
        && target.pathPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    });
  } catch {
    return false;
  }
}

function endpointContainsPlaintextSecret(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return true;
    for (const [key, value] of url.searchParams.entries()) {
      if (SENSITIVE_KEY_PATTERN.test(key) && literalSecret(value)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function addFinding(
  findings: AuditFinding[],
  severity: AuditFinding["severity"],
  code: string,
  detail: string,
  nodeName: string | null = null,
): void {
  findings.push({ severity, code, nodeName, detail });
}

export function auditN8nWorkflow(input: {
  workflow: unknown;
  policy?: unknown;
}): N8nAuditReport {
  const policyResult = N8nAuditPolicySchema.safeParse(input.policy ?? DEFAULT_POLICY);
  if (!policyResult.success) {
    return blockedParseReport("N8N_AUDIT_POLICY_INVALID", "Audit policy failed strict validation.");
  }
  const policy = policyResult.data;
  let decoded: unknown = input.workflow;
  if (typeof input.workflow === "string") {
    if (Buffer.byteLength(input.workflow, "utf8") > policy.maximumBytes) {
      return blockedParseReport("N8N_WORKFLOW_TOO_LARGE", "Workflow JSON exceeds the configured audit size limit.");
    }
    try {
      decoded = JSON.parse(input.workflow);
    } catch {
      return blockedParseReport("N8N_WORKFLOW_JSON_INVALID", "Workflow is not valid JSON.");
    }
  } else if (Buffer.byteLength(JSON.stringify(input.workflow), "utf8") > policy.maximumBytes) {
    return blockedParseReport("N8N_WORKFLOW_TOO_LARGE", "Workflow object exceeds the configured audit size limit.");
  }
  const workflowResult = N8nWorkflowSchema.safeParse(decoded);
  if (!workflowResult.success) {
    return blockedParseReport("N8N_WORKFLOW_SCHEMA_INVALID", "Workflow failed strict schema validation.");
  }

  const workflow = workflowResult.data;
  const workflowHash = createHash("sha256")
    .update(JSON.stringify(stableValue(workflow)))
    .digest("hex");
  const findings: AuditFinding[] = [];
  const inventory = emptyInventory();
  if (workflow.active === true) {
    addFinding(findings, "BLOCKER", "N8N_ACTIVE_WORKFLOW_IMPORT", "Imported workflows must be inactive.");
  }

  for (const node of workflow.nodes) {
    for (const [credentialType, reference] of Object.entries(node.credentials ?? {})) {
      inventory.credentialReferences.push({
        nodeName: node.name,
        credentialType,
        credentialId: reference.id ?? null,
        credentialName: reference.name ?? null,
      });
    }

    const plaintextPaths: string[] = [];
    scanPlaintextCredentials(node.parameters, `nodes.${node.name}.parameters`, plaintextPaths);
    for (const path of plaintextPaths) {
      inventory.plaintextCredentialPaths.push(path);
      addFinding(
        findings,
        "BLOCKER",
        "N8N_PLAINTEXT_CREDENTIAL",
        `Plaintext credential-like value found at ${path}; the value was not retained in the report.`,
        node.name,
      );
    }

    if (isCommunityNode(node, policy)) {
      inventory.communityNodes.push(node.name);
      addFinding(
        findings,
        "BLOCKER",
        "N8N_COMMUNITY_NODE",
        `Node type ${node.type} is not in the approved official-prefix allowlist.`,
        node.name,
      );
    }
    if (isCodeNode(node)) {
      inventory.codeNodes.push(node.name);
      addFinding(findings, "BLOCKER", "N8N_CODE_NODE", "Arbitrary code or command nodes are not allowed.", node.name);
    }
    if (isSendNode(node)) {
      inventory.sendNodes.push(node.name);
      addFinding(findings, "BLOCKER", "N8N_SEND_NODE", "Send/publish nodes cannot be imported for production.", node.name);
    }
    if (isDatabaseNode(node)) {
      inventory.databaseNodes.push(node.name);
      const sqlite = /sqlite/i.test(`${node.type}\n${node.name}\n${stringsIn(node.parameters).join("\n")}`);
      addFinding(
        findings,
        "BLOCKER",
        sqlite ? "N8N_DIRECT_SQLITE_ACCESS" : "N8N_DIRECT_DATABASE_ACCESS",
        "n8n must use the restricted internal API and cannot access an authoritative database directly.",
        node.name,
      );
      if (isDatabaseWrite(node)) inventory.dataWriteDestinations.push(`DATABASE:${node.name}`);
    }
    if (isWebhookNode(node)) {
      inventory.webhooks.push(node.name);
      const authentication = String(node.parameters.authentication ?? "none").toLocaleLowerCase("en-US");
      if (["none", "", "undefined"].includes(authentication)) {
        addFinding(findings, "BLOCKER", "N8N_UNAUTHENTICATED_WEBHOOK", "Webhook authentication is missing.", node.name);
      } else {
        addFinding(findings, "INFO", "N8N_WEBHOOK_PRESENT", "Webhook requires a separate replay and rate-limit review.", node.name);
      }
    }
    if (isHttpNode(node)) {
      const rawUrl = typeof node.parameters.url === "string" ? node.parameters.url.trim() : "";
      const method = String(node.parameters.method ?? "GET").toLocaleUpperCase("en-US");
      const sanitized = sanitizeEndpoint(rawUrl);
      inventory.httpEndpoints.push(sanitized ?? "DYNAMIC_OR_INVALID_ENDPOINT");
      if (!sanitized || !endpointAllowed(rawUrl, method, policy)) {
        addFinding(
          findings,
          "BLOCKER",
          "N8N_UNKNOWN_HTTP_ENDPOINT",
          "HTTP endpoint or method is dynamic, invalid, or absent from the explicit allowlist.",
          node.name,
        );
      }
      if (endpointContainsPlaintextSecret(rawUrl)) {
        const path = `nodes.${node.name}.parameters.url`;
        inventory.plaintextCredentialPaths.push(path);
        addFinding(
          findings,
          "BLOCKER",
          "N8N_PLAINTEXT_CREDENTIAL",
          `Credential-like URL material found at ${path}; query and user-info values were not retained.`,
          node.name,
        );
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        inventory.dataWriteDestinations.push(`HTTP:${sanitized ?? "DYNAMIC_OR_INVALID_ENDPOINT"}`);
      }
      if (sanitized && /\/(?:send|dispatch|approve|activate|publish)(?:\/|$)/i.test(new URL(rawUrl).pathname)) {
        addFinding(
          findings,
          "BLOCKER",
          "N8N_APPROVAL_BYPASS_ENDPOINT",
          "Endpoint path could bypass local approval or sending controls.",
          node.name,
        );
      }
    }

    const idempotencyMarkerFound = containsKey(
      node.parameters,
      /^(?:idempotency[-_]?key|provider[-_]?event[-_]?id|dedupe[-_]?key)$/i,
    );
    if (node.retryOnFail || node.maxTries || node.waitBetweenTries) {
      const maxTries = node.maxTries ?? (node.retryOnFail ? 3 : 1);
      inventory.retryConfiguration.push({
        nodeName: node.name,
        retryOnFail: node.retryOnFail ?? false,
        maxTries,
        waitBetweenTries: node.waitBetweenTries ?? 0,
        idempotencyMarkerFound,
      });
      if (maxTries > 1 && (isSendNode(node) || isDatabaseWrite(node) || isHttpNode(node)) && !idempotencyMarkerFound) {
        inventory.duplicateRiskNodes.push(node.name);
        addFinding(
          findings,
          "BLOCKER",
          "N8N_RETRY_WITHOUT_IDEMPOTENCY",
          "Retried side effects require an explicit idempotency key.",
          node.name,
        );
      }
    }
  }

  inventory.httpEndpoints = unique(inventory.httpEndpoints);
  inventory.webhooks = unique(inventory.webhooks);
  inventory.sendNodes = unique(inventory.sendNodes);
  inventory.codeNodes = unique(inventory.codeNodes);
  inventory.communityNodes = unique(inventory.communityNodes);
  inventory.databaseNodes = unique(inventory.databaseNodes);
  inventory.dataWriteDestinations = unique(inventory.dataWriteDestinations);
  inventory.plaintextCredentialPaths = unique(inventory.plaintextCredentialPaths);
  inventory.duplicateRiskNodes = unique(inventory.duplicateRiskNodes);
  inventory.credentialReferences.sort((left, right) =>
    `${left.nodeName}:${left.credentialType}`.localeCompare(`${right.nodeName}:${right.credentialType}`));
  inventory.retryConfiguration.sort((left, right) => left.nodeName.localeCompare(right.nodeName));
  findings.sort((left, right) =>
    `${left.severity}:${left.code}:${left.nodeName ?? ""}`.localeCompare(
      `${right.severity}:${right.code}:${right.nodeName ?? ""}`,
    ));
  const blocked = findings.some((finding) => finding.severity === "BLOCKER");
  return N8nAuditReportSchema.parse({
    schemaVersion: N8N_AUDIT_SCHEMA_VERSION,
    status: blocked ? "BLOCKED" : "SHADOW_ONLY_ALLOWED",
    workflowName: workflow.name,
    workflowHash,
    shadowImportAllowed: !blocked,
    productionImportAllowed: false,
    inventory,
    findings,
  });
}

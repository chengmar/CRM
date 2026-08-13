import { getDomain } from "tldts";
import { z } from "zod";

const sourceIndependenceRecordSchema = z.object({
  id: z.string().trim().min(1).max(500),
  sourceUrl: z.string().trim().min(1).max(5_000).nullable().optional(),
  publisherDomain: z.string().trim().max(500).nullable().optional(),
  independenceKey: z.string().trim().max(5_000).nullable().optional(),
  originalDocumentKey: z.string().trim().max(5_000).nullable().optional(),
}).strict();

export type SourceIndependenceRecord = z.infer<typeof sourceIndependenceRecordSchema>;

export interface SourceIndependenceGroup {
  key: string;
  publisherDomains: string[];
  underlyingKeys: string[];
  sourceIds: string[];
}

function registeredDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

export function publisherDomainForSource(source: SourceIndependenceRecord): string {
  const explicit = source.publisherDomain?.trim();
  if (explicit) return registeredDomain(explicit);
  const sourceUrl = source.sourceUrl?.trim();
  if (!sourceUrl) return `unknown:${source.id.toLowerCase()}`;
  try {
    return registeredDomain(new URL(sourceUrl).hostname);
  } catch {
    return registeredDomain(sourceUrl);
  }
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index];
    if (parent === undefined) throw new Error(`invalid disjoint-set index ${index}`);
    if (parent !== index) this.parent[index] = this.find(parent);
    return this.parent[index] ?? index;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

export function collapseIndependentSources(
  recordsInput: readonly SourceIndependenceRecord[],
): SourceIndependenceGroup[] {
  const records = z.array(sourceIndependenceRecordSchema).max(10_000).parse(recordsInput);
  const sets = new DisjointSet(records.length);
  const publisherOwner = new Map<string, number>();
  const underlyingOwner = new Map<string, number>();

  records.forEach((record, index) => {
    const publisher = publisherDomainForSource(record);
    const underlying = (
      record.originalDocumentKey?.trim() ||
      record.independenceKey?.trim() ||
      record.sourceUrl?.trim() ||
      record.id
    ).toLowerCase();
    const samePublisher = publisherOwner.get(publisher);
    const sameUnderlying = underlyingOwner.get(underlying);
    if (samePublisher !== undefined) sets.union(index, samePublisher);
    else publisherOwner.set(publisher, index);
    if (sameUnderlying !== undefined) sets.union(index, sameUnderlying);
    else underlyingOwner.set(underlying, index);
  });

  const components = new Map<number, SourceIndependenceRecord[]>();
  records.forEach((record, index) => {
    const root = sets.find(index);
    const component = components.get(root) ?? [];
    component.push(record);
    components.set(root, component);
  });

  return [...components.values()]
    .map((component): SourceIndependenceGroup => {
      const publisherDomains = [...new Set(component.map(publisherDomainForSource))].sort();
      const underlyingKeys = [...new Set(component.map((record) => (
        record.originalDocumentKey?.trim() ||
        record.independenceKey?.trim() ||
        record.sourceUrl?.trim() ||
        record.id
      ).toLowerCase()))].sort();
      return {
        key: `underlying:${underlyingKeys[0] ?? `publisher:${publisherDomains[0] ?? "unknown"}`}`,
        publisherDomains,
        underlyingKeys,
        sourceIds: component.map((record) => record.id).sort(),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

import { createHash } from "node:crypto";

// Deterministic id keyed on (timestamp, service, message). ISO timestamp keeps
// the hash stable across timezones; service is normalized to "" when absent so
// the same log emitted twice in different parsers still collides.
export function computeEntryId(params: {
  timestamp: Date;
  service?: string;
  message: string;
}): string {
  const ts = params.timestamp.toISOString();
  const svc = params.service ?? "";
  const hash = createHash("sha256");
  hash.update(`${ts}${svc}${params.message}`);
  return hash.digest("hex");
}

// Content-only key: stable regardless of timestamp or service. Used for
// deduplication in KNOWLEDGE.md (same approach as MEMORY.md promotion markers).
export function computeContentKey(content: string): string {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

// Jaccard word-overlap similarity for fuzzy deduplication.
// Counts matching distinct words (length > 1, CJK characters included).
export function jaccardWordSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\w一-鿿]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

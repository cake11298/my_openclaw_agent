import { createHash } from "node:crypto";
import { parseBlocks, serializeSemanticBlock } from "./md-format.js";
import type { LogMemoryStore } from "./store.js";
import type { LogMemoryEntry } from "./types.js";

// Mirrors PluginRuntime["subagent"] without importing core internals.
type SubagentSurface = {
  run: (p: {
    idempotencyKey: string;
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    lane?: string;
    lightContext?: boolean;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (p: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: string; error?: string }>;
  getSessionMessages: (p: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
  deleteSession: (p: { sessionKey: string }) => Promise<void>;
};

const CURATOR_TIMEOUT_MS = 60_000;

// Cheatsheet-style curator: every time a new entry is captured, the curator
// sees the full KNOWLEDGE.md + the new entry + optional conversation context
// and decides the COMPLETE new state of KNOWLEDGE.md (can add, merge, prune,
// update AccessCount). This prevents unbounded growth and keeps the knowledge
// base high-value and non-redundant.
const CURATOR_SYSTEM_PROMPT = `You are a Knowledge Curator for an engineering workspace memory system.
Your role: maintain KNOWLEDGE.md as a compact, evolving "cheatsheet" of high-value engineering insights.

### Core Responsibilities

**Selective Knowledge Retention**
- Preserve only high-value, generalizable patterns/rules/solutions that apply across problems
- Discard redundant, trivial, or highly problem-specific entries that do not generalize
- Total entries must stay under 30 to prevent unbounded growth

**Continuous Refinement**
- Merge entries that address the same topic or constraint (prefer merging over keeping duplicates)
- Remove entries that are outdated, superseded, or no longer relevant
- Improve clarity or generalizability of existing entries where possible
- If a better approach than a previously recorded one is found, replace the old version

**Usage Tracking**
- Increment AccessCount for any existing entry that was relevant to the current conversation turn
- Entries with higher AccessCount are more valuable — preserve them over rarely used ones

**Structure**
- Pinned: true → injected into every LLM call (mandatory rules, naming conventions, critical policies)
- No Pinned line → recalled only when relevant (debug solutions, specific fixes)
- AccessCount starts at 1 for new entries; increment each time an entry proves relevant

### KNOWLEDGE.md Block Format

Each entry must use exactly this format:
\`\`\`
## [2026-05-29T12:00:00.000Z] Short descriptive title
Pattern: [concise rule, insight, or solution — one line]
Root cause: [why this matters — omit this line entirely if not applicable]
Tags: tag1, tag2
Source: conversation_capture
Pinned: true
AccessCount: N
\`\`\`

IMPORTANT: Do NOT include a ContentKey line — it is computed automatically on write.
Use realistic ISO timestamps. For new entries use the current session timestamp.
For existing entries preserve their original timestamps.

### Output Format

Respond with the COMPLETE new KNOWLEDGE.md after your curation:

FULL_REWRITE:
[all entries you decide to keep, merged, pruned, or updated]

If absolutely nothing needs to change (new entry already well-represented, no pruning needed):
NO_CHANGE`;

function buildPrompt(
  existing: LogMemoryEntry[],
  newEntry: LogMemoryEntry,
  conversationContext?: { userMessage: string; assistantResponse: string },
): string {
  const lines: string[] = ["## EXISTING KNOWLEDGE.md"];

  if (existing.length === 0) {
    lines.push("(empty — no prior entries)");
  } else {
    for (let i = 0; i < existing.length; i++) {
      const e = existing[i];
      const accessStr = e.payload.accessCount > 0 ? ` [AccessCount:${e.payload.accessCount}]` : "";
      const pinnedStr = e.payload.pinned ? " [Pinned]" : "";
      lines.push(
        `[${i}]${pinnedStr}${accessStr} ${e.payload.content.replace(/\n/g, " ").slice(0, 300)}`,
      );
    }
  }

  lines.push("", "## NEWLY CAPTURED ENTRY");
  const kind = newEntry.payload.tags.find((t) => t.startsWith("kind:")) ?? "";
  const pinnedStr = newEntry.payload.pinned ? " [Pinned]" : "";
  lines.push(`${kind}${pinnedStr}: ${newEntry.payload.content.replace(/\n/g, " ").slice(0, 400)}`);

  if (conversationContext) {
    lines.push("", "## CONVERSATION CONTEXT");
    lines.push(`User: ${conversationContext.userMessage.slice(0, 500)}`);
    lines.push(`Assistant: ${conversationContext.assistantResponse.slice(0, 800)}`);
  }

  lines.push(
    "",
    "Curate KNOWLEDGE.md. Preserve all high-value entries.",
    "Merge entries that address the same topic. Prune redundancy.",
    "Increment AccessCount for entries relevant to this turn.",
    "Keep total entries ≤ 30.",
  );
  return lines.join("\n");
}

function buildSessionKey(workspaceDir: string): string {
  const hash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
  return `knowledge-curator-${hash}-${Date.now()}`;
}

function extractAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const r = msg as Record<string, unknown>;
    if (r.role !== "assistant") continue;
    const content = r.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (p): p is { type: "text"; text: string } =>
            !!p &&
            typeof p === "object" &&
            (p as Record<string, unknown>).type === "text" &&
            typeof (p as Record<string, unknown>).text === "string",
        )
        .map((p) => p.text)
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function parseResponse(response: string): LogMemoryEntry[] | null {
  const trimmed = response.trim();
  if (trimmed.startsWith("NO_CHANGE")) return null;
  const m = trimmed.match(/^FULL_REWRITE:\s*\n([\s\S]+)/i);
  if (!m?.[1]?.trim()) return null;
  const entries = parseBlocks(m[1].trim(), { layer: "semantic" });
  return entries.length > 0 ? entries : null;
}

// Soft lock: at most one curator running per workspace at a time.
const curating = new Set<string>();

export async function curateKnowledgeMd(params: {
  subagent: SubagentSurface;
  store: LogMemoryStore;
  workspaceDir: string;
  newEntry: LogMemoryEntry;
  // Optional: full turn context helps the curator decide AccessCount increments.
  conversationContext?: { userMessage: string; assistantResponse: string };
  logger: { warn: (msg: string) => void };
}): Promise<void> {
  const { subagent, store, workspaceDir, newEntry, conversationContext, logger } = params;

  if (curating.has(workspaceDir)) return;
  curating.add(workspaceDir);

  const sessionKey = buildSessionKey(workspaceDir);
  try {
    const allEntries = await store.loadSemantic();
    // Show existing entries excluding the one just written (it appears separately).
    const existing = allEntries.filter((e) => e.id !== newEntry.id);

    const { runId } = await subagent.run({
      idempotencyKey: sessionKey,
      sessionKey,
      message: buildPrompt(existing, newEntry, conversationContext),
      extraSystemPrompt: CURATOR_SYSTEM_PROMPT,
      lane: `knowledge-curator:${sessionKey}`,
      lightContext: true,
      deliver: false,
    });

    const result = await subagent.waitForRun({ runId, timeoutMs: CURATOR_TIMEOUT_MS });
    if (result.status !== "ok") {
      logger.warn(`log-memory: curator ended with status=${result.status}`);
      return;
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const response = extractAssistantText(messages);
    if (!response) {
      logger.warn("log-memory: curator produced no text");
      return;
    }

    const newEntries = parseResponse(response);
    if (newEntries === null) return; // NO_CHANGE

    await store.overwriteSemantic(newEntries);
    logger.warn(
      `log-memory: curator compacted KNOWLEDGE.md → ${newEntries.length} entries [workspace=${workspaceDir}]`,
    );
  } catch (err) {
    logger.warn(`log-memory: curator failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    curating.delete(workspaceDir);
    subagent.deleteSession({ sessionKey }).catch(() => {});
  }
}

// Re-export serializeSemanticBlock so callers that previously imported it from
// here (before the refactor) don't need to update their import path.
export { serializeSemanticBlock };

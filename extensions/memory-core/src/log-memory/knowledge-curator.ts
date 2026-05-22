import { createHash } from "node:crypto";
import { computeEntryId } from "./dedupe.js";
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

const CURATOR_TIMEOUT_MS = 45_000;

const CURATOR_SYSTEM_PROMPT = `You are a conservative knowledge curator for an engineering workspace memory system.
Your job: identify semantic overlaps between rules — including non-obvious, implicit overlaps.
When in doubt, do NOT merge. Preserving all information is always safer than losing it.`;

function buildSessionKey(workspaceDir: string): string {
  const hash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
  return `knowledge-curator-${hash}-${Date.now()}`;
}

function buildPrompt(existing: LogMemoryEntry[], newEntry: LogMemoryEntry): string {
  const lines: string[] = [
    "Check if the NEW ENTRY semantically overlaps with any EXISTING ENTRY.",
    "Overlaps include non-obvious or implicit domain-based similarities.",
    'Example: "linked list nodes use typedef" and "all pointers end with _lobster" might',
    "both be C data-structure conventions — that counts as overlap.",
    "",
    "EXISTING ENTRIES:",
  ];
  for (let i = 0; i < existing.length; i++) {
    lines.push(`[${i}] ${existing[i].payload.content.replace(/\n/g, " ").slice(0, 400)}`);
  }
  lines.push(
    "",
    `NEW ENTRY [${existing.length}]:`,
    newEntry.payload.content.replace(/\n/g, " ").slice(0, 400),
    "",
    "Rules:",
    "- Only merge when the overlap is clear. If uncertain, output NO_MERGE.",
    "- A merged entry must preserve ALL information from every entry being merged.",
    "- You may only merge the NEW ENTRY with at most one or two existing entries.",
    "",
    "If there IS meaningful overlap, respond with exactly one line:",
    "MERGE [comma-separated indices including the new entry's index] NEW_CONTENT: {merged rule text}",
    "",
    "If there is NO overlap, respond with exactly:",
    "NO_MERGE",
  );
  return lines.join("\n");
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

interface MergeInstruction {
  indices: number[];
  newContent: string;
}

function parseResponse(response: string, totalCount: number): MergeInstruction | null {
  const trimmed = response.trim();
  if (trimmed.startsWith("NO_MERGE")) return null;

  const m = trimmed.match(/^MERGE\s*\[([^\]]+)\]\s*NEW_CONTENT:\s*([\s\S]+)/i);
  if (!m) return null;

  const indices = m[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n >= 0 && n < totalCount);
  const newContent = m[2].trim();

  // Require at least the new entry + one existing entry, and a non-empty result.
  if (indices.length < 2 || !newContent) return null;
  return { indices, newContent };
}

// Soft lock: at most one curator running per workspace at a time.
const curating = new Set<string>();

export async function curateKnowledgeMd(params: {
  subagent: SubagentSurface;
  store: LogMemoryStore;
  workspaceDir: string;
  newEntry: LogMemoryEntry;
  logger: { warn: (msg: string) => void };
}): Promise<void> {
  const { subagent, store, workspaceDir, newEntry, logger } = params;

  if (curating.has(workspaceDir)) return;
  curating.add(workspaceDir);

  const sessionKey = buildSessionKey(workspaceDir);
  try {
    const allEntries = await store.loadSemantic();
    const existing = allEntries.filter((e) => e.id !== newEntry.id);
    if (existing.length === 0) return;

    const { runId } = await subagent.run({
      idempotencyKey: sessionKey,
      sessionKey,
      message: buildPrompt(existing, newEntry),
      extraSystemPrompt: CURATOR_SYSTEM_PROMPT,
      lane: `knowledge-curator:${sessionKey}`,
      lightContext: true,
      deliver: false,
    });

    const result = await subagent.waitForRun({ runId, timeoutMs: CURATOR_TIMEOUT_MS });
    if (result.status !== "ok") {
      logger.warn(`log-memory: curator run ended with status=${result.status}`);
      return;
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const response = extractAssistantText(messages);
    if (!response) {
      logger.warn("log-memory: curator produced no text");
      return;
    }

    // totalCount = existing entries + 1 new entry, matching prompt indices.
    const instruction = parseResponse(response, existing.length + 1);
    if (!instruction) return;

    // Build the merged entry from the collected content.
    const all = [...existing, newEntry];
    const mergeSet = new Set(instruction.indices);
    const kept = all.filter((_, i) => !mergeSet.has(i));
    const mergedTags = [...new Set(instruction.indices.flatMap((i) => all[i]?.payload.tags ?? []))];
    const merged: LogMemoryEntry = {
      ...newEntry,
      id: computeEntryId({
        timestamp: newEntry.timestamp,
        service: "curator",
        message: instruction.newContent,
      }),
      payload: {
        ...newEntry.payload,
        content: instruction.newContent,
        tags: mergedTags,
      },
    };

    await store.overwriteSemantic([...kept, merged]);
    logger.warn(
      `log-memory: curator merged ${instruction.indices.length} entries → 1 [workspace=${workspaceDir}]`,
    );
  } catch (err) {
    logger.warn(`log-memory: curator failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    curating.delete(workspaceDir);
    subagent.deleteSession({ sessionKey }).catch(() => {});
  }
}

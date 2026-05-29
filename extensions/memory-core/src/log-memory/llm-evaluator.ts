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

interface ConvTurn {
  user: string;
  assistant: string;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as Record<string, unknown>).type === "text" &&
          typeof (p as Record<string, unknown>).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

// Extract user/assistant turn pairs from session messages, excluding any turn
// whose user message matches the current turn (to avoid re-including it).
export function extractPriorTurns(
  messages: unknown[],
  currentUserMsg: string,
  limit = 3,
): ConvTurn[] {
  const turns: ConvTurn[] = [];
  let pendingUser: string | null = null;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const r = msg as Record<string, unknown>;
    const content = extractTextContent(r.content).trim();
    if (r.role === "user") {
      pendingUser = content;
    } else if (r.role === "assistant" && pendingUser !== null) {
      turns.push({ user: pendingUser, assistant: content });
      pendingUser = null;
    }
  }

  // Exclude turns whose user message is the current turn (prefix match).
  const currentPrefix = currentUserMsg.slice(0, 200);
  const filtered = turns.filter((t) => t.user.slice(0, 200) !== currentPrefix);
  return filtered.slice(-limit);
}

// Session key prefixes used by internal evaluator/curator sessions.
// Any llm_output event whose sessionKey contains one of these is an internal
// call and must be skipped to prevent infinite recursion.
export const INTERNAL_SESSION_KEY_PREFIXES = ["knowledge-evaluator-", "knowledge-curator-"];

export function isInternalEvaluatorSession(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  return INTERNAL_SESSION_KEY_PREFIXES.some((p) => sessionKey.includes(p));
}

const EVALUATOR_TIMEOUT_MS = 30_000;

const EVALUATOR_SYSTEM_PROMPT = `You are a concise knowledge extractor for an engineering memory system.
Evaluate the conversation turn and output exactly two lines — nothing else.`;

const PRIOR_TURN_SNIPPET = 300;

function buildEvalPrompt(
  userMessage: string,
  assistantResponse: string,
  priorTurns: ConvTurn[] = [],
): string {
  const userSnippet = userMessage.slice(0, 800);
  const assistantSnippet = assistantResponse.slice(0, 800);

  const lines: string[] = [
    "Review this conversation between a user and an AI assistant.",
    priorTurns.length > 0
      ? "Prior turns are shown for context; evaluate only the FINAL turn."
      : "Evaluate the conversation turn below.",
    "",
  ];

  if (priorTurns.length > 0) {
    lines.push("[PRIOR CONTEXT]");
    for (const turn of priorTurns) {
      lines.push(`USER: ${turn.user.slice(0, PRIOR_TURN_SNIPPET)}`);
      lines.push(`ASSISTANT: ${turn.assistant.slice(0, PRIOR_TURN_SNIPPET)}`);
      lines.push("");
    }
  }

  lines.push(
    "[CURRENT TURN]",
    `USER: ${userSnippet}`,
    "",
    `ASSISTANT: ${assistantSnippet}`,
    "",
    "Answer BOTH questions — one per line, in this exact format:",
    "LEARNED: <one sentence describing a reusable pattern/technique/rule discovered, or NOTHING>",
    "SOLVED: <one sentence describing what specific problem was resolved, or NOTHING>",
    "",
    "Rules:",
    "- Only write something concrete and reusable, not generic observations.",
    "- NOTHING means truly nothing worth remembering.",
    "- Do NOT include preamble or explanation.",
  );

  return lines.join("\n");
}

function buildSessionKey(runId: string): string {
  const hash = createHash("sha1").update(runId).digest("hex").slice(0, 12);
  return `knowledge-evaluator-${hash}`;
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

interface EvalResult {
  learned: string | null;
  solved: string | null;
}

function parseEvalResponse(response: string): EvalResult {
  const learned = response.match(/^LEARNED:\s*(.+)/im)?.[1]?.trim() ?? null;
  const solved = response.match(/^SOLVED:\s*(.+)/im)?.[1]?.trim() ?? null;
  return {
    learned: learned === "NOTHING" || !learned ? null : learned,
    solved: solved === "NOTHING" || !solved ? null : solved,
  };
}

function buildEntry(
  content: string,
  type: "debug_solution" | "learned_pattern",
  runId: string,
  now: Date,
): LogMemoryEntry {
  const pinned = type === "learned_pattern";
  return {
    id: computeEntryId({ timestamp: now, service: "llm-evaluator", message: content }),
    timestamp: now,
    layer: "semantic",
    payload: {
      type: "conversation_rule",
      content,
      tags: [`source:llm_evaluator`, `kind:${type}`],
      source: "llm_evaluator",
      decayScore: pinned ? 0.95 : 0.5,
      pinned,
      accessCount: 1,
      lastAccessedAt: now,
      title: undefined,
    },
  };
}

// Soft lock: at most one evaluator running per runId at a time.
const evaluating = new Set<string>();

export async function evaluateAndCapture(params: {
  subagent: SubagentSurface;
  store: LogMemoryStore;
  workspaceDir: string;
  runId: string;
  userMessage: string;
  assistantResponse: string;
  mainSessionKey?: string;
  logger: { warn: (msg: string) => void };
}): Promise<void> {
  const {
    subagent,
    store,
    workspaceDir,
    runId,
    userMessage,
    assistantResponse,
    mainSessionKey,
    logger,
  } = params;

  if (evaluating.has(runId)) return;
  evaluating.add(runId);

  // Fetch prior turns from the main session for multi-turn context.
  let priorTurns: ConvTurn[] = [];
  if (mainSessionKey) {
    try {
      const { messages } = await subagent.getSessionMessages({
        sessionKey: mainSessionKey,
        limit: 10,
      });
      priorTurns = extractPriorTurns(messages, userMessage);
    } catch {
      // best-effort; proceed without prior context
    }
  }

  const sessionKey = buildSessionKey(runId);
  try {
    const { runId: evalRunId } = await subagent.run({
      idempotencyKey: sessionKey,
      sessionKey,
      message: buildEvalPrompt(userMessage, assistantResponse, priorTurns),
      extraSystemPrompt: EVALUATOR_SYSTEM_PROMPT,
      lane: `knowledge-evaluator:${sessionKey}`,
      lightContext: true,
      deliver: false,
    });

    const result = await subagent.waitForRun({ runId: evalRunId, timeoutMs: EVALUATOR_TIMEOUT_MS });
    if (result.status !== "ok") {
      logger.warn(`log-memory: evaluator run ended with status=${result.status}`);
      return;
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const response = extractAssistantText(messages);
    if (!response) {
      logger.warn("log-memory: evaluator produced no text");
      return;
    }

    const { learned, solved } = parseEvalResponse(response);
    const now = new Date();
    const entries: LogMemoryEntry[] = [];

    if (learned) {
      entries.push(buildEntry(learned, "learned_pattern", runId, now));
    }
    if (solved) {
      entries.push(buildEntry(solved, "debug_solution", runId, now));
    }

    for (const entry of entries) {
      const writeResult = await store.appendSemantic(entry);
      if (writeResult === "written") {
        logger.warn(
          `log-memory: evaluator captured [${entry.payload.tags.find((t) => t.startsWith("kind:"))}] — ${entry.payload.content.slice(0, 80)}`,
        );
        // Fire-and-forget: cheatsheet curator compacts KNOWLEDGE.md after each
        // new entry — merges duplicates, prunes stale entries, updates AccessCount.
        import("./knowledge-curator.js")
          .then(({ curateKnowledgeMd }) =>
            curateKnowledgeMd({
              subagent,
              store,
              workspaceDir,
              newEntry: entry,
              conversationContext: { userMessage, assistantResponse },
              logger,
            }),
          )
          .catch((err: unknown) => {
            logger.warn(
              `log-memory: curator error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }
  } catch (err) {
    logger.warn(
      `log-memory: evaluator failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    evaluating.delete(runId);
    subagent.deleteSession({ sessionKey }).catch(() => {});
  }
}

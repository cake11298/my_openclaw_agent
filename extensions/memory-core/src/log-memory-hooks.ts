import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isInternalEvaluatorSession } from "./log-memory/llm-evaluator.js";
import { SessionTracer } from "./log-memory/session-tracer.js";
import type { EmbedFn } from "./log-memory/types.js";

const INJECTION_REPORT_FILENAME = ".injection-report.json";
const CONVERSATION_PROMPT_FILENAME = "conversation_prompt.md";

// PluginHookMessageContext does not carry workspaceDir, so fall back to the
// default OpenClaw workspace path (~/.openclaw/workspace).
function resolveWorkspaceDir(ctxWorkspaceDir: string | undefined): string {
  return ctxWorkspaceDir ?? path.join(os.homedir(), ".openclaw", "workspace");
}

// No-op embedder: returns zero-length vectors so capture (which never calls
// embed) works without a real model. buildPinnedContext also works because it
// filters by payload.pinned rather than by score. Keyword matching still
// functions correctly; only cosine similarity is lost.
const noopEmbed: EmbedFn = async (texts) => texts.map(() => new Float32Array(0));

// Per-workspace instance cache so hooks share one store across calls.
interface LogMemoryComponents {
  capture: import("./log-memory/knowledge-capture.js").KnowledgeCapture;
  injector: import("./log-memory/context-injector.js").ContextInjector;
  store: import("./log-memory/store.js").LogMemoryStore;
}
const componentCache = new Map<string, LogMemoryComponents>();

async function getComponents(workspaceDir: string): Promise<LogMemoryComponents> {
  const cached = componentCache.get(workspaceDir);
  if (cached) return cached;

  const [{ LogMemoryStore }, { KnowledgeCapture }, { LogIngestor }, { ContextInjector }] =
    await Promise.all([
      import("./log-memory/store.js"),
      import("./log-memory/knowledge-capture.js"),
      import("./log-memory/ingestor.js"),
      import("./log-memory/context-injector.js"),
    ]);

  const store = new LogMemoryStore({ workspaceDir });
  const capture = new KnowledgeCapture({ workspaceDir, store, embed: noopEmbed });
  const ingestor = new LogIngestor({ store, embed: noopEmbed });
  const injector = new ContextInjector(ingestor);

  const components: LogMemoryComponents = { capture, injector, store };
  componentCache.set(workspaceDir, components);
  return components;
}

// Per-workspace SessionTracer instance cache.
const tracerCache = new Map<string, SessionTracer>();
function getTracer(workspaceDir: string): SessionTracer {
  let tracer = tracerCache.get(workspaceDir);
  if (!tracer) {
    tracer = new SessionTracer(workspaceDir);
    tracerCache.set(workspaceDir, tracer);
  }
  return tracer;
}

export function registerLogMemoryHooks(api: OpenClawPluginApi): void {
  // Capture: scan every incoming user message for rules/conventions and write
  // them to KNOWLEDGE.md immediately, pinned so they never decay.
  api.on("message_received", async (event, ctx) => {
    const workspaceDir = resolveWorkspaceDir(
      (ctx as Record<string, unknown>).workspaceDir as string | undefined,
    );
    if (!event.content?.trim()) return;
    try {
      const { capture, store } = await getComponents(workspaceDir);
      const captured = await capture.maybeCapture({ message: event.content });
      if (captured && !captured.alreadyExisted) {
        const subagent = api.runtime?.subagent;
        if (subagent) {
          import("./log-memory/knowledge-curator.js")
            .then(({ curateKnowledgeMd }) =>
              curateKnowledgeMd({
                subagent,
                store,
                workspaceDir,
                newEntry: captured.entry,
                logger: api.logger,
              }),
            )
            .catch((err: unknown) => {
              api.logger.warn(
                `log-memory: background curation error: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
      }
    } catch (err) {
      api.logger.warn(
        `log-memory: capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Inject: prepend all pinned rules to the system prompt before each LLM call
  // so the model always sees active conventions regardless of query relevance.
  api.on("before_prompt_build", async (event, ctx) => {
    const workspaceDir = resolveWorkspaceDir(
      (ctx as Record<string, unknown>).workspaceDir as string | undefined,
    );
    try {
      const { injector } = await getComponents(workspaceDir);
      const pinnedCtx = await injector.buildPinnedContext();
      if (!pinnedCtx) return undefined;

      const logMemoryDir = path.join(workspaceDir, "log-memory");
      const conversationPromptPath = path.join(logMemoryDir, CONVERSATION_PROMPT_FILENAME);

      const prevMsgCount = Array.isArray((event as { messages?: unknown[] }).messages)
        ? ((event as { messages: unknown[] }).messages.length ?? 0)
        : 0;

      // Dump injected prompt for engineering inspection.
      const promptDump = [
        `# Injected Prompt Snapshot`,
        ``,
        `Generated: ${new Date().toISOString()}`,
        `Workspace: ${workspaceDir}`,
        `Chars: ${pinnedCtx.length}`,
        ...(prevMsgCount > 0
          ? [`Previous chat: ${prevMsgCount} message${prevMsgCount === 1 ? "" : "s"} injected`]
          : []),
        ``,
        `## KNOWLEDGE.md`,
        ``,
        pinnedCtx,
      ].join("\n");
      await fs.writeFile(conversationPromptPath, promptDump, "utf8").catch(() => {});

      // Write sidecar so system-prompt-report can show injection in Usage Tab.
      const sidecarPath = path.join(logMemoryDir, INJECTION_REPORT_FILENAME);
      await fs
        .writeFile(
          sidecarPath,
          JSON.stringify({
            ts: Date.now(),
            conversationPromptPath,
            sources: [{ name: "KNOWLEDGE.md", chars: pinnedCtx.length }],
          }),
          "utf8",
        )
        .catch(() => {});

      return { prependSystemContext: pinnedCtx };
    } catch (err) {
      api.logger.warn(
        `log-memory: context injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  });

  // Injection tracker: record every LLM call's full input size per session.
  // Skips internal evaluator/curator sessions to avoid noise.
  api.on("llm_input", (event, ctx) => {
    if (isInternalEvaluatorSession(ctx.sessionKey)) return;
    const workspaceDir = resolveWorkspaceDir(
      (ctx as Record<string, unknown>).workspaceDir as string | undefined,
    );
    const tracer = getTracer(workspaceDir);
    tracer
      .append({
        sessionId: event.sessionId,
        sessionKey: ctx.sessionKey,
        runId: event.runId,
        provider: event.provider,
        model: event.model,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
        imagesCount: event.imagesCount,
      })
      .catch((err: unknown) => {
        api.logger.warn(
          `log-memory: trace append failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  // LLM-based passive learning: after every model output, evaluate whether
  // the turn solved a problem or revealed a reusable pattern and write it to
  // KNOWLEDGE.md if so. Fire-and-forget so it never delays the reply.
  api.on("llm_output", (event, ctx) => {
    // Skip internal evaluator/curator subagent sessions to prevent recursion.
    if (isInternalEvaluatorSession(ctx.sessionKey)) return;
    const subagent = api.runtime?.subagent;
    if (!subagent) return;
    const userMessage = event.prompt?.trim();
    const assistantResponse = event.assistantTexts?.join("\n").trim();
    if (!userMessage || !assistantResponse) return;
    const runId = event.runId;
    const workspaceDir = resolveWorkspaceDir(
      (ctx as Record<string, unknown>).workspaceDir as string | undefined,
    );
    getComponents(workspaceDir)
      .then(({ store }) =>
        import("./log-memory/llm-evaluator.js").then(({ evaluateAndCapture }) =>
          evaluateAndCapture({
            subagent,
            store,
            workspaceDir,
            runId,
            userMessage,
            assistantResponse,
            mainSessionKey: ctx.sessionKey,
            logger: api.logger,
          }),
        ),
      )
      .catch((err: unknown) => {
        api.logger.warn(
          `log-memory: llm-evaluator error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  // HTTP route: GET /api/log-memory/context
  api.registerHttpRoute({
    path: "/api/log-memory/context",
    auth: "plugin",
    match: "exact",
    handler: async (_req, res) => {
      const workspaceDir = resolveWorkspaceDir(undefined);
      const filePath = path.join(workspaceDir, "log-memory", CONVERSATION_PROMPT_FILENAME);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const content = await fs.readFile(filePath, "utf8");
        res.end(JSON.stringify({ ok: true, content }));
      } catch {
        res.end(JSON.stringify({ ok: false, content: null }));
      }
    },
  });

  // HTTP route: GET /api/log-memory/trace[?limit=N]
  // Returns the last N LLM input trace records so the chat UI can show
  // per-turn injection totals across the current session.
  api.registerHttpRoute({
    path: "/api/log-memory/trace",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      const workspaceDir = resolveWorkspaceDir(undefined);
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
      const tracer = getTracer(workspaceDir);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      try {
        const turns = await tracer.load(limit);
        res.end(JSON.stringify({ ok: true, turns }));
      } catch (err) {
        res.end(JSON.stringify({ ok: false, turns: [], error: String(err) }));
      }
    },
  });
}

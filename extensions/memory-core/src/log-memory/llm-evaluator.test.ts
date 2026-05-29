import { describe, expect, it, vi } from "vitest";
import {
  isInternalEvaluatorSession,
  evaluateAndCapture,
  extractPriorTurns,
} from "./llm-evaluator.js";
import type { LogMemoryStore } from "./store.js";

// ── extractPriorTurns ───────────────────────────────────────────────────────

describe("extractPriorTurns", () => {
  const msgs = [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second answer" },
    { role: "user", content: "Current question" },
    { role: "assistant", content: "Current answer" },
  ];

  it("excludes the current turn", () => {
    const turns = extractPriorTurns(msgs, "Current question");
    expect(turns).toHaveLength(2);
    expect(turns[0].user).toBe("First question");
    expect(turns[1].user).toBe("Second question");
  });

  it("limits to the last N prior turns", () => {
    const turns = extractPriorTurns(msgs, "Current question", 1);
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBe("Second question");
  });

  it("returns empty when no prior turns exist", () => {
    const single = [
      { role: "user", content: "Only question" },
      { role: "assistant", content: "Only answer" },
    ];
    expect(extractPriorTurns(single, "Only question")).toHaveLength(0);
  });

  it("handles array content blocks", () => {
    const withBlocks = [
      { role: "user", content: [{ type: "text", text: "Block user" }] },
      { role: "assistant", content: [{ type: "text", text: "Block assistant" }] },
    ];
    const turns = extractPriorTurns(withBlocks, "other");
    expect(turns[0].user).toBe("Block user");
    expect(turns[0].assistant).toBe("Block assistant");
  });
});

// ── isInternalEvaluatorSession ──────────────────────────────────────────────

describe("isInternalEvaluatorSession", () => {
  it("returns true for knowledge-evaluator sessions", () => {
    expect(isInternalEvaluatorSession("knowledge-evaluator-abc123-session")).toBe(true);
  });

  it("returns true for knowledge-curator sessions", () => {
    expect(isInternalEvaluatorSession("knowledge-curator-abc123-session")).toBe(true);
  });

  it("returns false for normal user sessions", () => {
    expect(isInternalEvaluatorSession("agent:main:main")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isInternalEvaluatorSession(undefined)).toBe(false);
  });
});

// ── evaluateAndCapture ──────────────────────────────────────────────────────

function makeStore(existing: { content: string }[] = []) {
  const appended: unknown[] = [];
  const mock = {
    loadSemantic: vi.fn(async () =>
      existing.map((e, i) => ({
        id: `id-${i}`,
        timestamp: new Date(),
        layer: "semantic" as const,
        payload: {
          type: "conversation_rule" as const,
          content: e.content,
          tags: [],
          source: "test",
          decayScore: 0.95,
          pinned: true,
          accessCount: 0,
          lastAccessedAt: new Date(),
        },
      })),
    ),
    // Simulate store-level dedup: return "exact_key_dup" if content matches existing.
    appendSemantic: vi.fn(
      async (entry: {
        payload: { content: string };
      }): Promise<"written" | "exact_key_dup" | "fuzzy_dup"> => {
        const needle = entry.payload.content.trim().toLowerCase();
        const isDupe = existing.some((e) => e.content.trim().toLowerCase() === needle);
        if (isDupe) return "exact_key_dup";
        appended.push(entry);
        return "written";
      },
    ),
    // Curator overwrites after compaction; no-op in unit tests.
    overwriteSemantic: vi.fn(async () => {}),
    semanticPath: vi.fn(() => "/test/workspace/log-memory/KNOWLEDGE.md"),
    appended,
  };
  return { ...mock, store: mock as unknown as LogMemoryStore };
}

function makeSubagent(responseText: string, mainHistory: unknown[] = []) {
  // getSessionMessages is called twice when mainSessionKey is provided:
  // 1) for the main session history, 2) for the evaluator's own response.
  let historyFetched = false;
  return {
    run: vi.fn(async () => ({ runId: "eval-run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" })),
    getSessionMessages: vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
      // Main session key does not start with "knowledge-evaluator-".
      if (!sessionKey.startsWith("knowledge-evaluator-") && !historyFetched) {
        historyFetched = true;
        return { messages: mainHistory };
      }
      return { messages: [{ role: "assistant", content: responseText }] };
    }),
    deleteSession: vi.fn(async () => {}),
  };
}

describe("evaluateAndCapture", () => {
  it("captures learned pattern as pinned entry", async () => {
    const { store, appended } = makeStore();
    const subagent = makeSubagent(
      "LEARNED: Use for(;;) for infinite loops instead of while(1) per project convention\nSOLVED: NOTHING",
    );

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-abc",
      userMessage: "Why do you use for(;;)?",
      assistantResponse: "We use for(;;) as per the project coding standard for infinite loops.",
      logger: { warn: vi.fn() },
    });

    expect(store.appendSemantic).toHaveBeenCalledOnce();
    const entry = (appended[0] as { payload: { pinned: boolean; content: string; tags: string[] } })
      .payload;
    expect(entry.pinned).toBe(true);
    expect(entry.content).toContain("for(;;)");
    expect(entry.tags).toContain("kind:learned_pattern");
  });

  it("captures solved problem as non-pinned entry", async () => {
    const { store, appended } = makeStore();
    const subagent = makeSubagent(
      "LEARNED: NOTHING\nSOLVED: Fixed missing null check on pointer dereference causing segfault in parser",
    );

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-def",
      userMessage: "My parser crashes with a segfault",
      assistantResponse: "The issue is a missing null check before pointer dereference.",
      logger: { warn: vi.fn() },
    });

    expect(store.appendSemantic).toHaveBeenCalledOnce();
    const entry = (appended[0] as { payload: { pinned: boolean; tags: string[] } }).payload;
    expect(entry.pinned).toBe(false);
    expect(entry.tags).toContain("kind:debug_solution");
  });

  it("captures both learned and solved in same turn", async () => {
    const { store } = makeStore();
    const subagent = makeSubagent(
      "LEARNED: All metric variable names must be prefixed with lobster_\nSOLVED: Fixed undefined metric counter in monitoring module",
    );

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-ghi",
      userMessage: "The lobster_cpu metric is undefined",
      assistantResponse: "You need to prefix metric variables with lobster_ and initialize them.",
      logger: { warn: vi.fn() },
    });

    expect(store.appendSemantic).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when both are NOTHING", async () => {
    const { store } = makeStore();
    const subagent = makeSubagent("LEARNED: NOTHING\nSOLVED: NOTHING");

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-jkl",
      userMessage: "What time is it?",
      assistantResponse: "I don't have access to the current time.",
      logger: { warn: vi.fn() },
    });

    expect(store.appendSemantic).not.toHaveBeenCalled();
  });

  it("skips exact duplicate content", async () => {
    const { store, appended } = makeStore([
      { content: "Use for(;;) for infinite loops per project convention" },
    ]);
    const subagent = makeSubagent(
      "LEARNED: Use for(;;) for infinite loops per project convention\nSOLVED: NOTHING",
    );

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-mno",
      userMessage: "Remind me of the loop convention",
      assistantResponse: "Use for(;;) for infinite loops per project convention.",
      logger: { warn: vi.fn() },
    });

    // appendSemantic is called but returns "exact_key_dup"; nothing appended.
    expect(appended).toHaveLength(0);
  });

  it("passes prior turns to evaluator prompt when mainSessionKey is given", async () => {
    const { store } = makeStore();
    const mainHistory = [
      { role: "user", content: "What is the logging convention?" },
      { role: "assistant", content: "Use structured JSON logs with a level field." },
      { role: "user", content: "How do I add a new logger?" },
      { role: "assistant", content: "Call createLogger() with your module name." },
    ];
    const subagent = makeSubagent("LEARNED: NOTHING\nSOLVED: NOTHING", mainHistory);

    await evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-multi",
      userMessage: "How do I add a new logger?",
      assistantResponse: "Call createLogger() with your module name.",
      mainSessionKey: "agent:main:main",
      logger: { warn: vi.fn() },
    });

    // getSessionMessages should be called with the main session key first.
    expect(subagent.getSessionMessages).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    // The prompt sent to run() should include prior context.
    const firstCall = subagent.run.mock.calls[0] as unknown as [{ message: string }];
    const prompt = firstCall[0].message;
    expect(prompt).toContain("[PRIOR CONTEXT]");
    expect(prompt).toContain("What is the logging convention?");
    // The current turn should still appear under [CURRENT TURN].
    expect(prompt).toContain("[CURRENT TURN]");
    expect(prompt).toContain("How do I add a new logger?");
  });

  it("does not call subagent when runId is already evaluating", async () => {
    const { store } = makeStore();
    // Simulate lock: call twice with same runId; second call should be a no-op.
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const subagent = {
      run: vi.fn(async () => {
        await firstDone;
        return { runId: "r" };
      }),
      waitForRun: vi.fn(async () => ({ status: "ok" })),
      getSessionMessages: vi.fn(async () => ({
        messages: [{ role: "assistant", content: "LEARNED: NOTHING\nSOLVED: NOTHING" }],
      })),
      deleteSession: vi.fn(async () => {}),
    };

    const p1 = evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-dup",
      userMessage: "a",
      assistantResponse: "b",
      logger: { warn: vi.fn() },
    });
    const p2 = evaluateAndCapture({
      subagent,
      store,
      workspaceDir: "/test/workspace",
      runId: "run-dup",
      userMessage: "a",
      assistantResponse: "b",
      logger: { warn: vi.fn() },
    });
    resolveFirst();
    await Promise.all([p1, p2]);

    expect(subagent.run).toHaveBeenCalledOnce();
  });
});

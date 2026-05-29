# Fork Changes — memory-core

Changes relative to upstream `openclaw/openclaw`. Listed newest-first.
Use `git diff origin/master -- extensions/memory-core/` for the full diff.

---

## 2026-05-29 — Cheatsheet curator replaces MERGE/NO_MERGE curator

### Modified files

- `src/log-memory/knowledge-curator.ts` — full redesign as "cheatsheet curator":
  - Previous: asked LLM "MERGE [i,j] / NO_MERGE" for each new entry (too conservative)
  - New: LLM sees complete KNOWLEDGE.md + new entry + conversation context → outputs
    FULL_REWRITE or NO_CHANGE. Full authority: can add, merge, prune, update AccessCount.
  - `curateKnowledgeMd` now accepts optional `conversationContext` so the curator
    can increment AccessCount for existing entries that were relevant to this turn.
  - Hard cap: ≤ 30 entries; LLM decides what to drop when near limit.

- `src/log-memory/llm-evaluator.ts`
  - Added `workspaceDir` param (needed to forward to curator)
  - After `appendSemantic` returns `"written"`, fire-and-forget curator call so every
    new capture immediately triggers a compaction/merge pass on KNOWLEDGE.md.
  - New entries start with `accessCount: 1` instead of `0`.

- `src/log-memory/md-format.ts`
  - Added `"AccessCount"` to `SEMANTIC_META_KEYS`
  - `serializeSemanticBlock`: writes `AccessCount: N` line when > 0
  - `buildSemanticEntry`: parses `AccessCount` from metadata → `payload.accessCount`

- `src/log-memory-hooks.ts`
  - `llm_output` hook: passes `workspaceDir` to `evaluateAndCapture`

---

## 2026-05-28 — LLM-based passive learning + injection tracker + dedup fix

### New files

- `src/log-memory/llm-evaluator.ts` — after each LLM turn (`llm_output` hook),
  calls a subagent to evaluate two questions:
  - `LEARNED:` — reusable pattern or rule worth pinning (`pinned: true`)
  - `SOLVED:` — specific problem resolved (`pinned: false`, can decay)
    Includes recursion guard (`isInternalEvaluatorSession`) to skip evaluator's own subagent calls.
- `src/log-memory/llm-evaluator.test.ts` — 10 unit tests for evaluator logic.
- `src/log-memory/session-tracer.ts` — records per-LLM-call injection stats
  (`llm_input` hook) to `log-memory/injection-trace.jsonl`. Fields: total chars,
  knowledge chars, history chars, message count, model, session key.

### Modified files

- `src/log-memory-hooks.ts`
  - Added `llm_input` hook → `SessionTracer.append()` (fire-and-forget, skips internal sessions)
  - Added `llm_output` hook → `evaluateAndCapture()` (passive learning, fire-and-forget)
  - Added HTTP route `GET /api/log-memory/trace?limit=N` — returns last N turns as JSON
  - Existing `GET /api/log-memory/context` unchanged (backward compat)

- `src/log-memory/dedupe.ts`
  - Added `computeContentKey(content)` — SHA-1 of normalized content, timestamp-independent
  - Added `jaccardWordSimilarity(a, b)` — word-overlap ratio for fuzzy dedup

- `src/log-memory/md-format.ts`
  - `serializeSemanticBlock` now appends `ContentKey: HASH` metadata field (same concept
    as MEMORY.md's `<!-- openclaw-memory-promotion:KEY -->` markers)
  - Added `ContentKey` to `SEMANTIC_META_KEYS`
  - Added `extractSemanticContentKeys(text)` — O(n) scan for existing content keys

- `src/log-memory/store.ts`
  - `appendSemantic` now returns `"written" | "exact_key_dup" | "fuzzy_dup"` instead of void
  - Before writing, checks: (1) ContentKey marker match, (2) Jaccard similarity ≥ 0.55
  - Threshold: `FUZZY_DEDUP_THRESHOLD = 0.55`

- `src/log-memory/knowledge-capture.ts`
  - Removed manual `findSemanticDuplicate()` — dedup now handled by `store.appendSemantic`

- `src/log-memory/knowledge-curator.ts`
  - System prompt changed from "when in doubt do NOT merge" to "prefer merging over keeping
    duplicates" — less conservative, more aggressive about semantic consolidation

- `src/log-memory/md-format.test.ts` — updated expected serialization to include `ContentKey:` field

- `src/log-memory/llm-evaluator.test.ts` — updated duplicate-skip test to check `appended`
  length instead of call count (store handles dedup now)

### UI changes (`ui/`)

- `src/ui/views/chat.ts`
  - Added `TurnTrace` interface matching `session-tracer.ts` output
  - Added `renderTraceBubble()` — new collapsible panel showing per-turn injection table:
    turn #, time, total chars, knowledge chars, history chars, message count, model
  - Click row to expand: shows session key, run ID, per-source char breakdown
  - Auto-fetches from `/api/log-memory/trace` on open; shows last 30 turns
  - Rendered below the existing "System context" bubble

- `src/styles/chat/layout.css`
  - Added `.trace-table`, `.trace-row`, `.trace-detail`, `.trace-detail-pre` styles

---

## 2026-05-15 — Initial log-memory feature

### New files

- `src/log-memory/` — full log-memory subsystem:
  - `types.ts`, `store.ts`, `ingestor.ts`, `context-injector.ts`
  - `knowledge-capture.ts` — regex-based explicit rule capture
  - `knowledge-curator.ts` — LLM subagent deduplication on write
  - `chunk.ts`, `cluster.ts`, `decay.ts`, `dedupe.ts`, `dream.ts`
  - `md-format.ts` — KNOWLEDGE.md serializer/parser
  - `parse.ts`, `scheduler.ts`, `skill.ts`
  - Plus test files for all of the above

- `src/log-memory-hooks.ts` — registers `message_received` and `before_prompt_build` hooks;
  exposes `GET /api/log-memory/context` HTTP route

### Modified files

- `index.ts` — added `registerLogMemoryHooks(api)` call in `register()`

# Core Changes Log

This file tracks every modification made to the upstream OpenClaw core codebase
so the author can rebase or re-apply patches when merging a newer upstream version.

---

## 2026-05-28 — log-memory: injected system-prompt panel in chat UI

### Problem

The user wanted to see the injected system prompt (KNOWLEDGE.md content) as a
collapsible floating panel in the chat page, not just in the Usage Tab.

### Files modified (core)

| File                            | Type             | Summary                                                                                          |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `ui/src/ui/views/chat.ts`       | UI — chat view   | Added `logMemoryGatewayUrl` prop; `ChatEphemeralState` fields; `renderSysPromptPanel()` function |
| `ui/src/styles/chat/layout.css` | UI — styles      | Added `.sys-prompt-panel` + child rule block (~45 lines, appended at end)                        |
| `ui/src/ui/app-render.ts`       | UI — render host | Passed `logMemoryGatewayUrl` to `renderChat(...)` call (4 lines)                                 |

### Files modified (extension — not core)

| File                                             | Summary                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `extensions/memory-core/src/log-memory-hooks.ts` | Added `registerHttpRoute` for `GET /api/log-memory/context` returning `conversation_prompt.md` as JSON with CORS headers |

### Why these changes

`contextWeight` (which carries injected file metadata) lives in the Usage API
data flow and is not available in the chat view's `sessions` prop. The chat
view only receives `SessionsListResult` rows which do not carry context content.

A plugin HTTP route is the correct seam: the extension serves the content, and
the UI fetches it using the existing `gatewayUrl` setting (converted ws→http).

### Rebase notes

When merging a newer upstream `chat.ts`:

1. Re-add `logMemoryGatewayUrl?: string | null` to `ChatProps`
2. Re-add `sysPromptOpen / sysPromptContent / sysPromptFetching` to `ChatEphemeralState` + `createChatEphemeralState`
3. Re-add `renderSysPromptPanel()` function (search for `// Collapsible floating panel`)
4. Re-add the `${props.logMemoryGatewayUrl ? renderSysPromptPanel(...) : nothing}` call after `renderContextNotice`

When merging a newer `layout.css`:

- Append the `/* ── Injected system-prompt panel */` block from the end of the current file.

When merging a newer `app-render.ts`:

- Add the `logMemoryGatewayUrl:` line to the `renderChat({...})` call.

---

## Earlier changes (see previous session context)

### 2026-05 — log-memory subsystem (pure extension additions)

All changes below are **extension-only** (`extensions/memory-core/`) with the
following exceptions in core:

| File                                      | Type           | Summary                                                                                                                                                                                   |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/system-prompt-report.ts`      | Core — agents  | `readLogMemoryInjectionSources` renamed to `readLogMemorySidecar`; returns full sidecar JSON including `conversationPromptPath`; `injectedWorkspaceFiles` entries get `path` from sidecar |
| `ui/src/ui/views/usage-render-details.ts` | UI — usage tab | Files breakdown: added `(X.X%)` of total context tokens; added `f.path` subtitle display                                                                                                  |

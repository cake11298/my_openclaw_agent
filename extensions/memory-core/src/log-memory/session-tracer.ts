import fs from "node:fs/promises";
import path from "node:path";

export interface TurnTrace {
  ts: string;
  sessionId: string;
  sessionKey?: string;
  runId: string;
  turnIndex: number;
  provider: string;
  model: string;
  systemChars: number;
  promptChars: number;
  historyChars: number;
  historyMsgCount: number;
  imagesCount: number;
  knowledgeChars: number;
  totalInputChars: number;
}

const TRACE_FILENAME = "injection-trace.jsonl";
const MAX_TRACE_LINES = 200;

// Count chars in historyMessages array (serialize to JSON for a simple estimate).
function historyChars(messages: unknown[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}

// Extract the chars contributed by the [Mandatory rules] block injected by
// before_prompt_build, so the UI can show knowledge-specific injection size.
function extractKnowledgeChars(systemPrompt: string): number {
  const marker = "[Mandatory rules";
  const idx = systemPrompt.indexOf(marker);
  if (idx === -1) return 0;
  // Everything from the marker to the end of the rules block.
  const after = systemPrompt.slice(idx);
  // The block ends at the next double-newline or end of string.
  const end = after.indexOf("\n\n");
  return end === -1 ? after.length : end;
}

export class SessionTracer {
  private readonly tracePath: string;
  private turnCounters = new Map<string, number>();

  constructor(workspaceDir: string) {
    this.tracePath = path.join(workspaceDir, "log-memory", TRACE_FILENAME);
  }

  async append(params: {
    sessionId: string;
    sessionKey?: string;
    runId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
    imagesCount: number;
  }): Promise<void> {
    const sysPrompt = params.systemPrompt ?? "";
    const sessionKey = params.sessionKey ?? params.sessionId;

    const counter = (this.turnCounters.get(sessionKey) ?? 0) + 1;
    this.turnCounters.set(sessionKey, counter);

    const entry: TurnTrace = {
      ts: new Date().toISOString(),
      sessionId: params.sessionId,
      sessionKey,
      runId: params.runId,
      turnIndex: counter,
      provider: params.provider,
      model: params.model,
      systemChars: sysPrompt.length,
      promptChars: params.prompt.length,
      historyChars: historyChars(params.historyMessages),
      historyMsgCount: params.historyMessages.length,
      imagesCount: params.imagesCount,
      knowledgeChars: extractKnowledgeChars(sysPrompt),
      totalInputChars:
        sysPrompt.length + params.prompt.length + historyChars(params.historyMessages),
    };

    await fs.mkdir(path.dirname(this.tracePath), { recursive: true });
    await fs.appendFile(this.tracePath, JSON.stringify(entry) + "\n", "utf8");
    await this.trim();
  }

  async load(limit = 50): Promise<TurnTrace[]> {
    try {
      const text = await fs.readFile(this.tracePath, "utf8");
      const lines = text.trim().split("\n").filter(Boolean);
      const last = lines.slice(-limit);
      return last
        .map((line) => {
          try {
            return JSON.parse(line) as TurnTrace;
          } catch {
            return null;
          }
        })
        .filter((e): e is TurnTrace => e !== null);
    } catch {
      return [];
    }
  }

  private async trim(): Promise<void> {
    try {
      const text = await fs.readFile(this.tracePath, "utf8");
      const lines = text.trim().split("\n").filter(Boolean);
      if (lines.length <= MAX_TRACE_LINES) return;
      await fs.writeFile(this.tracePath, lines.slice(-MAX_TRACE_LINES).join("\n") + "\n", "utf8");
    } catch {
      // best-effort
    }
  }
}

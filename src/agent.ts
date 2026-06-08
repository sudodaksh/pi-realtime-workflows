import type { AssistantMessage, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/** Thinking levels a subagent can run at, lowest to highest reasoning effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

/**
 * Token accounting for a subagent, mirroring how Pi's own status bar reports usage.
 *
 * Each subagent runs in its own fresh session, so these numbers are that session's totals — they
 * have nothing to do with the parent conversation's context. `tokens` is the headline figure
 * (`input + output`, the genuinely billed tokens); `cacheRead` is the much larger but cheap volume
 * of context re-read from the prompt cache each turn, surfaced separately so it never inflates the
 * headline. (Summing per-turn `totalTokens` — which folds `cacheRead` back in — is what produced
 * the misleading "500k per agent" number.)
 */
export interface AgentUsage {
  /** Billed tokens: fresh input + generated output, summed across turns. The headline number. */
  tokens: number;
  /** Fresh (non-cached) input tokens summed across turns. */
  input: number;
  /** Generated output tokens summed across turns. */
  output: number;
  /** Context re-read from the prompt cache, summed across turns. Large but cheap; shown separately. */
  cacheRead: number;
  /** Real dollar cost summed across turns. */
  costUsd: number;
}

/** Real metrics for a subagent, harvested from its session. Emitted live and again when it finishes. */
export interface AgentRunStats {
  /** Token accounting broken down so the UI can show input/output/cache/cost honestly. */
  usage: AgentUsage;
  /** Friendly model name the subagent ran on, when known. */
  model?: string;
  /** Wall-clock time the subagent has taken so far. */
  durationMs: number;
  /** One short summary per tool call the subagent has made, in order. */
  toolCalls: string[];
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Model to run this subagent on, resolved against the session's model registry. Accepts
   * `provider/id` (`openai/gpt-5.5`), a bare id (`gpt-5.5`), or the friendly name (`GPT-5.5`).
   * Falls back to the orchestrator's model if the name does not resolve.
   */
  model?: string;
  /**
   * Thinking level for this subagent. When omitted, the subagent uses Pi's default (from settings,
   * else `medium`) — it is never forced lower; the caller must ask for a lower level explicitly.
   */
  thinking?: AgentThinkingLevel;
  /**
   * Reports the subagent's real metrics as it works — once per completed assistant turn and tool
   * call, and a final authoritative time when it finishes — so the manager can show live activity.
   */
  onProgress?: (stats: AgentRunStats) => void;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const startedAt = Date.now();
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Per-agent model override: resolve the requested name, else keep the orchestrator's model.
    const sessionModel = (options.model ? this.resolveModel(options.model) : undefined) ?? this.sessionOptions.model;

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      model: sessionModel,
      // Per-agent override; when unset, keep any session-level level, else Pi's own default.
      thinkingLevel: options.thinking ?? this.sessionOptions.thinkingLevel,
    });

    let removeAbortListener: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const emitProgress = () => {
      options.onProgress?.({
        usage: sumUsage(session.messages),
        model: sessionModel?.name ?? lastAssistantModel(session.messages),
        durationMs: Date.now() - startedAt,
        toolCalls: collectToolCalls(session.messages),
      });
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      // Stream metrics as the subagent works: each finished turn and each tool call updates the
      // committed message list, so recomputing on those events gives the manager live activity.
      if (options.onProgress) {
        unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end" || event.type === "tool_execution_start") emitProgress();
        });
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // Final authoritative reading once the turn fully settles.
      emitProgress();

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      unsubscribe?.();
      removeAbortListener?.();
      session.dispose();
    }
  }

  /**
   * Resolve a model name against the session's registry, falling back to undefined (and so to the
   * orchestrator's model) when there is no registry or match — never hard-failing on a typo.
   */
  private resolveModel(name: string): Model<any> | undefined {
    return resolveModelByName(this.sessionOptions.modelRegistry?.getAll() ?? [], name);
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}

/**
 * Match a model name against a list, case-insensitively. Accepts `provider/id`
 * (`openai/gpt-5.5`), a bare `id` (`gpt-5.5`), or the friendly display name (`GPT-5.5`). Returns
 * undefined when nothing matches, so callers fall back to the orchestrator's model.
 */
export function resolveModelByName(models: Model<any>[], name: string): Model<any> | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  const qualified = want.includes("/");
  return models.find((model) =>
    qualified
      ? `${model.provider}/${model.id}`.toLowerCase() === want
      : model.id.toLowerCase() === want || model.name.toLowerCase() === want,
  );
}

/**
 * Sum a session's usage across assistant turns into an honest breakdown. `input`/`output` add up
 * cleanly (each turn's fresh tokens are counted once); `cacheRead` is kept separate so the cheap,
 * ever-growing re-read of cached context never inflates the headline `tokens` figure.
 */
function sumUsage(messages: unknown[]): AgentUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let costUsd = 0;
  for (const message of messages) {
    const usage = (message as Partial<AssistantMessage> | undefined)?.usage;
    if (!usage) continue;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    costUsd += usage.cost?.total ?? 0;
  }
  return { tokens: input + output, input, output, cacheRead, costUsd };
}

/** The model id of the most recent assistant turn, used when the session model name is unknown. */
function lastAssistantModel(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role === "assistant") return message.responseModel ?? message.model;
  }
  return undefined;
}

/** One short summary per tool call the subagent made, in order, e.g. `Bash(python3 -c …)`. */
function collectToolCalls(messages: unknown[]): string[] {
  const calls: string[] = [];
  for (const message of messages) {
    const m = message as Partial<AssistantMessage> | undefined;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if ((part as { type?: string })?.type === "toolCall") calls.push(renderToolCall(part as ToolCall));
    }
  }
  return calls;
}

function renderToolCall(call: ToolCall): string {
  const arg = firstArgPreview(call.arguments);
  return arg ? `${call.name}(${arg})` : call.name;
}

/** Pick the most descriptive string argument from a tool call for a compact preview. */
function firstArgPreview(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const preferred = ["command", "cmd", "path", "file_path", "query", "pattern", "name", "url"];
  for (const key of preferred) {
    if (typeof args[key] === "string") return clip(args[key] as string);
  }
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value) return clip(value);
  }
  return "";
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

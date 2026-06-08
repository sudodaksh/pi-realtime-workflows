import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createToolUpdateWorkflowDisplay, renderWorkflowText, type WorkflowSnapshot } from "./display.js";
import { WorkflowRegistry, type WorkflowRun, type WorkflowRunStatus } from "./registry.js";
import { parseWorkflowScript } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Required raw JavaScript workflow script, with no Markdown fences.",
      "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. meta.phases is optional documentation; live progress is driven by phase(title).",
      "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
      "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
    ].join(" "),
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared registry so launched runs show up in the `/workflows` manager. Defaults to a private one. */
  registry?: WorkflowRegistry;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const registry = options.registry ?? new WorkflowRegistry();
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "script is required raw JavaScript. It must start with export const meta = { name, description } and must call agent() at least once; phases are optional metadata.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Use phase(title) at runtime to create progress groups.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences or prose around the script.",
      "For workflow, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`; meta.name and meta.description are required non-empty strings, and meta.phases is optional metadata for a stable upfront outline.",
      "For workflow, write plain JavaScript after the meta export. Do not use TypeScript syntax, imports, require(), fs, Date.now(), Math.random(), or new Date().",
      "For workflow, the script must be syntactically valid JavaScript. Watch for unescaped quotes inside prompt strings: an apostrophe in a single-quoted string ('it's') breaks parsing. Escape it (\\') or use a backtick template literal for prompts that contain quotes or newlines; build dynamic prompts with string concatenation rather than interpolation placeholders.",
      "For workflow, available globals are agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args, cwd, process.cwd(), and budget. Every workflow must call agent() at least once; do not use workflow only to declare phases or return a static object.",
      "For workflow, call phase(title) when a new group of work starts. Phase names may be conditional or built in a loop; do not predeclare speculative phases just in case.",
      "For workflow, prefer it for decomposable work: repository inspection, independent research/checks, multi-perspective review, or fan-out/fan-in synthesis. Do not use it for a single quick file read/edit or when ordinary tools are enough.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order.",
      "For workflow, pipeline(items, ...stages) runs each item through stages sequentially, while different items may run concurrently. Each stage receives (previousValue, originalItem, index).",
      "For workflow, every agent() call should include a unique short label option, 2-5 words, such as { label: 'repo inventory' } or { label: 'source modules' }; unique labels make live status and error reporting readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted. Check for nulls before synthesizing conclusions.",
      "For workflow, include a final synthesis/assertion agent when combining multiple subagent results; return a compact JSON-serializable value with ok/verdict plus the important outputs.",
      "For workflow, if agent() needs machine-readable output, pass a plain JSON Schema via opts.schema; agent() will return the validated object. Use JSON Schema syntax, not TypeScript or TypeBox constructors.",
      "For workflow, subagents inherit your model by default. To run them on a different model, pass opts.model (a `provider/id` like 'openai/gpt-5.5', a bare id, or the friendly name). If the user asks for the subagents/workers to use a specific model, set that opts.model on every agent() call. An unrecognized name falls back to your model.",
      "For workflow, opts.thinking sets a subagent's reasoning effort (one of off, minimal, low, medium, high, xhigh). Omit it to use the default; only set it when the user asks (e.g. opts.thinking: 'high' for a deep review agent). Do not lower it to off/minimal/low unless the user explicitly requests less thinking.",
      "For workflow, do not assume the parent assistant has repository code context inside subagents; include enough task context and relevant paths in each agent prompt.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      // The run is registered with the shared registry, so `/workflows` can watch and control it
      // while this tool call streams its progress inline.
      const run = registry.start({
        script,
        meta: parsed.meta,
        args: params.args,
        options: {
          cwd: options.cwd ?? ctx.cwd,
          concurrency: options.concurrency,
          session: { modelRegistry: ctx.modelRegistry, model: ctx.model },
        },
      });

      const onAbort = () => registry.stop(run.id);
      signal?.addEventListener("abort", onAbort, { once: true });
      const unsubscribe = registry.subscribe(() => display.update(toToolSnapshot(run)));
      try {
        await registry.whenSettled(run.id);
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }

      const finalSnapshot = toToolSnapshot(run);
      display.complete(finalSnapshot);

      if (signal?.aborted) throw new Error("Workflow was aborted");

      if (run.status === "done" && finalSnapshot.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      const summary = `Workflow ${run.meta.name} ${describeStatus(run.status)} with ${finalSnapshot.agentCount} agent(s).`;
      const body =
        run.status === "error"
          ? `\n\n${run.error ?? "unknown error"}`
          : run.status === "done"
            ? `\n\nResult:\n${JSON.stringify(run.result, null, 2)}`
            : `\n\nThe run is ${run.status}. Open /workflows to inspect or resume it.`;

      return {
        ...(run.status === "error" ? { isError: true } : {}),
        content: [{ type: "text", text: summary + body }],
        details: {
          ...finalSnapshot,
          meta: run.meta,
          phases: finalSnapshot.phases,
          logs: finalSnapshot.logs,
          result: run.result,
          durationMs: finalSnapshot.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

/** Snapshot for the inline display, augmented with the run's result and elapsed time. */
function toToolSnapshot(run: WorkflowRun): WorkflowSnapshot {
  return {
    ...run.snapshot,
    result: run.result,
    durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
  };
}

function describeStatus(status: WorkflowRunStatus): string {
  switch (status) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return status;
  }
}

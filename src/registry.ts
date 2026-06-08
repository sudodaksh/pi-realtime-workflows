import { createWorkflowSnapshot, preview, recomputeWorkflowSnapshot, type WorkflowSnapshot } from "./display.js";
import {
  runWorkflow,
  type WorkflowAgentEndEvent,
  type WorkflowAgentProgressEvent,
  type WorkflowAgentStartEvent,
  type WorkflowJournal,
  type WorkflowMeta,
  type WorkflowRunOptions,
} from "./workflow.js";

/**
 * Lifecycle of a single workflow run.
 *
 * - `running` — an execution is in flight.
 * - `paused` — execution was aborted but the journal is kept, so it can resume from where it left off.
 * - `done` — the script returned a result.
 * - `error` — the script threw a non-abort error.
 * - `stopped` — the run was stopped by the user; completed work is kept but it is treated as terminal.
 */
export type WorkflowRunStatus = "running" | "paused" | "done" | "error" | "stopped";

/** Options the registry needs to (re-)execute a run, minus the per-execution hooks it owns. */
export type WorkflowRunBaseOptions = Omit<
  WorkflowRunOptions,
  "args" | "signal" | "journal" | "agentControls" | "onLog" | "onPhase" | "onAgentStart" | "onAgentEnd"
>;

export interface WorkflowRun {
  id: string;
  meta: WorkflowMeta;
  script: string;
  args: unknown;
  status: WorkflowRunStatus;
  snapshot: WorkflowSnapshot;
  /** Completed agent() results, keyed by deterministic call index; replayed on resume. */
  journal: WorkflowJournal;
  tokens: number;
  startedAt: number;
  endedAt?: number;
  result?: unknown;
  error?: string;
  /** Number of times the run has been (re)started, including resumes and restarts. */
  runCount: number;
}

export interface WorkflowLaunchInput {
  script: string;
  meta: WorkflowMeta;
  args?: unknown;
  options?: WorkflowRunBaseOptions;
}

interface RunInternals {
  baseOptions: WorkflowRunBaseOptions;
  controller?: AbortController;
  agentControls: Map<number, () => void>;
  /** Resolves when the current execution settles (any terminal-for-this-call state). */
  execution?: Promise<void>;
  /** Why the current execution is being aborted, so the catch can pick paused vs stopped. */
  intent?: "pause" | "stop";
}

/** Monotonic clock injected so tests stay deterministic; defaults to Date.now in host code. */
export type Clock = () => number;

/**
 * Holds every workflow run for the session and owns their lifecycle (start, pause, resume,
 * restart, stop). The `workflow` tool launches runs here; the `/workflows` manager reads from
 * here and drives the controls. Subscribers are notified on any state change so the UI re-renders.
 */
export class WorkflowRegistry {
  private readonly runs: WorkflowRun[] = [];
  private readonly internals = new Map<string, RunInternals>();
  private readonly listeners = new Set<() => void>();
  private readonly clock: Clock;
  private counter = 0;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  /** Runs in launch order (oldest first). The manager renders newest first. */
  list(): readonly WorkflowRun[] {
    return this.runs;
  }

  get(id: string): WorkflowRun | undefined {
    return this.runs.find((run) => run.id === id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Create a run and kick off its first execution, returning immediately while it runs in the
   * background. Callers stream progress by subscribing and await {@link whenSettled} for the result.
   */
  start(input: WorkflowLaunchInput): WorkflowRun {
    const id = String(++this.counter);
    const run: WorkflowRun = {
      id,
      meta: input.meta,
      script: input.script,
      args: input.args,
      status: "running",
      snapshot: createWorkflowSnapshot(input.meta),
      journal: new Map(),
      tokens: 0,
      startedAt: this.clock(),
      runCount: 0,
    };
    this.internals.set(id, { baseOptions: input.options ?? {}, agentControls: new Map() });
    this.runs.push(run);
    this.notify();
    void this.execute(run);
    return run;
  }

  /** Resolves once the run leaves the running state (done/error/paused/stopped) for the current execution. */
  whenSettled(id: string): Promise<WorkflowRun | undefined> {
    const internal = this.internals.get(id);
    const run = this.get(id);
    if (!internal?.execution || !run) return Promise.resolve(run);
    return internal.execution.then(() => run);
  }

  /** Convenience: start a run and await its first settle. */
  async launch(input: WorkflowLaunchInput): Promise<WorkflowRun> {
    const run = this.start(input);
    await this.whenSettled(run.id);
    return run;
  }

  /** Pause a running workflow, keeping its journal so it can resume. */
  pause(id: string): void {
    const run = this.get(id);
    const internal = this.internals.get(id);
    if (!run || !internal || run.status !== "running") return;
    internal.intent = "pause";
    internal.controller?.abort();
  }

  /** Resume a paused workflow: completed agents replay from the journal, the rest run live. */
  resume(id: string): void {
    const run = this.get(id);
    if (run?.status !== "paused") return;
    void this.execute(run);
  }

  /** Stop a running or paused workflow. Completed work is kept but the run becomes terminal. */
  stop(id: string): void {
    const run = this.get(id);
    const internal = this.internals.get(id);
    if (!run || !internal) return;
    if (run.status === "running") {
      internal.intent = "stop";
      internal.controller?.abort();
      return;
    }
    if (run.status === "paused") {
      run.status = "stopped";
      run.endedAt = run.endedAt ?? this.clock();
      this.notify();
    }
  }

  /** Stop a single in-flight agent; its branch returns null and the rest of the run continues. */
  stopAgent(id: string, index: number): void {
    const internal = this.internals.get(id);
    internal?.agentControls.get(index)?.();
  }

  /**
   * Restart an agent: drop its journaled result (and every later one, which depended on it), then
   * relaunch. The selected agent and its successors run live while the unchanged prefix replays.
   */
  async restartAgent(id: string, index: number): Promise<void> {
    const run = this.get(id);
    if (!run) return;
    for (const key of [...run.journal.keys()]) {
      if (key >= index) run.journal.delete(key);
    }
    await this.relaunch(run);
  }

  /** Abort the current execution (if any), wait for it to unwind, then start a fresh execution. */
  private async relaunch(run: WorkflowRun): Promise<void> {
    const internal = this.internals.get(run.id);
    if (!internal) return;
    if (run.status === "running") {
      internal.intent = "pause";
      internal.controller?.abort();
      try {
        await internal.execution;
      } catch {
        // execute() never rejects; the await is just to let it unwind.
      }
    }
    void this.execute(run);
  }

  private execute(run: WorkflowRun): Promise<void> {
    const internal = this.internals.get(run.id);
    if (!internal) return Promise.resolve();

    const controller = new AbortController();
    internal.controller = controller;
    internal.intent = undefined;
    internal.agentControls.clear();
    run.status = "running";
    run.runCount++;
    run.endedAt = undefined;
    run.error = undefined;
    // Each execution re-emits every agent (cached + live), so start from a clean snapshot.
    run.snapshot = createWorkflowSnapshot(run.meta);
    run.tokens = 0;
    this.notify();

    const options: WorkflowRunOptions = {
      ...internal.baseOptions,
      args: run.args,
      signal: controller.signal,
      journal: run.journal,
      agentControls: internal.agentControls,
      onLog: (message) => {
        run.snapshot.logs.push(message);
        this.touch(run);
      },
      onPhase: (title) => {
        run.snapshot.currentPhase = title;
        if (!run.snapshot.phases.includes(title)) run.snapshot.phases.push(title);
        this.touch(run);
      },
      onAgentStart: (event) => this.applyAgentStart(run, event),
      onAgentProgress: (event) => this.applyAgentProgress(run, event),
      onAgentEnd: (event) => this.applyAgentEnd(run, event),
    };

    const execution = runWorkflow(run.script, options).then(
      (result) => {
        run.status = "done";
        run.result = result.result;
        run.meta = result.meta;
        run.endedAt = this.clock();
        this.touch(run);
      },
      (error) => {
        if (isAbortError(error, controller.signal)) {
          run.status = internal.intent === "stop" ? "stopped" : "paused";
          markUnsettledAgents(run.snapshot, run.status === "paused" ? "queued" : "skipped");
        } else {
          run.status = "error";
          run.error = error instanceof Error ? error.message : String(error);
        }
        internal.intent = undefined;
        run.endedAt = this.clock();
        this.touch(run);
      },
    );
    internal.execution = execution;
    return execution;
  }

  private applyAgentStart(run: WorkflowRun, event: WorkflowAgentStartEvent): void {
    const existing = run.snapshot.agents.find((agent) => agent.id === event.index + 1);
    if (existing) {
      existing.status = event.cached ? existing.status : "running";
      existing.cached = event.cached;
      if (!event.cached) existing.startedAt = this.clock();
    } else {
      run.snapshot.agents.push({
        id: event.index + 1,
        label: event.label,
        phase: event.phase,
        prompt: event.prompt,
        status: "running",
        cached: event.cached,
        startedAt: event.cached ? undefined : this.clock(),
      });
    }
    this.touch(run);
  }

  /** Live updates while an agent runs: token spend, model, elapsed time, and tool calls so far. */
  private applyAgentProgress(run: WorkflowRun, event: WorkflowAgentProgressEvent): void {
    const agent = run.snapshot.agents.find((item) => item.id === event.index + 1);
    if (agent?.status !== "running") return;
    agent.tokens = event.tokens;
    agent.usage = event.usage;
    agent.model = event.model ?? agent.model;
    agent.durationMs = event.durationMs;
    agent.toolCalls = event.toolCalls;
    this.touch(run);
  }

  private applyAgentEnd(run: WorkflowRun, event: WorkflowAgentEndEvent): void {
    const agent = run.snapshot.agents.find((item) => item.id === event.index + 1);
    if (agent) {
      agent.status = event.result === null ? "error" : "done";
      agent.resultPreview = preview(event.result);
      agent.result = event.result;
      agent.tokens = event.tokens;
      agent.usage = event.usage;
      agent.cached = event.cached;
      agent.model = event.model;
      agent.durationMs = event.durationMs;
      agent.toolCalls = event.toolCalls;
    }
    this.touch(run);
  }

  private touch(run: WorkflowRun): void {
    run.snapshot = recomputeWorkflowSnapshot(run.snapshot);
    // Sum from the agents so the total stays correct across live updates, replays, and restarts.
    run.tokens = run.snapshot.agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0);
    this.notify();
  }
}

function markUnsettledAgents(snapshot: WorkflowSnapshot, status: "queued" | "skipped"): void {
  for (const agent of snapshot.agents) {
    if (agent.status === "running") {
      agent.status = status;
      if (status === "skipped") agent.error = "stopped";
    }
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && /\babort(?:ed)?\b/i.test(error.message);
}

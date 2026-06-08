# pi-dynamic-workflows

> Claude-Code-style dynamic workflows for [Pi](https://github.com/earendil-works/pi).

A Pi extension that adds a `workflow` tool. Instead of one assistant doing everything sequentially, the model writes a small JavaScript script that fans out the work across many isolated subagents, then synthesizes the results.

Great for codebase audits, multi-perspective review, large refactors, and fan-out research.

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code).

## Install

```bash
pi install npm:pi-dynamic-workflows
# or from a local checkout
pi install /path/to/pi-dynamic-workflows
```

Then in Pi:

```text
/reload
```

That's it. The extension registers a `workflow` tool and activates it on session start.

## Usage

Just ask Pi for a workflow in plain language:

```text
Run a workflow to inspect this repository and summarize the main modules.
```

The model will write a workflow script and call the `workflow` tool. Live progress shows up inline:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## The `/workflows` manager

Every run a workflow tool starts is registered for the session. Type `/workflows` to open a
focus-capturing, Claude-Code-style overlay: a header band with the workflow name, description, and
live status, then a bordered master/detail two-pane view, then a footer of controls.

```text
─────────────────────────────────────────────────────────────────────────────────────────
 audit_endpoints
 Audit every API endpoint under src/routes for missing auth checks   1/3 agents · 41s · running
┌─ Phases ───────────────────┬─ verify /users ──────────────────────────────────────────────┐
│  ✓ Scan  1/1               │  ▶ Running · Sonnet 4.6                                       │
│❯ ▶ Verify  0/2 · 2 running │  12.4k in · 5.2k out · 480.0k cached · $0.21 · 4 tools · 0m 9s│
│                            │                                                              │
│                            │  Activity · 4 tool calls so far                              │
│                            │    Read(routes/users.ts)                                     │
│                            │    Grep(requireAuth)                                         │
│                            │    ▸ Bash(rg -n "export const" routes/ …)                    │
└────────────────────────────┴──────────────────────────────────────────────────────────────┘
 ↑↓ agent · j/k scroll · esc back · x stop · r restart · p pause/resume
```

Pressing `Enter` drills in: run list → its phases → a phase's agents → a single agent's detail. The
left pane is always the navigation list; the right pane shows the selected phase's agents, and at the
deepest level the agent's detail — its status and model, the real token/cost breakdown, a prompt
preview, its tool calls, and the full outcome, scrollable with `j`/`k`. A run with a single phase
opens straight to its agents. `Esc` backs out one level and closes the overlay from the top.

The detail is **live**: while an agent is running, its activity (the tool calls it is making right
now, the in-flight one marked `▸`) is hoisted above the prompt and the clock ticks as it works, so
you can watch what is happening in the moment rather than a static prompt.

Each agent row carries the subagent's **real** usage harvested from its session — not an estimate.
The token line is broken down the way Pi's own status bar reports it: `input` and `output` are the
genuinely billed tokens, `cached` is the (large but cheap) context re-read from the prompt cache each
turn, and `$` is the real cost. Each subagent runs in its **own fresh session**, so these numbers are
that session's totals and have nothing to do with the parent conversation's context — it is not
re-reading your chat history. (A single conflated "total tokens" figure that folds the cache re-reads
back in is what made each agent look like it cost ~500k tokens; the breakdown shows the truth.)

| Key | Action |
| --- | --- |
| `↑` / `↓` (or `k` / `j`) | Move the selection |
| `Enter` / `→` | Drill into the selected run, phase, or agent |
| `Esc` / `←` | Back out one level; close from the run list |
| `j` / `k` | Scroll the agent detail when it overflows |
| `p` | Pause or resume the selected run |
| `x` | Stop the selected agent, or the whole run when a run is selected |
| `r` | Restart the selected agent |
| `s` | Save the run's script to `.pi/workflows/<name>.js` |

The overlay reads live state, so progress, token totals, and elapsed time update while runs are
still in flight. The same registry backs the inline tool display and the manager.

### Pause, resume, and restart

Runs are resumable within the session. The runtime journals each `agent()` call by its
deterministic call index, so re-running the same script replays completed results instantly and
only runs what is left:

- **Pause** (`p`) aborts in-flight subagents but keeps the journal. **Resume** (`p` again) re-runs
  the script: finished agents replay from the journal, the rest run live.
- **Restart** (`r`) drops the selected agent's journaled result and every later one (which depended
  on it), then relaunches — the unchanged prefix replays while the target and its successors run
  live. This also re-runs an agent that is currently stuck.
- **Stop** (`x` on a run) ends the run but keeps completed work, so you can still inspect it.

Journals live in memory for the session. Exiting Pi while a run is unfinished starts it fresh next
time.

## Workflow script shape

A workflow is plain JavaScript. The first statement must export literal metadata. `name` and `description` are required; `phases` is optional documentation for an expected outline. The live progress view is driven by `phase(...)` calls at runtime:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [
    { title: 'Scan' },
    { title: 'Analyze' },
  ],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent(
  'Summarize the main modules from this inventory:\n' + inventory,
  { label: 'module summary' },
)

return { inventory, summary }
```

Phases are discovered as the script runs, so conditional and loop-created phases work naturally. If a branch is skipped, its phase does not show up as an empty progress row.

### Editor IntelliSense

Reusable workflow files can opt into editor hints for workflow globals:

```js
/// <reference types="pi-dynamic-workflows/workflow" />
```

This declares `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, and `budget` for TypeScript-aware editors.

### Available globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text or, with `opts.schema`, a validated object. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Results are returned in input order. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current phase. Used for grouping in the live progress view. |
| `log(message)` | Append a workflow-level log line. |
| `args` | Optional JSON value passed in via the tool's `args` parameter. |
| `cwd`, `process.cwd()` | Current working directory for subagents. |
| `budget` | `{ total, spent(), remaining() }` token budget tracker. |

### Determinism rules

Workflow scripts are evaluated inside a Node `vm` sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`
- `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, template interpolation, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and the subagent will return a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
```

Under the hood this is a Pi `structured_output` tool with `terminate: true`, so the subagent ends on that call without an extra assistant turn.

## How it works

```text
user prompt
  → Pi model writes a workflow script
  → workflow tool parses + runs script in a vm sandbox
  → script calls agent(), parallel(), pipeline()
  → each agent() spawns an in-memory Pi subagent session
  → snapshots stream back as compact progress
  → final structured result returned to the parent assistant
```

Subagents run in fresh in-memory Pi sessions with the standard coding tools, so they can read files, run shell commands, and call structured output exactly like a normal Pi turn.

## Library modules

| File | Purpose |
| --- | --- |
| `src/workflow.ts` | AST-validated parser and sandboxed workflow runtime, including the resumable agent journal. |
| `src/registry.ts` | `WorkflowRegistry`: holds every run for the session and owns pause/resume/restart/stop. |
| `src/workflow-tool.ts` | The Pi `workflow` tool, prompt guidelines, rendering, abort handling. |
| `src/workflow-manager.ts` | The `/workflows` overlay component plus its pure view-model (navigation + rendering). |
| `src/workflow-command.ts` | Opens the manager overlay and saves a run's script. |
| `src/agent.ts` | `WorkflowAgent`, an in-memory Pi subagent runner. |
| `src/structured-output.ts` | Terminating structured-output tool backed by TypeBox/JSON Schema. |
| `src/display.ts` | Workflow snapshots and compact text renderers. |
| `extensions/workflow.ts` | The Pi extension entrypoint: registers the tool and the `/workflows` command. |

## Development

```bash
npm install
npm test     # biome check + tsc + unit tests
npm run dev
```

Unit tests cover the parser (`tests/workflow-parser.test.ts`), the runtime and its journal
(`tests/workflow-runtime.test.ts`), the run registry's lifecycle (`tests/workflow-registry.test.ts`),
and the manager's navigation and rendering (`tests/workflow-manager.test.ts`).

## Status

This is a prototype. It implements the core workflow primitive (script, subagents,
parallel/pipeline, phases, abort, structured output), the `/workflows` manager overlay, and
session-scoped resumable runs (pause/resume/restart backed by an agent journal). Runs are not yet
persisted across Pi restarts.

## License

MIT

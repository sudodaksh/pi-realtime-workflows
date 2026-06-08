import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowAgentSnapshot } from "../src/display.js";
import type { WorkflowRun } from "../src/registry.js";
import {
  agentDetailLines,
  clampDetailScroll,
  displayedRuns,
  formatCount,
  formatDuration,
  formatTokens,
  handleManagerKey,
  initialManagerState,
  type ManagerActions,
  type ManagerState,
  phaseGroups,
  renderManagerLines,
} from "../src/workflow-manager.js";

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const viewport = { rows: 24, cols: 80 };

function agent(over: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return { id: 1, label: "scan repo", phase: "Scan", prompt: "Scan the repo", status: "done", ...over };
}

function makeRun(over: Partial<WorkflowRun> = {}): WorkflowRun {
  const agents = over.snapshot?.agents ?? [agent()];
  return {
    id: "1",
    meta: { name: "demo_wf", description: "demo" },
    script: "",
    args: undefined,
    status: "running",
    journal: new Map(),
    tokens: 1234,
    startedAt: 0,
    runCount: 1,
    snapshot: {
      name: "demo_wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents,
      agentCount: agents.length,
      runningCount: agents.filter((a) => a.status === "running").length,
      doneCount: agents.filter((a) => a.status === "done").length,
      errorCount: 0,
    },
    ...over,
  };
}

function spyActions(): { actions: ManagerActions; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      pauseResume: (run) => calls.push(`pauseResume:${run.id}`),
      stopRun: (run) => calls.push(`stopRun:${run.id}`),
      stopAgent: (run, index) => calls.push(`stopAgent:${run.id}:${index}`),
      restartAgent: (run, index) => calls.push(`restartAgent:${run.id}:${index}`),
      save: (run) => calls.push(`save:${run.id}`),
      close: () => calls.push("close"),
    },
  };
}

const NOOP = spyActions().actions;

test("displayedRuns lists newest first", () => {
  const runs = [makeRun({ id: "1" }), makeRun({ id: "2" }), makeRun({ id: "3" })];
  assert.deepEqual(
    displayedRuns({ list: () => runs }).map((r) => r.id),
    ["3", "2", "1"],
  );
});

test("phaseGroups buckets agents by phase and adds an Unphased group", () => {
  const run = makeRun({
    snapshot: {
      name: "demo_wf",
      phases: ["Scan", "Review"],
      logs: [],
      agents: [
        agent({ id: 1, phase: "Scan" }),
        agent({ id: 2, phase: "Review", label: "review" }),
        agent({ id: 3, phase: undefined, label: "loose" }),
      ],
      agentCount: 3,
      runningCount: 0,
      doneCount: 3,
      errorCount: 0,
    },
  });
  assert.deepEqual(
    phaseGroups(run).map((g) => `${g.title}:${g.agents.length}`),
    ["Scan:1", "Review:1", "Unphased:1"],
  );
});

/** A run with two phases, so the phase pane is not auto-skipped on open. */
function twoPhaseRun(): WorkflowRun {
  return makeRun({
    snapshot: {
      name: "demo_wf",
      phases: ["Scan", "Review"],
      logs: [],
      agents: [agent({ id: 1, phase: "Scan" }), agent({ id: 2, phase: "Review", label: "review" })],
      agentCount: 2,
      runningCount: 0,
      doneCount: 2,
      errorCount: 0,
    },
  });
}

test("enter drills list -> run -> phase -> agent and esc backs out", () => {
  const runs = [twoPhaseRun()];
  let state = initialManagerState();
  assert.equal(state.level, "list");

  state = handleManagerKey(KEY.enter, state, runs, NOOP);
  assert.equal(state.level, "run");
  state = handleManagerKey(KEY.enter, state, runs, NOOP);
  assert.equal(state.level, "phase");
  state = handleManagerKey(KEY.enter, state, runs, NOOP);
  assert.equal(state.level, "agent");

  state = handleManagerKey(KEY.escape, state, runs, NOOP);
  assert.equal(state.level, "phase");
  state = handleManagerKey(KEY.left, state, runs, NOOP);
  assert.equal(state.level, "run");
  state = handleManagerKey(KEY.escape, state, runs, NOOP);
  assert.equal(state.level, "list");
});

test("opening a single-phase run skips the phase pane and lands on its agents", () => {
  const runs = [makeRun()];
  let state = handleManagerKey(KEY.enter, initialManagerState(), runs, NOOP);
  assert.equal(state.level, "phase", "one phase auto-skips the run-level phase list");
  state = handleManagerKey(KEY.escape, state, runs, NOOP);
  assert.equal(state.level, "list", "esc returns straight to the run list");
});

test("esc at the list level closes the manager", () => {
  const { actions, calls } = spyActions();
  handleManagerKey(KEY.escape, initialManagerState(), [makeRun()], actions);
  assert.deepEqual(calls, ["close"]);
});

test("up/down wrap around the run list", () => {
  const runs = [makeRun({ id: "1" }), makeRun({ id: "2" }), makeRun({ id: "3" })];
  let state = initialManagerState();
  assert.equal(state.runIndex, 0);
  state = handleManagerKey(KEY.up, state, runs, NOOP);
  assert.equal(state.runIndex, 2, "up from the top wraps to the bottom");
  state = handleManagerKey(KEY.down, state, runs, NOOP);
  assert.equal(state.runIndex, 0);
});

test("p pauses/resumes and s saves the selected run from the list", () => {
  const { actions, calls } = spyActions();
  const runs = [makeRun({ id: "7" })];
  handleManagerKey("p", initialManagerState(), runs, actions);
  handleManagerKey("s", initialManagerState(), runs, actions);
  assert.deepEqual(calls, ["pauseResume:7", "save:7"]);
});

test("x stops the whole run at the list level but a single agent at the agent level", () => {
  const runs = [makeRun({ id: "9", snapshot: { ...makeRun().snapshot, agents: [agent({ id: 5, label: "a5" })] } })];

  const top = spyActions();
  handleManagerKey("x", initialManagerState(), runs, top.actions);
  assert.deepEqual(top.calls, ["stopRun:9"]);

  const deep = spyActions();
  const agentLevel: ManagerState = { level: "agent", runIndex: 0, phaseIndex: 0, agentIndex: 0, detailScroll: 0 };
  handleManagerKey("x", agentLevel, runs, deep.actions);
  handleManagerKey("r", agentLevel, runs, deep.actions);
  assert.deepEqual(deep.calls, ["stopAgent:9:4", "restartAgent:9:4"], "agent id 5 maps to call index 4");
});

test("renderManagerLines shows the run list with a footer of controls", () => {
  const lines = renderManagerLines([makeRun()], initialManagerState(), theme, viewport, 5000);
  const text = lines.join("\n");
  assert.match(text, /Workflows/);
  assert.match(text, /demo_wf/);
  assert.match(text, /⏎ open/);
  assert.match(text, /esc close/);
});

test("renderManagerLines renders the agent detail with prompt text", () => {
  const runs = [makeRun()];
  const state: ManagerState = { level: "agent", runIndex: 0, phaseIndex: 0, agentIndex: 0, detailScroll: 0 };
  const text = renderManagerLines(runs, state, theme, viewport, 5000).join("\n");
  assert.match(text, /Prompt ·/);
  assert.match(text, /Scan the repo/);
  assert.match(text, /j\/k scroll/);
});

test("renderManagerLines surfaces run status and token totals in the list summary", () => {
  const paused = makeRun({ id: "1", status: "paused", tokens: 12_300 });
  const text = renderManagerLines([paused], initialManagerState(), theme, viewport, 5000).join("\n");
  assert.match(text, /Paused/);
  assert.match(text, /12\.3k tok/);
});

test("agentDetailLines shows status, model, prompt, activity and outcome", () => {
  const lines = agentDetailLines(
    agent({
      status: "done",
      prompt: "Inspect the repo",
      resultPreview: '{"ok":true}',
      tokens: 1500,
      model: "Sonnet 4.6",
      durationMs: 67_000,
      toolCalls: ["Bash(ls)", "Read(x)"],
    }),
  );
  const text = lines.join("\n");
  assert.match(text, /Completed · Sonnet 4\.6/);
  assert.match(text, /1\.5k tok · 2 tool calls · 1m 7s/);
  assert.match(text, /Prompt · 1 line/);
  assert.match(text, /Inspect the repo/);
  assert.match(text, /Activity · last 2 of 2 tool calls/);
  assert.match(text, /Outcome/);
  assert.match(text, /\{"ok":true\}/);
});

test("agentDetailLines streams live activity and a token breakdown while the agent runs", () => {
  const lines = agentDetailLines(
    agent({
      status: "running",
      startedAt: 1_000,
      durationMs: undefined,
      usage: { tokens: 17_600, input: 12_400, output: 5_200, cacheRead: 480_000, costUsd: 0.21 },
      model: "GPT-5.5",
      toolCalls: ["Bash(a)", "Bash(b)", "Read(c)"],
      result: undefined,
      resultPreview: undefined,
    }),
    61_000,
  );
  const text = lines.join("\n");
  assert.match(text, /▶ Running · GPT-5\.5/);
  // Honest breakdown — fresh input + output + cheap cache reads + real cost, not one inflated total.
  assert.match(text, /12\.4k in · 5\.2k out · 480\.0k cached · \$0\.210 · 3 tool calls · 1m 0s/);
  assert.match(text, /Activity · 3 tool calls so far/);
  assert.match(text, /▸ Read\(c\)/);
  assert.ok(text.indexOf("Activity") < text.indexOf("Prompt"), "activity is hoisted above the prompt while running");
});

test("agentDetailLines pretty-prints the full structured result as the outcome", () => {
  const lines = agentDetailLines(agent({ status: "done", result: { id: "log_1", ok: true, calls: 1 } }));
  const text = lines.join("\n");
  assert.match(text, /"id": "log_1"/);
  assert.match(text, /"ok": true/);
});

test("clampDetailScroll caps an over-scrolled detail offset to the last page", () => {
  const bigResult = { items: Array.from({ length: 40 }, (_, i) => ({ i, value: `row-${i}` })) };
  const runs = [makeRun({ snapshot: { ...makeRun().snapshot, agents: [agent({ result: bigResult })] } })];
  const smallViewport = { rows: 12, cols: 80 };
  const state: ManagerState = { level: "agent", runIndex: 0, phaseIndex: 0, agentIndex: 0, detailScroll: 9999 };
  const clamped = clampDetailScroll(state, runs, smallViewport);
  const totalLines = agentDetailLines(runs[0].snapshot.agents[0]).length;
  const body = Math.max(3, smallViewport.rows - 6);
  assert.equal(clamped.detailScroll, totalLines - body);
  assert.ok(clamped.detailScroll > 0);
});

test("formatDuration and formatTokens render compact values", () => {
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(64_000), "1m 4s");
  assert.equal(formatDuration(3_700_000), "1h 1m");
  assert.equal(formatTokens(950), "950 tok");
  assert.equal(formatTokens(12_300), "12.3k tok");
  assert.equal(formatTokens(2_000_000), "2.0M tok");
  assert.equal(formatCount(950), "950");
  assert.equal(formatCount(12_300), "12.3k");
  assert.equal(formatCount(2_000_000), "2.0M");
});

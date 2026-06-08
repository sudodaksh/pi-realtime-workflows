import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowAgentStatus } from "./display.js";
import type { WorkflowRegistry, WorkflowRun, WorkflowRunStatus } from "./registry.js";

/** Minimal slice of the host Theme the manager needs; the real Theme satisfies it structurally. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Background for the selected row, so the active selection reads as a highlighted band. */
const SELECT_BG = "selectedBg";

export type ManagerLevel = "list" | "run" | "phase" | "agent";

export interface ManagerState {
  level: ManagerLevel;
  runIndex: number;
  phaseIndex: number;
  agentIndex: number;
  /** Scroll offset for the agent detail view (driven by j/k). */
  detailScroll: number;
}

export interface ManagerViewport {
  rows: number;
  cols: number;
}

export interface ManagerActions {
  pauseResume(run: WorkflowRun): void;
  stopRun(run: WorkflowRun): void;
  stopAgent(run: WorkflowRun, agentIndex: number): void;
  restartAgent(run: WorkflowRun, agentIndex: number): void;
  save(run: WorkflowRun): void;
  close(): void;
}

export interface PhaseGroup {
  title: string;
  agents: WorkflowAgentSnapshot[];
}

export function initialManagerState(): ManagerState {
  return { level: "list", runIndex: 0, phaseIndex: 0, agentIndex: 0, detailScroll: 0 };
}

/** Runs newest-first, which is how the manager lists them. */
export function displayedRuns(registry: Pick<WorkflowRegistry, "list">): WorkflowRun[] {
  return [...registry.list()].reverse();
}

/** Ordered phase buckets for a run, mirroring the inline display's phase derivation. */
export function phaseGroups(run: WorkflowRun): PhaseGroup[] {
  const snapshot = run.snapshot;
  const order: string[] = [];
  const push = (title: string) => {
    if (!order.includes(title)) order.push(title);
  };
  for (const phase of snapshot.phases) push(phase);
  if (snapshot.currentPhase) push(snapshot.currentPhase);
  for (const agent of snapshot.agents) if (agent.phase) push(agent.phase);

  const groups: PhaseGroup[] = order.map((title) => ({
    title,
    agents: snapshot.agents.filter((agent) => agent.phase === title),
  }));
  const unphased = snapshot.agents.filter((agent) => !agent.phase);
  if (unphased.length) groups.push({ title: "Unphased", agents: unphased });
  return groups.filter((group) => group.agents.length > 0 || group.title === snapshot.currentPhase);
}

interface Selection {
  runs: WorkflowRun[];
  run?: WorkflowRun;
  groups: PhaseGroup[];
  group?: PhaseGroup;
  agent?: WorkflowAgentSnapshot;
}

function select(runs: WorkflowRun[], state: ManagerState): Selection {
  const run = runs[clamp(state.runIndex, runs.length)];
  if (!run) return { runs, groups: [] };
  const groups = phaseGroups(run);
  const group = groups[clamp(state.phaseIndex, groups.length)];
  const agent = group?.agents[clamp(state.agentIndex, group.agents.length)];
  return { runs, run, groups, group, agent };
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/**
 * Apply a key press to the manager. Returns the next nav state and performs any control-side
 * effect (pause/stop/restart/save/close) via `actions`. Pure with respect to state; side effects
 * are confined to `actions`, which makes the navigation easy to unit test.
 */
export function handleManagerKey(
  data: string,
  state: ManagerState,
  runs: WorkflowRun[],
  actions: ManagerActions,
): ManagerState {
  const sel = select(runs, state);

  if (matchesKey(data, Key.escape)) return back(state, sel, actions);
  if (matchesKey(data, Key.left)) return state.level === "list" ? state : back(state, sel, actions);

  // In the agent detail view, j/k scroll the right pane while ↑/↓ change which agent is shown.
  if (state.level === "agent" && data === "j") return { ...state, detailScroll: state.detailScroll + 1 };
  if (state.level === "agent" && data === "k") return { ...state, detailScroll: Math.max(0, state.detailScroll - 1) };
  if (isUp(data, state.level)) return move(state, runs, -1);
  if (isDown(data, state.level)) return move(state, runs, +1);

  if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) return drillIn(state, sel);

  if (data === "p" && sel.run) {
    actions.pauseResume(sel.run);
    return state;
  }
  if (data === "x" && sel.run) {
    if ((state.level === "phase" || state.level === "agent") && sel.agent) {
      actions.stopAgent(sel.run, sel.agent.id - 1);
    } else {
      actions.stopRun(sel.run);
    }
    return state;
  }
  if (data === "r" && sel.run && sel.agent && (state.level === "phase" || state.level === "agent")) {
    actions.restartAgent(sel.run, sel.agent.id - 1);
    return state;
  }
  if (data === "s" && sel.run) {
    actions.save(sel.run);
    return state;
  }
  return state;
}

function isUp(data: string, level: ManagerLevel): boolean {
  if (matchesKey(data, Key.up)) return true;
  return level !== "agent" && data === "k";
}

function isDown(data: string, level: ManagerLevel): boolean {
  if (matchesKey(data, Key.down)) return true;
  return level !== "agent" && data === "j";
}

function move(state: ManagerState, runs: WorkflowRun[], delta: number): ManagerState {
  const sel = select(runs, state);
  if (state.level === "list") {
    return { ...state, runIndex: wrap(state.runIndex + delta, sel.runs.length), phaseIndex: 0, agentIndex: 0 };
  }
  if (state.level === "run") {
    return { ...state, phaseIndex: wrap(state.phaseIndex + delta, sel.groups.length), agentIndex: 0 };
  }
  // "phase" and "agent" both navigate the agent list (the agent view updates its detail live).
  return {
    ...state,
    agentIndex: wrap(state.agentIndex + delta, sel.group?.agents.length ?? 0),
    detailScroll: 0,
  };
}

function wrap(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function drillIn(state: ManagerState, sel: Selection): ManagerState {
  if (state.level === "list" && sel.run) {
    // Skip the phase pane when there is nothing to choose between.
    const level = sel.groups.length <= 1 ? "phase" : "run";
    return { ...state, level, phaseIndex: 0, agentIndex: 0 };
  }
  if (state.level === "run" && sel.group) return { ...state, level: "phase", agentIndex: 0 };
  if (state.level === "phase" && sel.agent) return { ...state, level: "agent", detailScroll: 0 };
  return state;
}

function back(state: ManagerState, sel: Selection, actions: ManagerActions): ManagerState {
  switch (state.level) {
    case "list":
      actions.close();
      return state;
    case "run":
      return { ...state, level: "list" };
    case "phase":
      return sel.groups.length <= 1 ? { ...state, level: "list" } : { ...state, level: "run" };
    case "agent":
      return { ...state, level: "phase", detailScroll: 0 };
  }
}

// ---------------------------------------------------------------------------
// Keep the j/k scroll honest by clamping the detail offset before keys apply.
// ---------------------------------------------------------------------------

export function clampDetailScroll(state: ManagerState, runs: WorkflowRun[], viewport: ManagerViewport): ManagerState {
  if (state.level !== "agent") return state;
  const sel = select(runs, state);
  if (!sel.agent) return state;
  const lines = agentDetailLines(sel.agent);
  const max = Math.max(0, lines.length - paneBodyHeight(viewport));
  if (state.detailScroll <= max) return state;
  return { ...state, detailScroll: max };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Body rows in the two-pane area: total minus top rule, 2 header lines, 2 pane borders, 1 footer. */
function paneBodyHeight(viewport: ManagerViewport): number {
  return Math.max(3, viewport.rows - 6);
}

interface PaneRow {
  text: string;
  selected?: boolean;
}

interface PaneSpec {
  title: string;
  footer: string;
  rows: PaneRow[];
  active: boolean;
}

interface ManagerView {
  name: string;
  subtitle: string;
  status: string;
  left: PaneSpec;
  right: PaneSpec;
  footer: string;
}

export function renderManagerLines(
  runs: WorkflowRun[],
  state: ManagerState,
  theme: ThemeLike,
  viewport: ManagerViewport,
  now: number,
): string[] {
  const cols = Math.max(40, viewport.cols);
  const bodyH = paneBodyHeight(viewport);
  const leftWidth = Math.min(40, Math.max(18, Math.floor(cols * 0.3)));
  const sel = select(runs, state);
  const view = buildView(sel, state, theme, cols, leftWidth, bodyH, now);

  return [
    theme.fg("dim", "─".repeat(cols)),
    ...headerBand(theme, cols, view.name, view.subtitle, view.status),
    ...renderTwoPane(theme, cols, leftWidth, bodyH, view.left, view.right),
    ` ${theme.fg("dim", view.footer)}`,
  ];
}

function buildView(
  sel: Selection,
  state: ManagerState,
  theme: ThemeLike,
  cols: number,
  leftWidth: number,
  bodyH: number,
  now: number,
): ManagerView {
  const innerL = leftWidth;
  const innerR = cols - leftWidth - 3;
  switch (state.level) {
    case "list":
      return buildListView(sel, state, theme, bodyH, now);
    case "run":
      return buildPhasesView(sel, state, theme, innerR, bodyH, now, "phases");
    case "phase":
      return buildPhasesView(sel, state, theme, innerR, bodyH, now, "agents");
    default:
      return buildAgentView(sel, state, theme, innerL, bodyH, now);
  }
}

function buildListView(sel: Selection, state: ManagerState, theme: ThemeLike, bodyH: number, now: number): ManagerView {
  const runs = sel.runs;
  const running = runs.filter((run) => run.status === "running").length;
  const left = windowList(
    runs.map((run) => runRowText(theme, run)),
    state.runIndex,
    bodyH,
  );
  const summary = sel.run ? runSummaryRows(theme, sel.run, now) : [{ text: theme.fg("muted", "No workflows yet.") }];
  return {
    name: "Workflows",
    subtitle: `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
    status: running ? `${running} running` : "",
    left: { title: "Runs", footer: left.footer, rows: left.rows, active: true },
    right: { title: sel.run?.meta.name ?? "", footer: "", rows: summary, active: false },
    footer: "↑↓ select · ⏎ open · p pause/resume · x stop · s save · esc close",
  };
}

function buildPhasesView(
  sel: Selection,
  state: ManagerState,
  theme: ThemeLike,
  innerR: number,
  bodyH: number,
  now: number,
  activePane: "phases" | "agents",
): ManagerView {
  const run = sel.run;
  const phasesActive = activePane === "phases";
  const left = windowList(
    sel.groups.map((group) => phaseRowText(theme, group)),
    state.phaseIndex,
    bodyH,
  );
  const agents = sel.group?.agents ?? [];
  const right = windowList(
    agents.map((agent) => agentRowText(theme, agent, innerR - 2, true, now)),
    phasesActive ? -1 : state.agentIndex,
    bodyH,
  );
  return {
    name: run?.meta.name ?? "Workflow",
    subtitle: run?.meta.description ?? "",
    status: run ? runStatusLine(run, now) : "",
    left: { title: "Phases", footer: left.footer, rows: left.rows, active: phasesActive },
    right: {
      title: sel.group ? `${sel.group.title} · ${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : "Agents",
      footer: right.footer,
      rows: right.rows,
      active: !phasesActive,
    },
    footer: phasesActive
      ? "↑↓ phase · ⏎ open · esc back · p pause/resume · x stop · s save"
      : "↑↓ agent · ⏎ open · esc back · x stop · r restart · p pause/resume",
  };
}

function buildAgentView(
  sel: Selection,
  state: ManagerState,
  theme: ThemeLike,
  innerL: number,
  bodyH: number,
  now: number,
): ManagerView {
  const run = sel.run;
  const agents = sel.group?.agents ?? [];
  const left = windowList(
    agents.map((agent) => agentRowText(theme, agent, innerL - 2, false, now)),
    state.agentIndex,
    bodyH,
  );
  const detail = sel.agent
    ? windowDetail(theme, agentDetailLines(sel.agent, now), state.detailScroll, bodyH)
    : { rows: [], footer: "" };
  return {
    name: run?.meta.name ?? "Workflow",
    subtitle: run?.meta.description ?? "",
    status: run ? runStatusLine(run, now) : "",
    left: { title: sel.group?.title ?? "Agents", footer: left.footer, rows: left.rows, active: true },
    right: { title: sel.agent?.label ?? "", footer: detail.footer, rows: detail.rows, active: false },
    footer: "↑↓ agent · j/k scroll · esc back · x stop · r restart · s save",
  };
}

// ---------------------------------------------------------------------------
// Pane content builders
// ---------------------------------------------------------------------------

function windowList(texts: string[], selectedIndex: number, height: number): { rows: PaneRow[]; footer: string } {
  if (texts.length === 0) return { rows: [], footer: "" };
  const idxs = windowed(texts.length, Math.max(0, selectedIndex), height);
  const rows = idxs.map((i) => ({ text: texts[i], selected: i === selectedIndex }));
  if (texts.length <= height) return { rows, footer: "" };
  const first = idxs[0];
  const last = idxs[idxs.length - 1];
  const arrow = last < texts.length - 1 ? " ↓" : first > 0 ? " ↑" : "";
  return { rows, footer: `${first + 1}-${last + 1} of ${texts.length}${arrow}` };
}

function windowDetail(
  theme: ThemeLike,
  lines: string[],
  scroll: number,
  height: number,
): { rows: PaneRow[]; footer: string } {
  const start = Math.min(Math.max(0, scroll), Math.max(0, lines.length - height));
  const rows = lines.slice(start, start + height).map((line) => ({ text: styleDetail(theme, line) }));
  if (lines.length <= height) return { rows, footer: "" };
  return { rows, footer: `${start + 1}-${Math.min(start + height, lines.length)} of ${lines.length} ↕` };
}

function runRowText(theme: ThemeLike, run: WorkflowRun): string {
  return `${theme.fg(statusColor(run.status), statusIcon(run.status))} ${theme.fg("text", run.meta.name)}`;
}

function runSummaryRows(theme: ThemeLike, run: WorkflowRun, now: number): PaneRow[] {
  const lines = [
    `${statusIcon(run.status)} ${capitalize(statusWord(run.status))}`,
    `${run.snapshot.doneCount}/${run.snapshot.agentCount} agents · ${formatDuration(elapsed(run, now))} · ${formatTokens(run.tokens)}`,
  ];
  const groups = phaseGroups(run);
  if (groups.length) {
    lines.push("", "Phases");
    for (const group of groups) {
      const done = group.agents.filter((a) => a.status === "done").length;
      lines.push(`  ${phaseGlyph(group)} ${group.title} ${done}/${group.agents.length}`);
    }
  }
  return lines.map((line) => ({ text: styleDetail(theme, line) }));
}

function phaseRowText(theme: ThemeLike, group: PhaseGroup): string {
  const done = group.agents.filter((a) => a.status === "done").length;
  const running = group.agents.filter((a) => a.status === "running").length;
  const counts = `${done}/${group.agents.length}${running ? ` · ${running} running` : ""}`;
  return `${theme.fg(phaseColor(group), phaseGlyph(group))} ${theme.fg("text", group.title)}  ${theme.fg("dim", counts)}`;
}

function agentRowText(
  theme: ThemeLike,
  agent: WorkflowAgentSnapshot,
  width: number,
  withMeta: boolean,
  now?: number,
): string {
  const left = `${theme.fg(statusColor(agent.status), statusIcon(agent.status))} ${theme.fg("text", agent.label)}`;
  if (!withMeta) return left;
  const meta = agentMeta(agent, now);
  return meta ? twoColText(left, theme.fg("dim", meta), width) : left;
}

function agentMeta(agent: WorkflowAgentSnapshot, now?: number): string {
  const dur = liveDuration(agent, now);
  return [
    agent.model ?? null,
    agent.tokens ? formatTokens(agent.tokens) : null,
    agent.toolCalls?.length ? `${agent.toolCalls.length} ${agent.toolCalls.length === 1 ? "tool" : "tools"}` : null,
    dur != null ? formatDuration(dur) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Plain (unstyled) detail lines for an agent; styling and scrolling happen in the caller. While the
 * agent is running, Activity is hoisted above the prompt and the clock ticks off `now`, so the pane
 * shows what is happening in the moment instead of a static prompt.
 */
export function agentDetailLines(agent: WorkflowAgentSnapshot, now?: number): string[] {
  const lines: string[] = [];
  const running = agent.status === "running";
  lines.push(
    [`${statusIcon(agent.status)} ${capitalize(statusWord(agent.status))}`, agent.model, agent.cached ? "cached" : null]
      .filter(Boolean)
      .join(" · "),
  );
  const stats = statLine(agent, now);
  if (stats) lines.push(stats);

  if (running) {
    // The live action goes first; the prompt is reference material and sits below it.
    pushActivity(lines, agent, true);
    pushPrompt(lines, agent);
  } else {
    pushPrompt(lines, agent);
    pushActivity(lines, agent, false);
    pushOutcome(lines, agent);
  }
  return lines;
}

/** The metrics line: the real input/output/cache/cost breakdown when known, else the headline tokens. */
function statLine(agent: WorkflowAgentSnapshot, now?: number): string {
  const dur = liveDuration(agent, now);
  const tools = agent.toolCalls?.length
    ? `${agent.toolCalls.length} tool ${agent.toolCalls.length === 1 ? "call" : "calls"}`
    : null;
  const time = dur != null ? formatDuration(dur) : null;
  if (agent.usage) {
    const u = agent.usage;
    return [
      `${formatCount(u.input)} in`,
      `${formatCount(u.output)} out`,
      u.cacheRead ? `${formatCount(u.cacheRead)} cached` : null,
      u.costUsd ? formatCost(u.costUsd) : null,
      tools,
      time,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [agent.tokens ? formatTokens(agent.tokens) : null, tools, time].filter(Boolean).join(" · ");
}

function pushPrompt(lines: string[], agent: WorkflowAgentSnapshot): void {
  const promptLines = wrapPlain(agent.prompt, 86);
  lines.push("", `Prompt · ${promptLines.length} ${promptLines.length === 1 ? "line" : "lines"}`);
  const previewCount = Math.min(promptLines.length, 12);
  for (const line of promptLines.slice(0, previewCount)) lines.push(`  ${line}`);
  if (promptLines.length > previewCount) lines.push(`  … ${promptLines.length - previewCount} more lines`);
}

function pushActivity(lines: string[], agent: WorkflowAgentSnapshot, running: boolean): void {
  const calls = agent.toolCalls ?? [];
  if (running) {
    lines.push("", `Activity · ${calls.length} tool ${calls.length === 1 ? "call" : "calls"} so far`);
    if (calls.length === 0) {
      lines.push("  running — no tool calls yet…");
      return;
    }
    const slice = calls.slice(-12);
    for (let i = 0; i < slice.length; i++) {
      // Mark the last call — the one currently in flight — so the live action stands out.
      lines.push(`  ${i === slice.length - 1 ? "▸ " : ""}${slice[i]}`);
    }
    return;
  }
  if (calls.length === 0) return;
  const shown = Math.min(3, calls.length);
  lines.push("", `Activity · last ${shown} of ${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`);
  for (const call of calls.slice(-shown)) lines.push(`  ${call}`);
}

function pushOutcome(lines: string[], agent: WorkflowAgentSnapshot): void {
  if (agent.error) {
    lines.push("", "Error");
    for (const line of wrapPlain(agent.error, 86)) lines.push(`  ${line}`);
  } else if (agent.result !== undefined) {
    lines.push("", "Outcome");
    for (const line of outcomeLines(agent.result)) lines.push(`  ${line}`);
  } else if (agent.resultPreview) {
    lines.push("", "Outcome");
    for (const line of wrapPlain(agent.resultPreview, 86)) lines.push(`  ${line}`);
  }
}

/** Elapsed time for an agent: ticks off `now` while it runs, freezes at its recorded duration after. */
function liveDuration(agent: WorkflowAgentSnapshot, now?: number): number | undefined {
  if (agent.status === "running" && now != null && agent.startedAt != null) return now - agent.startedAt;
  return agent.durationMs;
}

function outcomeLines(result: unknown): string[] {
  if (typeof result === "string") return wrapPlain(result, 86);
  try {
    return JSON.stringify(result, null, 2).split("\n");
  } catch {
    return wrapPlain(String(result), 86);
  }
}

function styleDetail(theme: ThemeLike, line: string): string {
  if (!line) return "";
  // Indented lines are content; flush-left lines are section headers or the status line.
  return line.startsWith(" ") ? theme.fg("text", line) : theme.bold(theme.fg("accent", line));
}

// ---------------------------------------------------------------------------
// Two-pane box composition
// ---------------------------------------------------------------------------

function renderTwoPane(
  theme: ThemeLike,
  cols: number,
  leftWidth: number,
  height: number,
  left: PaneSpec,
  right: PaneSpec,
): string[] {
  const innerL = leftWidth;
  const innerR = cols - leftWidth - 3;
  const b = (s: string) => theme.fg("border", s);
  const lines: string[] = [];
  lines.push(b("┌") + titleBar(theme, left.title, innerL) + b("┬") + titleBar(theme, right.title, innerR) + b("┐"));
  for (let r = 0; r < height; r++) {
    lines.push(
      b("│") +
        cell(theme, left.rows[r], innerL, left.active) +
        b("│") +
        cell(theme, right.rows[r], innerR, right.active) +
        b("│"),
    );
  }
  lines.push(b("└") + footBar(theme, left.footer, innerL) + b("┴") + footBar(theme, right.footer, innerR) + b("┘"));
  return lines;
}

function cell(theme: ThemeLike, row: PaneRow | undefined, width: number, active: boolean): string {
  const selected = Boolean(row?.selected);
  const caret = selected ? (active ? theme.fg("accent", "❯ ") : theme.fg("dim", "› ")) : "  ";
  const body = truncateToWidth(row?.text ?? "", width - 2, "…", true);
  const content = caret + body;
  return selected && active ? fillBackground(theme, content) : content;
}

/**
 * Wrap a line in the selection background, re-arming it after any full reset (`\x1b[0m`) the
 * truncator injected — otherwise a truncated row's highlight would stop at the ellipsis.
 */
function fillBackground(theme: ThemeLike, content: string): string {
  const probe = theme.bg(SELECT_BG, "\u0000");
  const at = probe.indexOf("\u0000");
  const open = probe.slice(0, at);
  const close = probe.slice(at + 1);
  const rearmed = content.split("\x1b[0m").join(`\x1b[0m${open}`);
  return `${open}${rearmed}${close}`;
}

function titleBar(theme: ThemeLike, title: string, width: number): string {
  const label = title ? ` ${title} ` : "";
  const clipped = visibleWidth(label) > width - 1 ? truncateToWidth(label, width - 1, "…", false) : label;
  const dashes = Math.max(0, width - 1 - visibleWidth(clipped));
  return theme.fg("border", "─") + theme.fg("muted", clipped) + theme.fg("border", "─".repeat(dashes));
}

function footBar(theme: ThemeLike, footer: string, width: number): string {
  if (!footer) return theme.fg("border", "─".repeat(width));
  const label = ` ${footer} `;
  const clipped = visibleWidth(label) > width - 1 ? truncateToWidth(label, width - 1, "…", false) : label;
  const dashes = Math.max(0, width - 1 - visibleWidth(clipped));
  return theme.fg("border", "─".repeat(dashes)) + theme.fg("dim", clipped) + theme.fg("border", "─");
}

function headerBand(theme: ThemeLike, cols: number, name: string, subtitle: string, status: string): string[] {
  const title = ` ${theme.bold(theme.fg("accent", name))}`;
  const second = twoColText(` ${theme.fg("dim", subtitle)}`, status ? `${theme.fg("dim", status)} ` : "", cols);
  return [title, second];
}

/** Place `left` and `right` on one line `width` wide, right-aligning `right` (truncating `left` to fit). */
function twoColText(left: string, right: string, width: number): string {
  const rw = visibleWidth(right);
  const lt = truncateToWidth(left, Math.max(1, width - rw - 1), "…", false);
  const gap = Math.max(1, width - visibleWidth(lt) - rw);
  return lt + " ".repeat(gap) + right;
}

function statusWord(status: WorkflowRunStatus | WorkflowAgentStatus): string {
  switch (status) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "skipped":
      return "stopped";
    default:
      return status;
  }
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function phaseGlyph(group: PhaseGroup): string {
  if (group.agents.some((a) => a.status === "running")) return "▶";
  if (group.agents.some((a) => a.status === "error")) return "✗";
  if (group.agents.length && group.agents.every((a) => a.status === "done")) return "✓";
  return "•";
}

function phaseColor(group: PhaseGroup): string {
  if (group.agents.some((a) => a.status === "running")) return "accent";
  if (group.agents.some((a) => a.status === "error")) return "error";
  if (group.agents.length && group.agents.every((a) => a.status === "done")) return "success";
  return "text";
}

function runStatusLine(run: WorkflowRun, now: number): string {
  return `${run.snapshot.doneCount}/${run.snapshot.agentCount} agents · ${formatDuration(elapsed(run, now))} · ${statusWord(run.status)}`;
}

function statusIcon(status: WorkflowRunStatus | WorkflowAgentStatus): string {
  switch (status) {
    case "running":
      return "▶";
    case "paused":
      return "⏸";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "stopped":
    case "skipped":
      return "■";
    case "queued":
      return "○";
    default:
      return "•";
  }
}

function statusColor(status: WorkflowRunStatus | WorkflowAgentStatus): string {
  switch (status) {
    case "running":
      return "accent";
    case "done":
      return "success";
    case "error":
      return "error";
    case "paused":
    case "stopped":
    case "skipped":
    case "queued":
      return "warning";
    default:
      return "text";
  }
}

function elapsed(run: WorkflowRun, now: number): number {
  return (run.endedAt ?? now) - run.startedAt;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}

/** A bare token count without the `tok` suffix, for the `12.4k in · 5.2k out` breakdown line. */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

/** Indices of a window that keeps `selected` visible within `size` rows. */
function windowed(length: number, selected: number, size: number): number[] {
  if (length <= size) return range(0, length);
  let start = Math.max(0, Math.min(selected - Math.floor(size / 2), length - size));
  if (selected < start) start = selected;
  if (selected >= start + size) start = selected - size + 1;
  return range(start, start + size);
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text).split("\n")) {
    let line = rawLine;
    if (line.length === 0) {
      out.push("");
      continue;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component wrapper
// ---------------------------------------------------------------------------

export interface WorkflowManagerComponentOptions {
  registry: WorkflowRegistry;
  theme: ThemeLike;
  tui: Pick<TUI, "requestRender">;
  onClose: () => void;
  onSave: (run: WorkflowRun) => void;
  now?: () => number;
}

/**
 * The `/workflows` overlay: a focus-capturing component that renders the run list and drill-down
 * views, forwards keys to {@link handleManagerKey}, and re-renders whenever the registry changes
 * or the once-a-second clock ticks (so elapsed times advance while a run is live).
 */
export class WorkflowManagerComponent implements Component {
  private state = initialManagerState();
  private viewport: ManagerViewport = { rows: 24, cols: 80 };
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly options: WorkflowManagerComponentOptions) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.registry.subscribe(() => options.tui.requestRender());
    this.ticker = setInterval(() => options.tui.requestRender(), 1000);
    if (typeof this.ticker === "object" && "unref" in this.ticker) this.ticker.unref?.();
  }

  setSize(cols: number, rows: number): void {
    this.viewport = { cols, rows };
  }

  handleInput(data: string): void {
    const runs = displayedRuns(this.options.registry);
    this.state = clampDetailScroll(this.state, runs, this.viewport);
    this.state = handleManagerKey(data, this.state, runs, this.actions());
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (!this.viewport.cols) this.viewport = { ...this.viewport, cols: width };
    const runs = displayedRuns(this.options.registry);
    return renderManagerLines(runs, this.state, this.options.theme, { ...this.viewport, cols: width }, this.now());
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
    clearInterval(this.ticker);
  }

  private actions(): ManagerActions {
    const { registry, onClose, onSave } = this.options;
    return {
      pauseResume: (run) => {
        if (run.status === "running") registry.pause(run.id);
        else if (run.status === "paused") registry.resume(run.id);
      },
      stopRun: (run) => registry.stop(run.id),
      stopAgent: (run, agentIndex) => registry.stopAgent(run.id, agentIndex),
      restartAgent: (run, agentIndex) => void registry.restartAgent(run.id, agentIndex),
      save: (run) => onSave(run),
      close: onClose,
    };
  }
}

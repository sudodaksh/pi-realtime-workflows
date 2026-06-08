import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowRegistry } from "../src/registry.js";

interface AgentProgress {
  usage: { tokens: number; input: number; output: number; cacheRead: number; costUsd: number };
  model?: string;
  durationMs: number;
  toolCalls: string[];
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Fake agent whose runs are gated by the test and that rejects when its signal aborts. */
function gatedAgent() {
  const gates: Array<{ prompt: string; finish: () => void }> = [];
  let callCount = 0;
  const agent = {
    run(prompt: string, opts?: { signal?: AbortSignal }): Promise<string> {
      callCount++;
      return new Promise<string>((resolve, reject) => {
        gates.push({ prompt, finish: () => resolve(`result:${prompt}`) });
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  return { agent, gates, getCallCount: () => callCount };
}

const TWO_STEP = `export const meta = { name: 'two_step', description: 'Two sequential agents' }
phase('Work')
const a = await agent('one', { label: 'one' })
const b = await agent('two', { label: 'two' })
return { a, b }
`;

let nowValue = 0;
const clock = () => ++nowValue;

test("registry runs a workflow to completion", async () => {
  const { agent, gates } = gatedAgent();
  const registry = new WorkflowRegistry({ clock });
  const launch = registry.launch({
    script: TWO_STEP,
    meta: { name: "two_step", description: "Two sequential agents" },
    options: { agent },
  });

  await waitFor(() => gates.length === 1, "first agent started");
  gates[0].finish();
  await waitFor(() => gates.length === 2, "second agent started");
  gates[1].finish();

  const run = await launch;
  assert.equal(run.status, "done");
  assert.equal(run.journal.size, 2);
  assert.equal((run.result as { a: string; b: string }).a, "result:one");
  assert.ok(run.tokens > 0);
});

test("registry streams live agent progress onto the running snapshot", async () => {
  let report: ((stats: AgentProgress) => void) | undefined;
  const agent = {
    run(_prompt: string, opts?: { onProgress?: (stats: AgentProgress) => void }): Promise<string> {
      report = opts?.onProgress;
      return new Promise<string>(() => {}); // never resolves — the agent stays running
    },
  };
  const registry = new WorkflowRegistry({ clock });
  registry.start({
    script: `export const meta = { name: 'live', description: 'Live progress' }
phase('Work')
await agent('go', { label: 'worker' })
return { ok: true }
`,
    meta: { name: "live", description: "Live progress" },
    options: { agent },
  });

  await waitFor(() => report !== undefined, "agent started and exposed onProgress");
  report?.({
    usage: { tokens: 900, input: 700, output: 200, cacheRead: 12_000, costUsd: 0.01 },
    model: "Sonnet 4.6",
    durationMs: 1500,
    toolCalls: ["Bash(npm test)"],
  });

  const run = registry.list()[0];
  await waitFor(() => (run.snapshot.agents[0]?.toolCalls?.length ?? 0) === 1, "tool call streamed onto the snapshot");
  const live = run.snapshot.agents[0];
  assert.equal(live.status, "running", "the agent is still in flight");
  assert.equal(live.tokens, 900);
  assert.equal(live.usage?.cacheRead, 12_000, "the cache-read breakdown is available for the detail view");
  assert.equal(run.tokens, 900, "the run total reflects the live agent");
});

test("registry pauses mid-run keeping the journal, then resumes from it", async () => {
  const { agent, gates, getCallCount } = gatedAgent();
  const registry = new WorkflowRegistry({ clock });
  const run = registry
    .launch({
      script: TWO_STEP,
      meta: { name: "two_step", description: "Two sequential agents" },
      options: { agent },
    })
    .then((settled) => settled);

  await waitFor(() => gates.length === 1, "first agent started");
  gates[0].finish();
  await waitFor(() => gates.length === 2, "second agent started");

  const id = registry.list()[0].id;
  registry.pause(id);

  const paused = await run;
  assert.equal(paused.status, "paused");
  assert.equal(paused.journal.size, 1, "completed agent stays journaled");
  assert.equal(getCallCount(), 2, "two agents were attempted before pause");

  registry.resume(id);
  await waitFor(() => gates.length === 3, "second agent re-runs live on resume");
  gates[2].finish();

  await waitFor(() => registry.get(id)?.status === "done", "run completes after resume");
  const done = registry.get(id);
  assert.equal(getCallCount(), 3, "only the unfinished agent re-ran; the first replayed from journal");
  assert.equal((done?.result as { b: string }).b, "result:two");
});

test("registry stop makes a paused run terminal", async () => {
  const { agent, gates } = gatedAgent();
  const registry = new WorkflowRegistry({ clock });
  const launch = registry.launch({
    script: TWO_STEP,
    meta: { name: "two_step", description: "Two sequential agents" },
    options: { agent },
  });

  await waitFor(() => gates.length === 1, "first agent started");
  gates[0].finish();
  await waitFor(() => gates.length === 2, "second agent started");

  const id = registry.list()[0].id;
  registry.pause(id);
  await launch;
  registry.stop(id);

  assert.equal(registry.get(id)?.status, "stopped");
});

test("registry restartAgent replays the prefix and re-runs from the target", async () => {
  const { agent, gates, getCallCount } = gatedAgent();
  const registry = new WorkflowRegistry({ clock });
  const launch = registry.launch({
    script: TWO_STEP,
    meta: { name: "two_step", description: "Two sequential agents" },
    options: { agent },
  });

  await waitFor(() => gates.length === 1, "first agent started");
  gates[0].finish();
  await waitFor(() => gates.length === 2, "second agent started");
  gates[1].finish();
  const run = await launch;
  assert.equal(run.status, "done");
  assert.equal(getCallCount(), 2);

  const id = run.id;
  const restart = registry.restartAgent(id, 1);
  await waitFor(() => gates.length === 3, "target agent re-runs");
  gates[2].finish();
  await restart;
  await waitFor(() => registry.get(id)?.status === "done", "run completes after restart");

  assert.equal(getCallCount(), 3, "only the restarted agent re-ran; index 0 replayed from journal");
});

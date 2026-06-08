import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow replays journaled results and only runs new agents on resume", async () => {
  const calls: string[] = [];
  const countingAgent = {
    async run(prompt: string): Promise<string> {
      calls.push(prompt);
      return `result:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'resume_demo', description: 'Resume from a journal' }
phase('Work')
const a = await agent('one', { label: 'one' })
const b = await agent('two', { label: 'two' })
return { a, b }
`;
  const journal = new Map();

  const first = await runWorkflow(script, { agent: countingAgent, journal });
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(first.journal.size, 2);

  const cachedFlags: boolean[] = [];
  const second = await runWorkflow(script, {
    agent: countingAgent,
    journal,
    onAgentStart: (event) => cachedFlags.push(event.cached),
  });

  assert.deepEqual(calls, ["one", "two"], "no agent re-runs when nothing changed");
  assert.deepEqual(cachedFlags, [true, true]);
  assert.equal(JSON.stringify(second.result), JSON.stringify(first.result));
});

test("runWorkflow re-runs only the changed agent and its successors on resume", async () => {
  const calls: string[] = [];
  const countingAgent = {
    async run(prompt: string): Promise<string> {
      calls.push(prompt);
      return `result:${prompt}`;
    },
  };
  const scriptOf = (secondPrompt: string) => `export const meta = { name: 'edit_demo', description: 'Edit then resume' }
phase('Work')
const a = await agent('one', { label: 'one' })
const b = await agent('${secondPrompt}', { label: 'two' })
return { a, b }
`;
  const journal = new Map();

  await runWorkflow(scriptOf("two"), { agent: countingAgent, journal });
  assert.deepEqual(calls, ["one", "two"]);

  await runWorkflow(scriptOf("two-edited"), { agent: countingAgent, journal });
  assert.deepEqual(calls, ["one", "two", "two-edited"], "only the edited call re-runs; the prefix replays");
});

test("runWorkflow reports the subagent's real stats when available", async () => {
  const usage = { tokens: 1234, input: 1000, output: 234, cacheRead: 50_000, costUsd: 0.21 };
  const statsAgent = {
    async run(
      prompt: string,
      opts?: {
        onProgress?: (stats: { usage: typeof usage; model?: string; durationMs: number; toolCalls: string[] }) => void;
      },
    ): Promise<string> {
      // Emit a mid-flight reading and then a final one, like a real streaming subagent.
      opts?.onProgress?.({
        usage: { ...usage, tokens: 600 },
        model: "Sonnet 4.6",
        durationMs: 2000,
        toolCalls: ["Bash(ls)"],
      });
      opts?.onProgress?.({ usage, model: "Sonnet 4.6", durationMs: 4200, toolCalls: ["Bash(ls)", "Read(x)"] });
      return `result:${prompt}`;
    },
  };
  const progress: number[] = [];
  let end: { tokens?: number; usage?: typeof usage; model?: string; durationMs?: number; toolCalls?: string[] } = {};
  const result = await runWorkflow(
    `export const meta = { name: 'usage_demo', description: 'Report real usage' }
phase('Work')
await agent('do it', { label: 'worker' })
return { ok: true }
`,
    {
      agent: statsAgent,
      onAgentProgress: (event) => progress.push(event.tokens),
      onAgentEnd: (event) => {
        end = event;
      },
    },
  );
  assert.deepEqual(progress, [600, 1234], "each progress reading streams through to the manager");
  assert.equal(end.tokens, 1234, "the reported usage is used instead of the result-size estimate");
  assert.equal(end.usage?.cacheRead, 50_000, "the cache-read breakdown rides along so the detail can show it");
  assert.equal(end.model, "Sonnet 4.6");
  assert.deepEqual(end.toolCalls, ["Bash(ls)", "Read(x)"]);
  assert.equal(result.journal.get(0)?.tokens, 1234, "the real stats are journaled for cached replays");
  assert.equal(result.journal.get(0)?.usage?.costUsd, 0.21);
  assert.deepEqual(result.journal.get(0)?.toolCalls, ["Bash(ls)", "Read(x)"]);
});

test("runWorkflow forwards the per-agent model option to the runner", async () => {
  const seen: Array<string | undefined> = [];
  const modelAgent = {
    async run(prompt: string, opts?: { model?: string }): Promise<string> {
      seen.push(opts?.model);
      return `result:${prompt}`;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'model_demo', description: 'Pick a subagent model' }
phase('Work')
await agent('a', { label: 'a', model: 'openai/gpt-5.5' })
await agent('b', { label: 'b' })
return { ok: true }
`,
    { agent: modelAgent },
  );
  assert.deepEqual(seen, ["openai/gpt-5.5", undefined], "model flows through per call; undefined when unset");
});

test("runWorkflow forwards the per-agent thinking level and rejects an invalid one", async () => {
  const seen: Array<string | undefined> = [];
  const thinkingAgent = {
    async run(prompt: string, opts?: { thinking?: string }): Promise<string> {
      seen.push(opts?.thinking);
      return `result:${prompt}`;
    },
  };
  await runWorkflow(
    `export const meta = { name: 'think_demo', description: 'Pick a thinking level' }
phase('Work')
await agent('a', { label: 'a', thinking: 'high' })
await agent('b', { label: 'b' })
return { ok: true }
`,
    { agent: thinkingAgent },
  );
  assert.deepEqual(seen, ["high", undefined], "thinking flows through; undefined uses the default");

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'bad_think', description: 'Invalid thinking level' }
await agent('a', { label: 'a', thinking: 'ultra' })
return { ok: true }
`,
        { agent: thinkingAgent },
      ),
    /agent thinking must be one of: off, minimal, low, medium, high, xhigh/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});

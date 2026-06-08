import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelByName } from "../src/agent.js";

const MODELS = [
  { id: "claude-opus-4-8", name: "Opus 4.8", provider: "anthropic" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
] as any[];

test("resolveModelByName matches provider/id, bare id, and friendly name case-insensitively", () => {
  assert.equal(resolveModelByName(MODELS, "openai/gpt-5.5")?.id, "gpt-5.5");
  assert.equal(resolveModelByName(MODELS, "gpt-5.5")?.id, "gpt-5.5");
  assert.equal(resolveModelByName(MODELS, "GPT-5.5")?.id, "gpt-5.5");
  assert.equal(resolveModelByName(MODELS, "  Opus 4.8 ")?.id, "claude-opus-4-8");
  assert.equal(resolveModelByName(MODELS, "anthropic/claude-opus-4-8")?.provider, "anthropic");
});

test("resolveModelByName returns undefined for an unknown or empty name (falls back to orchestrator)", () => {
  assert.equal(resolveModelByName(MODELS, "does-not-exist"), undefined);
  assert.equal(resolveModelByName(MODELS, ""), undefined);
  assert.equal(resolveModelByName([], "gpt-5.5"), undefined);
});

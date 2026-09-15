/**
 * Tests for subagent model/variant selection.
 *
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverAgents } from "../packages/agent/dist/agent.js";
import { applyModelVariant } from "../apps/pace/dist/agent-context.js";
import { getModelConfig } from "@pace/llm";

// ── applyModelVariant ────────────────────────────────────────────────────────

test("applyModelVariant merges variant provider options over the model config", () => {
  const config = getModelConfig("fireworks/glm-5.3-flash")!;
  assert.ok(config, "fireworks/glm-5.3-flash should exist in the catalog");

  const withVariant = applyModelVariant(config, "low");
  assert.deepEqual(withVariant.providerOptions, { reasoning_effort: "low" });
  // Base config fields are preserved.
  assert.equal(withVariant.id, config.id);
  assert.equal(withVariant.providerModel, config.providerModel);
  assert.equal(withVariant.contextWindow, config.contextWindow);
  // The input config is not mutated.
  assert.equal(config.providerOptions, undefined);
});

test("applyModelVariant ignores unknown variant ids", () => {
  const config = getModelConfig("fireworks/glm-5.3-flash")!;
  assert.equal(applyModelVariant(config, "no-such-variant"), config);
  assert.equal(applyModelVariant(config, undefined), config);
});

// ── Agent discovery ──────────────────────────────────────────────────────────

test("built-in explore agent uses the medium reasoning variant", async () => {
  const agents = await discoverAgents();
  const explore = agents.find((a) => a.name === "explore");
  assert.ok(explore, "built-in explore agent should be discovered");
  assert.equal(explore.model, "opencode/gpt-5.6-luna");
  assert.equal(explore.variant, "medium");
});

test("agent frontmatter can override the variant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pace-agents-"));
  const cwd = process.cwd();
  try {
    await mkdir(join(dir, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "agents", "explore.md"),
      [
        "---",
        "name: explore",
        "description: project explore override",
        "model: fireworks/glm-5.3-flash",
        "variant: high",
        "---",
        "",
        "Project explore body.",
      ].join("\n"),
    );
    process.chdir(dir);
    const agents = await discoverAgents();
    const explore = agents.find((a) => a.name === "explore");
    assert.ok(explore, "project explore override should be discovered");
    assert.equal(explore.source, "project");
    assert.equal(explore.variant, "high");
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

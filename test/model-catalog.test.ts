/**
 * Tests for models.dev → Pace model metadata mapping, mainly how reasoning
 * options become Pace model variants.
 * Run with: npm test (build first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveModelMetadata, getModelConfig, MODEL_METADATA } from "@pace/llm";
import type { ModelMetadata } from "@pace/llm";

const limits = { context: 1_000_000, output: 384_000 };
const modalities = { input: ["text", "image"], output: ["text"] };
const cost = { input: 0.3, output: 1.2, cache_read: 0.006 };

function entry(id: string, reasoningOptions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    limit: limits,
    modalities,
    cost,
    reasoning: true,
    reasoning_options: reasoningOptions,
    ...extra,
  };
}

/** A trimmed snapshot of the models.dev providers Pace maps from. */
const catalog = {
  "fireworks-ai": {
    id: "fireworks-ai",
    name: "Fireworks AI",
    models: {
      "accounts/fireworks/models/deepseek-v4p1-flash": entry(
        "accounts/fireworks/models/deepseek-v4p1-flash",
        [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        { name: "DeepSeek V4.1 Flash" },
      ),
      "accounts/fireworks/models/qwen3p8-max": entry(
        "accounts/fireworks/models/qwen3p8-max",
        [{ type: "effort", values: ["none", "low", "medium", "xhigh"] }],
        { name: "Qwen3.8 Max" },
      ),
      "accounts/fireworks/models/glm-5p3": entry(
        "accounts/fireworks/models/glm-5p3",
        [{ type: "toggle" }],
        { name: "GLM 5.3" },
      ),
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "deepseek/deepseek-v4.1-flash": entry(
        "deepseek/deepseek-v4.1-flash",
        [{ type: "effort", values: ["none", "low", "high", "max"] }],
        { name: "DeepSeek V4.1 Flash" },
      ),
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": entry(
        "gpt-5.4",
        [{ type: "effort", values: ["none", "low", "high"] }],
        { name: "GPT-5.4" },
      ),
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": entry(
        "claude-opus-4-8",
        [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
        { name: "Claude Opus 4.8" },
      ),
    },
  },
};

const metadata = deriveModelMetadata(catalog);

function variantsOf(id: string): ModelMetadata["variants"] {
  const model = metadata[id];
  assert.ok(model, `expected metadata for ${id}`);
  return model.variants;
}

// ── Fireworks DeepSeek V4.1 Flash ───────────────────────────────────────────

test("fireworks DeepSeek V4.1 Flash keeps the off switch and effort levels but drops the duplicate think variant", () => {
  const variants = variantsOf("fireworks/deepseek-v4p1-flash");

  // models.dev advertises toggle + effort(low, high, max). Fireworks serves the
  // model at effort "high" when none is requested, so a bare "think" variant
  // would issue the same request as "high".
  assert.deepEqual(Object.keys(variants ?? {}), ["nothink", "low", "high", "max"]);
});

test("fireworks DeepSeek V4.1 Flash resolves to the fully qualified Fireworks path", () => {
  assert.equal(
    metadata["fireworks/deepseek-v4p1-flash"]?.providerModel,
    "accounts/fireworks/models/deepseek-v4p1-flash",
  );
});

test("fireworks DeepSeek V4.1 Flash nothink disables thinking", () => {
  assert.deepEqual(
    variantsOf("fireworks/deepseek-v4p1-flash")?.nothink.providerOptions,
    { thinking: { type: "disabled" } },
  );
});

test("fireworks DeepSeek V4.1 Flash effort variants send only reasoning_effort", () => {
  const variants = variantsOf("fireworks/deepseek-v4p1-flash");

  for (const effort of ["low", "high", "max"]) {
    assert.deepEqual(variants?.[effort].providerOptions, { reasoning_effort: effort });
  }
});

// ── Fireworks rejects thinking + reasoning_effort together ──────────────────

test("no derived variant sends thinking and reasoning_effort in the same request", () => {
  for (const [id, model] of Object.entries(metadata)) {
    for (const variant of Object.values(model.variants ?? {})) {
      const options = variant.providerOptions ?? {};
      assert.ok(
        !("thinking" in options && "reasoning_effort" in options),
        `${id}:${variant.id} sends thinking together with reasoning_effort`,
      );
    }
  }
});

test("effort=none does not force thinking on", () => {
  // Fireworks answers `thinking.type='enabled'` combined with
  // `reasoning_effort='none'` with a 400.
  assert.deepEqual(
    variantsOf("fireworks/qwen3p8-max")?.none.providerOptions,
    { reasoning_effort: "none" },
  );
});

// ── Styles that were already correct ────────────────────────────────────────

test("binary toggle models without effort levels still expose think and nothink", () => {
  const variants = variantsOf("fireworks/glm-5p3");
  assert.deepEqual(Object.keys(variants ?? {}), ["think", "nothink"]);
});

test("openrouter effort variants stay in the normalized reasoning shape", () => {
  const variants = variantsOf("openrouter/deepseek/deepseek-v4.1-flash");
  assert.deepEqual(Object.keys(variants ?? {}), ["none", "low", "high", "max"]);
  assert.deepEqual(variants?.low.providerOptions, { reasoning: { effort: "low" } });
});

test("openai effort variants stay in the Responses API shape", () => {
  const variants = variantsOf("openai/gpt-5.4");
  assert.deepEqual(variants?.low.providerOptions, {
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  });
});

test("anthropic effort variants stay in the adaptive thinking shape", () => {
  const variants = variantsOf("anthropic/claude-opus-4-8");
  assert.deepEqual(Object.keys(variants ?? {}), ["nothink", "low", "high"]);
  assert.deepEqual(variants?.low.providerOptions, {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
  });
});

// ── Curated catalog ─────────────────────────────────────────────────────────

/**
 * Curated variants must offer the levels models.dev reports for the model.
 * Effort levels are listed in the order models.dev reports them; the explicit
 * off switch comes first because it is the toggle, not an effort level.
 */
const MODELS_DEV_EFFORT_LEVELS: Record<string, string[]> = {
  "opencode/deepseek-v4-pro": ["nothink", "high", "max"],
  "opencode/deepseek-v4-flash": ["nothink", "low", "high", "max"],
  "opencode/deepseek-v4-flash-free": ["low", "high", "max"],
  "opencode/deepseek-v4.1-flash": ["nothink", "low", "high", "max"],
  "opencode/kimi-k3": ["nothink", "low", "high", "max"],
  "opencode/glm-5.2": ["high", "max"],
  "opencode/glm-5.3": ["low", "high", "max"],
  "opencode/glm-5.3-flash": ["low", "high", "max"],
  "fireworks/glm-5.3": ["low", "high", "max"],
  "fireworks/glm-5.3-flash": ["low", "high", "max"],
  // models.dev lists a toggle for TensorX too, but TensorX accepts
  // `thinking: { type: "disabled" }` and still emits reasoning content, so a
  // nothink variant would be a no-op there.
  "tensorx/z-ai/glm-5.3-flash": ["low", "high", "max"],
};

test("curated OpenCode/Fireworks variants match models.dev reasoning options", () => {
  for (const [id, expected] of Object.entries(MODELS_DEV_EFFORT_LEVELS)) {
    const config = getModelConfig(id);
    assert.ok(config, `expected ${id} in the catalog`);
    assert.deepEqual(Object.keys(config.variants ?? {}), expected, `${id} variant levels`);
  }
});

test("no curated variant sends thinking and reasoning_effort in the same request", () => {
  for (const [id, model] of Object.entries(MODEL_METADATA)) {
    for (const variant of Object.values(model.variants ?? {})) {
      const options = variant.providerOptions ?? {};
      assert.ok(
        !("thinking" in options && "reasoning_effort" in options),
        `${id}:${variant.id} sends thinking together with reasoning_effort`,
      );
    }
  }
});

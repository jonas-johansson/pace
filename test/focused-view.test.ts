import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUSED_ACTIVITY_BLOCK_ID,
  FOCUSED_ACTIVITY_PLACEHOLDER,
  projectBlocksForDisplay,
  type RenderBlock,
} from "../apps/pace/dist/view-model.js";

function block(id: number, role: RenderBlock["role"], content: string, title?: string): RenderBlock {
  return { id, role, content, ...(title && { title }) };
}

test("detailed view preserves every block", () => {
  const blocks = [block(1, "user", "Look"), block(2, "reasoning", "secret"), block(3, "tool", "output")];
  assert.strictEqual(projectBlocksForDisplay(blocks, { mode: "detailed", running: true }), blocks);
});

test("focused view shows the newest user message and the latest agent message", () => {
  const blocks = [
    block(1, "user", "First"),
    block(2, "assistant", "First answer"),
    block(3, "user", "Second"),
    block(4, "reasoning", "secret"),
    block(5, "tool", "lots of output"),
    block(6, "assistant", "Second answer"),
    block(7, "meta", "tokens"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [3, 6]);
});

test("focused view shows intermediate narration only while it is the latest message", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "I will inspect"),
    block(3, "tool", "output"),
    block(4, "assistant", "Final answer"),
  ];
  const idle = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(idle.map(({ id }) => id), [1, 4]);
});

test("focused view skips whitespace-only assistant blocks", () => {
  const blocks = [block(1, "user", "Look"), block(2, "assistant", "Done"), block(3, "assistant", " \n ")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2]);
});

test("a titled assistant block counts as visible content", () => {
  const blocks = [block(1, "user", "Look"), block(2, "assistant", "", "Model changed")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2]);
});

test("a running turn shows the user message and the activity block before any text streams", () => {
  const blocks = [block(1, "user", "Look"), block(2, "reasoning", "secret"), block(3, "tool", "output")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, FOCUSED_ACTIVITY_BLOCK_ID]);
  assert.equal(projected[1].content, FOCUSED_ACTIVITY_PLACEHOLDER);
  assert.equal(projected[1].role, "assistant");
  assert.equal(projected[1].state, "running");
});

test("a running turn shows the in-flight assistant message above the activity block", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "reasoning", "secret"),
    block(3, "tool", "output"),
    block(4, "assistant", "Partial answer"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 4, FOCUSED_ACTIVITY_BLOCK_ID]);
});

test("a steering user message replaces the focus segment while running", () => {
  const blocks = [
    block(1, "user", "First"),
    block(2, "assistant", "First answer"),
    block(3, "user", "Actually stop"),
    block(4, "assistant", "Continuing"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [3, 4, FOCUSED_ACTIVITY_BLOCK_ID]);
});

test("a running turn with no user message still shows the activity block", () => {
  const projected = projectBlocksForDisplay([], { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [FOCUSED_ACTIVITY_BLOCK_ID]);
});

test("error blocks newer than the latest agent message stay visible", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "Answer"),
    block(3, "error", "Compaction failed"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 3]);
});

test("error blocks between the user message and the latest agent message stay visible", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "tool", "output"),
    block(3, "error", "Failed"),
    block(4, "assistant", "Recovered answer"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 3, 4]);
});

test("a user command with no agent response still shows the command", () => {
  const blocks = [block(1, "user", "!ls"), block(2, "tool", "output")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1]);
});

test("the synthetic activity id cannot collide with normal block ids", () => {
  assert.ok(FOCUSED_ACTIVITY_BLOCK_ID < 0);
});

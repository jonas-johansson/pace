import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUSED_ACTIVITY_BLOCK_ID,
  FOCUSED_ACTIVITY_PLACEHOLDER,
  projectBlocksForDisplay,
  type RenderBlock,
} from "../apps/pace/dist/view-model.js";

function block(
  id: number,
  role: RenderBlock["role"],
  content: string,
  title?: string,
  heading?: string,
): RenderBlock {
  return { id, role, content, ...(title && { title }), ...(heading && { heading }) };
}

test("detailed view preserves every block", () => {
  const blocks = [block(1, "user", "Look"), block(2, "reasoning", "secret"), block(3, "tool", "output")];
  assert.strictEqual(projectBlocksForDisplay(blocks, { mode: "detailed", running: true }), blocks);
});

test("focused view keeps every user message and every agent message", () => {
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
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 3, 6]);
});

test("a running turn keeps all of its agent messages", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "First update"),
    block(3, "tool", "output"),
    block(4, "assistant", "Second update"),
    block(5, "tool", "output"),
    block(6, "assistant", "Third update"),
    block(7, "tool", "output"),
    block(8, "assistant", "Fourth update"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 4, 6, 8]);
});

test("a running turn keeps its agent messages in order", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "Only update"),
    block(3, "tool", "output"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2]);
});

test("a finished turn keeps all of its agent messages", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "First update"),
    block(3, "tool", "output"),
    block(4, "assistant", "Second update"),
    block(5, "tool", "output"),
    block(6, "assistant", "Final answer"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 4, 6]);
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

test("a running turn shows the reasoning heading on the activity line", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "reasoning", "planning the search", undefined, "Planning the search"),
    block(3, "tool", "output"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, FOCUSED_ACTIVITY_BLOCK_ID]);
  assert.equal(projected[1].content, "Planning the search");
});

test("a running turn falls back to the placeholder when reasoning has no heading", () => {
  const blocks = [block(1, "user", "Look"), block(2, "reasoning", "secret"), block(3, "tool", "output")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, FOCUSED_ACTIVITY_BLOCK_ID]);
  assert.equal(projected[1].content, FOCUSED_ACTIVITY_PLACEHOLDER);
});

test("the activity line is suppressed while assistant text is the latest activity", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "reasoning", "planning", undefined, "Planning"),
    block(3, "assistant", "Partial answer"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 3]);
});

test("a new reasoning block takes the activity line back from assistant text", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "Interim answer"),
    block(3, "tool", "output"),
    block(4, "reasoning", "next step", undefined, "Checking results"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, FOCUSED_ACTIVITY_BLOCK_ID]);
  assert.equal(projected[2].content, "Checking results");
});

test("reasoning without a heading after text resets the activity line to the placeholder", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "Interim answer"),
    block(3, "reasoning", "secret"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, FOCUSED_ACTIVITY_BLOCK_ID]);
  assert.equal(projected[2].content, FOCUSED_ACTIVITY_PLACEHOLDER);
});

test("previous turns stay visible while a new turn runs", () => {
  const blocks = [
    block(1, "user", "First"),
    block(2, "assistant", "First answer"),
    block(3, "user", "Second"),
    block(4, "tool", "output"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 3, FOCUSED_ACTIVITY_BLOCK_ID]);
});

test("a steering user message starts a new focus segment while running", () => {
  const blocks = [
    block(1, "user", "First"),
    block(2, "assistant", "First answer"),
    block(3, "user", "Actually stop"),
    block(4, "assistant", "Continuing"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 3, 4]);
});

test("a running turn with no user message still shows the activity block", () => {
  const projected = projectBlocksForDisplay([], { mode: "focused", running: true });
  assert.deepEqual(projected.map(({ id }) => id), [FOCUSED_ACTIVITY_BLOCK_ID]);
});

test("blocks before the first user message stay visible", () => {
  const blocks = [block(1, "error", "One"), block(2, "tool", "hidden"), block(3, "assistant", "Two"), block(4, "user", "Hi")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 3, 4]);
});

test("error blocks stay visible between agent messages", () => {
  const blocks = [
    block(1, "user", "Look"),
    block(2, "assistant", "Partial answer"),
    block(3, "error", "Compaction failed"),
    block(4, "assistant", "Final answer"),
  ];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 2, 3, 4]);
});

test("a turn with an error and no final answer shows the error", () => {
  const blocks = [block(1, "user", "Look"), block(2, "tool", "output"), block(3, "error", "Failed")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1, 3]);
});

test("a user command with no agent response still shows the command", () => {
  const blocks = [block(1, "user", "!ls"), block(2, "tool", "output")];
  const projected = projectBlocksForDisplay(blocks, { mode: "focused", running: false });
  assert.deepEqual(projected.map(({ id }) => id), [1]);
});

test("the synthetic activity id cannot collide with normal block ids", () => {
  assert.ok(FOCUSED_ACTIVITY_BLOCK_ID < 0);
});

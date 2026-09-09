/**
 * View-model types and pure formatting helpers shared by the TUI renderer
 * and session replay. This module must stay UI-framework-free and must not
 * import from tui.ts — the dependency direction is view-model → consumers.
 */

import type { BlockRole } from "./themes";
import { DEFAULT_COST_DISPLAY_CONFIG, type CostDisplayConfig } from "./config";

export type BlockState = "running" | "done" | "error";
export type DisplayMode = "focused" | "detailed";

export const FOCUSED_ACTIVITY_BLOCK_ID = -1;
export const FOCUSED_ACTIVITY_BLOCK_KEY = "focused-activity";
/** Placeholder shown in the focused view while the agent works. */
export const FOCUSED_ACTIVITY_PLACEHOLDER = "Thinking...";

export type RenderBlock = {
  id: number;
  key?: string;
  role: BlockRole;
  title?: string;
  content: string;
  collapsed?: boolean;
  state?: BlockState;
};

export type BlockPatch = Partial<Pick<RenderBlock, "title" | "content" | "state" | "collapsed">>;

export type ContextInfo = {
  usedTokens: number;
  contextWindow: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** True when usedTokens is an estimate (e.g. right after a compaction). */
  estimated?: boolean;
};

function hasVisibleAssistantContent(block: RenderBlock): boolean {
  return block.role === "assistant" && Boolean(block.title || block.content.trim());
}

function activityBlock(): RenderBlock {
  return {
    id: FOCUSED_ACTIVITY_BLOCK_ID,
    key: FOCUSED_ACTIVITY_BLOCK_KEY,
    role: "assistant",
    content: FOCUSED_ACTIVITY_PLACEHOLDER,
    state: "running",
  };
}

/**
 * Project the complete render transcript into the selected presentation mode.
 *
 * Detailed mode returns the blocks unchanged. Focused mode keeps the newest
 * user message, the latest agent message after it (plus any error blocks in
 * between or after), and — while the agent is running — one synthetic
 * "Thinking..." activity block. The input is never mutated, so switching
 * modes mid-turn is lossless.
 */
export function projectBlocksForDisplay(
  blocks: RenderBlock[],
  options: { mode: DisplayMode; running: boolean },
): RenderBlock[] {
  if (options.mode === "detailed") return blocks;

  // Focus on the current conversation pair: the newest user message and
  // everything after it. Blocks before it (earlier turns) are hidden.
  let turnStart = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].role === "user") {
      turnStart = index;
      break;
    }
  }

  // Scan backward from the end: keep error blocks and the first contentful
  // assistant block — the latest agent message — until the user message.
  // Reasoning, tool, and meta blocks are hidden.
  const projected: RenderBlock[] = [];
  let seenAssistant = false;
  for (let index = blocks.length - 1; index >= turnStart; index--) {
    const block = blocks[index];
    if (block.role === "error") {
      projected.unshift(block);
    } else if (block.role === "user") {
      projected.unshift(block);
      break;
    } else if (hasVisibleAssistantContent(block) && !seenAssistant) {
      projected.unshift(block);
      seenAssistant = true;
    }
  }

  if (options.running) {
    projected.push(activityBlock());
  }
  return projected;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return value % 1 === 0 ? `${value}M` : `${value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return value % 1 === 0 ? `${value}k` : `${value.toFixed(1)}k`;
  }
  return `${tokens}`;
}

export function formatCost(cost: number, config: CostDisplayConfig): string {
  const convertedCost = cost * config.conversionRate;
  const amount = formatCostAmount(convertedCost, config.fractionDigits);
  return config.format.replaceAll("{amount}", amount);
}

/** Format a cost for display in session listings, always rounded to 3 decimals. */
export function formatSessionCost(cost: number, config: CostDisplayConfig): string {
  const convertedCost = cost * config.conversionRate;
  const amount = convertedCost.toFixed(3);
  return config.format.replaceAll("{amount}", amount);
}

export function formatCostAmount(cost: number, fractionDigits: number | undefined): string {
  if (fractionDigits !== undefined) {
    return cost.toFixed(fractionDigits);
  }
  if (cost < 0.01) {
    // Show sub-cent costs with more precision
    return cost.toFixed(4);
  }
  if (cost < 1) {
    return cost.toFixed(3);
  }
  return cost.toFixed(2);
}

// Re-exported so consumers of the formatters get the config default too.
export { DEFAULT_COST_DISPLAY_CONFIG };

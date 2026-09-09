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
 * Detailed mode returns the blocks unchanged. Focused mode collapses each
 * user turn to its user message plus the turn's latest agent message (plus
 * any error blocks after it), and — while the agent is running — appends one
 * synthetic "Thinking..." activity block to the running turn. The input is
 * never mutated, so switching modes mid-turn is lossless.
 */
export function projectBlocksForDisplay(
  blocks: RenderBlock[],
  options: { mode: DisplayMode; running: boolean },
): RenderBlock[] {
  if (options.mode === "detailed") return blocks;

  const projected: RenderBlock[] = [];
  let index = 0;

  // Standalone UI output before the first user message (startup errors,
  // command responses on a fresh session) stays visible.
  while (index < blocks.length && blocks[index].role !== "user") {
    const block = blocks[index];
    if (block.role === "assistant" || block.role === "error") {
      projected.push(block);
    }
    index++;
  }

  while (index < blocks.length) {
    const turnStart = index;
    let turnEnd = blocks.length;
    for (let i = index + 1; i < blocks.length; i++) {
      if (blocks[i].role === "user") {
        turnEnd = i;
        break;
      }
    }
    const isRunningTurn = options.running && turnEnd === blocks.length;

    projected.push(blocks[turnStart]);

    // Scan backward within the turn: keep error blocks and the first
    // contentful assistant block — the turn's final answer. Reasoning,
    // tool, meta, and intermediate assistant narration are hidden.
    const turnBlocks: RenderBlock[] = [];
    let seenAssistant = false;
    for (let i = turnEnd - 1; i > turnStart; i--) {
      const block = blocks[i];
      if (block.role === "error") {
        turnBlocks.unshift(block);
      } else if (hasVisibleAssistantContent(block) && !seenAssistant) {
        turnBlocks.unshift(block);
        seenAssistant = true;
      }
    }
    projected.push(...turnBlocks);

    if (isRunningTurn) {
      projected.push(activityBlock());
    }
    index = turnEnd;
  }

  if (options.running && projected[projected.length - 1]?.id !== FOCUSED_ACTIVITY_BLOCK_ID) {
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

# Focused view — implementation plan

## Goal

Add a distraction-free display mode that keeps Pace's full event/session data but renders each turn with a small footprint:

```text
> Look for bugs

⠏ Exploring the project (read, bash)
```

The activity row is replaced in place as work progresses. When the loop completes, it is replaced by the final assistant response. Users can switch instantly between this view and today's complete transcript, including while an agent is running.

## Product decisions

- Name the modes **focused** and **detailed**.
- **Focused is the default** when no preference has been saved. Existing users can switch back once and Pace will remember it.
- Add `/view focused` and `/view detailed`.
- `/view` reports the current mode and usage without changing it.
- **Ctrl+G** toggles modes. It is currently unused.
- Mode is a global user preference in `~/.config/pace/prefs.json`, not session state.
- Switching modes changes presentation only. No reasoning, tool calls, outputs, or assistant messages are discarded or omitted from session persistence.
- Headless mode is unchanged.

## Focused-mode behavior

### Completed turns

For each user turn, render:

1. The user block.
2. The last assistant text block in that turn (the final answer).
3. A terminal error/cancellation block if there is no final assistant answer.

Hide reasoning blocks, tool blocks, and turn-summary/meta blocks. Intermediate assistant narration from earlier provider steps is also hidden once a turn is complete. Detailed mode continues to render every block exactly as it does today.

Keeping completed user/final-answer pairs preserves conversational context while preventing reasoning and tool history from consuming the viewport.

### Running turn

For the newest running turn, render the user block followed by one synthetic activity row. Do not render that turn's reasoning, tool, meta, or assistant blocks separately.

The row contains:

- The normal animated spinner while `Tui.running` is true.
- The latest assistant text for the current provider step, normalized to one terminal line.
- Tool names used after that text began, deduplicated in first-seen order: `(read, bash)`.
- A concise fallback when no assistant text has arrived, such as `Working`, `Running tools`, `Compacting`, or the current retry status.

Transient assistant text is restricted to one terminal row and ellipsized to fit. Its complete Markdown remains available immediately in detailed mode. Tool labels should also fit the row; when necessary, render the names that fit followed by `+N`.

Activity precedence:

1. Latest non-empty assistant text.
2. Explicit exceptional activity (compaction, retry/backoff, cancellation).
3. `Running tools` when tools are active or have run in the current step.
4. Current TUI status, falling back to `Working`.

At `text_start`, begin a new activity phase: replace the text and clear the phase's tool-name set. `text_delta` updates that text in place. Subsequent `tool_use_start` events append tool names while preserving the narration. Reasoning events do not expose reasoning text.

When the turn ends, remove the synthetic row. The focused projection then displays the turn's last assistant block as the final response. Cancellation should display the existing `Prompt execution cancelled.` assistant block; an exception with no assistant response should display the error block.

### Special cases

- **Parallel tools:** show each tool name once, regardless of call count. The detailed view retains every call.
- **Tool failures:** keep the compact activity row while work continues. If the loop ultimately returns a final answer, that answer wins. If execution ends without one, show the terminal error.
- **Steering messages:** each rendered steering user block starts a new visible focused segment, matching the current transcript behavior.
- **Direct `!command`:** show the user command and one activity row while running; on completion replace it with a concise success/error outcome. Do not expose streamed command output in focused mode.
- **Slash-command responses and startup errors:** continue to be visible. They are UI output rather than hidden agent internals.
- **Session replay/resume:** derive completed focused turns from the existing replay blocks; no session schema migration is needed.
- **Mode changes while scrolled:** reset focused/detailed scroll offset to the bottom. Selection and block-click mappings must be rebuilt from the newly projected rows.
- **Overlays:** model, MCP, session, and tree overlays are unaffected.

## Architecture

Keep mode ownership in `app.ts` because it is a persisted application preference. Keep block projection and rendering in the TUI layer. The agent loop and session model remain unchanged.

### 1. Add display-mode and activity view models

In `apps/pace/src/view-model.ts`, add framework-free types and pure helpers:

```ts
export type DisplayMode = "focused" | "detailed";

export type FocusedActivity = {
  text?: string;
  fallback?: string;
  toolNames: string[];
};
```

Add a pure projection helper whose exact signature can follow existing TUI conventions:

```ts
projectBlocksForDisplay(blocks, {
  mode,
  running,
  activity,
}): RenderBlock[]
```

Detailed mode returns the original blocks. Focused mode groups blocks into user-turn spans, keeps completed user/final-answer pairs, and adds a synthetic activity block for the running final span. Give the synthetic block a reserved negative ID so it cannot collide with `Tui.nextBlockId`.

Add `"activity"` to the render-only `RenderBlock.role` union. It is not a session entry type and must never be serialized.

Keep the grouping/projection rules pure so they can be tested without constructing `Tui`, which owns stdin/stdout and the alternate screen.

### 2. Add focused activity rendering

In `apps/pace/src/tui.ts`:

- Add `displayMode`, defaulting to `"focused"`.
- Add `focusedActivity`, initialized empty.
- Add public methods:
  - `setDisplayMode(mode)`
  - `getDisplayMode()` (or a readonly getter)
  - `setFocusedActivity(patch)`
  - `resetFocusedActivity()`
- Add `onToggleDisplayMode` to the constructor options. Handle Ctrl+G in `handleData` by invoking this callback; app state remains the source of truth.
- Have `setDisplayMode` clear the block render cache, reset scroll/selection state, and request a render.
- In `render()`, call `projectBlocksForDisplay(...)` once and use the resulting `visibleBlocks` for visual-type lookup, next-visible lookup, the render loop, layout, and click mapping.
- Continue purging cache entries against the underlying `this.blocks`; the synthetic activity ID may either bypass the cache while running or include all activity fields and spinner state in its cache key.
- Add `renderActivityBlock()`: muted spinner + one-line text + muted tool suffix, with ANSI-aware truncation to `columns`.
- Classify activity as its own inline visual type so it gets one top/bottom margin and does not inherit assistant Markdown spacing.
- Leave the existing bottom status bar unchanged. The activity row is part of the message viewport, not a replacement for model/context/cost status chrome.

Do not mutate or remove entries in `this.blocks`. That invariant is what makes mid-turn switching lossless.

### 3. Feed high-level activity from loop events

In `apps/pace/src/app.ts`, maintain activity at the same event boundary that currently creates detailed blocks:

- At the start of a normal prompt, call `resetFocusedActivity()` and set fallback `Working`.
- `text_start`: set the activity text and clear tool names.
- `text_delta`: update the accumulated activity text.
- `tool_use_start`: append `event.name` if it is not already present; when there is no text, use `Running tools`.
- `reasoning_start` / `reasoning_delta`: update only a generic fallback (`Thinking`), never copy reasoning content.
- Auto-compaction and provider retry events: set explicit fallbacks (`Compacting`, `Rate limited …`, `Stream interrupted …`) so important waits remain visible.
- In the existing `handleUserInput` `finally`, stop running and clear transient activity only after the final/cancel/error block has been added. The projection will then reveal the final outcome in the same frame.
- Mirror the lifecycle for direct `!command` execution so focused mode does not leak streamed shell output.

Continue creating and updating all existing detailed blocks. Activity updates are an additional presentation signal, not a replacement for current event handling.

### 4. Add commands and keyboard toggle

In `apps/pace/src/app.ts`:

- Add `/view` to `slashCommands` with detail `Show or switch display mode (Ctrl+G)`.
- Add a `handleCommand` case accepting exactly `focused` or `detailed`.
- With no argument, use `tui.setStatus()` to report `View: focused` or `View: detailed` plus usage.
- Invalid values add the standard error block with `Usage: /view <focused|detailed>`.
- Factor mode changes through one `setDisplayMode(mode, showStatus = true)` function. It updates the app variable, calls `tui.setDisplayMode`, schedules preference persistence, and optionally reports the new mode.
- Pass `onToggleDisplayMode` to `new Tui(...)`; toggle through the same function.

The command remains available only when normal slash commands are available. Ctrl+G may toggle during a running prompt and while idle, but not while an overlay owns keyboard input.

### 5. Persist the preference

In `apps/pace/src/preferences.ts`:

- Add `displayMode?: DisplayMode` to `UserPreferences`.
- Add `z.enum(["focused", "detailed"]).optional()` to the tolerant schema.
- Update the file header documentation.

In `apps/pace/src/app.ts`:

- Initialize the app-level mode to `"focused"`.
- Include `displayMode` in `buildPreferences()`.
- Restore it in `applyStoredPreferences()` by calling the shared mode setter with `showStatus = false`.

Preferences are loaded before `tui.start()`, so the first rendered frame uses the saved mode and does not flash focused mode first.

### 6. Documentation

Update `README.md`:

- Add Ctrl+G to the keyboard-shortcut table.
- Add `/view focused|detailed` to the slash-command table.
- Briefly explain that focused mode hides intermediate reasoning/tool detail without changing saved history and that detailed mode can be enabled at any time.

## Testing

Add `test/focused-view.test.ts` against pure exports from `apps/pace/dist/view-model.js`.

Cover:

1. Detailed projection returns all blocks in order.
2. Focused projection hides reasoning, tools, and meta blocks.
3. A completed turn keeps the user block and only its final assistant text block.
4. Multiple completed turns each retain their own user/final pair.
5. A running final turn replaces all internal blocks with exactly one activity block.
6. Activity keeps the latest narration and deduplicated tool names in insertion order.
7. Starting a new text phase clears old tool names.
8. Cancellation renders the cancellation assistant block after running stops.
9. An error with no final assistant remains visible.
10. Blocks before the first user (startup errors or command output) remain visible.
11. The synthetic activity ID cannot collide with normal block IDs.
12. Empty or whitespace-only assistant blocks are not selected as final answers.

Add focused rendering tests to a small pure formatter helper if ANSI-aware truncation is extracted from `tui.ts`:

- Single-line whitespace normalization.
- Narrow-terminal ellipsis.
- Tool suffix truncation and `+N` behavior.
- Spinner/activity rendering does not exceed the requested visible width.

Preference parsing should also be tested if a preferences test module is introduced: valid modes survive, invalid values cause tolerant fallback, and an absent value defaults in app state to focused.

## Implementation order

1. Add `DisplayMode`, `FocusedActivity`, and pure projection/formatting helpers with tests.
2. Integrate projected blocks and activity rendering into `Tui`.
3. Add app-level mode ownership, Ctrl+G, and `/view`.
4. Feed activity from normal prompts, retries/compaction, and direct shell commands.
5. Persist and restore the mode before first render.
6. Update README documentation.
7. Run `npm run lint`, `npm run build`, and `npm test`.
8. Manually verify mode switching in a live turn with reasoning, sequential tools, parallel tools, cancellation, an error, and a resumed session.

## Acceptance criteria

- A new installation starts in focused mode.
- While a prompt runs, focused mode shows one changing activity row beneath the current user message, regardless of reasoning/tool volume.
- The row shows the latest assistant narration and a concise deduplicated tool summary without exposing arguments or output.
- Completion replaces the activity row with the full final assistant response.
- Ctrl+G and `/view focused|detailed` switch immediately, including mid-turn.
- Detailed mode is visually and behaviorally unchanged from today's Pace UI.
- Switching to detailed mode reveals all reasoning and tool blocks accumulated while focused.
- Sessions written in either mode are byte-for-byte equivalent in structure; no schema change is required.
- The selected mode survives restart.
- No new runtime dependency or startup-time work is introduced.

# Focused view — implementation plan

## Goal

Add a distraction-free display mode alongside today's complete transcript:

```text
⠙ Thinking...
```

While the agent works, focused mode shows the full history collapsed to one row per turn — each user message followed by that turn's final agent message — plus a single muted `Thinking...` line under the running turn (with the in-flight streamed message once text arrives). Users can switch instantly between this view and today's complete transcript, including while an agent is running.

## Product decisions

- Name the modes **focused** and **detailed**.
- **Focused is the default** when no preference has been saved.
- Add `/view focused` and `/view detailed`; `/view` alone reports the current mode.
- **Ctrl+G** toggles modes (previously unused).
- Mode is a global user preference in `~/.config/pace/preferences.json`, not session state.
- Switching modes changes presentation only. Nothing is discarded from session persistence or `Tui.blocks`.
- Headless mode is unchanged. Compaction, tool execution, and the agent loop are unchanged.

## Focused-mode behavior

- **Detailed mode** renders every block exactly as it does today — the projection returns the block list unchanged.
- **Focused mode** collapses each user turn to a small footprint:
  1. The user message.
  2. The turn's latest agent message: its last assistant block with visible content (title or non-whitespace text) — the final answer once the turn completes.
  3. Error blocks newer than that answer, so failures are never hidden.
  4. For the running turn: one synthetic `Thinking...` activity row. The normal spinner animates it; the unchanged status bar continues to report compaction, retries, and tool progress. The in-flight streamed message shows above it.
- Reasoning, tool, meta, and intermediate assistant narration are hidden in every turn. Each steering user message starts a new turn segment. Standalone output before the first user message (startup errors, command responses) stays visible.
- Completion/cancellation/error blocks are regular assistant/error blocks, so the projection reveals the outcome automatically when `running` flips false — no special-casing.
- `!command` output is a tool block and is therefore not shown in focused mode; Ctrl+G reveals it.
- Mode changes reset scroll/selection state; block-click mappings are rebuilt from the projected rows.
- Overlays are unaffected.

## Architecture

Mode ownership lives in `app.ts` (persisted application preference). Projection and rendering live in the TUI layer. The agent loop, event handling, and session model are unchanged.

### 1. Projection (`view-model.ts`)

- `export type DisplayMode = "focused" | "detailed"`.
- `FOCUSED_ACTIVITY_BLOCK_ID = -1` (reserved so it cannot collide with `Tui.nextBlockId`), `FOCUSED_ACTIVITY_BLOCK_KEY`, `FOCUSED_ACTIVITY_PLACEHOLDER = "Thinking..."`.
- `projectBlocksForDisplay(blocks, { mode, running })`: pure, no `Tui` construction. Detailed returns the input; focused applies the rules above. The synthetic activity block has `role: "assistant"`, `state: "running"` and constant content.

### 2. Rendering (`tui.ts`)

- `displayMode` field (default `"focused"`) with `setDisplayMode(mode)`, which resets scroll/selection/line-map and invalidates the render cache.
- `onToggleDisplayMode` constructor option; Ctrl+G (`\u0007`) in `handleData` invokes it. Overlay input is handled before this, so overlays keep precedence.
- `render()` projects once and uses the resulting `visibleBlocks` for the render loop, next-visible lookup, margins, and click mapping. `this.blocks` is never mutated.
- `renderFocusedActivityBlock()`: muted one-line spinner + `Thinking...`. `state: "running"` bypasses the block render cache so the spinner animates.

### 3. App wiring (`app.ts`)

- `displayMode` state, `setDisplayMode(mode, showStatus, persist)`, `toggleDisplayMode`.
- `/view` slash command (no arg → status; invalid arg → error block).
- `displayMode` included in `buildPreferences()` and restored in `applyStoredPreferences()` before `tui.start()`, so the first frame uses the saved mode.
- Preferences schema (`preferences.ts`): `displayMode: z.enum(["focused", "detailed"]).optional()`.

## Testing

`test/focused-view.test.ts` against pure exports from `apps/pace/dist/view-model.js`:

1. Detailed projection returns the identical block list.
2. Focused projection keeps every user message and each turn's final agent message.
3. Whitespace-only assistant blocks are skipped; titled blocks count as visible.
4. A running turn collapses to the activity block before text streams, and shows the in-flight message above it once text arrives.
5. A running turn with no user message still shows the activity block.
6. Error blocks newer than the latest message stay visible; older ones are hidden.
7. The synthetic activity ID cannot collide with normal block IDs.

## Implementation order

1. Add `DisplayMode` and the projection helper with tests.
2. Integrate projection and activity rendering into `Tui`.
3. Add app-level mode ownership, Ctrl+G, and `/view`.
4. Persist and restore the mode before first render.
5. Update README documentation.
6. Run `npm run lint`, `npm run build`, and `npm test`.

## Acceptance criteria

- A new installation starts in focused mode; the saved mode survives restart.
- While a prompt runs, focused mode shows the user message, `Thinking...` (animated), and the in-flight streamed message, regardless of reasoning/tool volume.
- Completion replaces the view with the final assistant response; errors and cancellations remain visible.
- Ctrl+G and `/view focused|detailed` switch immediately, including mid-turn; detailed mode is behaviorally identical to master.
- Sessions written in either mode are structurally identical; no schema change.
- No new runtime dependency or startup-time work.

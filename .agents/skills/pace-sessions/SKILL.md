---
name: pace-sessions
description: >
  Search and reconstruct past Pace agent sessions (~/.pace/sessions). Use when
  the user explicitly asks to find a Pace session (not just any session), recall what they told the agent in
  an earlier conversation, look up a past decision/answer, or find the session
  that created/edited a file (e.g. "find the pace session that wrote X", "what did
  I tell the agent about Y", "look at Pace session <id>"). Triggers: pace
  session, previous pace session, earlier pace conversation,
  pace session history, find the pace session, ~/.pace.
---

# Pace Sessions

Pace stores every session as JSON under `~/.pace/sessions/<projectKey>/<sessionId>.json`.
Project keys are opaque; the `cwd` field inside maps a session to a project.
Large tool outputs are spilled to `~/.pace/tool-outputs/<entryId>/` as plain text.

Session JSON shape (version 1):
- `id`, `projectKey`, `cwd`, `createdAt`/`updatedAt` (UTC ISO), `currentModelId`
- `entries[]`: each has `id`, `timestamp`, `type` (`user`, `assistant`, tool
  calls), and `content` as an array of `{type: "text", text}` blocks.

## Run the bundled script

`pace_session_search.py` sits next to this SKILL.md. It ranks sessions by hit
count, prints metadata, and extracts user messages — one round trip, no
reading whole session files into context.

```bash
# Find sessions mentioning something, show matching user messages
python3 ~/.agents/skills/pace-sessions/pace_session_search.py "physics-alignment-output"

# Reconstruct the full user side of the best-matching session
python3 ~/.agents/skills/pace-sessions/pace_session_search.py "physics" --limit 1 --all-user

# Scope by project or date
python3 ~/.agents/skills/pace-sessions/pace_session_search.py "Jolt" --cwd game-engine --since 2026-08-01

# Dump everything a specific session's user said
python3 ~/.agents/skills/pace-sessions/pace_session_search.py --session 9732c7e8 --all-user
```

## Workflow

1. **Rank first**: run the script with the query. Sessions are ranked by raw
   hit count — the session that actually performed the work usually has an
   order of magnitude more hits than ones that merely reference it.
2. **Correlate with the filesystem when needed**: `stat` the target file's
   mtime and compare against session `updatedAt` values to disambiguate
   (JSON timestamps are UTC; file mtimes are local time).
3. **Read user messages only** (`--all-user` on the top hit). Do not dump
   assistant/tool entries unless the user asks for them — they flood context.
4. **Spilled tool outputs**: if an entry references a file under
   `~/.pace/tool-outputs/<entryId>/`, read that file for the full untruncated
   content.
5. For very large sessions or open-ended archaeology, delegate the extraction
   to a subagent and keep only its summary in the main context.

## Gotchas

- Search raw JSON with substring matching (the script does); session JSON
  escapes newlines, so multi-word phrases spanning line breaks won't match —
  prefer single distinctive words or paths.
- A file's current mtime may be newer than the session that wrote it (later
  checkouts/touches); the original write is found by content search, not mtime.
- Multiple `user` entries can be identical retries of the same prompt.

#!/usr/bin/env python3
"""Search Pace session logs (~/.pace/sessions) without flooding context.

Usage:
  pace_session_search.py <query> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                         [--cwd SUBSTRING] [--limit N] [--all-user]
                         [--session <sessionId-prefix>]

Default: rank sessions by raw hit count of <query>, then print each matching
session's metadata and the user messages that contain the query.

--all-user: print ALL user messages of matching sessions (for reconstructing
what the user told the agent, not just the matching lines).

Exit codes: 0 = matches found, 1 = no matches, 2 = bad usage.
"""
import argparse
import json
import sys
from pathlib import Path

SESSIONS = Path.home() / ".pace" / "sessions"


def entry_texts(entry):
    for c in entry.get("content") or []:
        if isinstance(c, dict) and isinstance(c.get("text"), str):
            yield c["text"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?", default="")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--cwd", dest="cwd_sub")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--all-user", action="store_true")
    ap.add_argument("--session")
    args = ap.parse_args()

    if not SESSIONS.is_dir():
        print(f"No Pace sessions dir at {SESSIONS}", file=sys.stderr)
        return 1
    if not args.query and not args.session:
        print("Provide a query or --session <id-prefix>", file=sys.stderr)
        return 2

    hits = []
    for f in SESSIONS.glob("*/*.json"):
        raw = f.read_text(errors="replace")
        if args.session and not f.stem.startswith(args.session):
            continue
        n = raw.count(args.query) if args.query else 0
        if args.query and n == 0:
            continue
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            continue
        created, updated = d.get("createdAt", ""), d.get("updatedAt", "")
        if args.since and updated[:10] < args.since:
            continue
        if args.until and created[:10] > args.until:
            continue
        if args.cwd_sub and args.cwd_sub not in (d.get("cwd") or ""):
            continue
        hits.append((n, f, d))

    if not hits:
        print("No sessions matched.")
        return 1
    hits.sort(key=lambda t: (-t[0], t[1].name))

    shown = 0
    for n, f, d in hits:
        if shown >= args.limit:
            break
        shown += 1
        print("=" * 78)
        print(f"session : {f.stem}  (hits: {n})")
        print(f"project : {d.get('projectKey')}  cwd: {d.get('cwd')}")
        print(f"span    : {d.get('createdAt')} -> {d.get('updatedAt')}  "
              f"model: {d.get('currentModelId')}")
        print(f"entries : {len(d.get('entries', []))}")
        for e in d.get("entries", []):
            if e.get("type") != "user":
                continue
            for text in entry_texts(e):
                if args.all_user or (args.query and args.query in text):
                    print("-" * 78)
                    print(e.get("timestamp", ""))
                    print(text.strip()[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())

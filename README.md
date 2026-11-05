# uncompact

A Claude Code skill that undoes a conversation compaction. Type `/uncompact` in a compacted session and it writes a copy of that session with the compaction removed, then tells you what to `/resume`.

Compaction never deletes anything: the transcript in `~/.claude/projects/<project>/<session-id>.jsonl` keeps every message, and the compaction is a `compact_boundary` entry with a `null` parent followed by a summary. Resuming only loads from the last boundary. This skill splices the pre-compaction messages back onto the post-compaction ones and drops the boundary, the summary and the context Claude Code re-injected after compacting.

## Install

```sh
git clone https://github.com/MrCoft/claude-uncompact.git ~/.claude/skills/uncompact
```

Requires Node 18+. Update with `git -C ~/.claude/skills/uncompact pull`.

## Use

In the compacted session:

```
/uncompact            undo the most recent compaction
/uncompact --all      undo every compaction in the session
/uncompact --list     list the session's compactions
/uncompact --dry-run  report what would be restored, write nothing
/uncompact <id>       work on another session (id or 8+ character prefix)
```

Then switch with `/resume <new-id>`, or from a terminal in the project directory: `claude --resume <new-id>`.

The script also runs on its own, e.g. `node ~/.claude/skills/uncompact/uncompact.mjs <session-id> --list`.

## What it does

- Writes a new session next to the original, titled `<original title> (uncompacted)`. The original transcript is never modified, so the compacted version stays available.
- Copies the session's `tool-results` and file-history checkpoints so `/rewind` keeps working in the copy.
- When run from `/uncompact`, the copy ends just before the `/uncompact` message.
- Validates the restored message chain before writing and writes nothing if it is broken.
- Handles both transcript layouts seen so far: preserved messages kept before the boundary (2.1.3xx) and moved after the summary (2.1.2xx).

## Caveats

- The transcript format is internal to Claude Code and can change between versions. Built against 2.1.318; checked against 175 compactions from 2.1.2xx and 2.1.3xx sessions.
- The restored session is as large as the conversation was before compacting. The script prints an estimate; anything past the context window compacts again on resume.
- Idle compactions happen while you are away. To turn them off, set `"idleCompaction": false` in `~/.claude/settings.json`.

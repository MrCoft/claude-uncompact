---
name: uncompact
description: Restore this conversation to how it was before its most recent compaction (manual, auto or idle), as a new session to /resume. Only when the user runs /uncompact.
disable-model-invocation: true
argument-hint: "[session-id] [--all] [--list] [--dry-run]"
allowed-tools: Bash(node:*)
---

# Uncompact

The restore already ran when this skill loaded. Its output:

!`node "${CLAUDE_SKILL_DIR}/uncompact.mjs" --session "${CLAUDE_SESSION_ID}" $ARGUMENTS`

Relay that result to the user in a few lines, then stop:

- On success, the one thing to do next is the `/resume <id>` line from the output: put it on its own line so it is easy to copy. Say the original session is unchanged, and pass on the estimated context size plus any warning or note lines.
- If it found no compaction or failed, show that line as is.
- For `--list` or `--dry-run`, show the output as is.

Do not read, load or summarize the transcript yourself, do not run the script again, and do not edit any session files. The restored session carries the full history; this one does not need to.

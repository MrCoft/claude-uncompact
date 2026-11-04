#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const UNCOMPACT_COMMAND = '<command-name>/uncompact</command-name>';
const FILLER_WINDOW_MS = 10_000;
const TITLE_SUFFIX = ' (uncompacted)';
const IDLE_NOTE = /idle|while you were away/i;
const LARGEST_CONTEXT_WINDOW = 1_000_000;
const COMPACT_PROMPT = /^\s*\/compact(\s|$)|<command-name>\/compact<\/command-name>/;
const COMMAND_ECHO = /^\s*(<local-command-caveat>|<local-command-stdout>)/;

const USAGE = `Usage: uncompact.mjs [session-id | path/to/session.jsonl] [options]

Writes a copy of a Claude Code session with its most recent compaction undone,
as a new session you can /resume. The original session is not modified.

Options:
  --all            Undo every compaction in the session, not only the most recent
  --list           List the session's compactions and exit
  --dry-run        Report what would be restored without writing anything
  --session <id>   Session to use when no positional session is given
  -h, --help       Show this help`;

class Info extends Error {}

function parseArgs(argv) {
  const opts = { all: false, list: false, dryRun: false, help: false, session: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--session') opts.session = argv[++i] ?? null;
    else if (!arg.startsWith('-') && !opts.target) opts.target = arg;
    else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function usableSessionRef(ref) {
  return typeof ref === 'string' && ref.trim() !== '' && !ref.includes('${') ? ref.trim() : null;
}

function resolveSessionFile(ref) {
  if (ref.endsWith('.jsonl')) {
    if (fs.existsSync(ref)) return path.resolve(ref);
    throw new Error(`Session file not found: ${ref}`);
  }
  const projectsDir = path.join(configDir(), 'projects');
  if (!fs.existsSync(projectsDir)) throw new Error(`No projects directory at ${projectsDir}`);
  const projectDirs = fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(projectsDir, d.name));
  for (const dir of projectDirs) {
    const exact = path.join(dir, `${ref}.jsonl`);
    if (fs.existsSync(exact)) return exact;
  }
  if (ref.length >= 8) {
    const matches = projectDirs.flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && f.startsWith(ref))
        .map((f) => path.join(dir, f)),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Session prefix "${ref}" matches ${matches.length} sessions; give more characters.`);
  }
  throw new Error(`Session not found: ${ref}`);
}

function readEntries(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {}
    entries.push({ line, obj });
  }
  if (entries.length && entries.at(-1).obj === null) entries.pop();
  return entries;
}

function isChain(obj) {
  return !!obj && typeof obj.uuid === 'string' && !obj.isSidechain;
}

function messageText(obj) {
  const content = obj?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
}

function findBoundaries(entries) {
  const indices = [];
  entries.forEach(({ obj }, i) => {
    if (isChain(obj) && obj.type === 'system' && obj.subtype === 'compact_boundary') indices.push(i);
  });
  return indices;
}

function isCompactPrompt(obj) {
  return obj.type === 'user' && COMPACT_PROMPT.test(messageText(obj));
}

function isSummaryOrEcho(obj) {
  return obj.type === 'user' && (obj.isCompactSummary === true || isCompactPrompt(obj) || COMMAND_ECHO.test(messageText(obj)));
}

function indexByUuid(entries) {
  const index = new Map();
  entries.forEach(({ obj }, i) => {
    if (isChain(obj) && !index.has(obj.uuid)) index.set(obj.uuid, i);
  });
  return index;
}

function movedPreservedSegment(entries, boundaryIndex, indexOf) {
  const preserved = new Set();
  let head = null;
  let uuid = entries[boundaryIndex].obj.logicalParentUuid;
  while (indexOf.get(uuid) > boundaryIndex) {
    const obj = entries[indexOf.get(uuid)].obj;
    if (obj.subtype === 'compact_boundary' || isSummaryOrEcho(obj) || preserved.has(uuid)) break;
    preserved.add(uuid);
    head = uuid;
    uuid = obj.parentUuid;
  }
  if (!head) return null;
  let p = boundaryIndex - 1;
  while (p >= 0 && !isChain(entries[p].obj)) p--;
  return { preserved, head, parent: p >= 0 ? entries[p].obj.uuid : null };
}

function analyzeBoundary(entries, boundaryIndex, indexOf) {
  const boundary = entries[boundaryIndex].obj;
  const moved = movedPreservedSegment(entries, boundaryIndex, indexOf);
  const preserved = moved?.preserved ?? new Set();
  const tail = boundary.logicalParentUuid;
  const tailIndex = indexOf.get(tail);
  const start = Date.parse(boundary.timestamp);
  const block = new Set([boundary.uuid]);
  const notes = [];
  const from = tailIndex !== undefined && tailIndex < boundaryIndex ? tailIndex + 1 : boundaryIndex + 1;
  for (let j = from; j < entries.length; j++) {
    const obj = entries[j].obj;
    if (!isChain(obj) || block.has(obj.uuid) || preserved.has(obj.uuid)) continue;
    const underBlock = block.has(obj.parentUuid) || preserved.has(obj.parentUuid);
    const isFiller =
      (obj.type === 'attachment' || obj.type === 'system') &&
      Math.abs(Date.parse(obj.timestamp) - start) <= FILLER_WINDOW_MS;
    const belongs = underBlock ? isSummaryOrEcho(obj) || isFiller : obj.parentUuid === tail && isCompactPrompt(obj);
    if (!belongs) continue;
    block.add(obj.uuid);
    if (obj.type === 'system' && typeof obj.content === 'string') notes.push(obj.content);
  }
  return { tail, moved, block, notes };
}

function describeBoundary(entries, boundaryIndex, ordinal, indexOf) {
  const boundary = entries[boundaryIndex].obj;
  const meta = boundary.compactMetadata ?? {};
  const { notes } = analyzeBoundary(entries, boundaryIndex, indexOf);
  return {
    ordinal,
    timestamp: boundary.timestamp,
    trigger: notes.some((n) => IDLE_NOTE.test(n)) ? 'idle' : (meta.trigger ?? 'unknown'),
    preTokens: meta.preTokens,
    postTokens: meta.postTokens,
  };
}

function formatTokens(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '?';
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describeLine(b) {
  return `#${b.ordinal} ${formatTime(b.timestamp)}  ${b.trigger}  ${formatTokens(b.preTokens)} -> ${formatTokens(b.postTokens)} tokens`;
}

function findInvocationCut(entries, afterIndex) {
  for (let j = entries.length - 1; j > afterIndex; j--) {
    const obj = entries[j].obj;
    if (!isChain(obj) || obj.type !== 'user' || !messageText(obj).includes(UNCOMPACT_COMMAND)) continue;
    const laterPrompt = entries
      .slice(j + 1)
      .some(({ obj: o }) => isChain(o) && o.type === 'user' && o.promptId && o.promptId !== obj.promptId);
    return laterPrompt ? -1 : j;
  }
  return -1;
}

function sessionTitle(entries, file) {
  let custom = null;
  let ai = null;
  for (const { obj } of entries) {
    if (obj?.type === 'custom-title' && obj.customTitle) custom = obj.customTitle;
    if (obj?.type === 'ai-title' && obj.aiTitle) ai = obj.aiTitle;
  }
  if (!custom) {
    try {
      const sessionDir = path.join(path.dirname(file), path.basename(file, '.jsonl'));
      custom = JSON.parse(fs.readFileSync(path.join(sessionDir, 'custom-title.json'), 'utf8')).customTitle || null;
    } catch {}
  }
  return custom ?? ai ?? 'Untitled session';
}

function walkChain(byUuid, leaf) {
  const seen = new Set();
  let messages = 0;
  let uuid = leaf;
  while (uuid) {
    const obj = byUuid.get(uuid);
    if (!obj) return { ok: true, truncatedAt: uuid, seen, messages };
    if (seen.has(uuid)) return { ok: false, reason: `cycle at ${uuid}`, seen, messages };
    seen.add(uuid);
    if (obj.type === 'user' || obj.type === 'assistant') messages++;
    uuid = obj.parentUuid;
  }
  return { ok: true, seen, messages };
}

function lastLeaf(objs) {
  for (let i = objs.length - 1; i >= 0; i--) if (isChain(objs[i])) return objs[i].uuid;
  return null;
}

function contextTokens(obj) {
  const u = obj?.message?.usage;
  if (!u) return null;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function estimateRestoredTokens(entries, end, targets) {
  const lastTarget = targets.at(-1);
  let base = null;
  for (let j = end - 1; j > lastTarget; j--) {
    const obj = entries[j].obj;
    if (isChain(obj) && obj.type === 'assistant') {
      base = contextTokens(obj);
      if (base !== null) break;
    }
  }
  const metas = targets.map((i) => entries[i].obj.compactMetadata ?? {});
  base ??= metas.at(-1).postTokens ?? null;
  if (base === null || metas.some((m) => typeof m.preTokens !== 'number' || typeof m.postTokens !== 'number')) return null;
  return base + metas.reduce((sum, m) => sum + (m.preTokens - m.postTokens), 0);
}

function copyIfExists(from, to) {
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
}

export function planRestore(file, { all }) {
  const entries = readEntries(file);
  const oldId = path.basename(file, '.jsonl');
  const boundaries = findBoundaries(entries);
  if (!boundaries.length) throw new Info(`No compaction found in session ${oldId}. Nothing to restore.`);

  const targets = all ? boundaries : [boundaries.at(-1)];
  const byUuid = new Map(entries.filter(({ obj }) => isChain(obj)).map(({ obj }) => [obj.uuid, obj]));
  const indexOf = indexByUuid(entries);
  const redirect = new Map();
  const reattach = new Map();
  for (const bi of targets) {
    const boundary = entries[bi].obj;
    const { tail, moved, block } = analyzeBoundary(entries, bi, indexOf);
    if (!tail || !byUuid.has(tail)) {
      throw new Error(`Compaction at ${formatTime(boundary.timestamp)} has no recoverable pre-compaction messages. Nothing was written.`);
    }
    for (const uuid of block) redirect.set(uuid, tail);
    if (moved) reattach.set(moved.head, moved.parent);
  }
  const resolve = (uuid) => {
    const seen = new Set();
    while (redirect.has(uuid) && !seen.has(uuid)) {
      seen.add(uuid);
      uuid = redirect.get(uuid);
    }
    return uuid;
  };

  const cut = findInvocationCut(entries, boundaries.at(-1));
  const end = cut === -1 ? entries.length : cut;
  const newId = randomUUID();
  const kept = [];
  const lines = [];
  for (let j = 0; j < end; j++) {
    const { line, obj } = entries[j];
    if (obj === null) {
      lines.push(line);
      continue;
    }
    if (isChain(obj) && redirect.has(obj.uuid)) continue;
    const next = { ...obj };
    if (isChain(next) && reattach.has(next.uuid)) {
      const parent = reattach.get(next.uuid);
      next.parentUuid = parent === null ? null : resolve(parent);
    } else if (isChain(next) && next.parentUuid && redirect.has(next.parentUuid)) {
      next.parentUuid = resolve(next.parentUuid);
    }
    if (next.sessionId === oldId) next.sessionId = newId;
    kept.push(next);
    lines.push(JSON.stringify(next));
  }

  const leaf = lastLeaf(kept);
  if (!leaf) throw new Error('Restored session would be empty. Nothing was written.');
  const restoredByUuid = new Map(kept.filter(isChain).map((obj) => [obj.uuid, obj]));
  const restored = walkChain(restoredByUuid, leaf);
  if (!restored.ok) throw new Error(`Restored conversation chain is broken (${restored.reason}). Nothing was written.`);
  for (const bi of targets) {
    if (!restored.seen.has(entries[bi].obj.logicalParentUuid)) {
      throw new Error('Restored conversation does not reach the pre-compaction messages. Nothing was written.');
    }
  }
  const original = walkChain(byUuid, lastLeaf(entries.slice(0, end).map((e) => e.obj).filter(Boolean)));

  const baseTitle = sessionTitle(entries, file);
  const title = baseTitle.endsWith(TITLE_SUFFIX) ? baseTitle : baseTitle + TITLE_SUFFIX;
  lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newId }));
  lines.push(JSON.stringify({ type: 'last-prompt', leafUuid: leaf, sessionId: newId }));

  const undone = targets.map((bi) => describeBoundary(entries, bi, boundaries.indexOf(bi) + 1, indexOf));
  const result = {
    oldId,
    newId,
    title,
    undone,
    remaining: boundaries.length - targets.length,
    messagesBefore: original.messages,
    messagesAfter: restored.messages,
    estimatedTokens: estimateRestoredTokens(entries, end, targets),
    cwd: [...kept].reverse().find((o) => typeof o.cwd === 'string')?.cwd ?? null,
    cutInvocation: cut !== -1,
    truncated: !!restored.truncatedAt,
    outFile: path.join(path.dirname(file), `${newId}.jsonl`),
  };
  return { result, lines, kept, leaf, tails: targets.map((bi) => entries[bi].obj.logicalParentUuid) };
}

function writeRestore(file, { result, lines }) {
  const projectDir = path.dirname(file);
  const sessionDir = path.join(projectDir, result.newId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'custom-title.json'), JSON.stringify({ customTitle: result.title }));
  copyIfExists(path.join(projectDir, result.oldId, 'tool-results'), path.join(sessionDir, 'tool-results'));
  copyIfExists(path.join(configDir(), 'file-history', result.oldId), path.join(configDir(), 'file-history', result.newId));
  const tmp = `${result.outFile}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, result.outFile);
}

function report(result, dryRun) {
  const out = [];
  out.push(dryRun ? 'Dry run: nothing was written.' : 'Restored a copy of the session from before compaction.');
  for (const b of result.undone) out.push(`  undone: ${describeLine(b)}`);
  if (result.remaining) out.push(`  earlier compactions still in place: ${result.remaining} (use --all to undo them too)`);
  out.push(`  messages in context: ${result.messagesBefore} -> ${result.messagesAfter}`);
  if (result.truncated) out.push('  note: the original transcript was already missing a link further back, so history before that gap does not load');
  if (result.estimatedTokens !== null) out.push(`  estimated context on resume: ~${formatTokens(result.estimatedTokens)} tokens`);
  if (result.estimatedTokens > LARGEST_CONTEXT_WINDOW) {
    out.push(`  warning: that is over ${formatTokens(LARGEST_CONTEXT_WINDOW)} tokens, so it will be compacted again as soon as it is resumed`);
  }
  out.push('');
  out.push(`New session:      ${result.newId}`);
  out.push(`Title:            ${result.title}`);
  out.push(`Original session: ${result.oldId} (unchanged)`);
  if (!dryRun) {
    out.push('');
    out.push(`Switch to it:     /resume ${result.newId}`);
    out.push(`From a terminal:  ${result.cwd ? `cd "${result.cwd}" && ` : ''}claude --resume ${result.newId}`);
  }
  if (result.undone.some((b) => b.trigger === 'idle')) {
    out.push('');
    out.push('This was an idle compaction. To stop them: set "idleCompaction": false in ~/.claude/settings.json');
  }
  return out.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  const ref = usableSessionRef(opts.target) ?? usableSessionRef(opts.session) ?? usableSessionRef(process.env.CLAUDE_CODE_SESSION_ID);
  if (!ref) throw new Error(`No session given and none detected.\n\n${USAGE}`);
  const file = resolveSessionFile(ref);

  if (opts.list) {
    const entries = readEntries(file);
    const boundaries = findBoundaries(entries);
    if (!boundaries.length) return console.log(`No compaction found in session ${path.basename(file, '.jsonl')}.`);
    console.log(`Compactions in session ${path.basename(file, '.jsonl')}:`);
    boundaries.forEach((bi, i) => console.log(`  ${describeLine(describeBoundary(entries, bi, i + 1, indexByUuid(entries)))}`));
    return;
  }

  const plan = planRestore(file, opts);
  if (!opts.dryRun) writeRestore(file, plan);
  console.log(report(plan.result, opts.dryRun));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (err instanceof Info) {
      console.log(err.message);
    } else {
      console.log(`uncompact failed: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

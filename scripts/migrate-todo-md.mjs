// One-off importer for the legacy single-file docs/TODO.md format:
//   - [ ] #12 [S2] Title status:todo wt:12-slug plan:docs/plans/x.md
//         indented notes
// under "## Bugs", "## Features", "## Reworks" and "## Needs Discussion".
// Usage: node scripts/migrate-todo-md.mjs <repo> <TODO.md path relative to repo> <output dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

const [repo, todoRel, outDir] = process.argv.slice(2);
if (repo === undefined || todoRel === undefined || outDir === undefined) {
  console.error('usage: migrate-todo-md.mjs <repo> <todo-file> <out-dir>');
  process.exit(2);
}

const KEY_ORDER = ['id', 'title', 'kind', 'status', 'sev', 'created', 'started', 'closed', 'wt', 'branch', 'needs', 'after', 'parent', 'verified', 'outcome', 'report', 'reason', 'attest'];
const today = new Date().toISOString().slice(0, 10);

function slugify(title) {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
  return slug === '' ? 'item' : slug;
}

function firstSeenDates() {
  const out = execFileSync('git', ['log', '--reverse', '--format=@@COMMIT@@%cs', '-p', '--', todoRel], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
  const seen = new Map();
  let date = today;
  for (const line of out.split('\n')) {
    if (line.startsWith('@@COMMIT@@')) date = line.slice(10);
    else {
      const m = /^\+- \[.\] #(\d+) /.exec(line);
      if (m && !seen.has(Number(m[1]))) seen.set(Number(m[1]), date);
    }
  }
  return seen;
}

const created = firstSeenDates();
const lines = readFileSync(join(repo, todoRel), 'utf8').split('\n');

const items = [];
let section = '';
let current;
for (const line of lines) {
  const sec = /^## (.+)$/.exec(line);
  if (sec) {
    section = sec[1].trim().toLowerCase();
    current = undefined;
    continue;
  }
  const head = /^- \[( |x)\] #(\d+) (.*)$/.exec(line);
  if (head) {
    current = { checked: head[1] === 'x', id: Number(head[2]), raw: head[3], notes: [], section };
    items.push(current);
    continue;
  }
  if (current && /^\s{2,}\S/.test(line)) current.notes.push(line.replace(/^ {1,6}/, ''));
  else if (line.trim() !== '' && !/^\s/.test(line)) current = undefined;
}

const files = [];
for (const it of items) {
  let title = it.raw;
  const fields = {};
  for (;;) {
    const m = /\s(status|wt|plan):(\S*)$/.exec(title);
    if (!m) break;
    fields[m[1]] = m[2];
    title = title.slice(0, m.index);
  }
  const tags = [];
  for (;;) {
    const m = /^\[([^\]]+)\]\s*/.exec(title);
    if (!m) break;
    tags.push(m[1]);
    title = title.slice(m[0].length);
  }
  title = title.trim();
  const sevTag = tags.find((t) => /^S[1-4]$/.test(t));
  const postponed = tags.find((t) => t.startsWith('POSTPONED'));
  const high = tags.includes('HIGH');
  const decisionTag = tags.includes('Decision');

  let kind = it.section === 'bugs' ? 'bug' : it.section === 'reworks' ? 'rework' : 'feature';
  if (it.section === 'needs discussion' && postponed === undefined) kind = 'decision';
  if (decisionTag) kind = 'decision';

  const done = it.checked || fields.status === 'done';
  const active = !done && fields.status === 'in-progress';
  let status = done ? 'done' : active ? 'active' : 'todo';
  const noteText = it.notes.join('\n').trim();
  const firstNote = (it.notes.find((n) => n.trim() !== '') ?? '').trim();

  const meta = { id: it.id, title, kind, status, created: created.get(it.id) ?? today };
  if (kind === 'bug' && sevTag) meta.sev = sevTag;

  if (done) {
    const outcomeLine = it.notes.find((n) => /^(Outcome|Closed|Result)\b/i.test(n.trim()));
    const outcome = outcomeLine ? outcomeLine.replace(/^[^:]*:\s*/, '').trim() : '';
    meta.outcome = outcome !== '' ? outcome : 'Completed before the move to workgate; see git history.';
    meta.closed = (outcomeLine && /\d{4}-\d{2}-\d{2}/.exec(outcomeLine)?.[0]) || meta.created;
  } else if (active) {
    meta.started = meta.created;
    meta.wt = fields.wt || `${it.id}-${slugify(title)}`;
    meta.branch = meta.wt;
  } else if (it.section === 'needs discussion' || postponed) {
    meta.status = 'blocked';
    status = 'blocked';
    const label = postponed ? `${postponed[0] + postponed.slice(1).toLowerCase()}: ` : '';
    meta.needs = `${label}${firstNote || 'Needs a decision from the owner.'}`.slice(0, 300);
  }

  const bodyParts = [];
  if (high) bodyParts.push('Priority: HIGH');
  if (fields.plan) bodyParts.push(`Plan: ${fields.plan}`);
  if (noteText !== '') bodyParts.push(noteText);
  const body = bodyParts.join('\n\n');

  const ordered = {};
  for (const k of KEY_ORDER) if (meta[k] !== undefined) ordered[k] = meta[k];
  const text = `---\n${stringify(ordered, { lineWidth: 0 }).trimEnd()}\n---\n${body === '' ? '' : `\n${body}\n`}`;
  files.push({ name: `${String(it.id).padStart(4, '0')}-${slugify(title)}.md`, text, status });
}

mkdirSync(outDir, { recursive: true });
const counts = {};
for (const f of files) {
  writeFileSync(join(outDir, f.name), f.text);
  counts[f.status] = (counts[f.status] ?? 0) + 1;
}
console.log(`wrote ${files.length} items to ${outDir}`, counts);

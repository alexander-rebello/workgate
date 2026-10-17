import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { WgError } from './errors.js';
import { ItemMetaSchema, type Item, type ItemMeta, type Repo } from './types.js';

const KEY_ORDER: readonly (keyof ItemMeta)[] = [
  'id',
  'title',
  'kind',
  'status',
  'sev',
  'created',
  'started',
  'closed',
  'wt',
  'branch',
  'needs',
  'after',
  'parent',
  'verified',
  'outcome',
  'report',
  'reason',
  'attest',
  'attestReason',
];

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug === '' ? 'item' : slug;
}

export function pad(id: number): string {
  return String(id).padStart(4, '0');
}

export function todosPath(repo: Repo): string {
  return join(repo.mainRoot, repo.config.todosDir);
}

export function serializeItem(meta: ItemMeta, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = meta[key];
    if (value !== undefined) ordered[key] = value;
  }
  const front = stringify(ordered, { lineWidth: 0 }).trimEnd();
  const trimmedBody = body.trim();
  return `---\n${front}\n---\n${trimmedBody === '' ? '' : `\n${trimmedBody}\n`}`;
}

export function parseItem(text: string, file: string): Item {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (match === null) throw new WgError(`${file}: missing frontmatter`);
  let raw: unknown;
  try {
    raw = parse(match[1] ?? '');
  } catch (error) {
    throw new WgError(`${file}: invalid frontmatter YAML: ${(error as Error).message}`);
  }
  const parsed = ItemMetaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new WgError(`${file}: ${issues}`);
  }
  return { meta: parsed.data, body: (match[2] ?? '').trim(), file };
}

export interface LoadResult {
  items: Item[];
  errors: string[];
}

export function loadAll(repo: Repo): LoadResult {
  const dir = todosPath(repo);
  const items: Item[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { items, errors };
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d{4,}-.+\.md$/.test(name)) continue;
    const file = join(dir, name);
    try {
      const item = parseItem(readFileSync(file, 'utf8'), file);
      const prefix = Number.parseInt(name.slice(0, name.indexOf('-')), 10);
      if (prefix !== item.meta.id) {
        errors.push(`${file}: filename id ${prefix} does not match frontmatter id ${item.meta.id}`);
      }
      items.push(item);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  const seen = new Map<number, string>();
  for (const item of items) {
    const prior = seen.get(item.meta.id);
    if (prior !== undefined) errors.push(`duplicate id ${item.meta.id}: ${prior} and ${item.file}`);
    seen.set(item.meta.id, item.file);
  }
  return { items, errors };
}

export function loadItems(repo: Repo): Item[] {
  const { items, errors } = loadAll(repo);
  if (errors.length > 0) {
    throw new WgError(`Invalid item files (run "wg doctor"):\n${errors.join('\n')}`);
  }
  return items;
}

export function findItem(items: readonly Item[], id: number): Item {
  const item = items.find((i) => i.meta.id === id);
  if (item === undefined) throw new WgError(`No item #${id}.`);
  return item;
}

export function nextId(items: readonly Item[]): number {
  return items.reduce((max, i) => Math.max(max, i.meta.id), 0) + 1;
}

export function itemFileName(meta: ItemMeta): string {
  return `${pad(meta.id)}-${slugify(meta.title)}.md`;
}

export function writeItem(item: Item, nextMeta: ItemMeta, nextBody?: string): Item {
  const parsed = ItemMetaSchema.safeParse(nextMeta);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new WgError(`#${item.meta.id}: ${issues}`);
  }
  const body = nextBody ?? item.body;
  writeFileSync(item.file, serializeItem(parsed.data, body));
  return { meta: parsed.data, body: body.trim(), file: item.file };
}

export function createItem(repo: Repo, meta: ItemMeta, body: string): Item {
  const parsed = ItemMetaSchema.safeParse(meta);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new WgError(issues);
  }
  const dir = todosPath(repo);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, itemFileName(parsed.data));
  writeFileSync(file, serializeItem(parsed.data, body));
  return { meta: parsed.data, body: body.trim(), file };
}

/** Drops fields that no longer apply after a status transition; the result is re-validated. */
export function withoutKeys(meta: ItemMeta, keys: readonly (keyof ItemMeta)[]): ItemMeta {
  const omit: readonly string[] = keys;
  return ItemMetaSchema.parse(Object.fromEntries(Object.entries(meta).filter(([key]) => !omit.includes(key))));
}

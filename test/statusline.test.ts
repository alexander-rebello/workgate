import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatReset } from '../src/statusline.js';
import { WG, makeRepo, type TestRepo } from './helpers.js';

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
});

function render(input: Record<string, unknown>): string {
  const r = spawnSync('node', [WG, 'statusline'], { encoding: 'utf8', input: JSON.stringify(input) });
  expect(r.status).toBe(0);
  return strip(r.stdout.trim());
}

describe('statusline', () => {
  it('shows usage, context, todo counts and model', () => {
    repo.wgOk(['add', 'a', '--kind', 'feature']);
    repo.wgOk(['add', 'b', '--kind', 'feature']);
    repo.wgOk(['add', 'q', '--kind', 'decision', '--needs', 'x']);
    const now = Math.floor(Date.now() / 1000);
    const line = render({
      model: { display_name: 'Opus' },
      output_style: { name: 'default' },
      cwd: repo.dir,
      context_window: { remaining_percentage: 71.4 },
      rate_limits: { five_hour: { used_percentage: 12.6, resets_at: now + 3 * 3600 + 5 * 60 + 30 }, seven_day: { used_percentage: 40 } },
    });
    expect(line).toBe('5h:13% (3h 5m) 7d:40% | ctx:71% left | 1/2/3 | Opus / default');
  });

  it('omits todo counts outside workgate repos and survives garbage input', () => {
    expect(render({ model: { display_name: 'X' }, cwd: repo.root })).toBe('X / default');
    const r = spawnSync('node', [WG, 'statusline'], { encoding: 'utf8', input: 'garbage' });
    expect(strip(r.stdout.trim())).toBe('unknown / default');
  });

  it('shows the current item inside its worktree', () => {
    repo.wgOk(['add', 'a', '--kind', 'feature']);
    const out = repo.wgOk(['claim', '1']);
    const wt = /worktree: (.+)/.exec(out)?.[1] ?? '';
    expect(render({ cwd: wt })).toContain('#1');
  });

  it('formats reset countdowns', () => {
    expect(formatReset(100, 200)).toBe('(reset)');
    expect(formatReset(3600 + 120 + 200, 200)).toBe('(1h 2m)');
    expect(formatReset(600 + 200, 200)).toBe('(10m)');
  });
});

describe('statusline install', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'wg-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const install = (settings: string, ...extra: string[]): { code: number; out: string; err: string } => {
    const r = spawnSync('node', [WG, 'statusline', 'install', '--settings', settings, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
  };

  it('installs the script, sets statusLine with a refresh interval and keeps other settings', () => {
    const settings = join(home, 'settings.json');
    writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
    const r = install(settings);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(settings, 'utf8')) as { theme: string; statusLine: { command: string; refreshInterval: number; type: string } };
    expect(written.theme).toBe('dark');
    expect(written.statusLine.type).toBe('command');
    expect(written.statusLine.refreshInterval).toBe(30);
    expect(existsSync(join(home, '.claude', 'workgate', 'wg'))).toBe(true);
    expect(written.statusLine.command).toBe(`${join(home, '.claude', 'workgate', 'wg')} statusline`);
  });

  it('refuses to replace a different statusLine without --force and backs it up with it', () => {
    const settings = join(home, 'settings.json');
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/mine.sh' } }));
    const refused = install(settings);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--force');
    expect(JSON.parse(readFileSync(settings, 'utf8')) as { statusLine: { command: string } }).toMatchObject({ statusLine: { command: 'bash ~/mine.sh' } });
    expect(install(settings, '--force').code).toBe(0);
    expect(readFileSync(join(home, '.claude', 'workgate', 'statusline-backup.json'), 'utf8')).toContain('mine.sh');
  });

  it('is idempotent', () => {
    const settings = join(home, 'settings.json');
    expect(install(settings).code).toBe(0);
    expect(install(settings).code).toBe(0);
  });
});

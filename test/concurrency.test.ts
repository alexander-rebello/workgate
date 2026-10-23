import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WG, makeRepo, type TestRepo } from './helpers.js';

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
});

/** Exit code, with stderr kept so a failure in CI says why instead of only showing a 1. */
function wgAsync(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', [WG, ...args], { cwd: repo.dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => {
      if (code !== 0) console.error(`wg ${args.join(' ')} exited ${code ?? 'null'}:\n${err}`);
      resolve(code ?? 1);
    });
  });
}

describe('concurrency', () => {
  it('allocates unique ids and keeps the history clean under parallel adds', async () => {
    const codes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => wgAsync(['add', `Parallel ${i}`, '--kind', 'feature'])),
    );
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const ids = repo
      .wgOk(['list', '--json'])
      .split('\n')
      .flatMap((l) => (JSON.parse(l) as { id: number }[]).map((i) => i.id));
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(repo.git(['status', '--porcelain'])).toBe('');
    expect(repo.wgOk(['doctor'])).toContain('No problems');
  });

  it('serializes a claim against another claim of the same item', async () => {
    repo.wgOk(['add', 'Contested', '--kind', 'feature']);
    const codes = await Promise.all([wgAsync(['claim', '1']), wgAsync(['claim', '1'])]);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(repo.wgOk(['doctor'])).toContain('No problems');
  });
});

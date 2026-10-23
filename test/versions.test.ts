import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WG } from './helpers.js';

interface Versioned {
  version: string;
}
interface Marketplace {
  plugins: Versioned[];
}

const readVersioned = (path: string): Versioned =>
  JSON.parse(readFileSync(path, 'utf8')) as Versioned;
const readMarketplace = (path: string): Marketplace =>
  JSON.parse(readFileSync(path, 'utf8')) as Marketplace;

describe('release versions', () => {
  it('keeps the plugin manifests in sync with package.json', () => {
    const { version } = readVersioned('package.json');
    expect(readVersioned('.claude-plugin/plugin.json').version).toBe(version);
    for (const p of readMarketplace('.claude-plugin/marketplace.json').plugins) {
      expect(p.version).toBe(version);
    }
  });

  it('prints the package version with --version', () => {
    const { version } = readVersioned('package.json');
    const r = spawnSync('node', [WG, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it('ships the bundle without runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

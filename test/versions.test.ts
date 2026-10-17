import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
});

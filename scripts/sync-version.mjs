import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
plugin.version = version;
writeFileSync('.claude-plugin/plugin.json', `${JSON.stringify(plugin, null, 2)}\n`);

const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
for (const p of market.plugins) p.version = version;
writeFileSync('.claude-plugin/marketplace.json', `${JSON.stringify(market, null, 2)}\n`);

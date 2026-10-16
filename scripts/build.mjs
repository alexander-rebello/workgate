import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

mkdirSync('bin', { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'bin/wg',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'none',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __wgCreateRequire } from 'node:module';",
      'const require = __wgCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

chmodSync('bin/wg', 0o755);

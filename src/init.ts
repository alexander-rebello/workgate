import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WgError } from './errors.js';
import { commitOnly, currentBranch, git } from './git.js';
import { writeIndex } from './indexgen.js';
import { loadAll } from './items.js';
import { CONFIG_REL, locateGit, readConfig } from './repo.js';
import type { Config } from './types.js';
import { ConfigSchema } from './types.js';

function detectGates(root: string): Config['gates'] {
  const pkgFile = join(root, 'package.json');
  if (!existsSync(pkgFile)) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const runner = existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm run'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : 'npm run';
  return ['lint', 'build', 'test']
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => ({ name, command: `${runner} ${name}` }));
}

export interface InitOptions {
  branch?: string | undefined;
  claudeMd: boolean;
  commit: boolean;
}

const CLAUDE_MD_SECTION = `
## Work items (workgate)

Work is tracked with the \`wg\` CLI; item files live in the todos directory configured in \`.workgate/config.json\`.
The workflow rules are injected at session start by the workgate plugin. Follow them for every edit to this repository.
`;

export async function initRepo(cwd: string, options: InitOptions): Promise<string[]> {
  const loc = await locateGit(cwd);
  if (loc === undefined) throw new WgError('Not inside a git repository.');
  if (loc.toplevel !== loc.mainRoot) throw new WgError('Run "wg init" from the main checkout, not a worktree.');
  const log: string[] = [];
  const configFile = join(loc.mainRoot, CONFIG_REL);
  if (existsSync(configFile)) {
    log.push(`${CONFIG_REL} already exists; left unchanged.`);
  } else {
    const branch = options.branch ?? (await currentBranch(loc.mainRoot));
    const config = ConfigSchema.parse({
      version: 1,
      integrationBranch: branch,
      gates: detectGates(loc.mainRoot),
    });
    mkdirSync(join(loc.mainRoot, '.workgate'), { recursive: true });
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    log.push(`Wrote ${CONFIG_REL} (integration branch "${branch}", ${config.gates.length} gate(s) detected).`);
  }
  const config = readConfig(loc.mainRoot);
  const repo = { ...loc, stateDir: join(loc.commonDir, 'workgate'), config };
  mkdirSync(join(loc.mainRoot, config.todosDir), { recursive: true });
  const keep = join(loc.mainRoot, config.todosDir, '.gitkeep');
  if (!existsSync(keep)) writeFileSync(keep, '');
  const { items } = loadAll(repo);
  const indexRel = writeIndex(repo, items);
  const paths = [CONFIG_REL, relative(loc.mainRoot, keep), indexRel];
  if (options.claudeMd) {
    const claudeMd = join(loc.mainRoot, 'CLAUDE.md');
    if (!existsSync(claudeMd) || !readFileSync(claudeMd, 'utf8').includes('(workgate)')) {
      appendFileSync(claudeMd, CLAUDE_MD_SECTION);
      paths.push('CLAUDE.md');
      log.push('Added a workgate section to CLAUDE.md.');
    }
  }
  if (options.commit) {
    const branch = await currentBranch(loc.mainRoot);
    if (branch !== config.integrationBranch) {
      log.push(`On "${branch}", not "${config.integrationBranch}"; files written but not committed.`);
    } else {
      const pending = await git(loc.mainRoot, ['status', '--porcelain', '--', ...paths]);
      if (pending === '') {
        log.push('Nothing to commit.');
      } else {
        await commitOnly(loc.mainRoot, paths, `Set up workgate${config.commitSuffix}`);
        log.push('Committed the setup.');
      }
    }
  }
  return log;
}

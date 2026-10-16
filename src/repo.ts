import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { WgError } from './errors.js';
import { run } from './exec.js';
import { ConfigSchema, type Config, type Repo } from './types.js';

export const CONFIG_REL = '.workgate/config.json';

interface GitLocation {
  toplevel: string;
  mainRoot: string;
  commonDir: string;
}

export async function locateGit(cwd: string): Promise<GitLocation | undefined> {
  if (!existsSync(cwd)) return undefined;
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return undefined;
  const common = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (common.code !== 0) return undefined;
  const commonDir = common.stdout.trim();
  if (basename(commonDir) !== '.git') return undefined;
  return { toplevel: top.stdout.trim(), mainRoot: dirname(commonDir), commonDir };
}

export function readConfig(mainRoot: string): Config {
  const file = join(mainRoot, CONFIG_REL);
  if (!existsSync(file)) {
    throw new WgError(`No ${CONFIG_REL} in ${mainRoot}. Run "wg init" first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new WgError(`${CONFIG_REL} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WgError(`${CONFIG_REL} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Returns undefined when cwd is not inside a git repo that uses workgate. */
export async function tryResolveRepo(cwd: string): Promise<Repo | undefined> {
  const loc = await locateGit(cwd);
  if (loc === undefined) return undefined;
  if (!existsSync(join(loc.mainRoot, CONFIG_REL))) return undefined;
  return {
    ...loc,
    stateDir: join(loc.commonDir, 'workgate'),
    config: readConfig(loc.mainRoot),
  };
}

export async function resolveRepo(cwd: string): Promise<Repo> {
  const loc = await locateGit(cwd);
  if (loc === undefined) throw new WgError('Not inside a git repository (bare repos are unsupported).');
  return {
    ...loc,
    stateDir: join(loc.commonDir, 'workgate'),
    config: readConfig(loc.mainRoot),
  };
}

export function worktreeRoot(repo: Repo): string {
  const configured = repo.config.worktreeDir;
  if (configured !== undefined) return resolve(repo.mainRoot, configured);
  return resolve(dirname(repo.mainRoot), `${basename(repo.mainRoot)}-worktrees`);
}

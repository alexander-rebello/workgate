import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WgError } from './errors.js';

const SettingsSchema = z.record(z.string(), z.unknown());
const ExistingSchema = z.object({ command: z.string().optional() }).loose();

export interface InstallOptions {
  settingsFile?: string | undefined;
  homeDir?: string | undefined;
  force: boolean;
  refreshSeconds: number;
}

export function installStatusline(scriptPath: string, options: InstallOptions): string[] {
  const home = options.homeDir ?? homedir();
  const settingsFile = options.settingsFile ?? join(home, '.claude', 'settings.json');
  const targetDir = join(home, '.claude', 'workgate');
  const target = join(targetDir, 'wg');
  const log: string[] = [];

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch (error) {
      throw new WgError(`${settingsFile} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) throw new WgError(`${settingsFile} must contain a JSON object.`);
    settings = parsed.data;
  }

  const command = `${target} statusline`;
  const existing = ExistingSchema.safeParse(settings['statusLine']);
  if (existing.success && existing.data.command !== undefined && existing.data.command !== command && !options.force) {
    throw new WgError(
      `A different statusLine is already configured:\n  ${existing.data.command}\nRe-run with --force to replace it (the old value is saved to ${join(targetDir, 'statusline-backup.json')}).`,
    );
  }

  mkdirSync(targetDir, { recursive: true });
  if (existing.success && existing.data.command !== undefined && existing.data.command !== command) {
    writeFileSync(join(targetDir, 'statusline-backup.json'), JSON.stringify(settings['statusLine'], null, 2));
    log.push('Saved the previous statusLine to statusline-backup.json.');
  }
  copyFileSync(realpathSync(scriptPath), target);
  chmodSync(target, 0o755);
  settings['statusLine'] = { type: 'command', command, refreshInterval: options.refreshSeconds };
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  log.push(`Installed ${target} and set statusLine in ${settingsFile} (refresh every ${options.refreshSeconds}s).`);
  return log;
}

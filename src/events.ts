import { runShell } from './exec.js';
import type { Item, Repo, WgEvent } from './types.js';

export interface EventResult {
  output: string;
  warnings: string[];
}

/** Runs the configured hooks for an event. Hooks are notifications: failures become warnings, never errors. */
export async function fireEvent(repo: Repo, event: WgEvent, item: Item): Promise<EventResult> {
  const input = JSON.stringify({ event, item: { ...item.meta, file: item.file } });
  let output = '';
  const warnings: string[] = [];
  for (const hook of repo.config.hooks.filter((h) => h.on.includes(event))) {
    const result = await runShell(hook.command, repo.mainRoot, { input, timeoutMs: hook.timeoutSeconds * 1000 });
    output += result.stdout;
    if (result.timedOut) warnings.push(`hook "${hook.command}" timed out after ${hook.timeoutSeconds}s and was killed`);
    else if (result.code !== 0) warnings.push(`hook "${hook.command}" exited with code ${result.code}: ${result.stderr.trim()}`);
  }
  return { output, warnings };
}

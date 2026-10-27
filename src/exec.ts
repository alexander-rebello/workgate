import { execFile, spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(command: string, args: readonly string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
      },
    );
  });
}

export interface ShellResult extends ExecResult {
  output: string;
  timedOut: boolean;
}

export interface ShellOptions {
  /** Written to the child's stdin; stdin is closed either way. */
  input?: string | undefined;
  /** Kills the command's whole process tree after this many milliseconds. */
  timeoutMs?: number | undefined;
}

const activeShells = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** Stops every running gate command with its whole process tree (a build spawns workers of its own). */
export function killActiveShells(): void {
  for (const pid of activeShells) killGroup(pid);
  activeShells.clear();
}

/** Runs a configured command through the shell, merging both streams. */
export function runShell(command: string, cwd: string, options: ShellOptions = {}): Promise<ShellResult> {
  return new Promise((resolve) => {
    // Own process group (detached) so killActiveShells and the timeout can stop the command's children too.
    const child = spawn(command, { cwd, shell: true, env: process.env, detached: process.platform !== 'win32' });
    if (child.pid !== undefined) activeShells.add(child.pid);
    let output = '';
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<ShellResult, 'timedOut'>, timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (child.pid !== undefined) activeShells.delete(child.pid);
      resolve({ ...result, timedOut });
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid);
        finish({ code: 1, stdout, stderr, output }, true);
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      stdout += text;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      stderr += text;
    });
    // A command that never reads stdin closes the pipe early; that is not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
    child.on('error', (error) => {
      finish({ code: 1, stdout, stderr: error.message, output: error.message });
    });
    child.on('close', (code) => {
      finish({ code: code ?? 1, stdout, stderr, output });
    });
  });
}

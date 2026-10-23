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
}

const activeShells = new Set<number>();

/** Stops every running gate command with its whole process tree (a build spawns workers of its own). */
export function killActiveShells(): void {
  for (const pid of activeShells) {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  activeShells.clear();
}

/** Runs a user-configured gate command through the shell, merging both streams. */
export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    // Own process group (detached) so killActiveShells can stop the command's children too.
    const child = spawn(command, { cwd, shell: true, env: process.env, detached: process.platform !== 'win32' });
    if (child.pid !== undefined) activeShells.add(child.pid);
    const forget = (): void => {
      if (child.pid !== undefined) activeShells.delete(child.pid);
    };
    let output = '';
    let stdout = '';
    let stderr = '';
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
    child.on('error', (error) => {
      forget();
      resolve({ code: 1, stdout, stderr: error.message, output: error.message });
    });
    child.on('close', (code) => {
      forget();
      resolve({ code: code ?? 1, stdout, stderr, output });
    });
  });
}

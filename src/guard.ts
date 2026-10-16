/**
 * Static analysis of Bash commands for the git deny rule. It is a guard against
 * accidents and rationalization, not a security boundary: a determined shell user
 * can always obfuscate a command.
 */

const READ_ONLY_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'grep',
  'describe',
  'shortlog',
  'fetch',
  'cat-file',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'diff-tree',
  'ls-remote',
  'help',
  'version',
  'whatchanged',
  'check-ignore',
  'count-objects',
  'range-diff',
  'cherry',
  'verify-commit',
  'var',
]);

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'xargs', 'nice', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Global git options that consume the next token. */
const OPTIONS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);

export interface GitInvocation {
  subcommand: string;
  args: string[];
}

interface Word {
  text: string;
  /** True when the word was quoted at least in part, so it cannot be a bare operator. */
  quoted: boolean;
}

/** Splits a command into simple commands (lists of words), expanding $(...) and backticks. */
export function splitCommands(input: string, depth = 0): string[][] {
  const commands: string[][] = [];
  if (depth > 4) return commands;
  let words: Word[] = [];
  let current = '';
  let quoted = false;
  let hasWord = false;

  const flushWord = (): void => {
    if (hasWord) words.push({ text: current, quoted });
    current = '';
    quoted = false;
    hasWord = false;
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words.map((w) => w.text));
    words = [];
  };

  const nested = (code: string): void => {
    for (const cmd of splitCommands(code, depth + 1)) commands.push(cmd);
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      current += input.slice(i + 1, stop);
      quoted = true;
      hasWord = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      hasWord = true;
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const c = input[i] ?? '';
        if (c === '\\' && i + 1 < input.length) {
          current += input[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '$' && input[i + 1] === '(') {
          const close = findClosingParen(input, i + 2);
          nested(input.slice(i + 2, close));
          current += ' ';
          i = close + 1;
          continue;
        }
        if (c === '`') {
          const close = input.indexOf('`', i + 1);
          const stop = close === -1 ? input.length : close;
          nested(input.slice(i + 1, stop));
          i = stop + 1;
          continue;
        }
        current += c;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1] ?? '';
      hasWord = true;
      i += 2;
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') {
      const close = findClosingParen(input, i + 2);
      nested(input.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (ch === '`') {
      const close = input.indexOf('`', i + 1);
      const stop = close === -1 ? input.length : close;
      nested(input.slice(i + 1, stop));
      i = stop + 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flushCommand();
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i += 1;
      continue;
    }
    current += ch;
    hasWord = true;
    i += 1;
  }
  flushCommand();
  return commands;
}

function findClosingParen(input: string, from: number): number {
  let depth = 1;
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return input.length;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isGit(word: string): boolean {
  return word === 'git' || word.endsWith('/git');
}

/** Finds git invocations in a command, following shell -c / eval payloads. */
export function findGitInvocations(command: string, depth = 0): GitInvocation[] {
  const found: GitInvocation[] = [];
  if (depth > 4) return found;
  for (const words of splitCommands(command)) {
    let i = 0;
    while (i < words.length) {
      const word = words[i] ?? '';
      if (isAssignment(word) || WRAPPERS.has(word) || (word.startsWith('-') && i > 0)) {
        i += 1;
        continue;
      }
      break;
    }
    const head = words[i] ?? '';
    if (SHELLS.has(head.split('/').pop() ?? head)) {
      const dashC = words.findIndex((w, idx) => idx > i && /^-[a-z]*c[a-z]*$/.test(w));
      const payload = dashC === -1 ? undefined : words[dashC + 1];
      if (payload !== undefined) found.push(...findGitInvocations(payload, depth + 1));
      continue;
    }
    if (head === 'eval') {
      found.push(...findGitInvocations(words.slice(i + 1).join(' '), depth + 1));
      continue;
    }
    if (!isGit(head)) continue;
    let j = i + 1;
    while (j < words.length) {
      const w = words[j] ?? '';
      if (OPTIONS_WITH_ARG.has(w)) {
        j += 2;
        continue;
      }
      if (w.startsWith('-')) {
        j += 1;
        continue;
      }
      break;
    }
    const subcommand = words[j] ?? '';
    found.push({ subcommand, args: words.slice(j + 1) });
  }
  return found;
}

const BRANCH_LIST_FLAGS = new Set([
  '-a',
  '-r',
  '-l',
  '-v',
  '-vv',
  '--list',
  '--show-current',
  '--all',
  '--remotes',
  '--verbose',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--sort',
  '--format',
  '--points-at',
  '--color',
  '--no-color',
]);

export function isReadOnlyGit(inv: GitInvocation): boolean {
  const { subcommand, args } = inv;
  if (subcommand === '') return true;
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) return true;
  const positional = args.filter((a) => !a.startsWith('-'));
  switch (subcommand) {
    case 'branch': {
      const hasList = args.some((a) =>
        ['--list', '-l', '--contains', '--merged', '--no-merged', '--points-at'].includes(a),
      );
      const flagsOk = args
        .filter((a) => a.startsWith('-'))
        .every((a) => BRANCH_LIST_FLAGS.has(a.split('=')[0] ?? a));
      return flagsOk && (positional.length === 0 || hasList);
    }
    case 'tag':
      return positional.length === 0 || args.includes('-l') || args.includes('--list');
    case 'remote':
      return positional.length === 0 || positional[0] === 'show' || positional[0] === 'get-url';
    case 'config':
      return args.some((a) => a === '--get' || a === '--get-all' || a === '--get-regexp' || a === '--list' || a === '-l');
    case 'worktree':
      return positional[0] === 'list';
    case 'stash':
      return positional[0] === 'list' || positional[0] === 'show';
    case 'reflog':
      return positional.length === 0 || positional[0] === 'show';
    case 'symbolic-ref':
      return positional.length <= 1 && !args.includes('-d') && !args.includes('--delete');
    case 'submodule':
      return positional.length === 0 || positional[0] === 'status';
    default:
      return false;
  }
}

export function mutatingGit(command: string): GitInvocation[] {
  return findGitInvocations(command).filter((inv) => !isReadOnlyGit(inv));
}

const PROTECTED_STATE = /\.git\/workgate|\bbypass\.json\b/;

/** True if the command touches workgate's local state or manages bypass, which only the owner may do. */
export function touchesProtectedState(command: string): boolean {
  if (PROTECTED_STATE.test(command)) return true;
  return splitCommands(command).some((words) => {
    const idx = words.findIndex((w) => w === 'wg' || w.endsWith('/wg') || w === 'workgate' || w.endsWith('/workgate'));
    return idx !== -1 && words[idx + 1] === 'bypass' && words[idx + 2] !== 'status';
  });
}

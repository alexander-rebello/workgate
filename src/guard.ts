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
  return splitWords(input, depth).map((words) => words.map((w) => w.text));
}

function splitWords(input: string, depth: number): Word[][] {
  const commands: Word[][] = [];
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
    if (words.length > 0) commands.push(words);
    words = [];
  };

  const nested = (code: string): void => {
    for (const cmd of splitWords(code, depth + 1)) commands.push(cmd);
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

const REDIRECTION = /^\d*(<|>|&>)/;

/**
 * Finds simple commands that run a configured gate command as is (trailing redirections allowed).
 * Extra arguments mean a targeted run, which stays allowed.
 */
export function runsGateCommand(command: string, gateCommands: readonly string[]): string | undefined {
  const runs = splitCommands(command);
  for (const gate of gateCommands) {
    for (const gateWords of splitCommands(gate)) {
      if (gateWords.length === 0) continue;
      const hit = runs.some(
        (words) => gateWords.every((w, i) => words[i] === w) && words.slice(gateWords.length).every((w) => REDIRECTION.test(w)),
      );
      if (hit) return gate;
    }
  }
  return undefined;
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

const FILE_WRITERS = new Set(['tee', 'mv', 'cp', 'rm', 'truncate', 'install', 'ln', 'dd', 'rsync', 'patch']);
const IN_PLACE_EDITORS = new Set(['sed', 'perl', 'ruby']);
const INTERPRETERS = /^(python[\d.]*|node|ruby|perl|php|deno|bun)$/;

function basename0(words: readonly string[]): string {
  return (words[0] ?? '').split('/').pop() ?? '';
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the shell command appears to write to one of the given repo-relative paths (item files
 * and the index). Reads such as cat and grep pass. Like the git guard this catches mistakes, it is
 * not a security boundary.
 */
export function writesProtectedPaths(command: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  const alternatives = paths.map(escapeRegex).join('|');
  if (new RegExp(`>>?\\s*['"]?[^\\s'"]*(${alternatives})`).test(command)) return true;
  return splitCommands(command).some((segment) => {
    let words = segment;
    while (WRAPPERS.has(basename0(words))) words = words.slice(1);
    const name = basename0(words);
    if (SHELLS.has(name)) {
      const idx = words.findIndex((w) => /^-[a-z]*c$/.test(w));
      const script = idx === -1 ? undefined : words[idx + 1];
      if (script !== undefined) return writesProtectedPaths(script, paths);
    }
    if (!words.some((w) => paths.some((p) => w.includes(p)))) return false;
    if (FILE_WRITERS.has(name) || INTERPRETERS.test(name)) return true;
    return IN_PLACE_EDITORS.has(name) && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place');
  });
}

const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/** Drops here-document bodies so their text is not read as commands. */
function stripHeredocs(input: string): string {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of input.split('\n')) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const m of line.matchAll(HEREDOC)) {
      if (line[m.index + 2] === '<' || line[m.index - 1] === '<') continue;
      pending.push(m[3] ?? '');
    }
  }
  return kept.join('\n');
}

const REDIRECT = /^\d*(>>?|>\|)(.*)$/;
const COPIERS = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
const REMOVERS = new Set(['rm', 'rmdir', 'truncate', 'touch', 'mkdir']);
const SCRIPT_EDITORS = new Set(['sed', 'perl', 'ruby']);
/** Options that consume the next word, per command, so that word is not taken for a path. */
const OPTION_ARGS: Record<string, ReadonlySet<string>> = {
  truncate: new Set(['-s', '-r', '--size', '--reference']),
  touch: new Set(['-r', '-t', '-d', '--reference', '--date']),
  mkdir: new Set(['-m', '--mode']),
  install: new Set(['-m', '-o', '-g', '--mode', '--owner', '--group']),
  sed: new Set(['-e', '-f']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
};
const NO_OPTION_ARGS: ReadonlySet<string> = new Set();

function positionals(name: string, words: readonly string[]): string[] {
  const withArg = OPTION_ARGS[name] ?? NO_OPTION_ARGS;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (withArg.has(w)) i += 1;
    else if (!w.startsWith('-')) out.push(w);
  }
  return out;
}

function editorTargets(name: string, words: readonly string[]): string[] {
  const inPlace = words.findIndex((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'));
  if (inPlace === -1) return [];
  const rest = [...words];
  // BSD sed takes the backup suffix as a separate word: sed -i '' ...
  const next = rest[inPlace + 1];
  if (rest[inPlace] === '-i' && next !== undefined && (next === '' || next.startsWith('.'))) rest.splice(inPlace + 1, 1);
  const files = positionals(name, rest);
  const hasScriptOption = rest.some((w) => w === '-e' || w === '-f' || /^-[a-zA-Z]*e$/.test(w));
  return hasScriptOption ? files : files.slice(1);
}

function commandTargets(words: readonly Word[], depth: number): string[] {
  const targets: string[] = [];
  const plain: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === undefined) continue;
    const m = w.quoted ? null : REDIRECT.exec(w.text);
    if (m === null) {
      plain.push(w.text);
      continue;
    }
    const inline = m[2] ?? '';
    if (inline !== '') targets.push(inline);
    else if (words[i + 1] !== undefined) {
      targets.push(words[i + 1]?.text ?? '');
      i += 1;
    }
  }
  let rest = plain;
  while (rest.length > 0 && (WRAPPERS.has(basename0(rest)) || isAssignment(rest[0] ?? ''))) rest = rest.slice(1);
  const name = basename0(rest);
  const args = rest.slice(1);
  if (SHELLS.has(name)) {
    const idx = args.findIndex((w) => /^-[a-z]*c$/.test(w));
    const script = idx === -1 ? undefined : args[idx + 1];
    if (script !== undefined) targets.push(...collectTargets(script, depth + 1));
  } else if (name === 'eval') {
    targets.push(...collectTargets(args.join(' '), depth + 1));
  } else if (name === 'tee' || REMOVERS.has(name)) {
    targets.push(...positionals(name, args));
  } else if (COPIERS.has(name)) {
    const files = positionals(name, args);
    if (files.length >= 2) targets.push(files[files.length - 1] ?? '');
  } else if (SCRIPT_EDITORS.has(name)) {
    targets.push(...editorTargets(name, args));
  } else if (name === 'dd') {
    for (const a of args) if (a.startsWith('of=')) targets.push(a.slice(3));
  }
  return targets;
}

function collectTargets(command: string, depth: number): string[] {
  if (depth > 4) return [];
  return splitWords(stripHeredocs(command), depth).flatMap((words) => commandTargets(words, depth));
}

/**
 * Paths a shell command appears to write, create or delete, as written in the command. Targets that
 * cannot be resolved statically (variables, substitutions) and device files are left out. Interpreter
 * scripts are not inspected. Used for a warning only, so misses are acceptable and false alarms are not.
 */
export function shellWriteTargets(command: string): string[] {
  return collectTargets(command, 0).filter(
    (t) => t !== '' && !t.includes('$') && !t.includes('`') && !t.startsWith('/dev/'),
  );
}

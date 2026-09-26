import { tmpdir } from 'node:os'
import { isAbsolute, normalize, sep } from 'node:path'
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'

export type MutationRule = {
  readonly command: string
  readonly when: string
  readonly reason: string
}

export type MutationFinding = {
  readonly segment: string
  readonly reason: string
}

const ALWAYS = 'always'
const DRIVEN = "the driven command's own reason"

const ALWAYS_MUTATING: Readonly<Record<string, string>> = {
  rm: 'rm removes files',
  rmdir: 'rmdir removes directories',
  unlink: 'unlink removes a file',
  shred: 'shred overwrites and removes files',
  mv: 'mv moves or renames files',
  rename: 'rename renames files',
  touch: 'touch creates files or rewrites their timestamps',
  mkdir: 'mkdir creates directories',
  ln: 'ln creates links',
  truncate: 'truncate rewrites file sizes',
  chmod: 'chmod changes file permissions',
  chown: 'chown changes file ownership',
  chgrp: 'chgrp changes file ownership',
  patch: 'patch rewrites the files a diff names',
}

export const MUTATING_COMMAND_TABLE: readonly MutationRule[] = [
  ...Object.entries(ALWAYS_MUTATING).map(([command, reason]) => ({ command, when: ALWAYS, reason })),
  { command: 'cp / install / rsync', when: 'the destination lies outside the temp dir', reason: 'cp writes its destination' },
  { command: 'tee', when: 'a file operand lies outside the temp dir', reason: 'tee writes its file operands' },
  { command: 'dd', when: 'its of= target lies outside the temp dir', reason: 'dd writes its of= target' },
  { command: 'sed', when: '-i or --in-place is present', reason: 'sed -i rewrites its files in place' },
  { command: 'perl', when: '-i is present', reason: 'perl -i rewrites its files in place' },
  { command: 'tar', when: 'extracting into, or writing an archive to, a place outside the temp dir', reason: 'tar -x unpacks files into its directory; tar -c writes its archive file' },
  { command: 'unzip', when: 'extracting into a directory outside the temp dir', reason: 'unzip unpacks files into its directory' },
  { command: 'git <subcommand>', when: 'the subcommand writes the working tree, the index, the refs or a config file (a --dry-run does not)', reason: 'git <subcommand> writes the working tree, the index, the refs or a config file' },
  { command: 'npm / pnpm / yarn / bun <subcommand>', when: 'the subcommand installs, removes, links or updates packages (a bare yarn installs)', reason: '<manager> <subcommand> writes node_modules and the lockfile' },
  { command: 'prettier / biome / eslint / gofmt / black / rustfmt / ruff', when: 'invoked with its write flag, or (black, rustfmt, ruff format) without --check or --diff', reason: '<formatter> rewrites the files it formats' },
  { command: 'curl / wget', when: 'writing its download to a file outside the temp dir', reason: '<downloader> writes its download to a file' },
  { command: 'find', when: '-delete, -fprint/-fprint0/-fprintf/-fls outside the temp dir, or an -exec/-execdir/-ok/-okdir command that mutates', reason: 'find -delete removes files; find -fprint writes a file; find -exec runs the command it names' },
  { command: 'xargs <command>', when: 'the driven command mutates', reason: DRIVEN },
  { command: 'sudo / doas / env / nice / nohup / time / timeout / stdbuf / command / builtin / exec <command>', when: 'the wrapped command mutates', reason: DRIVEN },
  { command: 'bash -c / sh -c / zsh -c / dash -c / ksh -c / eval', when: 'the inner script mutates', reason: DRIVEN },
  { command: '`...`', when: 'the embedded command mutates', reason: DRIVEN },
  { command: '> / >> / >| / &> redirection', when: 'the target lies outside the temp dir or cannot be resolved', reason: 'a write redirection creates or truncates its target' },
]

const REDIRECT_REASON = 'a write redirection creates or truncates its target'
const UNRESOLVED_REDIRECT_REASON = 'a write redirection names a target that cannot be resolved'

const SINKS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])
const KEYWORDS: ReadonlySet<string> = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U'])
const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])
const NICE_VALUE_FLAGS: ReadonlySet<string> = new Set(['-n', '--adjustment'])
const TIME_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '-o', '--format', '--output'])
const TIMEOUT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-s', '-k', '--signal', '--kill-after'])
const STDBUF_VALUE_FLAGS: ReadonlySet<string> = new Set(['-i', '-o', '-e', '--input', '--output', '--error'])
const XARGS_VALUE_FLAGS: ReadonlySet<string> = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-a', '-E', '--replace', '--max-args', '--max-procs', '--delimiter', '--max-lines', '--max-chars', '--arg-file', '--eof'])
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_WRITERS: ReadonlySet<string> = new Set(['install', 'i', 'ci', 'add', 'a', 'remove', 'rm', 'r', 'uninstall', 'un', 'unlink', 'link', 'ln', 'update', 'up', 'upgrade', 'dedupe', 'ddp', 'prune', 'rebuild', 'rb', 'init', 'create', 'pin', 'patch', 'patch-commit', 'import'])
const PACKAGE_VALUE_FLAGS: ReadonlySet<string> = new Set(['--prefix', '-C', '--cwd', '--dir', '--filter', '-w', '--workspace', '--registry'])
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds'])
const GIT_WRITERS: ReadonlySet<string> = new Set(['commit', 'checkout', 'switch', 'restore', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'apply', 'add', 'rm', 'mv', 'clean', 'pull', 'init', 'clone', 'gc', 'prune', 'repack', 'filter-branch', 'filter-repo', 'update-ref', 'update-index', 'read-tree', 'checkout-index', 'bisect', 'mergetool', 'replace', 'fast-import'])
const GIT_TAG_LISTING: readonly string[] = ['-l', '--list', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged']
const GIT_BRANCH_WRITING: readonly string[] = ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-f', '--force']
const GIT_BRANCH_LISTING: readonly string[] = ['-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current', '--format', '--sort', '--column']
const GIT_CONFIG_WRITING: readonly string[] = ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit']
const GIT_CONFIG_READING: readonly string[] = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool']
const GIT_CONFIG_VERBS_WRITING: readonly string[] = ['set', 'unset', 'rename-section', 'remove-section', 'edit']
const GIT_CONFIG_VERBS_READING: readonly string[] = ['get', 'list']
const GIT_CONFIG_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file', '--blob', '-t', '--type', '--default'])
const GIT_DRY_RUN_SHORT: ReadonlySet<string> = new Set(['clean', 'add', 'rm', 'mv'])
const FORMATTER_WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  prettier: ['--write', '-w'],
  biome: ['--write', '--apply', '--apply-unsafe', '--fix', '--unsafe'],
  eslint: ['--fix', '--fix-dry-run=false'],
  gofmt: ['-w'],
  oxlint: ['--fix'],
}
const FORMATTERS_WRITING_BY_DEFAULT: ReadonlySet<string> = new Set(['black', 'rustfmt'])
const FORMATTER_CHECK_FLAGS: readonly string[] = ['--check', '--diff', '--dry-run', '-l', '--list-different']
const CURL_OUTPUT_FLAGS: ReadonlySet<string> = new Set(['-o', '--output'])
const CURL_REMOTE_NAME_FLAGS: ReadonlySet<string> = new Set(['-O', '--remote-name', '--remote-name-all'])
const WGET_OUTPUT_FLAGS: ReadonlySet<string> = new Set(['-O', '--output-document', '-P', '--directory-prefix'])
const GIT_VERBS: Readonly<Record<string, { readonly writing: readonly string[]; readonly what: string }>> = {
  remote: { writing: ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'], what: 'writes the remote configuration' },
  notes: { writing: ['add', 'append', 'edit', 'remove', 'prune', 'copy', 'merge'], what: 'writes the notes refs' },
  reflog: { writing: ['expire', 'delete'], what: 'rewrites the reflog' },
  worktree: { writing: ['add', 'remove', 'move', 'lock', 'unlock', 'prune', 'repair'], what: 'writes a worktree' },
  submodule: { writing: ['add', 'init', 'deinit', 'update', 'sync', 'absorbgitdirs', 'set-branch', 'set-url'], what: 'writes the submodules' },
  'sparse-checkout': { writing: ['init', 'set', 'add', 'reapply', 'disable'], what: 'rewrites the working tree' },
  maintenance: { writing: ['run', 'start', 'stop', 'register', 'unregister'], what: 'rewrites the repository' },
}
const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FIND_FILE_WRITERS: ReadonlySet<string> = new Set(['-fprint', '-fprint0', '-fprintf', '-fls'])
const INSTALL_VALUE_FLAGS: ReadonlySet<string> = new Set(['-m', '-o', '-g', '-S', '--mode', '--owner', '--group', '--suffix', '--strip-program'])

export function defaultTempRoots(): readonly string[] {
  const roots = new Set<string>(['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/dev/shm'])
  const system = tmpdir()
  roots.add(system)
  if (system.startsWith('/var/')) roots.add(`/private${system}`)
  if (system.startsWith('/private/var/')) roots.add(system.slice('/private'.length))
  return [...roots].map(root => (root.length > 1 && root.endsWith(sep) ? root.slice(0, -1) : root))
}

function comparable(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function isUnderTempRoot(target: string, roots: readonly string[] = defaultTempRoots()): boolean {
  if (!isAbsolute(target)) return false
  const full = comparable(normalize(target))
  return roots.some(root => {
    const base = comparable(normalize(root))
    return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
  })
}

function isSink(target: string): boolean {
  return SINKS.has(target) || target.startsWith('/dev/fd/') || target.startsWith('/proc/self/fd/')
}

function commandName(word: string): string {
  const slash = word.lastIndexOf('/')
  return slash === -1 ? word : word.slice(slash + 1)
}

function tokenize(segment: string): string[] | null {
  const parse = pinnedCommandAnalysis.tryParseShellCommand(segment)
  if (!parse.success) return null
  const argv: string[] = []
  for (const token of parse.tokens) {
    if (typeof token === 'string') {
      argv.push(token)
      continue
    }
    if ('op' in token && token.op === 'glob') {
      argv.push(token.pattern)
      continue
    }
    break
  }
  return argv
}

function skipFlags(words: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (word === '--') return words.slice(i + 1)
    if (!word.startsWith('-') || word === '-') break
    i += valueFlags.has(word) ? 2 : 1
  }
  return words.slice(i)
}

function skipEnv(words: readonly string[]): string[] {
  let rest: string[] = [...words]
  for (;;) {
    rest = skipFlags(rest, ENV_VALUE_FLAGS)
    if (rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) {
      rest = rest.slice(1)
      continue
    }
    return rest
  }
}

function unwrap(argv: readonly string[]): string[] {
  let words: string[] = [...argv]
  for (;;) {
    while (words.length > 0 && (KEYWORDS.has(words[0] as string) || ASSIGNMENT.test(words[0] as string))) words = words.slice(1)
    if (words[0] === 'function') {
      words = words.slice(2)
      continue
    }
    if (words.length === 0) return words
    const rest = words.slice(1)
    switch (commandName(words[0] as string)) {
      case 'sudo':
      case 'doas':
        words = skipFlags(rest, SUDO_VALUE_FLAGS)
        break
      case 'env':
        words = skipEnv(rest)
        break
      case 'nice':
        words = skipFlags(rest, NICE_VALUE_FLAGS)
        break
      case 'time':
        words = skipFlags(rest, TIME_VALUE_FLAGS)
        break
      case 'timeout':
        words = skipFlags(rest, TIMEOUT_VALUE_FLAGS).slice(1)
        break
      case 'stdbuf':
        words = skipFlags(rest, STDBUF_VALUE_FLAGS)
        break
      case 'xargs':
        words = skipFlags(rest, XARGS_VALUE_FLAGS)
        break
      case 'command':
        words = rest[0]?.startsWith('-') ? [] : rest
        break
      case 'nohup':
      case 'builtin':
      case 'exec':
      case 'busybox':
        words = rest
        break
      default:
        return words
    }
  }
}

function operandsOf(args: readonly string[]): string[] {
  const operands: string[] = []
  let ended = false
  for (const arg of args) {
    if (!ended && arg === '--') {
      ended = true
      continue
    }
    if (ended || !arg.startsWith('-') || arg === '-') operands.push(arg)
  }
  return operands
}

function hasInPlaceFlag(args: readonly string[], valueLetters: string): boolean {
  for (const arg of args) {
    if (arg === '--') return false
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return true
    if (!arg.startsWith('-') || arg.startsWith('--') || arg === '-') continue
    for (const letter of arg.slice(1)) {
      if (letter === 'i') return true
      if (valueLetters.includes(letter)) break
    }
  }
  return false
}

function judgeDestination(name: string, args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  const reason = `${name} writes its destination`
  if (name === 'rsync' && args.some(arg => arg === '--dry-run' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('n')))) return null
  let target: string | undefined
  const operands: string[] = []
  let ended = false
  let directoryMode = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!ended && arg === '--') {
      ended = true
      continue
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg === '-t' || arg === '--target-directory') target = args[++i]
      else if (arg.startsWith('--target-directory=')) target = arg.slice('--target-directory='.length)
      else if (name === 'install' && (arg === '-d' || arg === '--directory')) directoryMode = true
      else if (name === 'install' && INSTALL_VALUE_FLAGS.has(arg)) i++
      continue
    }
    operands.push(arg)
  }
  if (directoryMode) return operands.some(operand => !isUnderTempRoot(operand, roots)) ? { segment, reason } : null
  if (target === undefined) {
    if (operands.length < 2) return null
    target = operands[operands.length - 1] as string
  }
  if (name === 'rsync' && /^[^/]*:/.test(target)) return null
  return isUnderTempRoot(target, roots) ? null : { segment, reason }
}

function judgeTee(args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  const files = operandsOf(args).filter(operand => !isSink(operand))
  return files.some(file => !isUnderTempRoot(file, roots)) ? { segment, reason: 'tee writes its file operands' } : null
}

function judgeDd(args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  for (const arg of args) {
    if (!arg.startsWith('of=')) continue
    const target = arg.slice('of='.length)
    if (isSink(target) || isUnderTempRoot(target, roots)) continue
    return { segment, reason: 'dd writes its of= target' }
  }
  return null
}

function judgeTar(args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  let extracting = false
  let creating = false
  let directory: string | undefined
  let archive: string | undefined
  let archiveNext = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (archiveNext) {
      archive = arg
      archiveNext = false
      continue
    }
    if (arg === '--extract' || arg === '--get') extracting = true
    else if (arg === '--create' || arg === '--append' || arg === '--update') creating = true
    else if (arg === '--directory' || arg === '-C') directory = args[++i]
    else if (arg.startsWith('--directory=')) directory = arg.slice('--directory='.length)
    else if (arg === '--file' || arg === '-f') archiveNext = true
    else if (arg.startsWith('--file=')) archive = arg.slice('--file='.length)
    else if (arg.startsWith('--')) continue
    else if (arg.startsWith('-') || i === 0) {
      const cluster = arg.startsWith('-') ? arg.slice(1) : arg
      if (cluster.includes('x')) extracting = true
      if (cluster.includes('c') || cluster.includes('r') || cluster.includes('u')) creating = true
      if (cluster.includes('f')) archiveNext = true
    }
  }
  if (extracting && (directory === undefined || !isUnderTempRoot(directory, roots))) return { segment, reason: 'tar -x unpacks files into its directory' }
  if (creating && archive !== undefined && archive !== '-' && !isUnderTempRoot(archive, roots)) return { segment, reason: 'tar -c writes its archive file' }
  return null
}

function judgeUnzip(args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  let directory: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-d') directory = args[++i]
    else if (arg.startsWith('-') && !arg.startsWith('--') && /[ltzpc]/.test(arg.slice(1))) return null
    else if (arg === '-v' && args.length === 2) return null
  }
  if (directory !== undefined && isUnderTempRoot(directory, roots)) return null
  return { segment, reason: 'unzip unpacks files into its directory' }
}

function gitWriteReason(args: readonly string[]): string | null {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += GIT_VALUE_OPTIONS.has(args[i] as string) ? 2 : 1
  }
  const sub = args[i]
  if (sub === undefined) return null
  const rest = args.slice(i + 1)
  const operands: string[] = []
  const flags: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const arg = rest[k] as string
    if (!arg.startsWith('-')) {
      operands.push(arg)
      continue
    }
    flags.push(arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg)
    if (sub === 'config' && GIT_CONFIG_VALUE_FLAGS.has(arg)) k++
  }
  const has = (names: readonly string[]): boolean => flags.some(flag => names.includes(flag))
  const verb = operands[0] ?? ''
  const writes = (what: string): string => `git ${sub} ${what}`
  if (has(['--dry-run']) || (GIT_DRY_RUN_SHORT.has(sub) && has(['-n']))) return null
  if (GIT_WRITERS.has(sub)) return writes('writes the working tree, the index or the refs')
  switch (sub) {
    case 'stash':
      return verb === 'list' || verb === 'show' ? null : writes('writes the working tree and the stash refs')
    case 'tag':
      return operands.length > 0 && !has(GIT_TAG_LISTING) ? writes('creates or deletes a tag') : null
    case 'branch':
      return has(GIT_BRANCH_WRITING) || (operands.length > 0 && !has(GIT_BRANCH_LISTING)) ? writes('creates, deletes or moves a branch') : null
    case 'config':
      if (has(GIT_CONFIG_WRITING) || GIT_CONFIG_VERBS_WRITING.includes(verb)) return writes('writes a config file')
      if (has(GIT_CONFIG_READING) || GIT_CONFIG_VERBS_READING.includes(verb)) return null
      return operands.length >= 2 ? writes('writes a config file') : null
    case 'symbolic-ref':
      return has(['-d', '--delete']) || operands.length >= 2 ? writes('writes a ref') : null
    default: {
      const verbs = GIT_VERBS[sub]
      if (verbs === undefined) return null
      return verbs.writing.includes(verb) ? writes(verbs.what) : null
    }
  }
}

function packageWriteReason(manager: string, args: readonly string[]): string | null {
  const rest = skipFlags(args, PACKAGE_VALUE_FLAGS)
  const sub = rest[0]
  if (sub === undefined) return manager === 'yarn' ? 'yarn installs the packages the manifest names into node_modules' : null
  return PACKAGE_WRITERS.has(sub) ? `${manager} ${sub} writes node_modules and the lockfile` : null
}

function judgeFind(args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-delete') return { segment, reason: 'find -delete removes files' }
    if (FIND_FILE_WRITERS.has(arg)) {
      const target = args[i + 1]
      if (target === undefined || !isUnderTempRoot(target, roots)) return { segment, reason: `find ${arg} writes a file` }
      i++
      continue
    }
    if (!FIND_EXEC.has(arg)) continue
    const driven: string[] = []
    let j = i + 1
    while (j < args.length && args[j] !== ';' && args[j] !== '+') {
      driven.push(args[j] as string)
      j++
    }
    const inner = judgeCommandWords(driven, segment, roots)
    if (inner !== null) return { segment, reason: `find ${arg}: ${inner.reason}` }
    i = j
  }
  return null
}

function judgeFormatter(name: string, args: readonly string[], segment: string): MutationFinding | null {
  const reason = `${name} rewrites the files it formats`
  const flags = args.map(arg => (arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg))
  const writeFlags = FORMATTER_WRITE_FLAGS[name]
  if (writeFlags !== undefined) return flags.some(flag => writeFlags.includes(flag)) ? { segment, reason } : null
  if (name === 'ruff') {
    if (args[0] === 'format') return flags.some(flag => FORMATTER_CHECK_FLAGS.includes(flag)) ? null : { segment, reason }
    return flags.includes('--fix') ? { segment, reason } : null
  }
  if (FORMATTERS_WRITING_BY_DEFAULT.has(name)) return flags.some(flag => FORMATTER_CHECK_FLAGS.includes(flag)) ? null : { segment, reason }
  return null
}

function judgeDownloader(name: string, args: readonly string[], roots: readonly string[], segment: string): MutationFinding | null {
  const reason = `${name} writes its download to a file`
  if (name === 'curl') {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      if (CURL_REMOTE_NAME_FLAGS.has(arg)) return { segment, reason }
      if (!CURL_OUTPUT_FLAGS.has(arg) && !arg.startsWith('--output=')) continue
      const target = arg.startsWith('--output=') ? arg.slice('--output='.length) : args[++i]
      if (target === undefined) return null
      if (target === '-' || isSink(target) || isUnderTempRoot(target, roots)) continue
      return { segment, reason }
    }
    return null
  }
  let target: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--spider') return null
    if (WGET_OUTPUT_FLAGS.has(arg)) target = args[++i]
    else if (arg.startsWith('--output-document=')) target = arg.slice('--output-document='.length)
    else if (arg.startsWith('--directory-prefix=')) target = arg.slice('--directory-prefix='.length)
    else if (/^-O./.test(arg) || /^-P./.test(arg)) target = arg.slice(2)
  }
  if (target === undefined) return { segment, reason }
  if (target === '-' || isSink(target) || isUnderTempRoot(target, roots)) return null
  return { segment, reason }
}

function judgeShellScript(args: readonly string[], roots: readonly string[]): MutationFinding | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--' || !arg.startsWith('-')) return null
    if (arg.startsWith('--') || !arg.includes('c')) continue
    const script = args[i + 1]
    return script === undefined ? null : findMutatingSegment(script, roots)
  }
  return null
}

export function judgeCommandWords(argv: readonly string[], segment: string, roots: readonly string[] = defaultTempRoots()): MutationFinding | null {
  const words = unwrap(argv)
  if (words.length === 0) return null
  const name = commandName(words[0] as string)
  const args = words.slice(1)
  const always = ALWAYS_MUTATING[name]
  if (always !== undefined) return { segment, reason: always }
  if (SHELLS.has(name)) return judgeShellScript(args, roots)
  if (PACKAGE_MANAGERS.has(name)) {
    const reason = packageWriteReason(name, args)
    return reason === null ? null : { segment, reason }
  }
  if (name in FORMATTER_WRITE_FLAGS || FORMATTERS_WRITING_BY_DEFAULT.has(name) || name === 'ruff') return judgeFormatter(name, args, segment)
  switch (name) {
    case 'cp':
    case 'install':
    case 'rsync':
      return judgeDestination(name, args, roots, segment)
    case 'curl':
    case 'wget':
      return judgeDownloader(name, args, roots, segment)
    case 'tee':
      return judgeTee(args, roots, segment)
    case 'dd':
      return judgeDd(args, roots, segment)
    case 'sed':
      return hasInPlaceFlag(args, 'efl') ? { segment, reason: 'sed -i rewrites its files in place' } : null
    case 'perl':
      return hasInPlaceFlag(args, 'eEmMFlCIx0') ? { segment, reason: 'perl -i rewrites its files in place' } : null
    case 'tar':
      return judgeTar(args, roots, segment)
    case 'unzip':
      return judgeUnzip(args, roots, segment)
    case 'git': {
      const reason = gitWriteReason(args)
      return reason === null ? null : { segment, reason }
    }
    case 'find':
      return judgeFind(args, roots, segment)
    case 'eval':
      return findMutatingSegment(args.join(' '), roots)
    default:
      return null
  }
}

function judgeBackticks(segment: string, roots: readonly string[]): MutationFinding | null {
  let single = false
  let start = -1
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === "'" && start === -1) {
      single = !single
      continue
    }
    if (single || ch !== '`') continue
    if (start === -1) {
      start = i + 1
      continue
    }
    const inner = segment.slice(start, i)
    start = -1
    const finding = findMutatingSegment(inner, roots)
    if (finding !== null) return finding
  }
  return null
}

export function judgeShellSegment(segment: string, roots: readonly string[] = defaultTempRoots()): MutationFinding | null {
  const embedded = judgeBackticks(segment, roots)
  if (embedded !== null) return embedded
  const argv = tokenize(segment)
  if (argv === null) return null
  return judgeCommandWords(argv, segment, roots)
}

function judgeRedirections(command: string, roots: readonly string[]): MutationFinding | null {
  if (!pinnedCommandAnalysis.tryParseShellCommand(command).success) return null
  const { redirections, hasDangerousRedirection } = pinnedCommandAnalysis.extractOutputRedirections(command)
  for (const { target, operator } of redirections) {
    if (isSink(target) || isUnderTempRoot(target, roots)) continue
    return { segment: `${operator} ${target}`, reason: REDIRECT_REASON }
  }
  if (hasDangerousRedirection) return { segment: command.trim(), reason: UNRESOLVED_REDIRECT_REASON }
  return null
}

export function findMutatingSegment(command: string, roots: readonly string[] = defaultTempRoots()): MutationFinding | null {
  let segments: string[]
  try {
    segments = pinnedCommandAnalysis.splitCommand(command)
  } catch {
    segments = [command]
  }
  for (const raw of segments) {
    const segment = raw.trim()
    if (segment === '') continue
    const finding = judgeShellSegment(segment, roots)
    if (finding !== null) return finding
  }
  return judgeRedirections(command, roots)
}

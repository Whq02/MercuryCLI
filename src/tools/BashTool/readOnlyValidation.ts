/**
 * Read-only classification: decide whether a whole bash command is provably
 * read-only (auto-allowable without a prompt) via a flag allowlist plus a regex
 * allowlist, with git sandbox-escape guards. The floor is deliberately
 * conservative — anything the validator cannot fully account for falls through
 * to the normal permission path rather than being allowed.
 *
 * (Mercury note: the launcher help patterns in the regex allowlist route
 * through the identity owner rather than hard-coding a launcher name.)
 */
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  splitCommand_DEPRECATED,
  tryParseShellCommand,
  extractOutputRedirections,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  validateFlags,
  containsVulnerableUncPath,
  GIT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type ExternalCommandConfig,
  type FlagArgType,
} from '../../utils/shell/readOnlyCommandValidation.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { PATH_EXTRACTORS, COMMAND_OPERATION_TYPE, type PathCommand } from './pathValidation.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getPlatform } from '../../utils/platform.js'
import { binaryName } from '../../utils/config/derived.js'

// ── the local command configurations ──────────────────────────────────

const none: FlagArgType = 'none'
const str: FlagArgType = 'string'
const num: FlagArgType = 'number'
const char: FlagArgType = 'char'

/** ps: reject BSD-style option words (a bare all-letters token containing `e`). */
function psIsDangerous(_rawCommand: string, args: string[]): boolean {
  return args.some(token => !token.startsWith('-') && /^[a-z]+$/i.test(token) && token.includes('e'))
}

/** date: reject a positional that is not a `+`-format; skip flags and their args. */
function dateIsDangerous(_rawCommand: string, args: string[]): boolean {
  const argFlags = new Set(['-d', '--date', '-r', '--reference', '--iso-8601', '--rfc-3339'])
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (token.startsWith('--') && token.includes('=')) continue
    if (argFlags.has(token)) {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    if (!token.startsWith('+')) return true // a bare positional sets the clock
  }
  return false
}

/** lsof: reject any token equal to or beginning with `+m`. */
function lsofIsDangerous(_rawCommand: string, args: string[]): boolean {
  return args.some(token => token === '+m' || token.startsWith('+m'))
}

/** tput: reject dangerous capability names; honour `--` and `-T <value>`. */
const TPUT_DANGEROUS_CAPS = new Set([
  'init', 'reset', 'rs1', 'rs2', 'rs3', 'is1', 'is2', 'is3', 'iprog', 'if', 'rf',
  'clear', 'flash', 'mc0', 'mc4', 'mc5', 'mc5i', 'mc5p', 'pfkey', 'pfloc', 'pfx',
  'pfxl', 'smcup', 'rmcup',
])
function tputIsDangerous(_rawCommand: string, args: string[]): boolean {
  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (!optionsEnded && token === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && token === '-T') {
      i++ // -T consumes the following token
      continue
    }
    // -S bare or bundled with other short flags.
    if (!optionsEnded && /^-[A-Za-z]*S/.test(token)) return true
    if (optionsEnded || !token.startsWith('-')) {
      if (TPUT_DANGEROUS_CAPS.has(token)) return true
    }
  }
  return false
}

/** sed: defer entirely to the sed policy — dangerous unless that policy allows it. */
function sedIsDangerous(rawCommand: string): boolean {
  return !sedCommandIsAllowedByAllowlist(rawCommand)
}

/** The locally-declared configurations. Dangerous flags are OMITTED — omission is the control. */
const LOCAL_CONFIGS: Record<string, ExternalCommandConfig> = {
  xargs: { safeFlags: { '-I': char, '-E': 'EOF', '-n': num, '-P': num, '-0': none, '--null': none, '-a': str, '--arg-file': str, '-d': str, '--delimiter': str, '-L': num, '-p': none, '--interactive': none, '-r': none, '--no-run-if-empty': none, '-t': none, '--verbose': none } },
  file: { safeFlags: { '-b': none, '--brief': none, '-i': none, '--mime': none, '--mime-type': none, '--mime-encoding': none, '-L': none, '--dereference': none, '-z': none, '--uncompress': none, '-s': none, '--special-files': none } },
  // The read-only sed flags: flag validation runs BEFORE the dangerous-command
  // callback, so an empty map would reject every flag-bearing sed (`sed -n 1p f`)
  // before the policy ever saw it. The in-place `-i` stays OUT of this list;
  // the callback still rejects substitution/write seds.
  sed: {
    safeFlags: {
      '-e': str, '--expression': str,
      '-n': none, '--quiet': none, '--silent': none,
      '-r': none, '-E': none, '--regexp-extended': none, '--posix': none,
      '-l': num, '--line-length': num,
      '-z': none, '--zero-terminated': none,
      '-s': none, '--separate': none,
      '-u': none, '--unbuffered': none,
      '--debug': none, '--help': none, '--version': none,
    },
    additionalCommandIsDangerousCallback: sedIsDangerous,
  },
  sort: { safeFlags: { '-b': none, '-d': none, '-f': none, '-g': none, '-i': none, '-M': none, '-h': none, '-n': none, '-r': none, '-R': none, '-u': none, '-c': none, '-C': none, '-k': str, '--key': str, '-t': str, '--field-separator': str, '-z': none } },
  man: { safeFlags: { '-a': none, '--all': none, '-f': none, '--whatis': none, '-k': none, '--apropos': none, '-w': none, '--where': none } },
  help: { safeFlags: { '-d': none, '-m': none, '-s': none } },
  netstat: { safeFlags: { '-a': none, '-n': none, '-r': none, '-l': none, '-t': none, '-u': none, '-p': none, '-i': none, '-s': none } },
  ps: { safeFlags: { '-e': none, '-f': none, '-l': none, '-u': str, '-p': str, '-o': str, '-a': none, '-x': none, '-A': none, '--sort': str, '-C': str }, additionalCommandIsDangerousCallback: psIsDangerous },
  base64: { safeFlags: { '-d': none, '--decode': none, '-w': num, '--wrap': num, '-i': none, '--ignore-garbage': none }, respectsDoubleDash: false },
  grep: { safeFlags: { '-i': none, '-v': none, '-n': none, '-c': none, '-l': none, '-L': none, '-o': none, '-r': none, '-R': none, '-E': none, '-F': none, '-w': none, '-x': none, '-A': num, '-B': num, '-C': num, '-e': str, '-f': str, '--include': str, '--exclude': str, '--exclude-dir': str, '--include-dir': str, '--color': str, '-H': none, '-h': none, '--line-buffered': none } },
  sha256sum: { safeFlags: { '-b': none, '-c': none, '-t': none, '--tag': none } },
  sha1sum: { safeFlags: { '-b': none, '-c': none, '-t': none, '--tag': none } },
  md5sum: { safeFlags: { '-b': none, '-c': none, '-t': none, '--tag': none } },
  tree: { safeFlags: { '-a': none, '-d': none, '-f': none, '-i': none, '-l': none, '-L': num, '-P': str, '-I': str, '-C': none, '-n': none, '-p': none, '-s': none, '-h': none, '-D': none, '-t': none, '-r': none, '--dirsfirst': none, '-J': none } },
  date: { safeFlags: { '-u': none, '--utc': none, '-R': none, '--rfc-email': none, '-I': str, '--iso-8601': str, '-d': str, '--date': str, '-r': str, '--reference': str, '--rfc-3339': str }, additionalCommandIsDangerousCallback: dateIsDangerous },
  hostname: { safeFlags: { '-s': none, '--short': none, '-d': none, '--domain': none, '-f': none, '--fqdn': none, '-i': none, '-I': none, '-A': none }, regex: /^hostname(?:\s+-[A-Za-z])*\s*$/ },
  info: { safeFlags: { '-f': str, '--file': str, '-n': str, '--node': str, '-w': none, '--where': none, '--subnodes': none, '-a': none } },
  lsof: { safeFlags: { '-i': str, '-n': none, '-P': none, '-p': str, '-u': str, '-c': str, '-t': none, '-a': none, '-l': none, '-R': none, '-F': str }, additionalCommandIsDangerousCallback: lsofIsDangerous },
  pgrep: { safeFlags: { '-l': none, '-a': none, '-f': none, '-n': none, '-o': none, '-u': str, '-x': none, '-c': none, '-d': str } },
  tput: { safeFlags: { '-T': str }, additionalCommandIsDangerousCallback: tputIsDangerous },
  ss: { safeFlags: { '-a': none, '-l': none, '-n': none, '-p': none, '-t': none, '-u': none, '-x': none, '-s': none, '-r': none, '-i': none, '-e': none, '-m': none, '-o': none } },
  fd: FD_CONFIG(),
  fdfind: FD_CONFIG(),
}

/** fd / fdfind share one table; -x/-X/-l are OMITTED (execution / ls-spawn). */
function FD_CONFIG(): ExternalCommandConfig {
  return { safeFlags: { '-H': none, '--hidden': none, '-I': none, '--no-ignore': none, '-t': str, '--type': str, '-e': str, '--extension': str, '-d': num, '--max-depth': num, '-p': none, '--full-path': none, '-g': none, '--glob': none, '-a': none, '--absolute-path': none, '-c': str, '--color': str, '-s': none, '--case-sensitive': none, '-i': none, '--ignore-case': none, '-0': none, '--print0': none } }
}

/** xargs safe-target commands (contract data). */
const XARGS_TARGETS = ['echo', 'printf', 'wc', 'grep', 'head', 'tail']

/** Build the effective allowlist in the iteration order (Q-B3: no network/GH map). */
function buildAllowlist(): Map<string, ExternalCommandConfig> {
  const map = new Map<string, ExternalCommandConfig>()
  const add = (key: string, config: ExternalCommandConfig): void => {
    map.set(key, config)
  }
  const addAll = (src: Record<string, ExternalCommandConfig>): void => {
    for (const [key, config] of Object.entries(src)) map.set(key, config)
  }
  // Windows removes xargs entirely (data-to-code bridge).
  if (getPlatform() !== 'windows') add('xargs', LOCAL_CONFIGS.xargs as ExternalCommandConfig)
  addAll(GIT_READ_ONLY_COMMANDS)
  for (const key of ['file', 'sed', 'sort', 'man', 'help', 'netstat', 'ps', 'base64', 'grep']) {
    add(key, LOCAL_CONFIGS[key] as ExternalCommandConfig)
  }
  addAll(RIPGREP_READ_ONLY_COMMANDS)
  for (const key of ['sha256sum', 'sha1sum', 'md5sum', 'tree', 'date', 'hostname', 'info', 'lsof', 'pgrep', 'tput', 'ss', 'fd', 'fdfind']) {
    add(key, LOCAL_CONFIGS[key] as ExternalCommandConfig)
  }
  addAll(PYRIGHT_READ_ONLY_COMMANDS)
  addAll(DOCKER_READ_ONLY_COMMANDS)
  return map
}

let allowlistCache: Map<string, ExternalCommandConfig> | null = null
let allowlistPlatform: string | null = null
function effectiveAllowlist(): Map<string, ExternalCommandConfig> {
  const platform = getPlatform()
  if (allowlistCache === null || allowlistPlatform !== platform) {
    allowlistCache = buildAllowlist()
    allowlistPlatform = platform
  }
  return allowlistCache
}

// ── flag-allowlist validation ──────────────────────────────────────────

/** Whether the command is provably safe via flag parsing. Pure; never throws. */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  const parse = tryParseShellCommand(command)
  if (!parse.success) return false
  const tokens: string[] = []
  for (const token of parse.tokens) {
    if (typeof token === 'string') tokens.push(token)
    else if (isGlobToken(token)) tokens.push((token as { pattern: string }).pattern)
    else return false // an operator survived — decomposition is the caller's job
  }
  if (tokens.length === 0) return false

  const allowlist = effectiveAllowlist()
  let matchedConfig: ExternalCommandConfig | null = null
  let prefixOffset = 0
  for (const [key, config] of allowlist) {
    const words = key.split(' ')
    if (tokens.length >= words.length && words.every((w, i) => tokens[i] === w)) {
      matchedConfig = config
      prefixOffset = words.length
      break // first match in iteration order wins
    }
  }
  if (matchedConfig === null) return false
  const baseCommand = tokens[0] as string

  // git ls-remote special case.
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i] as string
      if (token.startsWith('-')) continue
      if (token.includes('://') || token.includes('@') || token.includes(':') || token.includes('$')) return false
    }
  }

  // Token screen over every token after the command prefix.
  for (let i = prefixOffset; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token.includes('$')) return false // parser-differential defence
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) return false // brace expansion
  }

  // The shared flag validator over the whole token list + the prefix offset.
  const flagOk = validateFlags(tokens, prefixOffset, matchedConfig, {
    commandName: baseCommand,
    rawCommand: command,
    xargsTargetCommands: baseCommand === 'xargs' ? XARGS_TARGETS : undefined,
  })
  if (!flagOk) return false

  if (matchedConfig.regex) {
    if (!matchedConfig.regex.test(command)) return false
  } else {
    if (command.includes('`')) return false
    if ((baseCommand === 'rg' || baseCommand === 'grep') && /[\r\n]/.test(command)) return false
  }

  if (matchedConfig.additionalCommandIsDangerousCallback) {
    if (matchedConfig.additionalCommandIsDangerousCallback(command, tokens.slice(prefixOffset))) return false
  }
  return true
}

// ── the unquoted-expansion guard ───────────────────────────────────────

const EXPANSION_FOLLOW = /[A-Za-z0-9_@*#?!$-]/

/** Whether the command carries an unquoted `$`-expansion or an unquoted glob. */
function hasUnquotedExpansion(command: string): boolean {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (mode !== 'single' && ch === '\\') {
      i++ // an escape outside single quotes
      continue
    }
    if (ch === "'" && mode !== 'double') {
      mode = mode === 'single' ? 'none' : 'single'
      continue
    }
    if (ch === '"' && mode !== 'single') {
      mode = mode === 'double' ? 'none' : 'double'
      continue
    }
    if (mode !== 'single' && ch === '$') {
      const next = command[i + 1]
      if (next !== undefined && next !== '{' && next !== '(' && EXPANSION_FOLLOW.test(next)) return true
    }
    if (mode === 'none' && (ch === '?' || ch === '*' || ch === '[' || ch === ']')) return true
  }
  return false
}

// ── the regex allowlist ────────────────────────────────────────────────

/** The Unix-specific simple command names (contract data). */
const SIMPLE_COMMAND_NAMES = [
  'cal', 'uptime', 'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump',
  'od', 'nl', 'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc',
  'basename', 'dirname', 'realpath', 'cut', 'paste', 'tr', 'column', 'tac',
  'rev', 'fold', 'expand', 'unexpand', 'fmt', 'comm', 'cmp', 'numfmt',
  'readlink', 'diff', 'true', 'false', 'sleep', 'which', 'type', 'expr', 'test',
  'getconf', 'seq', 'tsort', 'pr',
]

/** The injection control character set for a simple-command safe invocation. */
const SIMPLE_INJECTION = /[<>()$`|{}&;\r\n]/

/** Whether the command matches the regex allowlist. */
function matchesRegexAllowlist(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0] ?? ''
  const simpleNames = new Set<string>([
    ...EXTERNAL_READONLY_COMMANDS.map(c => (c.split(' ')[0] as string)),
    ...SIMPLE_COMMAND_NAMES,
  ])
  // (a) simple command names: name, then end/whitespace, remainder free of the injection set.
  if (simpleNames.has(firstWord)) {
    const remainder = command.slice(firstWord.length)
    if (!SIMPLE_INJECTION.test(remainder)) return true
  }
  // (b) hand-written patterns.
  return matchesHandWrittenPattern(command)
}

function matchesHandWrittenPattern(command: string): boolean {
  const trimmed = command.trim()
  const cli = binaryName()
  // Help invocations of the CLI, exactly (mercury via the identity owner, plus the base CLI).
  if ([`${cli} -h`, `${cli} --help`, 'claude -h', 'claude --help'].includes(trimmed)) return true
  // Version probes, anchored exactly.
  if (['node -v', 'node --version', 'python --version', 'python3 --version'].includes(trimmed)) return true
  // pwd / whoami / alias, exactly.
  if (trimmed === 'pwd' || trimmed === 'whoami' || trimmed === 'alias') return true
  // arch — bare or with -h/--help.
  if (/^arch(?:\s+(?:-h|--help))?$/.test(trimmed)) return true
  // ip addr, exactly.
  if (trimmed === 'ip addr') return true
  // ifconfig — bare or with one interface name.
  if (/^ifconfig(?:\s+[A-Za-z][A-Za-z0-9_-]*)?$/.test(trimmed)) return true
  // history — bare or one numeric argument.
  if (/^history(?:\s+\d+)?$/.test(trimmed)) return true
  // uniq — flags only, no file operands.
  if (/^uniq(?:\s+(?:-[A-Za-z]+|--[a-z-]+(?:=\S+)?|-[fsw]\d+))*\s*(?:2>&1)?$/.test(trimmed)) return true
  // echo — only safe argument spans.
  if (matchesEcho(trimmed)) return true
  // jq — flags plus a quoted filter/operands, with the named rejects.
  if (firstWordIs(trimmed, 'jq') && jqIsSafe(trimmed)) return true
  // cd — at most one safe operand.
  if (/^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/.test(trimmed)) return true
  // ls — operand free of the injection set.
  if (firstWordIs(trimmed, 'ls') && !/[<>()$`|{}&;\r\n]/.test(trimmed.slice(2))) return true
  // find — reject mutating/executing predicates; parentheses must be escaped.
  if (firstWordIs(trimmed, 'find') && findIsSafe(trimmed)) return true
  return false
}

function firstWordIs(command: string, word: string): boolean {
  return command === word || command.startsWith(word + ' ')
}

function matchesEcho(command: string): boolean {
  if (!firstWordIs(command, 'echo')) return false
  let rest = command.slice(4).trim().replace(/\s+2>&1$/, '')
  // Each argument: a single-quoted span, a safe double-quoted span, or a bare word.
  const argRe = /^(?:'[^']*'|"[^"$<>\r\n]*"|[^|;&`$(){}><#\\!"'\s]+)(?:\s+|$)/
  while (rest.length > 0) {
    const match = rest.match(argRe)
    if (!match) return false
    rest = rest.slice(match[0].length)
  }
  return true
}

function jqIsSafe(command: string): boolean {
  if (/(?:^|\s)(?:-f|--from-file|--rawfile|--slurpfile|--run-tests|-L|--library-path)\b/.test(command)) return false
  if (/\benv\b/.test(command) || command.includes('$ENV')) return false
  if (command.includes('`')) return false
  return true
}

function findIsSafe(command: string): boolean {
  if (/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fls|fprintf)\b/.test(command)) return false
  // Escaped parentheses are allowed; unescaped ones and the rest of the set are not.
  const withoutEscaped = command.replace(/\\[()]/g, '')
  if (/[<>()$`|{}&;\r\n]/.test(withoutEscaped)) return false
  return true
}

// ── git-internal-path write detection ──────────────────────────────────

const GIT_INTERNAL_CREATORS = new Set<PathCommand>(['mkdir', 'touch', 'mv', 'cp'])

/** Whether any subcommand writes to a git-internal path (HEAD / objects / refs / hooks). */
function writesToGitInternalPath(command: string): boolean {
  for (const raw of splitCommand_DEPRECATED(command)) {
    const subcommand = raw.trim()
    const parse = tryParseShellCommand(subcommand)
    if (!parse.success) continue
    const tokens = parse.tokens.filter(t => typeof t === 'string') as string[]
    if (tokens.length === 0) continue
    const base = tokens[0] as string
    const paths: string[] = []
    if (base in COMMAND_OPERATION_TYPE) {
      const command_ = base as PathCommand
      const opType = COMMAND_OPERATION_TYPE[command_]
      if ((opType === 'write' || opType === 'create') && GIT_INTERNAL_CREATORS.has(command_)) {
        paths.push(...PATH_EXTRACTORS[command_](tokens.slice(1)))
      }
    }
    // Also the subcommand's output-redirection targets.
    paths.push(...extractOutputRedirections(subcommand).redirections.map(r => r.target))
    if (paths.some(isGitInternalPath)) return true
  }
  return false
}

function isGitInternalPath(path: string): boolean {
  let p = path.replace(/^\.?\//, '')
  return p === 'HEAD' || /^(?:objects|refs|hooks)(?:\/|$)/.test(p)
}

// ── single-command read-only classification ────────────────────────────

function isSubcommandReadOnly(subcommand: string): boolean {
  let text = subcommand.trim()
  if (text.endsWith(' 2>&1')) text = text.slice(0, -' 2>&1'.length).trim()
  if (containsVulnerableUncPath(text)) return false
  if (hasUnquotedExpansion(text)) return false
  if (isCommandSafeViaFlagParsing(text)) return true
  if (matchesRegexAllowlist(text)) {
    // git escape guards: -c / --exec-path / --config-env inject code.
    if (/git/.test(text) && (/\s-c(?:\s|=)/.test(text) || /\s--exec-path(?:\s|=)/.test(text) || /\s--config-env(?:\s|=)/.test(text))) {
      return false
    }
    return true
  }
  return false
}

// ── the entry point ────────────────────────────────────────────────────

/** The bare-repo git guard's passthrough message. Contract data (dist-pinned). */
const BARE_REPO_GIT_GUARD_MESSAGE =
  'This directory has bare-repository structure, so git commands here go through the permission gate'

/** Classify a whole command as read-only (allow) or not (passthrough); may ask on a UNC path. */
export function checkReadOnlyConstraints(
  input: { command: string },
  compoundCommandHasCd: boolean,
): PermissionResult {
  const command = input.command

  // 1. Tokenise the whole command.
  if (!tryParseShellCommand(command).success) {
    return { behavior: 'passthrough', message: 'The command cannot be parsed; it needs further checks.' }
  }
  // 2. The whole-command security screen BEFORE splitting.
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return { behavior: 'passthrough', message: 'The security screen flagged the command.' }
  }
  // 3. A vulnerable UNC path on the original text.
  if (containsVulnerableUncPath(command)) {
    return { behavior: 'ask', message: 'This command contains a Windows UNC path that could be exploited via WebDAV.' }
  }

  const subcommands = splitCommand_DEPRECATED(command)
  const hasGitCommand = subcommands.some(sub => isNormalizedGitCommand(sub.trim()))

  // 5. git guards (all return passthrough — do not auto-allow).
  if (hasGitCommand) {
    if (compoundCommandHasCd) {
      return { behavior: 'passthrough', message: 'A cd combined with git is not auto-allowed.' }
    }
    if (isCurrentDirectoryBareGitRepo()) {
      return { behavior: 'passthrough', message: BARE_REPO_GIT_GUARD_MESSAGE }
    }
    if (writesToGitInternalPath(command)) {
      return { behavior: 'passthrough', message: 'A git command combined with a git-internal write is not auto-allowed.' }
    }
    if (SandboxManager.isSandboxingEnabled() && getCwd() !== getOriginalCwd()) {
      return { behavior: 'passthrough', message: 'A sandboxed git command outside the original directory is not auto-allowed.' }
    }
  }

  // 6. Every subcommand must pass the screen and be read-only.
  for (const raw of subcommands) {
    const subcommand = raw.trim()
    if (bashCommandIsSafe_DEPRECATED(subcommand).behavior !== 'passthrough') {
      return { behavior: 'passthrough', message: 'A subcommand was flagged by the security screen.' }
    }
    if (!isSubcommandReadOnly(subcommand)) {
      return { behavior: 'passthrough', message: 'A subcommand is not provably read-only.' }
    }
  }
  return { behavior: 'allow', updatedInput: input }
}

function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}

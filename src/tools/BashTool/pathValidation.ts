/**
 * Path containment for bash commands: extract the filesystem operands and
 * output-redirection targets a command touches, and decide ask/deny/passthrough
 * against the session's allowed working directories. This must survive shell
 * quoting, globbing, `--`, wrapper commands, output redirection, process
 * substitution, and directory changes inside compound commands.
 *
 * All parser access routes through the pinned command-analysis provider.
 */
import { posix as posixPath } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
  tryParseShellCommand,
  type Redirect,
  type SimpleCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'
import {
  validatePath,
  expandTilde,
  isDangerousRemovalPath,
  formatDirectoryList,
  type FileOperationType,
} from '../../utils/permissions/pathValidation.js'
import { allWorkingDirectories, pathInAllowedWorkingPath, pathInWorkingPath } from '../../utils/permissions/filesystem.js'
import { createEditRuleSuggestion, createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import { getCwd } from '../../utils/cwd.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

// ── the supported command set ──────────────────────────────────────────

/** The 36 supported path-command names. */
export type PathCommand =
  | 'cd' | 'ls' | 'find' | 'mkdir' | 'touch' | 'rm' | 'rmdir' | 'mv' | 'cp'
  | 'cat' | 'head' | 'tail' | 'sort' | 'uniq' | 'wc' | 'cut' | 'paste' | 'column'
  | 'tr' | 'file' | 'stat' | 'diff' | 'awk' | 'strings' | 'hexdump' | 'od'
  | 'base64' | 'nl' | 'grep' | 'rg' | 'sed' | 'git' | 'jq' | 'sha256sum'
  | 'sha1sum' | 'md5sum'

/** The read/write/create classification per command. Contract data. */
export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read', ls: 'read', find: 'read', cat: 'read', head: 'read', tail: 'read',
  sort: 'read', uniq: 'read', wc: 'read', cut: 'read', paste: 'read', column: 'read',
  tr: 'read', file: 'read', stat: 'read', diff: 'read', awk: 'read', strings: 'read',
  hexdump: 'read', od: 'read', base64: 'read', nl: 'read', grep: 'read', rg: 'read',
  git: 'read', jq: 'read', sha256sum: 'read', sha1sum: 'read', md5sum: 'read',
  mkdir: 'create', touch: 'create',
  rm: 'write', rmdir: 'write', mv: 'write', cp: 'write', sed: 'write',
}

// ── operand extraction ───────────────────────────────────────────────

/** Baseline positional extraction: non-`-` tokens are operands; `--` ends option parsing. */
function extractBaseline(args: string[]): string[] {
  const operands: string[] = []
  let optionsEnded = false
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (optionsEnded || !arg.startsWith('-')) operands.push(arg)
  }
  return operands
}

const HOME = (): string => process.env.HOME || process.env.USERPROFILE || ''

const FIND_PATH_PREDICATES = new Set([
  '-newer', '-anewer', '-cnewer', '-mnewer', '-samefile', '-path', '-wholename',
  '-ilname', '-lname', '-ipath', '-iwholename',
])
const FIND_GLOBAL_OPTIONS = new Set(['-H', '-L', '-P'])

const GREP_CONSUMING = new Set([
  '-e', '--regexp', '-f', '--file', '--exclude', '--include', '--exclude-dir',
  '--include-dir', '-m', '--max-count', '-A', '--after-context', '-B',
  '--before-context', '-C', '--context',
])
const RG_CONSUMING = new Set([
  '-e', '--regexp', '-f', '--file', '-t', '--type', '-T', '--type-not', '-g',
  '--glob', '-m', '--max-count', '--max-depth', '-r', '--replace', '-A',
  '--after-context', '-B', '--before-context', '-C', '--context',
])
const PATTERN_ALREADY_SUPPLIED = new Set(['-e', '--regexp', '-f', '--file'])
const JQ_CONSUMING = new Set([
  '-e', '--expression', '-f', '--from-file', '--arg', '--argjson', '--slurpfile',
  '--rawfile', '--args', '--jsonargs', '-L', '--library-path', '--indent', '--tab',
])

/** Per-command operand extraction. `args` is everything after the command name. */
export const PATH_EXTRACTORS: Record<PathCommand, (args: string[]) => string[]> = {
  cd: args => {
    const operands = args.filter(a => a !== '--')
    if (operands.length === 0) return [HOME()]
    return [operands.join(' ')]
  },
  ls: args => {
    const operands = extractBaseline(args)
    return operands.length === 0 ? ['.'] : operands
  },
  find: extractFindOperands,
  tr: args => {
    const operands = extractBaseline(args)
    const deleteStyle = args.some(a => a === '-d' || a === '--delete' || (a.startsWith('-') && a.includes('d')))
    return operands.slice(deleteStyle ? 1 : 2)
  },
  grep: args => extractPatternCommand(args, GREP_CONSUMING, ['-r', '-R', '--recursive']),
  rg: args => extractPatternCommand(args, RG_CONSUMING, undefined),
  sed: extractSedOperands,
  jq: args => extractPatternCommand(args, JQ_CONSUMING, null),
  git: extractGitOperands,
  // The baseline-rule commands:
  mkdir: extractBaseline, touch: extractBaseline, rm: extractBaseline, rmdir: extractBaseline,
  mv: extractBaseline, cp: extractBaseline, cat: extractBaseline, head: extractBaseline,
  tail: extractBaseline, sort: extractBaseline, uniq: extractBaseline, wc: extractBaseline,
  cut: extractBaseline, paste: extractBaseline, column: extractBaseline, file: extractBaseline,
  stat: extractBaseline, diff: extractBaseline, awk: extractBaseline, strings: extractBaseline,
  hexdump: extractBaseline, od: extractBaseline, base64: extractBaseline, nl: extractBaseline,
  sha256sum: extractBaseline, sha1sum: extractBaseline, md5sum: extractBaseline,
}

function extractFindOperands(args: string[]): string[] {
  const operands: string[] = []
  let i = 0
  // Leading search roots until the first non-global predicate.
  while (i < args.length) {
    const arg = args[i] as string
    if (arg === '--') break
    if (arg.startsWith('-')) {
      if (!FIND_GLOBAL_OPTIONS.has(arg)) break
      i++
      continue
    }
    operands.push(arg)
    i++
  }
  // Path-taking predicates take their following token.
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      // After `--`, every remaining token is collected.
      for (i++; i < args.length; i++) operands.push(args[i] as string)
      break
    }
    if (FIND_PATH_PREDICATES.has(arg) || /^-newer[acmtB][acmtB]$/.test(arg)) {
      const next = args[i + 1]
      if (next !== undefined) {
        operands.push(next)
        i++
      }
    }
  }
  return operands.length === 0 ? ['.'] : operands
}

function extractPatternCommand(
  args: string[],
  consuming: Set<string>,
  recursiveFlags: string[] | undefined | null,
): string[] {
  const operands: string[] = []
  let patternSeen = false
  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (consuming.has(arg)) {
        if (PATTERN_ALREADY_SUPPLIED.has(arg)) patternSeen = true
        i++ // consume the following token
      }
      // `--flag=value` consumes nothing; either way not an operand.
      continue
    }
    if (!patternSeen) {
      patternSeen = true // this token is the pattern
      continue
    }
    operands.push(arg)
  }
  if (operands.length === 0) {
    if (Array.isArray(recursiveFlags)) {
      if (args.some(a => recursiveFlags.includes(a))) return ['.']
      return []
    }
    if (recursiveFlags === undefined) return ['.'] // rg default
    return [] // jq: reads stdin
  }
  return operands
}

function extractSedOperands(args: string[]): string[] {
  const operands: string[] = []
  let scriptSeen = false
  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg === '-f' || arg === '--file') {
        const next = args[i + 1]
        scriptSeen = true
        if (next !== undefined) {
          operands.push(next) // a script file is read from disk
          i++
        }
        continue
      }
      if (arg === '-e' || arg === '--expression') {
        if (args[i + 1] !== undefined) i++ // consumed, not an operand
        scriptSeen = true
        continue
      }
      // Any other `-…` token containing `e` or `f` marks the script as supplied.
      if (arg.includes('e') || arg.includes('f')) scriptSeen = true
      continue
    }
    if (!scriptSeen) {
      scriptSeen = true // this token is the script
      continue
    }
    operands.push(arg)
  }
  return operands
}

function extractGitOperands(args: string[]): string[] {
  // Only `git diff --no-index`: diff must be the first argument, --no-index anywhere.
  if (args[0] !== 'diff') return []
  if (!args.includes('--no-index')) return []
  const rest = args.slice(1).filter(a => a !== '--no-index')
  return extractBaseline(rest).slice(0, 2)
}

// ── argv-level wrapper stripping ───────────────────────────────────────

const ARGV_WRAPPERS = new Set(['time', 'nohup', 'timeout', 'nice', 'stdbuf', 'env'])
const TIMEOUT_VALUE = /^[A-Za-z0-9_.+-]+$/
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/

/** Strip leading wrapper commands from an argv until the leading token is not a wrapper. */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let current = argv
  while (current.length > 0 && ARGV_WRAPPERS.has(current[0] as string)) {
    const stripped = stripOneWrapper(current)
    if (stripped === null) break // fail open — return unchanged from here
    current = stripped
  }
  return current
}

function stripOneWrapper(argv: string[]): string[] | null {
  const wrapper = argv[0] as string
  let rest = argv.slice(1)
  if (wrapper === 'time' || wrapper === 'nohup') {
    if (rest[0] === '--') rest = rest.slice(1)
    return rest
  }
  if (wrapper === 'timeout') return stripTimeout(rest)
  if (wrapper === 'nice') return stripNice(rest)
  if (wrapper === 'stdbuf') return stripStdbuf(rest)
  if (wrapper === 'env') return stripEnv(rest)
  return null
}

function stripTimeout(rest: string[]): string[] | null {
  let i = 0
  while (i < rest.length) {
    const token = rest[i] as string
    if (token === '--') {
      i++
      break
    }
    if (token === '--foreground' || token === '--preserve-status' || token === '--verbose' || token === '-v') {
      i++
      continue
    }
    const valuedLong = token.match(/^(--kill-after|--signal)=(.*)$/)
    if (valuedLong) {
      if (!TIMEOUT_VALUE.test(valuedLong[2] as string)) return null
      i++
      continue
    }
    if (token === '--kill-after' || token === '--signal') {
      const value = rest[i + 1]
      if (value === undefined || !TIMEOUT_VALUE.test(value)) return null
      i += 2
      continue
    }
    const fusedShort = token.match(/^-([ks])(.+)$/)
    if (fusedShort) {
      if (!TIMEOUT_VALUE.test(fusedShort[2] as string)) return null
      i++
      continue
    }
    if (token === '-k' || token === '-s') {
      const value = rest[i + 1]
      if (value === undefined || !TIMEOUT_VALUE.test(value)) return null
      i += 2
      continue
    }
    if (token.startsWith('-')) return null // unparseable option → fail open
    break // the duration position
  }
  const duration = rest[i]
  if (duration === undefined || !DURATION.test(duration)) return null // fail open
  return rest.slice(i + 1)
}

function stripNice(rest: string[]): string[] | null {
  const consumeMarker = (args: string[]): string[] => (args[0] === '--' ? args.slice(1) : args)
  if (rest[0] === '-n' && rest[1] !== undefined && /^-?\d+$/.test(rest[1] as string)) {
    return consumeMarker(rest.slice(2))
  }
  if (rest[0] !== undefined && /^-\d+$/.test(rest[0] as string)) {
    return consumeMarker(rest.slice(1))
  }
  return consumeMarker(rest) // unconditional fallback: drop only `nice`
}

function stripStdbuf(rest: string[]): string[] | null {
  let i = 0
  let consumed = 0
  while (i < rest.length) {
    const token = rest[i] as string
    if (token === '-i' || token === '-o' || token === '-e') {
      if (rest[i + 1] === undefined) return null
      i += 2
      consumed++
      continue
    }
    if (/^-[ioe].+$/.test(token) || /^--(?:input|output|error)=/.test(token)) {
      i++
      consumed++
      continue
    }
    if (token.startsWith('-')) return null // unknown flag fails closed
    break
  }
  if (consumed === 0 || i >= rest.length) return null // no option consumed / no command left
  return rest.slice(i)
}

function stripEnv(rest: string[]): string[] | null {
  let i = 0
  while (i < rest.length) {
    const token = rest[i] as string
    if (!token.startsWith('-') && token.includes('=')) {
      i++
      continue
    }
    if (token === '-i' || token === '-0' || token === '-v') {
      i++
      continue
    }
    if (token === '-u') {
      if (rest[i + 1] === undefined) return null
      i += 2
      continue
    }
    if (token.startsWith('-')) return null // -S/-C/-P/unknown fail closed
    break
  }
  if (i >= rest.length) return null // a wrapped command must remain
  return rest.slice(i)
}

// ── the path checker ───────────────────────────────────────────────────

/** A short verb phrase per command, for the composed refusal message. */
const COMMAND_ACTION: Record<PathCommand, string> = {
  cd: 'enter the directory', ls: 'list', find: 'search', mkdir: 'create the directory',
  touch: 'create', rm: 'remove', rmdir: 'remove the directory', mv: 'move', cp: 'copy',
  cat: 'read', head: 'read the start of', tail: 'read the end of', sort: 'read',
  uniq: 'read', wc: 'count', cut: 'read fields of', paste: 'merge', column: 'format',
  tr: 'read', file: 'inspect', stat: 'inspect', diff: 'compare', awk: 'process',
  strings: 'read strings from', hexdump: 'dump', od: 'dump', base64: 'encode',
  nl: 'number lines of', grep: 'search', rg: 'search', sed: 'edit', git: 'run git on',
  jq: 'query', sha256sum: 'hash', sha1sum: 'hash', md5sum: 'hash',
}

/** The wrapper: validate a command's operands and layer the dangerous-removal check. */
export function createPathChecker(command: PathCommand, operationTypeOverride?: FileOperationType) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd = false,
  ): PermissionResult => {
    const result = runPathChecker(command, operationTypeOverride, args, cwd, context, compoundCommandHasCd)
    if (result.behavior === 'deny') return result
    if (command === 'rm' || command === 'rmdir') {
      const dangerous = checkDangerousRemoval(command, args, cwd)
      if (dangerous.behavior !== 'passthrough') return dangerous
    }
    if (result.behavior === 'passthrough') return result
    return attachSuggestions(result, operationTypeOverride ?? COMMAND_OPERATION_TYPE[command])
  }
}

function runPathChecker(
  command: PathCommand,
  operationTypeOverride: FileOperationType | undefined,
  args: string[],
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // 1. Command-level validator: mv/cp with any flag → ask.
  if ((command === 'mv' || command === 'cp') && args.some(a => a.startsWith('-'))) {
    return {
      behavior: 'ask',
      message: `This ${command} command uses flags Mercury cannot validate automatically, so it needs manual approval.`,
      decisionReason: { type: 'other', reason: `${command} with flags requires manual approval` },
    }
  }
  // 2. Compound-cd write guard (before any operand is validated).
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: 'A command that changes directory and also writes needs explicit approval, because the final working directory cannot be determined.',
      decisionReason: { type: 'other', reason: 'A directory change combined with a write cannot be validated' },
    }
  }
  // 3. Operand loop.
  const operands = PATH_EXTRACTORS[command](args)
  for (const operand of operands) {
    const check = validatePath(operand, cwd, context, operationType)
    if (!check.allowed) {
      if (check.decisionReason?.type === 'rule') {
        return { behavior: 'deny', message: denyMessage(command, check.resolvedPath), decisionReason: check.decisionReason }
      }
      return {
        behavior: 'ask',
        message: composedMessage(command, check.resolvedPath, context, check.decisionReason),
        blockedPath: check.resolvedPath,
        decisionReason: check.decisionReason,
      }
    }
  }
  return { behavior: 'passthrough', message: `All ${command} operands are within the allowed directories.` }
}

function denyMessage(command: PathCommand, path: string): string {
  return `The ${command} of ${path} is blocked by a deny rule.`
}

function composedMessage(
  command: PathCommand,
  resolvedPath: string,
  context: ToolPermissionContext,
  reason: PermissionDecisionReason | undefined,
): string {
  if (reason && (reason.type === 'other' || reason.type === 'safetyCheck')) {
    return reason.reason
  }
  const operation = COMMAND_OPERATION_TYPE[command]
  if (operation === 'write' || operation === 'create') {
    // Write shapes ride the scope-honest composer (FC-059) — an added
    // directory must never be listed as "allowed" in a write refusal.
    return `For security: ${composeWriteRefusal(context, resolvedPath, COMMAND_ACTION[command])}`
  }
  const dirs = formatDirectoryList([...allWorkingDirectories(context)])
  return `For security, Mercury may only ${COMMAND_ACTION[command]} ${resolvedPath} within the allowed directories (${dirs}).`
}

// ── dangerous removals + suggestions ───────────────────────────────────

function checkDangerousRemoval(command: PathCommand, args: string[], cwd: string): PermissionResult {
  const operands = PATH_EXTRACTORS[command](args)
  for (const raw of operands) {
    let operand = raw
    if (/^['"]/.test(operand)) operand = operand.slice(1)
    if (/['"]$/.test(operand)) operand = operand.slice(0, -1)
    operand = expandTilde(operand)
    const resolved = operand.startsWith('/') ? operand : joinNoSymlink(cwd, operand)
    if (isDangerousRemovalPath(resolved)) {
      return {
        behavior: 'ask',
        message: `The ${command} of ${resolved} would remove a critical system directory. This needs explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: { type: 'other', reason: `${command} of a critical path: ${resolved}` },
        suggestions: [], // never offer to normalise this command
      }
    }
  }
  return { behavior: 'passthrough', message: 'No dangerous removal.' }
}

/** Resolve a relative path against cwd without following symlinks. */
function joinNoSymlink(cwd: string, operand: string): string {
  const combined = `${cwd}/${operand}`
  const segments: string[] = []
  for (const segment of combined.split(posixPath.sep)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return '/' + segments.join('/')
}

function attachSuggestions(result: PermissionResult, operationType: FileOperationType): PermissionResult {
  if (result.behavior !== 'ask' || !('blockedPath' in result) || !result.blockedPath) return result
  const suggestions: PermissionUpdate[] = []
  const containingDir = getDirectoryForPath(result.blockedPath)
  if (operationType === 'read') {
    const readRule = createReadRuleSuggestion(containingDir)
    if (readRule) suggestions.push(readRule)
  } else {
    suggestions.push({ type: 'addDirectories', destination: 'localSettings', directories: [containingDir] })
  }
  if (operationType === 'write' || operationType === 'create') {
    // The option's label promises access to ONE directory — never a session
    // posture flip: the bundled setMode(implement) turned off the ask for
    // every write in the cwd for the rest of the session, unnamed on the
    // card (FC-022). The write capability the label names is granted as a
    // session-scoped edit-family rule on that directory instead (the family
    // matcher honours it on every edit-type path check).
    const editRule = createEditRuleSuggestion(containingDir)
    if (editRule) suggestions.push(editRule)
  }
  return { ...result, suggestions }
}

// ── the entry point ────────────────────────────────────────────────────

const REDIRECT_PROCESS_SUBST = /(?:>\s*>\s*\(|>>\s*\(|>\s*>\s*>\s*\()/
const INPUT_PROCESS_SUBST = /<\s*\(/

/** The path-containment entry point. */
export function checkPathConstraints(
  input: { command: string },
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd = false,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  const command = input.command

  // 1. Process-substitution guard (only when AST simple commands absent).
  if (astCommands === undefined && (REDIRECT_PROCESS_SUBST.test(command) || INPUT_PROCESS_SUBST.test(command))) {
    return {
      behavior: 'ask',
      message: 'This command uses process substitution, which can run arbitrary commands and write to files that never appear as redirect targets, so it needs manual approval.',
      decisionReason: { type: 'other', reason: 'Process substitution cannot be validated' },
    }
  }

  // 2. Redirection collection.
  let redirectionTargets: string[]
  let dangerousRedirection = false
  if (astRedirects !== undefined) {
    redirectionTargets = convertAstRedirects(astRedirects)
  } else {
    const extracted = extractOutputRedirections(command)
    dangerousRedirection = extracted.hasDangerousRedirection
    redirectionTargets = extracted.redirections.map(r => r.target)
  }

  // 3. Dangerous-redirection guard (text path only).
  if (dangerousRedirection) {
    return {
      behavior: 'ask',
      message: 'This command redirects to a path built from shell expansion, which Mercury cannot validate, so it needs manual approval.',
      decisionReason: { type: 'other', reason: 'Shell expansion in a redirection target cannot be validated' },
    }
  }

  // 4. Redirection target validation.
  const redirectResult = validateRedirections(redirectionTargets, command, cwd, context, compoundCommandHasCd)
  if (redirectResult.behavior !== 'passthrough') return redirectResult

  // 5. Per-subcommand path validation.
  if (astCommands !== undefined) {
    for (const simple of astCommands) {
      const result = validateAstSimpleCommand(simple, cwd, context, compoundCommandHasCd)
      if (result.behavior !== 'passthrough') return result
    }
  } else {
    for (const raw of splitCommand_DEPRECATED(command)) {
      const result = validateTextSubcommand(raw.trim(), cwd, context, compoundCommandHasCd)
      if (result.behavior !== 'passthrough') return result
    }
  }

  return { behavior: 'passthrough', message: 'Path validation found no concern.' }
}

function convertAstRedirects(redirects: Redirect[]): string[] {
  const targets: string[] = []
  for (const redirect of redirects) {
    const op = redirect.op
    if (op === '>' || op === '>|' || op === '&>' || op === '>>' || op === '&>>') {
      targets.push(redirect.target)
    } else if (op === '>&') {
      // fd duplication when the target is all digits; otherwise a redirect to file.
      if (!/^\d+$/.test(redirect.target)) targets.push(redirect.target)
    }
    // input redirects (<, <<, <&, <<<) are ignored
  }
  return targets
}

/**
 * The write-refusal sentence, scope-honest (FC-059): the old sentence
 * listed EVERY working directory — added directories included — as "the
 * allowed directories" while refusing a write inside one of them (added
 * directories carry read scope only). A target inside an added directory
 * now names that fact and the two write roads; everything else keeps the
 * plain outside-the-working-directory sentence.
 */
function composeWriteRefusal(context: ToolPermissionContext, resolvedPath: string, action: string): string {
  const added = (context as unknown as { additionalWorkingDirectories?: ReadonlyMap<string, unknown> })
    .additionalWorkingDirectories
  for (const dir of added?.keys() ?? []) {
    if (pathInWorkingPath(resolvedPath, dir)) {
      return (
        `Mercury may only ${action} inside the working directory; ${resolvedPath} is inside the ADDED directory ${dir}, ` +
        `which grants reads only. Approve the write on its permission card, or add a session allow rule such as Edit(${dir}/**).`
      )
    }
  }
  // A target INSIDE the working directory that still needs approval (the
  // permission mode grants no automatic write and no allow rule covers it)
  // must never be told it is outside — the ladder answers "not allowed"
  // without a reason there, and the geometry sentence was a lie for a file
  // one level under the cwd.
  if (pathInAllowedWorkingPath(resolvedPath, context)) {
    return (
      `Mercury needs approval to ${action} ${resolvedPath}: this permission mode does not ${action} files on its own ` +
      `and no allow rule covers it. Approve it on its permission card, add an allow rule, or start in a mode that allows writes.`
    )
  }
  return `Mercury may only ${action} inside the working directory (${formatDirectoryList([getCwd()])}); ${resolvedPath} is outside it.`
}

function validateRedirections(
  targets: string[],
  command: string,
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  if (targets.length === 0) return { behavior: 'passthrough', message: 'No redirections.' }
  // A cd in a compound command with any redirection → ask (the final cwd is unknown).
  if (compoundCommandHasCd) {
    return {
      behavior: 'ask',
      message: 'This command changes directory and redirects output, so the target directory cannot be determined safely. It needs explicit approval.',
      decisionReason: { type: 'other', reason: 'A directory change makes a redirection target unresolvable' },
    }
  }
  for (const target of targets) {
    if (target === '/dev/null') continue
    const check = validatePath(target, cwd, context, 'create')
    if (!check.allowed) {
      if (check.decisionReason?.type === 'rule') {
        return { behavior: 'deny', message: `The redirection to ${check.resolvedPath} is blocked by a deny rule.`, decisionReason: check.decisionReason }
      }
      const message =
        check.decisionReason && (check.decisionReason.type === 'other' || check.decisionReason.type === 'safetyCheck')
          ? check.decisionReason.reason
          : composeWriteRefusal(context, check.resolvedPath, 'write')
      return {
        behavior: 'ask',
        message,
        blockedPath: check.resolvedPath,
        decisionReason: check.decisionReason,
        suggestions: [{ type: 'addDirectories', destination: 'localSettings', directories: [getDirectoryForPath(check.resolvedPath)] }],
      }
    }
  }
  return { behavior: 'passthrough', message: 'All redirection targets are allowed.' }
}

function validateAstSimpleCommand(
  simple: SimpleCommand,
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(simple.argv)
  if (argv.length === 0) return { behavior: 'passthrough', message: 'Empty command.' }
  const base = argv[0] as string
  if (!(base in COMMAND_OPERATION_TYPE)) return { behavior: 'passthrough', message: 'Not a path command.' }
  const command = base as PathCommand
  const override = sedReadOverride(command, simple.text)
  return createPathChecker(command, override)(argv.slice(1), cwd, context, compoundCommandHasCd)
}

function validateTextSubcommand(
  subcommand: string,
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(tokeniseArgv(subcommand))
  if (argv.length === 0) return { behavior: 'passthrough', message: 'Empty command.' }
  const base = argv[0] as string
  if (!(base in COMMAND_OPERATION_TYPE)) return { behavior: 'passthrough', message: 'Not a path command.' }
  const command = base as PathCommand
  const override = sedReadOverride(command, subcommand)
  return createPathChecker(command, override)(argv.slice(1), cwd, context, compoundCommandHasCd)
}

/** The sed read-operation override: consult the allowlist in its default forbid-writes form. */
function sedReadOverride(command: PathCommand, sourceText: string): FileOperationType | undefined {
  if (command !== 'sed') return undefined
  const stripped = stripSafeWrappers(sourceText)
  return sedCommandIsAllowedByAllowlist(stripped) ? 'read' : undefined
}

/** Tokenise a subcommand to argv: glob → pattern text; empty string kept; operators dropped. */
function tokeniseArgv(subcommand: string): string[] {
  const parse = tryParseShellCommand(subcommand)
  if (!parse.success) return []
  const argv: string[] = []
  for (const token of parse.tokens) {
    if (typeof token === 'string') argv.push(token)
    else if (isGlobToken(token)) argv.push((token as { pattern: string }).pattern)
    // other non-string tokens silently dropped
  }
  return argv
}

function isGlobToken(token: unknown): boolean {
  return typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob'
}

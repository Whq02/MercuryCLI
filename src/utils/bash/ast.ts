import { SHELL_KEYWORDS } from './bashParser.js'
import { parseCommandRaw, preparedCommandRoot } from './parser.js'
import { parseForSecurityFromAst } from '../permissions/decision/commandAnalysis/exact.js'
import { EVALUATING_BUILTINS, quoteArgv, READ_DATA_FLAGS } from '../permissions/decision/commandAnalysis/exactCommands.js'
import { isKnown, NEWLINE_COMMENT_RE, PROCESS_ENVIRON_RE, SYSTEM_CALL_RE } from '../permissions/decision/commandAnalysis/exactWords.js'
import { peelWrappers } from '../permissions/decision/commandAnalysis/wrappers.js'
import type { ParseForSecurityResult, SimpleCommand } from '../permissions/decision/commandAnalysis/reading.js'
export { nodeTypeId, parseForSecurityFromAst } from '../permissions/decision/commandAnalysis/exact.js'
export { WILDCARD_REASON } from '../permissions/decision/commandAnalysis/exactWords.js'
export { peelWrappers } from '../permissions/decision/commandAnalysis/wrappers.js'
export type { ParseForSecurityResult, Redirect, SimpleCommand } from '../permissions/decision/commandAnalysis/reading.js'

type SemanticCheckResult = { ok: true } | { ok: false; reason: string }
const preparedSimpleCommands = new Map<string, WeakRef<SimpleCommand>>()
const reclaimedCommands = new FinalizationRegistry<{ text: string; reference: WeakRef<SimpleCommand> }>(({ text, reference }) => {
  if (preparedSimpleCommands.get(text) === reference) preparedSimpleCommands.delete(text)
})

function preparedSimpleCommand(text: string): SimpleCommand | null {
  return preparedSimpleCommands.get(text)?.deref() ?? null
}

function rememberCommands(commands: SimpleCommand[]): void {
  for (const command of commands) {
    const reference = new WeakRef(command)
    for (const text of new Set([command.text, command.argv.map(quoteArgv).join(' ')])) {
      preparedSimpleCommands.set(text, reference)
      reclaimedCommands.register(command, { text, reference })
    }
  }
}

export function preparedSecurityParse(command: string): ParseForSecurityResult {
  const root = preparedCommandRoot(command)
  if (root) return parseForSecurityFromAst(command, root)
  const simple = preparedSimpleCommand(command)
  return simple ? { kind: 'simple', commands: [simple] } : { kind: 'parse-unavailable' }
}

export function shellCommandText(argv: string[]): string {
  return argv.map(quoteArgv).join(' ')
}

export function startedCommandText(command: unknown, args: unknown): string | undefined {
  if (typeof command !== 'string' || command === '') return undefined
  return shellCommandText([command, ...(Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [])])
}

export async function parseForSecurity(command: string): Promise<ParseForSecurityResult> {
  if (command === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(command)
  if (root === null) return { kind: 'parse-unavailable' }
  const result = parseForSecurityFromAst(command, root)
  if (result.kind === 'simple') rememberCommands(result.commands)
  return result
}

const SUBSCRIPT_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['test', ['-v', '-R']],
  ['[', ['-v', '-R']],
  ['[[', ['-v', '-R']],
  ['printf', ['-v']],
  ['read', ['-a']],
  ['unset', ['-v']],
  ['wait', ['-p']],
])

const ARITHMETIC_COMPARISONS: ReadonlySet<string> = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

const JQ_SHORT_FILE_FLAG_RE = /^-(?:f|L)(?:$|[^A-Za-z])/
const JQ_LONG_FILE_FLAG_RE = /^--(?:from-file|rawfile|slurpfile|library-path)(?:$|=)/

function readClusterTakesNext(cluster: string): boolean {
  for (let i = 1; i < cluster.length; i++) {
    if (READ_DATA_FLAGS.has(cluster[i]!)) return i === cluster.length - 1
  }
  return false
}

type SemanticCheck = (name: string, argv: string[], command: SimpleCommand) => string | null

const emptyName: SemanticCheck = name =>
  name === '' ? 'command name is empty, so argv[0] may not reflect what the shell runs' : null

const runtimeName: SemanticCheck = name => (!isKnown(name) ? 'command name is determined at runtime' : null)

const fragmentName: SemanticCheck = name =>
  name.startsWith('-') || name.startsWith('|') || name.startsWith('&')
    ? `argv starts with the incomplete fragment ${JSON.stringify(name)}`
    : null

const subscriptOperands: SemanticCheck = (name, argv) => {
  const flags = SUBSCRIPT_FLAGS.get(name)
  if (!flags) return null
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-') || arg.startsWith('--')) continue
    for (const flag of flags) {
      const letter = flag[1]!
      if (arg === flag) {
        const next = argv[i + 1]
        if (next !== undefined && next.includes('[')) {
          return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
        }
      } else if (arg.startsWith(flag) && arg.slice(flag.length).includes('[')) {
        return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
      } else if (/^-[A-Za-z]+$/.test(arg) && arg.includes(letter)) {
        const next = argv[i + 1]
        if (next !== undefined && next.includes('[')) {
          return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
        }
      }
    }
  }
  return null
}

const arithmeticComparison: SemanticCheck = (name, argv) => {
  if (name !== '[[') return null
  for (let i = 2; i < argv.length; i++) {
    if (!ARITHMETIC_COMPARISONS.has(argv[i]!)) continue
    const left = argv[i - 1]!
    const right = argv[i + 1]
    if (left.includes('[') || (right !== undefined && right.includes('['))) {
      return 'arithmetic comparison inside [[ ]] evaluates bracketed subscripts, which can execute code'
    }
  }
  return null
}

const bareNameOperands: SemanticCheck = (name, argv) => {
  if (name !== 'read' && name !== 'unset') return null
  let i = 1
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg.startsWith('-')) {
      if (name === 'read' && readClusterTakesNext(arg)) i += 1
      i += 1
      continue
    }
    if (arg.includes('[')) {
      return `${name} with a bracketed name operand evaluates array subscripts, which can execute code`
    }
    i += 1
  }
  return null
}

const reservedName: SemanticCheck = name =>
  SHELL_KEYWORDS.has(name) ? `reserved word ${JSON.stringify(name)} as a command name indicates a mis-parsed command` : null

const newlineComment: SemanticCheck = (_name, _argv, command) => {
  for (const arg of command.argv) {
    if (NEWLINE_COMMENT_RE.test(arg)) {
      return 'a command argument contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const envVar of command.envVars) {
    if (NEWLINE_COMMENT_RE.test(envVar.value)) {
      return 'an environment variable value contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const redirect of command.redirects) {
    if (NEWLINE_COMMENT_RE.test(redirect.target)) {
      return 'a redirect target contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  return null
}

const jqProgram: SemanticCheck = (name, argv) => {
  if (name !== 'jq') return null
  for (const arg of argv.slice(1)) {
    if (SYSTEM_CALL_RE.test(arg)) {
      return 'jq program contains a system() call, which executes arbitrary commands'
    }
    if (JQ_SHORT_FILE_FLAG_RE.test(arg) || JQ_LONG_FILE_FLAG_RE.test(arg)) {
      return `jq flag ${JSON.stringify(arg)} enables code execution or arbitrary file reads`
    }
  }
  return null
}

const evaluatingBuiltin: SemanticCheck = (name, argv) => {
  if (!EVALUATING_BUILTINS.has(name)) return null
  if (name === 'command') {
    if (argv[1] !== '-v' && argv[1] !== '-V') {
      return 'command bypasses function and alias lookup, so the effective target cannot be validated'
    }
    return null
  }
  if (name === 'fc') {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-') && !arg.startsWith('--') && /[es]/.test(arg)) {
        return 'fc in editor or re-execute mode runs the resulting command'
      }
    }
    return null
  }
  if (name === 'compgen') {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-') && !arg.startsWith('--') && /[CFW]/.test(arg)) {
        return 'compgen with -C, -F or -W executes code while generating completions'
      }
    }
    return null
  }
  return `${name} evaluates its arguments as shell code`
}

const processEnvironment: SemanticCheck = (_name, _argv, command) => {
  for (const arg of command.argv) {
    if (PROCESS_ENVIRON_RE.test(arg)) {
      return 'references a process environment file, which may expose secrets'
    }
  }
  for (const redirect of command.redirects) {
    if (PROCESS_ENVIRON_RE.test(redirect.target)) {
      return 'redirects from a process environment file, which may expose secrets'
    }
  }
  return null
}

const SEMANTIC_CHECKS: readonly SemanticCheck[] = [
  emptyName,
  runtimeName,
  fragmentName,
  subscriptOperands,
  arithmeticComparison,
  bareNameOperands,
  reservedName,
  newlineComment,
  jqProgram,
  evaluatingBuiltin,
  processEnvironment,
]

const UNKNOWN_VALUE_REASON =
  'Bash needs approval for this argument or redirect because its value is unknown. Use literal arguments and paths; set the working directory with cwd.'

export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const command of commands) {
    const isEcho = command.argv[0] === 'echo'
    for (let i = 0; i < command.argv.length; i++) {
      if (isEcho && i > 0) continue
      if (!isKnown(command.argv[i]!)) {
        return { ok: false, reason: UNKNOWN_VALUE_REASON }
      }
    }
    for (const redirect of command.redirects) {
      if (!isKnown(redirect.target)) {
        return { ok: false, reason: UNKNOWN_VALUE_REASON }
      }
    }

    const peeled = peelWrappers(command.argv)
    if (!Array.isArray(peeled)) {
      return { ok: false, reason: peeled.failReason }
    }
    if (peeled.length === 0) continue

    const name = peeled[0]!
    if (name === 'xargs' && peeled.length === 1) {
      return {
        ok: false,
        reason: 'bare xargs chooses its command implicitly; spell out the command, or approve',
      }
    }

    for (const check of SEMANTIC_CHECKS) {
      const reason = check(name, peeled, command)
      if (reason !== null) return { ok: false, reason }
    }
  }
  return { ok: true }
}

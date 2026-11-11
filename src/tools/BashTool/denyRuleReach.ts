import { readdirSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, posix as posixPath, resolve } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  checkSemantics,
  parseForSecurity,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  shellCommandText,
  type Node,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { getDenyRules } from '../../utils/permissions/decision/rules.js'
import { matchingRulesForInput } from '../../utils/permissions/filesystem.js'
import { expandTilde, validatePath } from '../../utils/permissions/pathValidation.js'
import { refusalWithReason, ruleSentence, ruleWords, withRuleReason } from '../../utils/permissions/ruleReason.js'
import { gitSubcommandIndex } from '../../utils/git/spawnArgs.js'
import { LISTED_WORDS } from '../../utils/shell/readOnlyCommandValidation.js'
import { scanCeiling } from '../../utils/verification/scanCeiling.js'
import { BASH_TOOL_NAME } from './toolName.js'
import { COMMAND_OPERATION_TYPE, PATH_EXTRACTORS, type PathCommand } from './pathValidation.js'

export type HiddenDenyRule = { rule: PermissionRule; why: string }
type DenyRuleReach = { denied: PermissionResult | null; hidden: HiddenDenyRule | null }

export type ReachBudget = { left: number }

type DenyRuleReachPorts = {
  judge(command: string, cwd: string, budget: ReachBudget): Promise<DenyRuleReach>
  bashDenyRule(candidate: string): PermissionRule | null
  optionNamedWrites(argv: string[]): string[]
  estate?(path: string): boolean
}

const ESTATE_RULE: PermissionRule = { source: 'session', ruleBehavior: 'deny', ruleValue: { toolName: 'Edit', ruleContent: 'Mercury configuration' } }

type FileKind = 'read' | 'edit'
type Word = string | null
type Scope = { cwds: string[]; cwdKnown: boolean; entered?: string[] }
type Feed = { said: string[] } | { roots: string[]; names: RegExp[]; exact: boolean } | null | undefined
type View = { argv: Word[]; redirects: Array<{ op: string; target: Word }>; feed: Feed; cwds: string[]; cwdKnown: boolean; text: string }

const NOTHING: DenyRuleReach = { denied: null, hidden: null }
const FILE_RULE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'NotebookRead', 'Edit', 'Write', 'NotebookEdit'])
const READ_RULE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'NotebookRead'])
const DYNAMIC_KINDS: ReadonlySet<string> = new Set(['simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion', 'ansi_c_string', 'translated_string'])
const OUTPUT_OPERATORS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>'])
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])
const QUIET_COMMANDS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', 'false', ':', 'test', '[', '[[', 'kill', 'sleep', 'wait', 'export', 'set', 'unset', 'read', 'local', 'declare', 'typeset', 'readonly',
  'return', 'exit', 'shift', 'cd', 'pushd', 'popd', 'pwd', 'umask', 'ulimit', 'break', 'continue', 'getopts', 'hash', 'type', 'which', 'let',
])
const GIT_WORKTREE_WRITERS: ReadonlySet<string> = new Set([
  'init', 'clone', 'checkout', 'restore', 'switch', 'mv', 'rm', 'clean', 'apply', 'am', 'stash', 'reset', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert',
  'worktree', 'submodule', 'sparse-checkout', 'checkout-index', 'format-patch', 'archive', 'bundle',
])
const GIT_WORD_VALUES: ReadonlySet<string> = new Set(['-m', '--message', '--author', '--grep', '-S', '-G', '--format', '--pretty', '--date', '-n', '--since', '--until', '--after', '--before'])
const MAX_DERIVED = 96
const MAX_DEPTH = 4
const MAX_GLOB_MATCHES = 512
const MAX_FOLDERS = 8

function hasDynamic(node: Node): boolean {
  return DYNAMIC_KINDS.has(node.type) || node.children.some(hasDynamic)
}

function literalOf(node: Node): Word {
  if (hasDynamic(node)) return null
  switch (node.type) {
    case 'word':
      return node.text.replace(/\\([\s\S])/g, '$1')
    case 'number':
      return node.text
    case 'raw_string':
      return node.text.slice(1, -1)
    case 'string':
      return node.text.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
    case 'concatenation': {
      const parts = node.children.map(literalOf)
      return parts.some(part => part === null) ? null : parts.join('')
    }
    case 'command_name':
      return node.children[0] ? literalOf(node.children[0]) : node.text
    default:
      return null
  }
}

function hasGlob(word: string): boolean {
  return /[*?[]/.test(word)
}

const MATCHES_NOTHING = /^(?!)$/

function segmentPattern(segment: string): RegExp {
  try {
    return segmentPatternOf(segment)
  } catch {
    return MATCHES_NOTHING
  }
}

function segmentPatternOf(segment: string): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const close = segment.indexOf(']', i + 2)
      if (close === -1) source += '\\['
      else {
        source += `[${segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else source += char.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function globMatches(pattern: string, cwd: string): string[] | null {
  const spelled = expandTilde(pattern)
  let folders = [isAbsolute(spelled) ? '/' : cwd]
  for (const segment of spelled.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      folders = folders.map(folder => dirname(folder))
      continue
    }
    if (!hasGlob(segment)) {
      folders = folders.map(folder => join(folder, segment))
      continue
    }
    const matches = segmentPattern(segment)
    const next: string[] = []
    for (const folder of folders) {
      let names: string[]
      try {
        names = readdirSync(folder)
      } catch {
        continue
      }
      for (const name of names) if (matches.test(name)) next.push(join(folder, name))
    }
    if (next.length > MAX_GLOB_MATCHES) return null
    folders = next
  }
  return folders
}

function braceAlternatives(inner: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    if (char === '\\') i++
    else if (char === '{') depth++
    else if (char === '}') depth--
    else if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  if (parts.length > 0) return [...parts, inner.slice(start)]
  const range = inner.match(/^(-?\d+)\.\.(-?\d+)$/)
  if (!range) return null
  const from = Number(range[1])
  const to = Number(range[2])
  if (Math.abs(to - from) > 64) return null
  const step = from <= to ? 1 : -1
  const out: string[] = []
  for (let value = from; value !== to + step; value += step) out.push(String(value))
  return out
}

function braceExpandedWord(word: string, budget: { left: number }): string[] | null {
  let quote: string | null = null
  for (let i = 0; i < word.length; i++) {
    const char = word[i] as string
    if (quote !== null) {
      if (char === '\\' && quote === '"') i++
      else if (char === quote) quote = null
      continue
    }
    if (char === '\\') {
      i++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== '{' || word[i - 1] === '$') continue
    let depth = 0
    let close = -1
    for (let j = i; j < word.length; j++) {
      if (word[j] === '\\') j++
      else if (word[j] === '{') depth++
      else if (word[j] === '}' && --depth === 0) {
        close = j
        break
      }
    }
    if (close === -1) return [word]
    const alternatives = braceAlternatives(word.slice(i + 1, close))
    if (alternatives === null) continue
    const out: string[] = []
    for (const alternative of alternatives) {
      const expanded = braceExpandedWord(word.slice(0, i) + alternative + word.slice(close + 1), budget)
      if (expanded === null || (budget.left -= expanded.length) < 0) return null
      out.push(...expanded)
    }
    return out
  }
  return [word]
}

function braceExpanded(command: string): string | null {
  if (!command.includes('{') || command.includes('<<')) return null
  const budget = { left: 64 }
  let changed = false
  let out = ''
  let word = ''
  let quote: string | null = null
  const flush = (): boolean => {
    if (word === '') return true
    const expanded = braceExpandedWord(word, budget)
    if (expanded === null) return false
    if (expanded.length !== 1 || expanded[0] !== word) changed = true
    out += expanded.filter(part => part !== '').join(' ')
    word = ''
    return true
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    if (quote !== null) {
      word += char
      if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else if (char === quote) quote = null
      continue
    }
    if (char === '\\' && i + 1 < command.length) {
      word += char + command[++i]
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      word += char
      continue
    }
    if (/[\s;|&<>()]/.test(char)) {
      if (!flush()) return null
      out += char
      continue
    }
    word += char
  }
  if (!flush()) return null
  return changed ? out : null
}

function optionValuesOf(args: readonly string[], short: string, longs: readonly string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const long = longs.find(name => arg === name || arg.startsWith(`${name}=`))
    if (long !== undefined) {
      const value = arg === long ? args[++i] : arg.slice(long.length + 1)
      if (value !== undefined) values.push(value)
      continue
    }
    if (!arg.startsWith('-') || arg.startsWith('--')) continue
    const at = [...arg].findIndex((letter, index) => index > 0 && short.includes(letter))
    if (at === -1) continue
    const value = at === arg.length - 1 ? args[++i] : arg.slice(at + 1)
    if (value !== undefined) values.push(value)
  }
  return values
}

type Peeled = { rest: Word[] } | { scripts: Word[] } | 'stands'

function afterFlags(args: Word[], valued: string, flags: RegExp = /^-/): number {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === null || arg === '--' || !flags.test(arg)) break
    i += arg.length === 2 && valued.includes(arg[1] as string) ? 2 : 1
  }
  return args[i] === '--' ? i + 1 : i
}

function namesProcess(arg: Word): boolean {
  return arg === '--pid' || (arg !== null && arg.length === 2 && arg[0] === '-' && arg[1] === 'p')
}

function peelOnce(name: string, args: Word[]): Peeled | null {
  switch (name) {
    case 'env': {
      let i = 0
      while (i < args.length) {
        const arg = args[i]
        if (arg === null) return null
        if (arg === '--' || arg === '-') {
          i++
          if (arg === '--') break
          continue
        }
        if (!arg.startsWith('-') && arg.includes('=')) i++
        else if (arg === '-u' || arg === '-C' || arg === '--unset' || arg === '--chdir') i += 2
        else if (arg === '-S' || arg === '--split-string') return { scripts: [args.slice(i + 1).some(word => word === null) ? null : (args.slice(i + 1) as string[]).join(' ')] }
        else if (arg.startsWith('--split-string=')) return { scripts: [arg.slice('--split-string='.length)] }
        else if (arg.startsWith('-S') && arg.length > 2) return { scripts: [arg.slice(2)] }
        else if (arg.startsWith('-')) i++
        else break
      }
      return i < args.length ? { rest: args.slice(i) } : 'stands'
    }
    case 'command':
    case 'builtin':
      if (args[0] === '-v' || args[0] === '-V') return 'stands'
      return { rest: args.slice(afterFlags(args, '')) }
    case 'exec': {
      const at = afterFlags(args, 'a')
      return at < args.length ? { rest: args.slice(at) } : 'stands'
    }
    case 'time':
    case 'nohup':
    case 'chronic':
    case 'unbuffer':
    case 'nocache':
    case 'coproc':
    case 'busybox':
      return { rest: args.slice(afterFlags(args, '')) }
    case 'nice':
      return { rest: args.slice(afterFlags(args, 'n')) }
    case 'setsid':
      return { rest: args.slice(afterFlags(args, '')) }
    case 'caffeinate':
      return { rest: args.slice(afterFlags(args, 'tw')) }
    case 'ionice':
      return args.some(namesProcess) ? 'stands' : { rest: args.slice(afterFlags(args, 'cn')) }
    case 'stdbuf':
      return { rest: args.slice(afterFlags(args, 'ioe')) }
    case 'timeout': {
      const at = afterFlags(args, 'ks')
      return { rest: args.slice(at + 1) }
    }
    case 'taskset':
    case 'chrt': {
      if (args.some(namesProcess)) return 'stands'
      const at = afterFlags(args, '')
      return { rest: args.slice(at + 1) }
    }
    case 'sudo':
    case 'doas': {
      const at = afterFlags(args, 'ugCDhprtTURa', /^-|^[A-Za-z_][A-Za-z0-9_]*=/)
      return { rest: args.slice(at) }
    }
    case 'flock': {
      const at = afterFlags(args, 'wE')
      const rest = args.slice(at + 1)
      if (rest[0] === '-c' || rest[0] === '--command') return { scripts: [rest[1] ?? null] }
      return rest.length > 0 ? { rest } : 'stands'
    }
    case 'script': {
      const literal = args.filter((arg): arg is string => arg !== null)
      const scripted = optionValuesOf(literal, 'c', ['--command'])
      if (scripted.length > 0) return { scripts: scripted }
      const at = afterFlags(args, 'tT')
      const rest = args.slice(at + 1)
      return rest.length > 0 ? { rest } : 'stands'
    }
    case 'watch': {
      const at = afterFlags(args, 'n')
      const rest = args.slice(at)
      if (rest.length === 0) return 'stands'
      return { scripts: [rest.some(word => word === null) ? null : (rest as string[]).join(' ')] }
    }
    case 'parallel': {
      const at = afterFlags(args, 'jSN')
      const rest = args.slice(at).filter(arg => arg !== ':::' && arg !== '::::' && arg !== ':::+')
      return rest.length > 0 ? { rest } : 'stands'
    }
    case 'xargs': {
      const at = afterFlags(args, 'aEdILnPsJ')
      return at < args.length ? { rest: args.slice(at) } : 'stands'
    }
    case 'eval':
      return args.length === 0 ? 'stands' : { scripts: [args.some(word => word === null) ? null : (args as string[]).join(' ')] }
    case 'alias':
      return { scripts: args.filter(arg => arg === null || (!arg.startsWith('-') && arg.includes('='))).map(arg => (arg === null ? null : arg.slice(arg.indexOf('=') + 1))) }
    case 'trap': {
      const at = afterFlags(args, '')
      const script = args[at]
      return script === undefined || script === '-' || script === '' || args.length - at < 2 ? 'stands' : { scripts: [script] }
    }
    default:
      return null
  }
}

function shellScript(args: Word[]): { script: Word } | { file: string } | 'stdin' {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === null) return { script: null }
    if (arg === '--') return args[i + 1] === undefined ? 'stdin' : args[i + 1] === null ? { script: null } : { file: args[i + 1] as string }
    if (arg === '-s') return 'stdin'
    if (arg === '-o' || arg === '-O' || arg === '+o' || arg === '+O' || arg === '--rcfile' || arg === '--init-file') {
      i++
      continue
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) return { script: args[i + 1] ?? null }
    if (arg.startsWith('-') || arg.startsWith('+')) continue
    return { file: arg }
  }
  return 'stdin'
}

const INTERACTIVE_SHELLS: ReadonlySet<string> = new Set([...SHELLS, 'fish', 'csh', 'tcsh'])
const SHELL_IN_SCRIPT = /(?:^|[\s;&|(])(?:exec\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|ash|fish|csh|tcsh)(?=$|[\s;&|)])/

export function startedProgramIsShell(command: string | undefined, args: readonly string[] = []): boolean {
  if (command === undefined || command === '') return false
  let argv: Word[] = [command, ...args]
  for (let rounds = 0; rounds < 8; rounds++) {
    const head = argv[0]
    if (head === null || head === undefined) return false
    const base = posixPath.basename(head)
    const rest = argv.slice(1)
    if (INTERACTIVE_SHELLS.has(base)) {
      const run = shellScript(rest)
      if (run === 'stdin') return true
      return 'script' in run && (run.script === null || SHELL_IN_SCRIPT.test(run.script))
    }
    if (base === 'su') return true
    if ((base === 'sudo' || base === 'doas') && rest.some(arg => arg === '-s' || arg === '-i' || arg === '--shell' || arg === '--login')) return true
    const peeled = peelOnce(base, rest)
    if (peeled === null) return false
    if (peeled === 'stands') return base === 'script'
    if ('scripts' in peeled) return peeled.scripts.some(script => script === null || SHELL_IN_SCRIPT.test(script))
    if (peeled.rest.length === 0) return base === 'script' || base === 'sudo' || base === 'doas'
    argv = peeled.rest
  }
  return false
}

function fileUrlPath(url: string): string {
  const path = url.slice('file://'.length)
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function operandPaths(args: readonly string[]): string[] {
  const paths: string[] = []
  for (const arg of args) {
    if (arg === '' || arg === '-' || arg === '--') continue
    if (arg.startsWith('-')) {
      const equals = arg.indexOf('=')
      if (equals !== -1 && equals < arg.length - 1) paths.push(arg.slice(equals + 1))
      else if (/^-[A-Za-z][^-]/.test(arg) && arg.length > 2) paths.push(arg.slice(2))
      continue
    }
    paths.push(arg)
    const equals = arg.indexOf('=')
    if (equals > 0 && equals < arg.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, equals))) paths.push(arg.slice(equals + 1))
  }
  return paths.flatMap(path => {
    const plain = path.replace(/^[@<]/, '')
    if (plain.startsWith('file://')) return [fileUrlPath(plain)]
    const named = plain.match(/^[A-Za-z_][A-Za-z0-9_]*=[@<](.+)$/)
    return named ? [plain, named[1] as string] : [plain, ...quotedInCode(plain)]
  })
}

function quotedInCode(text: string): string[] {
  if (!/['"`]/.test(text)) return []
  const quoted: string[] = []
  for (const [, , inner = ''] of text.matchAll(/(['"`])((?:(?!\1)[^\\\n]){1,400})\1/g)) if (/[\w.~]/.test(inner) && !/\s/.test(inner)) quoted.push(inner)
  return quoted.slice(0, 64)
}

function curlReads(args: readonly string[]): string[] {
  const posted = optionValuesOf(args, 'Fd', ['--form', '--form-string', '--data', '--data-binary', '--data-ascii', '--data-urlencode', '--json'])
  const sent = posted.flatMap(value => {
    const at = value.search(/[@<]/)
    return at === -1 ? [] : [value.slice(at + 1).split(';')[0] as string]
  })
  const urls = args.filter(arg => arg.startsWith('file://')).map(fileUrlPath)
  return [...sent, ...optionValuesOf(args, 'TK', ['--upload-file', '--config', '--cacert', '--cert', '--key']), ...urls]
}

export async function denyRuleReach(
  command: string,
  cwd: string,
  context: ToolPermissionContext,
  ports: DenyRuleReachPorts,
  depth = 0,
  budget: ReachBudget = { left: MAX_DERIVED },
): Promise<DenyRuleReach> {
  const rules = getDenyRules(context).filter(rule => rule.ruleValue.ruleContent !== undefined)
  const bashRules = rules.filter(rule => rule.ruleValue.toolName === BASH_TOOL_NAME)
  const fileRules = rules.filter(rule => FILE_RULE_TOOLS.has(rule.ruleValue.toolName))
  if (bashRules.length === 0 && fileRules.length === 0 && ports.estate === undefined) return NOTHING
  try {
    return await reachOf(command, cwd, context, ports, depth, budget, bashRules, fileRules)
  } catch {
    const rule = bashRules[0] ?? fileRules[0]
    return rule === undefined ? NOTHING : { denied: null, hidden: { rule, why: 'the reading of it failed' } }
  }
}

async function reachOf(
  command: string,
  cwd: string,
  context: ToolPermissionContext,
  ports: DenyRuleReachPorts,
  depth: number,
  budget: ReachBudget,
  bashRules: PermissionRule[],
  fileRules: PermissionRule[],
): Promise<DenyRuleReach> {
  const estate = ports.estate
  const kinds: FileKind[] = [...(fileRules.some(rule => READ_RULE_TOOLS.has(rule.ruleValue.toolName)) ? ['read' as const] : []), ...(estate !== undefined || fileRules.some(rule => !READ_RULE_TOOLS.has(rule.ruleValue.toolName)) ? ['edit' as const] : [])]
  const anyRule: PermissionRule | undefined = bashRules[0] ?? fileRules[0]
  const fileRule = fileRules[0]
  let hidden: HiddenDenyRule | null = null
  const hide = (rule: PermissionRule | undefined, why: string): void => {
    if (rule !== undefined) hidden ??= { rule, why }
  }
  if (depth > MAX_DEPTH) return anyRule === undefined ? NOTHING : { denied: null, hidden: { rule: anyRule, why: 'it nests commands deeper than Mercury follows' } }

  const root = await pinnedCommandAnalysis.parseCommandRaw(command)
  if (root === null || root === PARSE_ABORTED) {
    return anyRule === undefined ? NOTHING : { denied: null, hidden: { rule: anyRule, why: command.length > 10_000 ? 'it is longer than the shell parser reads' : 'the shell parser gave no reading of it' } }
  }
  const parsed = await parseForSecurity(command)
  const followed = parsed.kind === 'simple' && checkSemantics(parsed.commands).ok
  if (parsed.kind !== 'simple') {
    const expanded = braceExpanded(command)
    if (expanded !== null) return ports.judge(expanded, cwd, budget)
  }

  const fileDenial = (path: string, folder: string, wanted: readonly FileKind[]): PermissionRule | null => {
    for (const kind of wanted) {
      if (!kinds.includes(kind)) continue
      const check = validatePath(path, folder, context, kind === 'read' ? 'read' : 'create')
      if (!check.allowed && check.decisionReason?.type === 'rule' && check.decisionReason.rule.ruleBehavior === 'deny') return check.decisionReason.rule
    }
    return estate !== undefined && wanted.includes('edit') && estate(resolve(folder, expandTilde(path))) ? ESTATE_RULE : null
  }
  const pathDenial = (path: string, folders: readonly string[], wanted: readonly FileKind[]): { rule: PermissionRule; path: string } | 'unread' | null => {
    for (const folder of folders) {
      if (!hasGlob(path)) {
        const rule = fileDenial(path, folder, wanted)
        if (rule !== null) return { rule, path: resolve(folder, expandTilde(path)) }
        continue
      }
      const matches = globMatches(path, folder)
      if (matches === null) return 'unread'
      for (const match of matches) {
        const rule = fileDenial(match, folder, wanted)
        if (rule !== null) return { rule, path: match }
      }
      const above = path.slice(0, path.search(/[*?[]/)).replace(/[^\\/]*$/, '')
      if (estate !== undefined && above !== '' && wanted.includes('edit') && estate(resolve(folder, expandTilde(above)))) return { rule: ESTATE_RULE, path: resolve(folder, expandTilde(above)) }
    }
    return null
  }
  const treeDenial = (roots: readonly string[], folders: readonly string[], wanted: readonly FileKind[], names: readonly RegExp[]): { rule: PermissionRule; path: string } | 'unread' | null => {
    const budget = scanCeiling()
    let visited = 0
    const queue = folders.flatMap(folder => roots.map(root => resolve(folder, expandTilde(root))))
    const named = estate !== undefined && wanted.includes('edit') ? queue.find(root => estate(root)) : undefined
    if (named !== undefined) return { rule: ESTATE_RULE, path: named }
    const seen = new Set<string>()
    const denies = (path: string): PermissionRule | undefined =>
      wanted.flatMap(kind => (kinds.includes(kind) ? matchingRulesForInput(path, context, kind, 'deny') : []))[0] ?? (estate !== undefined && wanted.includes('edit') && estate(path) ? ESTATE_RULE : undefined)
    while (queue.length > 0) {
      const folder = queue.pop() as string
      if (seen.has(folder)) continue
      seen.add(folder)
      if (names.length === 0) {
        const own = denies(folder)
        if (own !== undefined) return { rule: own, path: folder }
      }
      let entries: Dirent[]
      try {
        entries = readdirSync(folder, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (++visited > budget) return 'unread'
        const full = join(folder, entry.name)
        if (entry.isDirectory()) queue.push(full)
        if (names.length > 0 ? !names.some(name => name.test(entry.name)) : entry.isDirectory()) continue
        const rule = denies(full)
        if (rule !== undefined) return { rule, path: full }
      }
    }
    return null
  }
  const refusal = (subject: string, path: string, rule: PermissionRule, kind: FileKind): PermissionResult => {
    if (rule === ESTATE_RULE) {
      const message = `${subject} would change Mercury's configuration`
      return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
    }
    const said = withRuleReason(context, rule, () => matchingRulesForInput(path, context, kind, 'deny'))
    return { behavior: 'deny', message: refusalWithReason(ruleSentence(subject, 'deny', said), said.ruleValue.reason), decisionReason: { type: 'rule', rule: said } }
  }
  const kindOf = (rule: PermissionRule): FileKind => (READ_RULE_TOOLS.has(rule.ruleValue.toolName) ? 'read' : 'edit')

  const views: View[] = []
  let broken = false
  const feedOf = (node: Node): Feed => {
    if (node.type !== 'command') return null
    const said = node.children.filter(child => child.type !== 'command_name' && child.type !== 'variable_assignment' && child.type !== 'file_redirect' && child.type !== 'herestring_redirect').map(literalOf)
    const name = literalOf(node.children.find(child => child.type === 'command_name') ?? node)
    if (name === null || said.some(word => word === null)) return null
    const words = said as string[]
    const base = posixPath.basename(name)
    if (base === 'echo' || base === 'printf') {
      const text = words.filter(word => base !== 'echo' || !/^-[neE]+$/.test(word)).join(' ')
      return { said: [base === 'printf' ? text.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : text] }
    }
    if (base === 'find') return { roots: PATH_EXTRACTORS.find(words), names: optionValuesOf(words, '', ['-name', '-iname']).map(segmentPattern), exact: true }
    if (base === 'git') return { roots: ['.'], names: [], exact: false }
    if (!(base in COMMAND_OPERATION_TYPE)) return null
    const roots = PATH_EXTRACTORS[base as PathCommand](words)
    return { roots: roots.length === 0 ? ['.'] : roots, names: [], exact: false }
  }
  const walk = (node: Node, scope: Scope, feed: Feed): void => {
    switch (node.type) {
      case 'ERROR':
        broken = true
        for (const child of node.children) walk(child, scope, undefined)
        return
      case 'subshell':
      case 'command_substitution':
      case 'process_substitution': {
        const inner: Scope = { cwds: [...scope.cwds], cwdKnown: scope.cwdKnown }
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, inner)
          else walk(child, inner, undefined)
        }
        return
      }
      case 'pipeline': {
        let fed = feed
        for (const child of node.children) {
          if (child.type === '|' || child.type === '|&') continue
          walk(child, scope, fed)
          fed = feedOf(child)
        }
        return
      }
      case 'redirected_statement': {
        const heredoc = node.children.find(child => child.type === 'heredoc_redirect')
        const body = heredoc?.children.find(child => child.type === 'heredoc_body')
        const text: Feed = body === undefined ? undefined : hasDynamic(body) ? null : { said: [body.text] }
        const inner = node.children.find(child => child.type !== 'file_redirect' && child.type !== 'heredoc_redirect')
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, scope)
          else if (child.type === 'heredoc_redirect') {
            const passes = inner?.type === 'command' && literalOf(inner.children.find(part => part.type === 'command_name') ?? inner) === 'cat' && inner.children.filter(part => part.type !== 'command_name').length === 0
            for (const part of child.children) if (part.type === 'pipeline' || part.type === 'command' || part.type === 'list') walk(part, scope, passes ? text : null)
          } else walk(child, scope, text === undefined ? feed : text)
        }
        return
      }
      case 'command': {
        const argv: Word[] = []
        const redirects: View['redirects'] = []
        let fed = feed
        for (const child of node.children) {
          if (child.type === 'variable_assignment') {
            for (const part of child.children) walk(part, scope, undefined)
            continue
          }
          if (child.type === 'file_redirect') {
            redirects.push(redirectOf(child))
            continue
          }
          if (child.type === 'herestring_redirect') {
            const said = child.children.filter(part => part.type !== '<<<').map(literalOf)
            fed = said.some(part => part === null) ? null : { said: [(said as string[]).join(' ')] }
            continue
          }
          argv.push(literalOf(child))
          walk(child, scope, undefined)
        }
        if (argv.some(word => word === null)) {
          const read = pinnedCommandAnalysis.parseForSecurityFromAst(node.text, node)
          const own = read.kind === 'simple' ? read.commands.find(simple => simple.argv.length === argv.length && simple.argv[0] === argv[0]) : undefined
          if (own !== undefined) own.argv.forEach((word, index) => { argv[index] = word.includes('__MERCURY_UNKNOWN') ? null : word })
        }
        views.push({ argv, redirects, feed: fed, cwds: [...scope.cwds], cwdKnown: scope.cwdKnown, text: node.text })
        const name = argv[0]
        delete scope.entered
        if (name === 'cd' || name === 'pushd') {
          const target = argv[1]
          if (argv.length !== 2 || target === null || target === undefined || target === '-' || target.startsWith('-')) scope.cwdKnown = false
          else {
            const entered = [...new Set(scope.cwds.map(folder => resolve(folder, expandTilde(target))))]
            const next = [...new Set([...scope.cwds, ...entered])]
            if (next.length > MAX_FOLDERS) scope.cwdKnown = false
            else {
              scope.cwds = next
              scope.entered = entered
            }
          }
        } else if (name === 'popd') scope.cwdKnown = false
        return
      }
      default:
        for (const child of node.children) {
          if (child.type === 'file_redirect') redirect(child, scope)
          else if (child.type === '&&' && scope.entered !== undefined) {
            scope.cwds = scope.entered
            delete scope.entered
          } else walk(child, scope, undefined)
        }
    }
  }
  const loose: Array<{ op: string; target: Word; cwds: string[]; cwdKnown: boolean }> = []
  const redirectOf = (node: Node): { op: string; target: Word } => {
    const op = node.children.find(child => /^[<>&|]+$/.test(child.type))?.type ?? ''
    const target = node.children.filter(child => child.type !== 'file_descriptor' && !/^[<>&|]+$/.test(child.type))[0]
    return { op, target: target === undefined ? null : literalOf(target) }
  }
  function redirect(node: Node, scope: Scope): void {
    loose.push({ ...redirectOf(node), cwds: [...scope.cwds], cwdKnown: scope.cwdKnown })
  }
  walk(root, { cwds: [cwd], cwdKnown: true }, undefined)
  if (broken) hide(anyRule, 'the shell parser could not read its syntax')

  const judged = new Set<string>()
  const judge = async (text: string, folders: readonly string[]): Promise<PermissionResult | null> => {
    for (const folder of folders) {
      const key = `${folder}\0${text}`
      if (judged.has(key) || (folder === cwd && text === command)) continue
      judged.add(key)
      if (--budget.left < 0) {
        hide(anyRule, 'it holds more commands than Mercury follows')
        return null
      }
      const inner = await ports.judge(text, folder, budget)
      if (inner.denied !== null) return inner.denied
      if (inner.hidden !== null) hidden ??= inner.hidden
    }
    return null
  }
  const checkRedirect = (op: string, target: Word, folders: readonly string[], known: boolean): PermissionResult | null => {
    if (kinds.length === 0 || /^[<>]&$/.test(op) || (target !== null && (/^\d+$/.test(target) || target === '-' || target === '/dev/null'))) return null
    const kind: FileKind = OUTPUT_OPERATORS.has(op) ? 'edit' : 'read'
    if (!kinds.includes(kind)) return null
    if (target === null || !known) {
      hide(fileRules.find(rule => kindOf(rule) === kind), target === null ? 'a redirect names its file at run time' : 'the folder a redirect resolves in could not be established')
      return null
    }
    const found = pathDenial(target, folders, [kind])
    if (found === 'unread') hide(fileRules.find(rule => kindOf(rule) === kind), `the wildcard ${target} matches more files than Mercury reads`)
    else if (found !== null) return refusal(kind === 'edit' ? `The redirection to ${found.path}` : `The input redirect from ${found.path}`, found.path, found.rule, kind)
    return null
  }
  for (const one of loose) {
    const denied = checkRedirect(one.op, one.target, one.cwds, one.cwdKnown)
    if (denied !== null) return { denied, hidden: null }
  }

  for (const view of views) {
    for (const one of view.redirects) {
      const denied = checkRedirect(one.op, one.target, view.cwds, view.cwdKnown)
      if (denied !== null) return { denied, hidden: null }
    }
    let argv = view.argv
    let changed = false
    let scripts: Word[] = []
    for (let rounds = 0; rounds < 8; rounds++) {
      const head = argv[0]
      if (head === null || head === undefined) break
      const base = posixPath.basename(head)
      const known = base in COMMAND_OPERATION_TYPE || SHELLS.has(base) || QUIET_COMMANDS.has(base) || LISTED_WORDS.has(base) || peelOnce(base, []) !== null
      if (head.includes('/') && known) {
        argv = [base, ...argv.slice(1)]
        changed = true
      }
      const wrapper = posixPath.basename(argv[0] as string)
      const peeled = peelOnce(wrapper, argv.slice(1))
      if (peeled === null || peeled === 'stands') break
      if ('scripts' in peeled) {
        scripts = peeled.scripts
        break
      }
      if (peeled.rest.length === 0) break
      argv = peeled.rest
      changed = true
      if (wrapper !== 'xargs') continue
      const fed = view.feed
      if (fed !== null && fed !== undefined && 'said' in fed) argv = [...argv, ...fed.said.flatMap(text => text.split(/\s+/).filter(word => word !== ''))]
      else if (kinds.length > 0 && (fed === null || fed === undefined)) hide(fileRule, 'xargs takes its operands from a pipe')
      else if (kinds.length > 0 && fed !== null && fed !== undefined) {
        const ran = posixPath.basename(argv[0] ?? '')
        const reader = ran in COMMAND_OPERATION_TYPE && COMMAND_OPERATION_TYPE[ran as PathCommand] === 'read'
        const found = treeDenial(fed.roots, view.cwds, reader ? ['read'] : ['read', 'edit'], fed.names)
        if (found === 'unread') hide(fileRule, 'xargs takes its operands from a tree larger than Mercury reads')
        else if (found !== null && fed.exact) return { denied: refusal(`The ${ran} of ${found.path}`, found.path, found.rule, kindOf(found.rule)), hidden: null }
        else if (found !== null) hide(found.rule, `xargs may hand ${found.path} to ${ran}`)
      }
    }
    for (const script of scripts) {
      if (script === null) hide(anyRule, 'it runs a script built at run time')
      else {
        const denied = await judge(script, view.cwds)
        if (denied !== null) return { denied, hidden: null }
      }
    }
    if (scripts.length > 0) continue
    const name = argv[0]
    if (name === null || name === undefined) {
      hide(anyRule, 'the command it runs is named at run time')
      continue
    }
    const base = posixPath.basename(name)
    const args = argv.slice(1)
    const literal = args.every(arg => arg !== null)
    const words = args.filter((arg): arg is string => arg !== null)
    if (literal && (changed || !followed || view.cwds.length > 1)) {
      const denied = await judge(shellCommandText([base, ...words]), view.cwds)
      if (denied !== null) return { denied, hidden: null }
    }
    if (SHELLS.has(base)) {
      const run = shellScript(args)
      if (run === 'stdin') {
        const fed = view.feed
        if (fed === null || (fed !== undefined && !('said' in fed))) hide(anyRule, `${base} reads its script from a pipe`)
        for (const script of fed !== null && fed !== undefined && 'said' in fed ? fed.said : []) {
          const denied = await judge(script, view.cwds)
          if (denied !== null) return { denied, hidden: null }
        }
      } else if ('script' in run) {
        if (run.script === null) hide(anyRule, `${base} runs a script built at run time`)
        else {
          const denied = await judge(run.script, view.cwds)
          if (denied !== null) return { denied, hidden: null }
        }
      } else {
        const found = pathDenial(run.file, view.cwds, ['read'])
        if (found !== null && found !== 'unread') return { denied: refusal(`The ${base} of ${found.path}`, found.path, found.rule, 'read'), hidden: null }
      }
      continue
    }
    if (base === 'source' || base === '.') {
      const file = args[0]
      if (file === null) hide(fileRule, `${base} names its file at run time`)
      else if (file !== undefined) {
        const found = pathDenial(file, view.cwds, ['read'])
        if (found !== null && found !== 'unread') return { denied: refusal(`The ${base} of ${found.path}`, found.path, found.rule, 'read'), hidden: null }
      }
      continue
    }
    if (base === 'xargs' || base === 'find') {
      if (base === 'find' && kinds.length > 0 && literal) {
        const roots = PATH_EXTRACTORS.find(words)
        const runs = words.some(word => ['-exec', '-execdir', '-ok', '-okdir'].includes(word))
        const ran = words[words.findIndex(word => ['-exec', '-execdir', '-ok', '-okdir'].includes(word)) + 1] ?? ''
        const reader = ran in COMMAND_OPERATION_TYPE && COMMAND_OPERATION_TYPE[ran as PathCommand] === 'read'
        const wanted: FileKind[] = words.includes('-delete') ? ['edit'] : !runs ? [] : reader ? ['read'] : ['read', 'edit']
        if (wanted.length > 0) {
          const found = treeDenial(roots, view.cwds, wanted, optionValuesOf(words, '', ['-name', '-iname']).map(segmentPattern))
          if (found === 'unread') hide(fileRule, 'find acts on a tree larger than Mercury reads')
          else if (found !== null) return { denied: refusal(`The find over ${found.path}`, found.path, found.rule, kindOf(found.rule)), hidden: null }
        }
      }
      continue
    }
    if (QUIET_COMMANDS.has(base)) continue
    if (kinds.length > 0 && !view.cwdKnown && (words.some(word => !word.startsWith('-')) || !literal)) hide(fileRule, 'the folder it runs in could not be established')
    if (base === 'curl' && literal) {
      for (const [paths, kind] of [[curlReads(words), 'read'], [ports.optionNamedWrites([base, ...words]), 'edit']] as const) {
        for (const path of paths) {
          const found = pathDenial(path, view.cwds, [kind])
          if (found !== null && found !== 'unread') return { denied: refusal(`The curl ${kind === 'read' ? 'upload of' : 'download to'} ${found.path}`, found.path, found.rule, kind), hidden: null }
        }
      }
      continue
    }
    if (literal) {
      for (const path of ports.optionNamedWrites([base, ...words])) {
        const found = pathDenial(path, view.cwds, ['edit'])
        if (found !== null && found !== 'unread') return { denied: refusal(`The ${base} write to ${found.path}`, found.path, found.rule, 'edit'), hidden: null }
      }
    }
    if (base in COMMAND_OPERATION_TYPE && base !== 'git') {
      if (kinds.length === 0) continue
      if (!literal) {
        hide(fileRule, `${base} names a path at run time`)
        continue
      }
      const operation = COMMAND_OPERATION_TYPE[base as PathCommand]
      const edits = base === 'sed' ? words.some(word => /^-[A-Za-z]*i/.test(word) || word.startsWith('--in-place')) : operation !== 'read'
      const own: FileKind = edits ? 'edit' : 'read'
      const flagged = (base === 'cp' || base === 'mv') && words.some(word => word.startsWith('-'))
      const targets = flagged ? optionValuesOf(words, 't', ['--target-directory']) : []
      const operands = flagged ? [...words.filter(word => !word.startsWith('-') && !targets.includes(word)), ...targets] : PATH_EXTRACTORS[base as PathCommand](words)
      const sources = base === 'cp' || base === 'mv' ? (targets.length > 0 ? operands.slice(0, -targets.length) : operands.slice(0, -1)) : []
      const reads = base === 'dd' ? words.filter(word => word.startsWith('if=')).map(word => word.slice(3)) : sources
      for (const [paths, wanted] of [[reads, ['read']], [operands, [own]]] as Array<[string[], FileKind[]]>) {
        for (const path of paths) {
          const found = pathDenial(path, view.cwds, wanted)
          if (found === 'unread') hide(fileRule, `the wildcard ${path} matches more files than Mercury reads`)
          else if (found !== null) return { denied: refusal(`The ${base} of ${found.path}`, found.path, found.rule, kindOf(found.rule)), hidden: null }
        }
      }
      continue
    }
    if (base === 'git') {
      if (!literal) {
        hide(fileRule, 'git names a path at run time')
        continue
      }
      const at = gitSubcommandIndex(words)
      const subcommand = words[at] ?? ''
      for (let i = 0; i < at; i++) {
        const alias = words[i] === '-c' ? words[i + 1]?.match(/^alias\.([^=]+)=([\s\S]*)$/) : null
        if (!alias) continue
        const expansion = (alias[2] as string).startsWith('!') ? (alias[2] as string).slice(1) : alias[1] === subcommand ? `git ${alias[2]} ${shellCommandText(words.slice(at + 1))}` : null
        if (expansion === null) continue
        const denied = await judge(expansion, view.cwds)
        if (denied !== null) return { denied, hidden: null }
      }
      if (kinds.length === 0) continue
      const folders = optionValuesOf(words.slice(0, at), 'C', ['--git-dir', '--work-tree'])
      const operands = words.slice(at + 1).filter((word, index, rest) => !GIT_WORD_VALUES.has(rest[index - 1] ?? '') && !/^--(?:message|author|grep|format|pretty|date|since|until|after|before)=/.test(word))
      const wanted: FileKind[] = GIT_WORKTREE_WRITERS.has(subcommand) ? ['read', 'edit'] : ['read']
      for (const path of [...folders, ...operandPaths(operands).flatMap(path => (path.includes(':') && !path.startsWith('/') ? [path, path.slice(path.indexOf(':') + 1)] : [path]))]) {
        if (path === '') continue
        const found = pathDenial(path, view.cwds, wanted)
        if (found !== null && found !== 'unread') hide(found.rule, `git ${subcommand} names ${found.path}`)
      }
      continue
    }
    if (LISTED_WORDS.has(base)) continue
    if (!literal) {
      hide(anyRule, `${base} is not a command Mercury can follow and an argument of it is built at run time`)
      continue
    }
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string
      if (word.startsWith('-')) continue
      const rule = ports.bashDenyRule(shellCommandText(words.slice(i))) ?? (/\s/.test(word) ? ports.bashDenyRule(word) : null)
      if (rule !== null) {
        hide(rule, `${base} is not a command Mercury can follow and may run ${shellCommandText(words.slice(i))}`)
        break
      }
    }
    for (const path of operandPaths(words)) {
      const found = pathDenial(path, view.cwds, ['read', 'edit'])
      if (found === 'unread') hide(fileRule, `the wildcard ${path} matches more files than Mercury reads`)
      else if (found !== null) hide(found.rule, `${base} is not a command Mercury can follow and it names ${found.path}`)
    }
  }
  return { denied: null, hidden }
}

export function hiddenDenyRuleRefusal(hidden: HiddenDenyRule, modeTitle: string): PermissionResult {
  const message = `This command is refused: its effect could not be established (${hidden.why}), and ${ruleWords(hidden.rule)} denies what it may do. ${modeTitle} asks nobody, so it does not run; spell it out as plain commands with literal paths.`
  return { behavior: 'deny', message, decisionReason: { type: 'rule', rule: hidden.rule } }
}

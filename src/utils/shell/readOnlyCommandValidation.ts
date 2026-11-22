import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'
import { binaryName } from '../config/derived.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

type FlagValue = 'none' | 'number' | 'string' | 'char' | '{}' | 'EOF'

type ReadOnlyRule = {
  readonly words: readonly string[]
  readonly attachedNumbers?: true
  readonly countShorthand?: true
  readonly dashDashIsAnOperand?: true
  readonly descendingSort?: true
  readonly flags?: Flags
  readonly form?: (command: string) => boolean
  readonly noNewline?: true
  readonly readsOnly?: (operands: readonly string[], command: string) => boolean
  readonly targets?: readonly string[]
  readonly unixOnly?: true
  readonly unlisted?: true
  readonly whole?: RegExp
}

type ExternalCommandConfig = {
  safeFlags: Record<string, FlagValue>
  regex?: RegExp
  respectsDoubleDash?: boolean
  additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean
}

const none: FlagValue = 'none'
const str: FlagValue = 'string'
const num: FlagValue = 'number'
const char: FlagValue = 'char'

type Flags = Readonly<Record<string, FlagValue>>

function flags(...groups: Flags[]): Flags {
  return Object.assign({}, ...groups)
}

const statFlags: Flags = { '--stat': none, '--numstat': none, '--shortstat': none, '--name-only': none, '--name-status': none }
const colourFlags: Flags = { '--color': none, '--no-color': none }
const patchFlags: Flags = { '--patch': none, '-p': none, '--no-patch': none, '--no-ext-diff': none, '--no-textconv': none, '-s': none }
const logDisplayFlags: Flags = { '--oneline': none, '--graph': none, '--decorate': none, '--no-decorate': none, '--date': str, '--relative-date': none }
const refSelectionFlags: Flags = { '--all': none, '--branches': none, '--tags': none, '--remotes': none }
const dateFilterFlags: Flags = { '--since': str, '--after': str, '--until': str, '--before': str }
const countFlags: Flags = { '--max-count': num, '-n': num }
const authorFilterFlags: Flags = { '--author': str, '--committer': str, '--grep': str }

const TAG_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '-n'])
const BRANCH_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--points-at', '--sort'])
const BRANCH_FILTER_FLAGS = new Set(['--merged', '--no-merged'])

function bundlesListLetter(token: string): boolean {
  return token.startsWith('-') && !token.startsWith('--') && token.length > 2 && !token.includes('=') && token.slice(1).includes('l')
}

function asksForTheList(token: string): boolean {
  return token === '-l' || token === '--list' || bundlesListLetter(token)
}

function tagOperandsRead(operands: readonly string[]): boolean {
  let listing = false
  let operandsOnly = false
  for (let i = 0; i < operands.length; i++) {
    const token = operands[i] as string
    if (token === '') continue
    if (!operandsOnly && token === '--') {
      operandsOnly = true
      continue
    }
    if (!operandsOnly && token.startsWith('-')) {
      if (asksForTheList(token)) listing = true
      if (token.includes('=')) continue
      if (TAG_VALUE_FLAGS.has(token)) i++
      continue
    }
    if (!listing) return false
  }
  return true
}

function branchOperandsRead(operands: readonly string[]): boolean {
  let listing = false
  let operandsOnly = false
  let lastFlag: string | undefined
  for (let i = 0; i < operands.length; i++) {
    const token = operands[i] as string
    if (token === '') continue
    if (!operandsOnly && token === '--') {
      operandsOnly = true
      lastFlag = undefined
      continue
    }
    if (!operandsOnly && token.startsWith('-')) {
      if (asksForTheList(token)) listing = true
      const name = token.split('=')[0] as string
      lastFlag = name
      if (token.includes('=')) continue
      if (BRANCH_VALUE_FLAGS.has(name)) i++
      continue
    }
    if (!listing && !(lastFlag !== undefined && BRANCH_FILTER_FLAGS.has(lastFlag))) return false
  }
  return true
}

function reflogOperandsRead(operands: readonly string[]): boolean {
  for (const token of operands) {
    if (token === '' || token.startsWith('-')) continue
    return token !== 'expire' && token !== 'delete' && token !== 'exists'
  }
  return true
}

function remoteShowOperandsRead(operands: readonly string[]): boolean {
  const names = operands.filter(token => token !== '' && token !== '-n')
  return names.length === 1 && /^[A-Za-z0-9_-]+$/.test(names[0] as string)
}

function remoteOperandsRead(operands: readonly string[]): boolean {
  return operands.every(token => token === '' || token === '-v' || token === '--verbose')
}

function lsRemoteOperandsRead(operands: readonly string[]): boolean {
  return operands.every(token => token.startsWith('-') || !(token.includes('://') || token.includes('@') || token.includes(':') || token.includes('$')))
}

function psOperandsRead(operands: readonly string[]): boolean {
  return !operands.some(token => !token.startsWith('-') && /^[a-z]+$/i.test(token) && token.includes('e'))
}

const DATE_VALUE_FLAGS = new Set(['-d', '--date', '-r', '--reference', '--iso-8601', '--rfc-3339'])

function dateOperandsRead(operands: readonly string[]): boolean {
  for (let i = 0; i < operands.length; i++) {
    const token = operands[i] as string
    if (token.startsWith('--') && token.includes('=')) continue
    if (DATE_VALUE_FLAGS.has(token)) {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    if (!token.startsWith('+')) return false
  }
  return true
}

function lsofOperandsRead(operands: readonly string[]): boolean {
  return !operands.some(token => token.startsWith('+m'))
}

const TPUT_WRITING_CAPABILITIES = new Set([
  'init', 'reset', 'rs1', 'rs2', 'rs3', 'is1', 'is2', 'is3', 'iprog', 'if', 'rf',
  'clear', 'flash', 'mc0', 'mc4', 'mc5', 'mc5i', 'mc5p', 'pfkey', 'pfloc', 'pfx',
  'pfxl', 'smcup', 'rmcup',
])

function tputOperandsRead(operands: readonly string[]): boolean {
  let optionsEnded = false
  for (let i = 0; i < operands.length; i++) {
    const token = operands[i] as string
    if (!optionsEnded && token === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && token === '-T') {
      i++
      continue
    }
    if (!optionsEnded && /^-[A-Za-z]*S/.test(token)) return false
    if ((optionsEnded || !token.startsWith('-')) && TPUT_WRITING_CAPABILITIES.has(token)) return false
  }
  return true
}

function pyrightOperandsRead(operands: readonly string[]): boolean {
  return !operands.some(token => token === '--watch' || token === '-w')
}

const XARGS_VALUE_FLAGS = new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '--eof', '-I', '--replace', '-J', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'])
const XARGS_READING_TARGETS = new Set([
  'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'less', 'more', 'sort', 'uniq', 'cut', 'paste', 'column', 'file', 'stat', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'strings', 'hexdump', 'od', 'xxd', 'base64', 'nl',
  'diff', 'cmp', 'comm', 'tac', 'rev', 'fold', 'fmt', 'pr', 'expand', 'unexpand', 'tsort', 'awk', 'sed', 'jq', 'du', 'ls', 'find', 'tree', 'fd', 'fdfind', 'realpath', 'readlink', 'info', 'man', 'pyright', 'test',
])

function xargsOperandsRead(operands: readonly string[]): boolean {
  let argFile = false
  let i = 0
  while (i < operands.length) {
    const token = operands[i] as string
    if (token === '') {
      i++
      continue
    }
    if (token === '--') {
      i++
      break
    }
    if (!token.startsWith('-')) break
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
    if (name === '-a' || name === '--arg-file') argFile = true
    i += XARGS_VALUE_FLAGS.has(name) && !token.includes('=') ? 2 : 1
  }
  const target = operands[i]
  return target === undefined || argFile || !XARGS_READING_TARGETS.has(target)
}

const PLAIN_OPERANDS = /[<>()$`|{}&;\r\n]/

function plainOperands(text: string): boolean {
  const word = text.split(/\s+/)[0] ?? ''
  return !PLAIN_OPERANDS.test(text.slice(word.length))
}

function startsWithWord(text: string, word: string): boolean {
  return text === word || text.startsWith(`${word} `)
}

function echoForm(text: string): boolean {
  if (!startsWithWord(text, 'echo')) return false
  let rest = text.slice(4).trim().replace(/\s+2>&1$/, '')
  const argument = /^(?:'[^']*'|"[^"$<>\r\n]*"|[^|;&`$(){}><#\\!"'\s]+)(?:\s+|$)/
  while (rest.length > 0) {
    const match = rest.match(argument)
    if (!match) return false
    rest = rest.slice(match[0].length)
  }
  return true
}

function jqForm(text: string): boolean {
  if (!startsWithWord(text, 'jq')) return false
  if (/(?:^|\s)(?:-f|--from-file|--rawfile|--slurpfile|--run-tests|-L|--library-path)\b/.test(text)) return false
  if (/\benv\b/.test(text) || text.includes('$ENV')) return false
  return !text.includes('`')
}

function lsForm(text: string): boolean {
  return startsWithWord(text, 'ls') && !PLAIN_OPERANDS.test(text.slice(2))
}

function findForm(text: string): boolean {
  if (!startsWithWord(text, 'find')) return false
  if (/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fls|fprintf)\b/.test(text)) return false
  return !PLAIN_OPERANDS.test(text.replace(/\\[()]/g, ''))
}

function walked(words: string, flagTable: Flags, rest: Omit<ReadOnlyRule, 'words' | 'flags'> = {}): ReadOnlyRule {
  return { words: words.split(' '), flags: flagTable, ...rest }
}

function git(words: string, flagTable: Flags, rest: Omit<ReadOnlyRule, 'words' | 'flags'> = {}): ReadOnlyRule {
  return walked(`git ${words}`, flagTable, { countShorthand: true, descendingSort: true, ...rest })
}

function plain(word: string): ReadOnlyRule {
  return { words: [word], form: plainOperands }
}

function exactly(word: string, ...forms: string[]): ReadOnlyRule {
  return notBuilt('src/utils/shell/readOnlyCommandValidation.ts:260')
}

function probe(word: string, ...forms: string[]): ReadOnlyRule {
  return { ...exactly(word, ...forms), unlisted: true }
}

const FD_FLAGS: Flags = { '-H': none, '--hidden': none, '-I': none, '--no-ignore': none, '-t': str, '--type': str, '-e': str, '--extension': str, '-d': num, '--max-depth': num, '-p': none, '--full-path': none, '-g': none, '--glob': none, '-a': none, '--absolute-path': none, '-c': str, '--color': str, '-s': none, '--case-sensitive': none, '-i': none, '--ignore-case': none, '-0': none, '--print0': none }
const CHECKSUM_FLAGS: Flags = { '-b': none, '-c': none, '-t': none, '--tag': none }

const READ_ONLY_RULES: readonly ReadOnlyRule[] = unbuilt('src/utils/shell/readOnlyCommandValidation.ts:275')

const WALKED_RULES = new Map<string, ReadOnlyRule>(READ_ONLY_RULES.filter(rule => rule.flags !== undefined).map(rule => [rule.words.join(' '), rule]))
const FORM_RULES = new Map<string, ReadOnlyRule>(READ_ONLY_RULES.filter(rule => rule.form !== undefined).map(rule => [rule.words[0] as string, rule]))
const LONGEST_RULE = Math.max(...READ_ONLY_RULES.map(rule => rule.words.length))

export function walkedRuleFor(tokens: readonly string[]): ReadOnlyRule | undefined {
  for (let size = Math.min(tokens.length, LONGEST_RULE); size > 0; size--) {
    const rule = WALKED_RULES.get(tokens.slice(0, size).join(' '))
    if (rule) return rule
  }
  return undefined
}

export function formRuleFor(word: string): ReadOnlyRule | undefined {
  return FORM_RULES.get(word)
}

export const LISTED_WORDS: ReadonlySet<string> = new Set(READ_ONLY_RULES.filter(rule => !rule.unlisted).map(rule => rule.words[0]!))

function isFlag(token: string): boolean {
  return /^-[\w-]/.test(token)
}

function fitsValue(kind: FlagValue, value: string): boolean {
  switch (kind) {
    case 'number': return /^\d+$/.test(value)
    case 'string': return true
    case 'char': return value.length === 1
    case '{}': return value === '{}'
    case 'EOF': return value === 'EOF'
    case 'none': return false
  }
}

export function walkFlags(tokens: readonly string[], startIndex: number, rule: ReadOnlyRule): boolean {
  const table: Flags = rule.flags ?? {}
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const flag = isFlag(token)
    if (rule.targets && (!flag || token === '--')) {
      return rule.targets.includes(token === '--' ? tokens[i + 1] ?? token : token)
    }
    if (token === '--') {
      if (rule.dashDashIsAnOperand) continue
      return true
    }
    if (!flag) continue
    const equal = token.indexOf('=')
    const name = equal < 0 ? token : token.slice(0, equal)
    const kind = table[name]
    if (kind === undefined) {
      if (rule.countShorthand && /^-\d+$/.test(token)) continue
      if (token.length <= 2 || token.startsWith('--')) return false
      const first = table[token.slice(0, 2)]
      if (rule.attachedNumbers && (first === num || first === str) && /^\d+$/.test(token.slice(2))) continue
      if (equal < 0 && [...name.slice(1)].every(c => table[`-${c}`] === none)) continue
      return false
    }
    if (kind === none) {
      if (equal >= 0) return false
      continue
    }
    const value = equal < 0 ? tokens[++i] : token.slice(equal + 1)
    if (value === undefined) return false
    const descending = rule.descendingSort && name === '--sort' && /^-[A-Za-z]/.test(value)
    if (!descending && ((equal < 0 && isFlag(value)) || (kind === str && value.startsWith('-')))) return false
    if (!fitsValue(kind, value)) return false
  }
  return true
}

function externalCommands(command: string): Record<string, ExternalCommandConfig> {
  const configs: Record<string, ExternalCommandConfig> = {}
  for (const rule of READ_ONLY_RULES) {
    if (!rule.flags || rule.words[0] !== command) continue
    const config: ExternalCommandConfig = { safeFlags: { ...rule.flags } }
    if (rule.whole) config.regex = rule.whole
    if (rule.dashDashIsAnOperand) config.respectsDoubleDash = false
    const { readsOnly } = rule
    if (readsOnly) config.additionalCommandIsDangerousCallback = (raw, args) => !readsOnly(args, raw)
    configs[rule.words.join(' ')] = config
  }
  return configs
}

export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = externalCommands('git')
export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = externalCommands('docker')

type ValidateOptions = {
  commandName?: string
  rawCommand?: string
  xargsTargetCommands?: string[]
}

export function validateFlags(tokens: string[], startIndex: number, config: ExternalCommandConfig, options?: ValidateOptions): boolean {
  const name = options?.commandName
  return walkFlags(tokens, startIndex, {
    words: [], flags: config.safeFlags,
    ...(config.respectsDoubleDash === false ? { dashDashIsAnOperand: true } : {}),
    ...(name === 'git' ? { countShorthand: true, descendingSort: true } : {}),
    ...(name === 'grep' ? { attachedNumbers: true } : {}),
    ...(name === 'xargs' && options?.xargsTargetCommands ? { targets: options.xargsTargetCommands } : {}),
  })
}

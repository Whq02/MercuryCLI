import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { join, posix as posixPath, win32 as win32Path } from 'node:path'
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  PermissionResult,
  PermissionDecisionReason,
} from '../../utils/permissions/PermissionResult.js'
import type { PermissionRule, PermissionUpdate } from '../../types/permissions.js'
import {
  preparedSecurityParse,
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
import { allWorkingDirectories, envFileReadAsk, envFileTargetsInGlob, isProjectEnvFileName, matchingRulesForInput, pathInAllowedWorkingPath } from '../../utils/permissions/filesystem.js'
import { createEditRuleSuggestion, createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import { refusalWithReason, ruleSentence, withRuleReason } from '../../utils/permissions/ruleReason.js'
import { getShellCwd, resolveShellCwd } from '../../utils/Shell.js'
import { getPlatform } from '../../utils/platform.js'
import { posixPathToWindowsPath } from '../../utils/windowsPaths.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'
import { scanCeiling } from '../../utils/verification/scanCeiling.js'


export type PathCommand =
  | 'cd' | 'ls' | 'find' | 'mkdir' | 'touch' | 'rm' | 'rmdir' | 'mv' | 'cp'
  | 'cat' | 'head' | 'tail' | 'sort' | 'uniq' | 'wc' | 'cut' | 'paste' | 'column'
  | 'tr' | 'file' | 'stat' | 'diff' | 'awk' | 'strings' | 'hexdump' | 'od'
  | 'base64' | 'nl' | 'grep' | 'rg' | 'sed' | 'git' | 'jq' | 'sha256sum'
  | 'sha1sum' | 'md5sum' | 'tee' | 'dd'
  | 'xargs' | 'tree' | 'fd' | 'fdfind' | 'du' | 'realpath' | 'readlink' | 'comm' | 'cmp'
  | 'tac' | 'rev' | 'fold' | 'fmt' | 'pr' | 'expand' | 'unexpand' | 'tsort' | 'info' | 'man'
  | 'date' | 'pyright' | 'test'

export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read', ls: 'read', find: 'read', cat: 'read', head: 'read', tail: 'read',
  sort: 'read', uniq: 'read', wc: 'read', cut: 'read', paste: 'read', column: 'read',
  tr: 'read', file: 'read', stat: 'read', diff: 'read', awk: 'read', strings: 'read',
  hexdump: 'read', od: 'read', base64: 'read', nl: 'read', grep: 'read', rg: 'read',
  git: 'read', jq: 'read', sha256sum: 'read', sha1sum: 'read', md5sum: 'read',
  xargs: 'read', tree: 'read', fd: 'read', fdfind: 'read', du: 'read', realpath: 'read', readlink: 'read',
  comm: 'read', cmp: 'read', tac: 'read', rev: 'read', fold: 'read', fmt: 'read', pr: 'read',
  expand: 'read', unexpand: 'read', tsort: 'read', info: 'read', man: 'read', date: 'read', pyright: 'read', test: 'read',
  mkdir: 'create', touch: 'create', tee: 'create', dd: 'create',
  rm: 'write', rmdir: 'write', mv: 'write', cp: 'write', sed: 'write',
}


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

type OptionGrammar = { readonly letters: string; readonly longs: ReadonlySet<string>; readonly pairs?: ReadonlySet<string> }

const GREP_GRAMMAR: OptionGrammar = {
  letters: 'efmABCdD',
  longs: new Set(['--regexp', '--file', '--exclude', '--include', '--exclude-dir', '--include-dir', '--exclude-from', '--max-count', '--after-context', '--before-context', '--context', '--label', '--devices', '--directories', '--binary-files', '--group-separator']),
}
const RG_GRAMMAR: OptionGrammar = {
  letters: 'efgtTmrABCEMjd',
  longs: new Set([
    '--regexp', '--file', '--type', '--type-not', '--glob', '--iglob', '--max-count', '--max-depth', '--maxdepth', '--replace', '--after-context', '--before-context', '--context',
    '--encoding', '--max-columns', '--threads', '--color', '--colors', '--type-add', '--type-clear', '--pre', '--pre-glob', '--sort', '--sortr', '--max-filesize', '--dfa-size-limit',
    '--regex-size-limit', '--path-separator', '--field-context-separator', '--field-match-separator', '--context-separator', '--ignore-file', '--engine', '--hyperlink-format', '--generate',
  ]),
}
const JQ_GRAMMAR: OptionGrammar = {
  letters: 'fL',
  longs: new Set(['--from-file', '--library-path', '--indent']),
  pairs: new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']),
}
const XARGS_GRAMMAR: OptionGrammar = { letters: 'adEIJLnPs', longs: new Set(['--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--process-slot-var']) }
const TREE_GRAMMAR: OptionGrammar = { letters: 'LPIHTo', longs: new Set(['--filelimit', '--charset', '--sort', '--timefmt', '--infofile', '--gitfile', '--hintro', '--houtro']) }
const FD_GRAMMAR: OptionGrammar = {
  letters: 'tedcExXjSo',
  longs: new Set([
    '--type', '--extension', '--max-depth', '--maxdepth', '--min-depth', '--exact-depth', '--color', '--exclude', '--exec', '--exec-batch', '--threads', '--size', '--changed-within',
    '--changed-before', '--owner', '--max-results', '--path-separator', '--max-buffer-time', '--batch-size', '--search-path', '--base-directory', '--ignore-file', '--format', '--and',
  ]),
}
const DU_GRAMMAR: OptionGrammar = { letters: 'dBtX', longs: new Set(['--max-depth', '--block-size', '--threshold', '--time-style', '--exclude', '--exclude-from', '--files0-from']) }
const DIFF_GRAMMAR: OptionGrammar = {
  letters: 'CUWxXSIFDL',
  longs: new Set([
    '--context', '--unified', '--width', '--exclude', '--exclude-from', '--starting-file', '--ignore-matching-lines', '--show-function-line', '--ifdef', '--label', '--from-file', '--to-file',
    '--tabsize', '--horizon-lines', '--line-format', '--old-line-format', '--new-line-format', '--unchanged-line-format', '--old-group-format', '--new-group-format', '--changed-group-format', '--unchanged-group-format', '--palette', '--color',
  ]),
}
const INFO_GRAMMAR: OptionGrammar = { letters: 'fndok', longs: new Set(['--file', '--node', '--directory', '--output', '--apropos', '--init-file', '--index-search', '--restore', '--dribble', '--variable']) }
const MAN_GRAMMAR: OptionGrammar = { letters: 'lMCSsLPpeRET', longs: new Set(['--local-file', '--manpath', '--config-file', '--sections', '--locale', '--pager', '--preprocessor', '--extension', '--recode', '--encoding', '--troff-device', '--systems', '--html']) }
const DATE_GRAMMAR: OptionGrammar = { letters: 'rdsf', longs: new Set(['--reference', '--date', '--set', '--file', '--rfc-3339', '--resolution']) }
const PYRIGHT_GRAMMAR: OptionGrammar = { letters: 'pt', longs: new Set(['--project', '--typeshedpath', '--typeshed-path', '--venvpath', '--venv-path', '--pythonpath', '--pythonversion', '--pythonplatform', '--level', '--threads', '--verifytypes']) }

const GREP_FILES = new Set(['-f', '--file', '--exclude-from'])
const RG_FILES = new Set(['-f', '--file', '--ignore-file'])
const PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file'])
const FILE_NAME_FILTERS = new Set(['-g', '--glob', '--iglob', '--include'])
const XARGS_FILES = new Set(['-a', '--arg-file'])
const TREE_FILES = new Set(['--infofile', '--gitfile', '--hintro', '--houtro'])
const FD_FILES = new Set(['--search-path', '--base-directory', '--ignore-file'])
const DU_FILES = new Set(['-X', '--exclude-from', '--files0-from'])
const DIFF_FILES = new Set(['-X', '--exclude-from', '--from-file', '--to-file'])
const INFO_FILES = new Set(['-f', '--file', '-d', '--directory', '--init-file'])
const MAN_FILES = new Set(['-l', '--local-file', '-M', '--manpath', '-C', '--config-file'])
const DATE_FILES = new Set(['-r', '--reference', '-f', '--file'])
const PYRIGHT_FILES = new Set(['-p', '--project', '--typeshedpath', '--typeshed-path', '--venvpath', '--venv-path', '--pythonpath'])
const JQ_FILES = new Set(['-f', '--from-file', '-L', '--library-path', '--slurpfile', '--rawfile'])
const TEST_FILE_UNARIES = /^-[bcdefgGhkLNOprsSuwx]$/
const TEST_FILE_BINARIES = new Set(['-nt', '-ot', '-ef'])
const ENV_METADATA_COMMANDS: ReadonlySet<PathCommand> = new Set(['cd', 'ls', 'find', 'file', 'stat', 'wc', 'sha256sum', 'sha1sum', 'md5sum', 'tree', 'fd', 'fdfind', 'du', 'realpath', 'readlink', 'date', 'test'])

function walkOptions(args: readonly string[], grammar: OptionGrammar, onFlag: (name: string, values: string[]) => void, onOperand: (value: string) => void): void {
  let optionsEnded = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (optionsEnded || !arg.startsWith('-') || arg === '-') {
      onOperand(arg)
      continue
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals === -1 ? arg : arg.slice(0, equals)
      if (equals !== -1) {
        onFlag(name, [arg.slice(equals + 1)])
      } else if (grammar.pairs?.has(name)) {
        const values = args.slice(i + 1, i + 3)
        i += values.length
        onFlag(name, values)
      } else if (grammar.longs.has(name) && args[i + 1] !== undefined) {
        onFlag(name, [args[++i] as string])
      } else {
        onFlag(name, [])
      }
      continue
    }
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k] as string
      if (!grammar.letters.includes(letter)) {
        onFlag(`-${letter}`, [])
        continue
      }
      const attached = arg.slice(k + 1)
      if (attached.length > 0) onFlag(`-${letter}`, [attached])
      else if (args[i + 1] !== undefined) onFlag(`-${letter}`, [args[++i] as string])
      else onFlag(`-${letter}`, [])
      break
    }
  }
}

function flaggedFile(name: string, values: string[], files: ReadonlySet<string>, operands: string[]): void {
  if (!files.has(name)) return
  const value = values[values.length - 1]
  if (value !== undefined && value !== '-') operands.push(value)
}

function extractFlagged(grammar: OptionGrammar, files: ReadonlySet<string>, positionals: 'all' | 'slash' | 'none' = 'all', fallback: string[] = []): (args: string[]) => string[] {
  return args => {
    const operands: string[] = []
    let seen = 0
    walkOptions(args, grammar, (name, values) => flaggedFile(name, values, files, operands), value => {
      seen++
      if (positionals === 'all' || (positionals === 'slash' && value.includes('/'))) operands.push(value)
    })
    return seen === 0 && positionals === 'all' ? [...operands, ...fallback] : operands
  }
}

function extractFdOperands(args: string[]): string[] {
  const operands: string[] = []
  const paths: string[] = []
  let searchPaths = 0
  let patternSeen = false
  walkOptions(args, FD_GRAMMAR, (name, values) => {
    if (FD_FILES.has(name)) searchPaths++
    flaggedFile(name, values, FD_FILES, operands)
  }, value => {
    if (!patternSeen) patternSeen = true
    else paths.push(value)
  })
  return paths.length === 0 && searchPaths === 0 ? [...operands, '.'] : [...operands, ...paths]
}

function extractTestOperands(args: string[]): string[] {
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const next = args[i + 1]
    if (TEST_FILE_UNARIES.test(arg) && next !== undefined) {
      operands.push(next)
      i++
    } else if (TEST_FILE_BINARIES.has(arg)) {
      const previous = args[i - 1]
      if (previous !== undefined) operands.push(previous)
      if (next !== undefined) operands.push(next)
      i++
    }
  }
  return operands
}

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
  grep: args => extractPatternCommand(args, GREP_GRAMMAR, GREP_FILES, ['-r', '-R', '--recursive', '--dereference-recursive']),
  rg: args => extractPatternCommand(args, RG_GRAMMAR, RG_FILES, undefined),
  sed: extractSedOperands,
  jq: extractJqOperands,
  git: extractGitOperands,
  tee: args => extractBaseline(args).filter(a => a !== '/dev/null'),
  dd: args => args.filter(a => a.startsWith('of=') && !/^of=\/dev\/(?:null|stdout|stderr|fd\/[12])$/.test(a)).map(a => a.slice(3)),
  awk: extractAwkOperands,
  xargs: extractFlagged(XARGS_GRAMMAR, XARGS_FILES, 'none'),
  tree: extractFlagged(TREE_GRAMMAR, TREE_FILES, 'all', ['.']),
  fd: extractFdOperands,
  fdfind: extractFdOperands,
  du: extractFlagged(DU_GRAMMAR, DU_FILES, 'all', ['.']),
  diff: extractFlagged(DIFF_GRAMMAR, DIFF_FILES),
  info: extractFlagged(INFO_GRAMMAR, INFO_FILES, 'slash'),
  man: extractFlagged(MAN_GRAMMAR, MAN_FILES, 'slash'),
  date: extractFlagged(DATE_GRAMMAR, DATE_FILES, 'none'),
  pyright: extractFlagged(PYRIGHT_GRAMMAR, PYRIGHT_FILES),
  test: extractTestOperands,
  mkdir: extractBaseline, touch: extractBaseline, rm: extractBaseline, rmdir: extractBaseline,
  mv: extractBaseline, cp: extractBaseline, cat: extractBaseline, head: extractBaseline,
  tail: extractBaseline, sort: extractBaseline, uniq: extractBaseline, wc: extractBaseline,
  cut: extractBaseline, paste: extractBaseline, column: extractBaseline, file: extractBaseline,
  stat: extractBaseline, strings: extractBaseline,
  hexdump: extractBaseline, od: extractBaseline, base64: extractBaseline, nl: extractBaseline,
  sha256sum: extractBaseline, sha1sum: extractBaseline, md5sum: extractBaseline,
  realpath: extractBaseline, readlink: extractBaseline, comm: extractBaseline, cmp: extractBaseline,
  tac: extractBaseline, rev: extractBaseline, fold: extractBaseline, fmt: extractBaseline, pr: extractBaseline,
  expand: extractBaseline, unexpand: extractBaseline, tsort: extractBaseline,
}

const AWK_READ_OPTIONS = new Set(['-f', '--file', '-E', '--exec', '-i', '--include', '-l', '--load'])
const AWK_PROGRAM_OPTIONS = new Set(['-f', '--file', '-E', '--exec', '-e', '--source'])
const AWK_OPTIONS_END = new Set(['-E', '--exec'])
const AWK_SKIPPED_VALUE_OPTIONS = new Set(['-v', '--assign', '-F', '--field-separator', '-e', '--source'])

function extractAwkOperands(args: string[]): string[] {
  const operands: string[] = []
  let programGiven = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      i++
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    const fused = arg.match(/^-([fEilvF])(.+)$/)
    const long = arg.match(/^--(file|exec|include|load|assign|field-separator|source)=(.*)$/s)
    const option = fused ? `-${fused[1]}` : long ? `--${long[1]}` : arg
    const value = fused ? (fused[2] as string) : long ? (long[2] as string) : undefined
    if (AWK_PROGRAM_OPTIONS.has(option)) programGiven = true
    if (AWK_READ_OPTIONS.has(option)) {
      const read = value ?? args[i + 1]
      if (value === undefined && args[i + 1] !== undefined) i++
      if (read !== undefined) operands.push(read)
    } else if (AWK_SKIPPED_VALUE_OPTIONS.has(option)) {
      if (value === undefined && args[i + 1] !== undefined) i++
    }
    if (AWK_OPTIONS_END.has(option)) {
      i++
      break
    }
  }
  if (!programGiven && i < args.length) i++
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-') continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue
    operands.push(arg)
  }
  return operands
}

function extractFindOperands(args: string[]): string[] {
  const operands: string[] = []
  let i = 0
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
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
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

function envFileNameFilter(value: string | undefined, operands: string[]): void {
  if (value !== undefined) operands.push(...envFileTargetsInGlob(value))
}

function extractPatternCommand(args: string[], grammar: OptionGrammar, files: ReadonlySet<string>, recursiveFlags: string[] | undefined): string[] {
  const operands: string[] = []
  const paths: string[] = []
  let patternSeen = false
  let recursive = recursiveFlags === undefined
  walkOptions(args, grammar, (name, values) => {
    if (PATTERN_FLAGS.has(name) || name === '--files') patternSeen = true
    if (recursiveFlags?.includes(name)) recursive = true
    if (FILE_NAME_FILTERS.has(name)) envFileNameFilter(values[0], operands)
    flaggedFile(name, values, files, operands)
  }, value => {
    if (!patternSeen) patternSeen = true
    else paths.push(value)
  })
  if (paths.length === 0 && recursive) paths.push('.')
  return [...operands, ...paths]
}

function extractJqOperands(args: string[]): string[] {
  const operands: string[] = []
  let filterSeen = false
  let argsMode = false
  walkOptions(args, JQ_GRAMMAR, (name, values) => {
    if (name === '-f' || name === '--from-file') filterSeen = true
    if (name === '--args' || name === '--jsonargs') argsMode = true
    flaggedFile(name, values, JQ_FILES, operands)
  }, value => {
    if (!filterSeen) filterSeen = true
    else if (!argsMode) operands.push(value)
  })
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
          operands.push(next)
          i++
        }
        continue
      }
      if (arg === '-e' || arg === '--expression') {
        if (args[i + 1] !== undefined) i++
        scriptSeen = true
        continue
      }
      if (arg.includes('e') || arg.includes('f')) scriptSeen = true
      continue
    }
    if (!scriptSeen) {
      scriptSeen = true
      continue
    }
    operands.push(arg)
  }
  return operands
}

function extractGitOperands(args: string[]): string[] {
  if (args[0] !== 'diff') return []
  if (!args.includes('--no-index')) return []
  const rest = args.slice(1).filter(a => a !== '--no-index')
  return extractBaseline(rest).slice(0, 2)
}


const ARGV_WRAPPERS = new Set(['time', 'nohup', 'timeout', 'nice', 'stdbuf', 'env'])
const TIMEOUT_VALUE = /^[A-Za-z0-9_.+-]+$/
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/

function stripWrappersFromArgv(argv: string[]): string[] {
  let current = argv
  while (current.length > 0 && ARGV_WRAPPERS.has(current[0] as string)) {
    const stripped = stripOneWrapper(current)
    if (stripped === null) break
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
    if (token.startsWith('-')) return null
    break
  }
  const duration = rest[i]
  if (duration === undefined || !DURATION.test(duration)) return null
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
  return consumeMarker(rest)
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
    if (token.startsWith('-')) return null
    break
  }
  if (consumed === 0 || i >= rest.length) return null
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
    if (token.startsWith('-')) return null
    break
  }
  if (i >= rest.length) return null
  return rest.slice(i)
}


const COMMAND_ACTION: Record<PathCommand, string> = {
  cd: 'enter the directory', ls: 'list', find: 'search', mkdir: 'create the directory',
  touch: 'create', rm: 'remove', rmdir: 'remove the directory', mv: 'move', cp: 'copy',
  cat: 'read', head: 'read the start of', tail: 'read the end of', sort: 'read',
  uniq: 'read', wc: 'count', cut: 'read fields of', paste: 'merge', column: 'format',
  tr: 'read', file: 'inspect', stat: 'inspect', diff: 'compare', awk: 'process',
  strings: 'read strings from', hexdump: 'dump', od: 'dump', base64: 'encode',
  nl: 'number lines of', grep: 'search', rg: 'search', sed: 'edit', git: 'run git on',
  jq: 'query', sha256sum: 'hash', sha1sum: 'hash', md5sum: 'hash', tee: 'write', dd: 'write',
  xargs: 'read', tree: 'list', fd: 'search', fdfind: 'search', du: 'inspect', realpath: 'inspect', readlink: 'inspect',
  comm: 'compare', cmp: 'compare', tac: 'read', rev: 'read', fold: 'read', fmt: 'read', pr: 'read',
  expand: 'read', unexpand: 'read', tsort: 'read', info: 'read', man: 'read', date: 'inspect', pyright: 'read', test: 'inspect',
}

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

  if ((command === 'mv' || command === 'cp') && args.some(a => a.startsWith('-'))) {
    return {
      behavior: 'ask',
      message: `This ${command} command uses flags Mercury cannot validate automatically, so it needs manual approval.`,
      decisionReason: { type: 'other', reason: `${command} with flags requires manual approval` },
    }
  }
  const absoluteMkdir = command === 'mkdir' && args.length === 2 && args[0] === '-p' &&
    getPlatform() !== 'windows' && posixPath.isAbsolute(args[1]!)
  if (compoundCommandHasCd && operationType !== 'read' && !absoluteMkdir) {
    return {
      behavior: 'ask',
      message: 'Bash needs approval for a write combined with cd because relative paths can land in a different folder. Set cwd on a separate Bash call and use literal output paths.',
      decisionReason: { type: 'other', reason: 'A directory change combined with a write cannot be validated' },
    }
  }
  const operands = PATH_EXTRACTORS[command](args)
  const flowRead = (context.mode === 'flow' || context.probedFrom === 'flow') && operationType === 'read' && command !== 'cd'
  const readsEnvContent = (operationType === 'read' && !ENV_METADATA_COMMANDS.has(command)) || command === 'cp' || command === 'mv'
  const roots: string[] = []
  for (const operand of operands) {
    const check = validatePath(operand, cwd, context, operationType)
    if (!check.allowed) {
      if (flowRead && check.decisionReason === undefined) continue
      return operandRefusal(command, check, context, operationType)
    }
    const envAsk = readsEnvContent ? envFileReadAsk(check.resolvedPath, context) : null
    if (envAsk) return { behavior: 'ask', message: envAsk.message, decisionReason: envAsk.decisionReason }
    roots.push(check.resolvedPath)
  }
  if (operationType === 'read' && !flowRead && FOLLOWS_LINKS[command]?.(args) === true) {
    const followed = followedLinksRefusal(command, roots, cwd, context, operationType)
    if (followed !== null) return followed
  }
  return { behavior: 'passthrough', message: `All ${command} operands are within the allowed directories.` }
}

function operandRefusal(command: PathCommand, check: ReturnType<typeof validatePath>, context: ToolPermissionContext, operationType: FileOperationType): PermissionResult {
  if (check.decisionReason?.type === 'rule') {
    return ruleDeny(denySubject(command, check.resolvedPath), check.resolvedPath, operationType === 'read' ? 'read' : 'edit', context, check.decisionReason.rule)
  }
  return {
    behavior: 'ask',
    message: composedMessage(command, check.resolvedPath, context, check.decisionReason),
    blockedPath: check.resolvedPath,
    decisionReason: check.decisionReason,
  }
}

function flagNames(args: string[], grammar: OptionGrammar): Set<string> {
  const names = new Set<string>()
  walkOptions(args, grammar, name => { names.add(name) }, () => {})
  return names
}

const LS_GRAMMAR: OptionGrammar = { letters: 'ITw', longs: new Set(['--block-size', '--format', '--hide', '--ignore', '--indicator-style', '--quoting-style', '--sort', '--time', '--time-style', '--width', '--tabsize']) }

const FOLLOWS_LINKS: Partial<Record<PathCommand, (args: string[]) => boolean>> = {
  grep: args => {
    const flags = flagNames(args, GREP_GRAMMAR)
    return flags.has('-R') || flags.has('--dereference-recursive')
  },
  rg: args => {
    const flags = flagNames(args, RG_GRAMMAR)
    return flags.has('-L') || flags.has('--follow')
  },
  find: args => args.includes('-L') || args.includes('-follow'),
  ls: args => {
    const flags = flagNames(args, LS_GRAMMAR)
    return (flags.has('-L') || flags.has('--dereference')) && (flags.has('-R') || flags.has('--recursive'))
  },
  du: args => {
    const flags = flagNames(args, DU_GRAMMAR)
    return flags.has('-L') || flags.has('--dereference')
  },
  tree: args => flagNames(args, TREE_GRAMMAR).has('-l'),
  fd: args => {
    const flags = flagNames(args, FD_GRAMMAR)
    return flags.has('-L') || flags.has('--follow')
  },
  fdfind: args => {
    const flags = flagNames(args, FD_GRAMMAR)
    return flags.has('-L') || flags.has('--follow')
  },
  diff: args => {
    const flags = flagNames(args, DIFF_GRAMMAR)
    return (flags.has('-r') || flags.has('--recursive')) && !flags.has('--no-dereference')
  },
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function followedLinksRefusal(command: PathCommand, roots: string[], cwd: string, context: ToolPermissionContext, operationType: FileOperationType): PermissionResult | null {
  const budget = scanCeiling()
  const seen = new Set<string>()
  const queue = roots.filter(isDirectory).map(root => ({ dir: root, root }))
  let visited = 0
  while (queue.length > 0) {
    const { dir, root } = queue.pop() as { dir: string; root: string }
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    let entries: Dirent[]
    try {
      entries = readdirSync(real, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > budget) {
        const message = `${command} follows links under ${root}, a tree of more than ${budget.toLocaleString('en-US')} entries; narrow the search, or approve`
        return { behavior: 'ask', message, decisionReason: { type: 'other', reason: message } }
      }
      const full = join(real, entry.name)
      if (entry.isSymbolicLink()) {
        const check = validatePath(full, cwd, context, operationType)
        if (!check.allowed) return operandRefusal(command, check, context, operationType)
        if (isDirectory(check.resolvedPath)) queue.push({ dir: check.resolvedPath, root })
      } else if (entry.isDirectory()) {
        queue.push({ dir: full, root })
      }
    }
  }
  return null
}

function denySubject(command: PathCommand, path: string): string {
  return `The ${command} of ${path}`
}

function ruleDeny(subject: string, path: string, toolType: 'edit' | 'read', context: ToolPermissionContext, rule: PermissionRule): PermissionResult {
  const said = withRuleReason(context, rule, () => matchingRulesForInput(path, context, toolType, 'deny'))
  return { behavior: 'deny', message: refusalWithReason(ruleSentence(subject, 'deny', said), said.ruleValue.reason), decisionReason: { type: 'rule', rule: said } }
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
    return `For security: ${composeWriteRefusal(context, resolvedPath, COMMAND_ACTION[command])}`
  }
  return `Mercury needs permission to ${COMMAND_ACTION[command]} ${resolvedPath}, outside the starting folder (${formatDirectoryList([...allWorkingDirectories(context)])}).`
}


function checkDangerousRemoval(command: PathCommand, args: string[], cwd: string): PermissionResult {
  const operands = PATH_EXTRACTORS[command](args)
  for (const raw of operands) {
    let operand = raw
    if (/^['"]/.test(operand)) operand = operand.slice(1)
    if (/['"]$/.test(operand)) operand = operand.slice(0, -1)
    operand = expandTilde(operand)
    if (getPlatform() === 'windows' && /^\/[a-z](?:\/|$)/i.test(operand)) operand = posixPathToWindowsPath(operand + (operand.length === 2 ? '/' : ''))
    const resolved = operand.startsWith('/') || (getPlatform() === 'windows' && /^[a-z]:[/\\]/i.test(operand)) ? operand : getPlatform() === 'windows' ? win32Path.resolve(cwd, operand) : joinNoSymlink(cwd, operand)
    if (isDangerousRemovalPath(resolved)) {
      return {
        behavior: 'ask',
        message: `The ${command} of ${resolved} would remove a critical system directory. This needs explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: { type: 'other', reason: `${command} of a critical path: ${resolved}` },
        suggestions: [],
      }
    }
  }
  return { behavior: 'passthrough', message: 'No dangerous removal.' }
}

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
  }
  if (operationType === 'write' || operationType === 'create') {
    const editRule = createEditRuleSuggestion(containingDir, 'localSettings')
    if (editRule) suggestions.push(editRule)
  }
  return { ...result, suggestions }
}

export function checkShellCwd(input: { cwd?: string }, context: ToolPermissionContext): PermissionResult | null {
  if (input.cwd === undefined) return null
  const result = createPathChecker('cd')([`"${resolveShellCwd(input.cwd)}"`], getShellCwd(), context)
  return result.behavior === 'passthrough' ? null : result
}


export function checkPathConstraints(
  input: { command: string },
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd = false,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  const command = input.command

  if (astCommands === undefined) {
    const parsed = preparedSecurityParse(command)
    if (parsed.kind !== 'simple') {
      const message = parsed.kind === 'too-complex' ? `${parsed.reason}; spell out the paths, or approve` : 'the shell parser has not produced paths to check; retry the command, or approve'
      return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: false } }
    }
    astCommands = parsed.commands
  }
  astRedirects ??= astCommands.flatMap(simple => simple.redirects)
  const redirectionTargets = convertAstRedirects(astRedirects)

  const redirectResult = validateRedirections(redirectionTargets, cwd, context, compoundCommandHasCd)
  if (redirectResult.behavior !== 'passthrough') return redirectResult

  const inputTargets = convertAstInputRedirects(astRedirects)
  const inputResult = validateInputRedirections(inputTargets, cwd, context, compoundCommandHasCd)
  if (inputResult.behavior !== 'passthrough') return inputResult

  for (const simple of astCommands) {
    const result = validateAstSimpleCommand(simple, cwd, context, compoundCommandHasCd)
    if (result.behavior !== 'passthrough') return result
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
      if (!/^\d+$/.test(redirect.target)) targets.push(redirect.target)
    }
  }
  return targets
}

function convertAstInputRedirects(redirects: Redirect[]): string[] {
  const targets: string[] = []
  for (const redirect of redirects) {
    if (redirect.op === '<') targets.push(redirect.target)
  }
  return targets
}

function validateInputRedirections(
  targets: string[],
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  if (targets.length === 0) return { behavior: 'passthrough', message: 'No input redirections.' }
  if (compoundCommandHasCd) {
    return {
      behavior: 'ask',
      message: 'This command changes directory and also reads through an input redirect, so the file it reads cannot be determined safely. It needs explicit approval.',
      decisionReason: { type: 'other', reason: 'A directory change makes an input redirect target unresolvable' },
    }
  }
  for (const target of targets) {
    if (target === '/dev/null') continue
    const check = validatePath(target, cwd, context, 'read')
    if (!check.allowed) {
      if (check.decisionReason?.type === 'rule') {
        return ruleDeny(`The input redirect from ${check.resolvedPath}`, check.resolvedPath, 'read', context, check.decisionReason.rule)
      }
      const message =
        check.decisionReason && (check.decisionReason.type === 'other' || check.decisionReason.type === 'safetyCheck')
          ? check.decisionReason.reason
          : `Mercury needs permission to read ${check.resolvedPath}, outside the starting folder (${formatDirectoryList([...allWorkingDirectories(context)])}).`
      return {
        behavior: 'ask',
        message,
        blockedPath: check.resolvedPath,
        decisionReason: check.decisionReason,
        suggestions: [createReadRuleSuggestion(getDirectoryForPath(check.resolvedPath))].filter((rule): rule is PermissionUpdate => rule !== undefined),
      }
    }
    const envAsk = envFileReadAsk(check.resolvedPath, context)
    if (envAsk) return { behavior: 'ask', message: envAsk.message, decisionReason: envAsk.decisionReason }
  }
  return { behavior: 'passthrough', message: 'All input redirect targets are readable.' }
}

function sourcedEnvFile(argv: string[], cwd: string, context: ToolPermissionContext): PermissionResult | null {
  const [base, file] = argv
  if ((base !== 'source' && base !== '.') || file === undefined || !isProjectEnvFileName(file)) return null
  const check = validatePath(file, cwd, context, 'read')
  if (check.allowed) return envFileReadAsk(check.resolvedPath, context)
  if (check.decisionReason?.type === 'rule') {
    return ruleDeny(`The ${base} of ${check.resolvedPath}`, check.resolvedPath, 'read', context, check.decisionReason.rule)
  }
  const reason = check.decisionReason
  const message = reason && (reason.type === 'other' || reason.type === 'safetyCheck')
    ? reason.reason
    : `Mercury needs permission to read ${check.resolvedPath}, outside the starting folder (${formatDirectoryList([...allWorkingDirectories(context)])}).`
  return { behavior: 'ask', message, decisionReason: reason }
}

function composeWriteRefusal(context: ToolPermissionContext, resolvedPath: string, action: string): string {
  if (pathInAllowedWorkingPath(resolvedPath, context)) {
    return (
      `Mercury needs approval to ${action} ${resolvedPath}: this permission mode does not ${action} files on its own ` +
      `and no allow rule covers it. Approve it on its permission card, add an allow rule, or start in a mode that allows writes.`
    )
  }
  return `Mercury needs approval to ${action} ${resolvedPath}, outside the starting folder (${formatDirectoryList([...allWorkingDirectories(context)])}). Approve it on its permission card or add an allow rule.`
}

function validateRedirections(
  targets: string[],
  cwd: string,
  context: ToolPermissionContext,
  compoundCommandHasCd: boolean,
): PermissionResult {
  if (targets.length === 0) return { behavior: 'passthrough', message: 'No redirections.' }
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
        return ruleDeny(`The redirection to ${check.resolvedPath}`, check.resolvedPath, 'edit', context, check.decisionReason.rule)
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
        suggestions: [createEditRuleSuggestion(getDirectoryForPath(check.resolvedPath), 'localSettings')].filter((rule): rule is PermissionUpdate => rule !== undefined),
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
  const sourced = sourcedEnvFile(argv, cwd, context)
  if (sourced) return sourced
  if (!(base in COMMAND_OPERATION_TYPE)) return { behavior: 'passthrough', message: 'Not a path command.' }
  const command = base as PathCommand
  const override = sedReadOverride(command, simple.text)
  return createPathChecker(command, override)(argv.slice(1), cwd, context, compoundCommandHasCd)
}

function sedReadOverride(command: PathCommand, sourceText: string): FileOperationType | undefined {
  if (command !== 'sed') return undefined
  const stripped = stripSafeWrappers(sourceText)
  return sedCommandIsAllowedByAllowlist(stripped) ? 'read' : undefined
}

import { sedCommandIsAllowedByAllowlist } from '../../tools/BashTool/sedValidation.js'
import { binaryName } from '../config/derived.js'

export type FlagValue = 'none' | 'number' | 'string' | 'char' | '{}' | 'EOF'

export type ReadOnlyRule = {
  readonly words: readonly string[]
  readonly flags?: Readonly<Record<string, FlagValue>>
  readonly readsOnly?: (operands: readonly string[], text: string) => boolean
  readonly form?: (text: string) => boolean
  readonly whole?: RegExp
  readonly dashDashIsAnOperand?: true
  readonly countShorthand?: true
  readonly attachedNumbers?: true
  readonly descendingSort?: true
  readonly noNewline?: true
  readonly targets?: readonly string[]
  readonly unixOnly?: true
  readonly unlisted?: true
}

export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagValue>
  regex?: RegExp
  additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean
  respectsDoubleDash?: boolean
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
const patchFlags: Flags = { '--patch': none, '-p': none, '--no-patch': none, '--no-ext-diff': none, '-s': none }
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
  return { words: [word], form: text => forms.includes(text) }
}

function probe(word: string, ...forms: string[]): ReadOnlyRule {
  return { ...exactly(word, ...forms), unlisted: true }
}

function matching(word: string, pattern: RegExp): ReadOnlyRule {
  return { words: [word], form: text => pattern.test(text) }
}

const FD_FLAGS: Flags = { '-H': none, '--hidden': none, '-I': none, '--no-ignore': none, '-t': str, '--type': str, '-e': str, '--extension': str, '-d': num, '--max-depth': num, '-p': none, '--full-path': none, '-g': none, '--glob': none, '-a': none, '--absolute-path': none, '-c': str, '--color': str, '-s': none, '--case-sensitive': none, '-i': none, '--ignore-case': none, '-0': none, '--print0': none }
const CHECKSUM_FLAGS: Flags = { '-b': none, '-c': none, '-t': none, '--tag': none }

export const READ_ONLY_RULES: readonly ReadOnlyRule[] = [
  walked('xargs', { '-I': char, '-E': 'EOF', '-n': num, '-P': num, '-0': none, '--null': none, '-a': str, '--arg-file': str, '-d': str, '--delimiter': str, '-L': num, '-p': none, '--interactive': none, '-r': none, '--no-run-if-empty': none, '-t': none, '--verbose': none }, { targets: ['echo', 'printf', 'wc', 'grep', 'head', 'tail'], unixOnly: true }),
  git('diff', flags(statFlags, colourFlags, {
    '--dirstat': none, '--summary': none, '--patch-with-stat': none, '--word-diff': none, '--word-diff-regex': str, '--color-words': none, '--no-renames': none, '--no-ext-diff': none,
    '--check': none, '--ws-error-highlight': str, '--full-index': none, '--binary': none, '--abbrev': num, '--break-rewrites': none, '--find-renames': none, '--find-copies': none,
    '--find-copies-harder': none, '--irreversible-delete': none, '--diff-algorithm': str, '--histogram': none, '--patience': none, '--minimal': none, '--ignore-space-at-eol': none,
    '--ignore-space-change': none, '--ignore-all-space': none, '--ignore-blank-lines': none, '--inter-hunk-context': num, '--function-context': none, '--exit-code': none, '--quiet': none,
    '--cached': none, '--staged': none, '--pickaxe-regex': none, '--pickaxe-all': none, '--no-index': none, '--relative': str, '--diff-filter': str,
    '-p': none, '-u': none, '-s': none, '-M': none, '-C': none, '-B': none, '-D': none, '-l': none, '-R': none, '-S': str, '-G': str, '-O': str,
  })),
  git('log', flags(logDisplayFlags, refSelectionFlags, dateFilterFlags, countFlags, statFlags, colourFlags, patchFlags, authorFilterFlags, {
    '--abbrev-commit': none, '--full-history': none, '--dense': none, '--sparse': none, '--simplify-merges': none, '--ancestry-path': none, '--source': none, '--first-parent': none,
    '--merges': none, '--no-merges': none, '--reverse': none, '--walk-reflogs': none, '--skip': num, '--max-age': num, '--min-age': num, '--no-min-parents': none,
    '--no-max-parents': none, '--follow': none, '--no-walk': none, '--left-right': none, '--cherry-mark': none, '--cherry-pick': none, '--boundary': none, '--topo-order': none,
    '--date-order': none, '--author-date-order': none, '--pretty': str, '--format': str, '--diff-filter': str, '-S': str, '-G': str, '--pickaxe-regex': none, '--pickaxe-all': none,
  })),
  git('show', flags(logDisplayFlags, statFlags, colourFlags, patchFlags, {
    '--abbrev-commit': none, '--word-diff': none, '--word-diff-regex': str, '--color-words': none, '--pretty': str, '--format': str, '--first-parent': none, '--raw': none,
    '--diff-filter': str, '-m': none, '--quiet': none,
  })),
  git('shortlog', flags(refSelectionFlags, dateFilterFlags, {
    '-s': none, '--summary': none, '-n': none, '--numbered': none, '-e': none, '--email': none, '-c': none, '--committer': none, '--group': str, '--format': str, '--no-merges': none, '--author': str,
  })),
  git('reflog', flags(logDisplayFlags, refSelectionFlags, dateFilterFlags, countFlags, authorFilterFlags), { readsOnly: reflogOperandsRead }),
  git('stash list', flags(logDisplayFlags, refSelectionFlags, countFlags)),
  git('ls-remote', {
    '--branches': none, '-b': none, '--tags': none, '-t': none, '--heads': none, '-h': none, '--refs': none, '--quiet': none, '-q': none, '--exit-code': none, '--get-url': none, '--symref': none, '--sort': str,
  }, { readsOnly: lsRemoteOperandsRead }),
  git('status', {
    '--short': none, '-s': none, '--branch': none, '-b': none, '--porcelain': none, '--long': none, '--verbose': none, '-v': none, '--untracked-files': str, '-u': str,
    '--ignored': none, '--ignore-submodules': str, '--column': none, '--no-column': none, '--ahead-behind': none, '--no-ahead-behind': none, '--renames': none, '--no-renames': none,
    '--find-renames': str, '-M': str,
  }),
  git('blame', flags(colourFlags, {
    '-L': str, '--porcelain': none, '-p': none, '--line-porcelain': none, '--incremental': none, '--root': none, '--show-stats': none, '--show-name': none, '--show-number': none, '-n': none,
    '--show-email': none, '-e': none, '-f': none, '--date': str, '-w': none, '--ignore-rev': str, '--ignore-revs-file': str, '-M': none, '-C': none, '--score-debug': none, '--abbrev': num,
    '-s': none, '-l': none, '-t': none,
  })),
  git('ls-files', {
    '--cached': none, '-c': none, '--deleted': none, '-d': none, '--modified': none, '-m': none, '--others': none, '-o': none, '--ignored': none, '-i': none, '--stage': none, '-s': none,
    '--killed': none, '-k': none, '--unmerged': none, '-u': none, '--directory': none, '--no-empty-directory': none, '--eol': none, '--full-name': none, '--abbrev': num,
    '--debug': none, '-z': none, '-t': none, '-v': none, '-f': none, '--exclude': str, '-x': str, '--exclude-from': str, '-X': str, '--exclude-per-directory': str,
    '--exclude-standard': none, '--error-unmatch': none, '--recurse-submodules': none,
  }),
  git('config --get', {
    '--local': none, '--global': none, '--system': none, '--worktree': none, '--default': str, '--type': str, '--bool': none, '--int': none, '--bool-or-int': none, '--path': none,
    '--expiry-date': none, '-z': none, '--null': none, '--name-only': none, '--show-origin': none, '--show-scope': none,
  }),
  git('remote show', { '-n': none }, { readsOnly: remoteShowOperandsRead }),
  git('remote', { '-v': none, '--verbose': none }, { readsOnly: remoteOperandsRead }),
  git('merge-base', { '--is-ancestor': none, '--fork-point': none, '--octopus': none, '--independent': none, '--all': none }),
  git('rev-parse', {
    '--verify': none, '--short': str, '--abbrev-ref': none, '--symbolic': none, '--symbolic-full-name': none, '--show-toplevel': none, '--show-cdup': none, '--show-prefix': none,
    '--git-dir': none, '--git-common-dir': none, '--absolute-git-dir': none, '--show-superproject-working-tree': none, '--is-inside-work-tree': none, '--is-inside-git-dir': none,
    '--is-bare-repository': none, '--is-shallow-repository': none, '--is-shallow-update': none, '--path-prefix': none,
  }),
  git('rev-list', flags(refSelectionFlags, dateFilterFlags, countFlags, authorFilterFlags, {
    '--count': none, '--reverse': none, '--first-parent': none, '--ancestry-path': none, '--merges': none, '--no-merges': none, '--min-parents': num, '--max-parents': num,
    '--no-min-parents': none, '--no-max-parents': none, '--skip': num, '--max-age': num, '--min-age': num, '--walk-reflogs': none, '--oneline': none, '--abbrev-commit': none,
    '--pretty': str, '--format': str, '--abbrev': num, '--full-history': none, '--dense': none, '--sparse': none, '--source': none, '--graph': none,
  })),
  git('describe', {
    '--tags': none, '--match': str, '--exclude': str, '--long': none, '--abbrev': num, '--always': none, '--contains': none, '--first-match': none, '--exact-match': none,
    '--candidates': num, '--dirty': none, '--broken': none,
  }),
  git('cat-file', { '-t': none, '-s': none, '-p': none, '-e': none, '--batch-check': none, '--allow-undetermined-type': none }),
  git('for-each-ref', { '--format': str, '--sort': str, '--count': num, '--contains': str, '--no-contains': str, '--merged': str, '--no-merged': str, '--points-at': str }),
  git('grep', {
    '-e': str, '-E': none, '--extended-regexp': none, '-G': none, '--basic-regexp': none, '-F': none, '--fixed-strings': none, '-P': none, '--perl-regexp': none, '-i': none,
    '--ignore-case': none, '-v': none, '--invert-match': none, '-w': none, '--word-regexp': none, '-n': none, '--line-number': none, '-c': none, '--count': none, '-l': none,
    '--files-with-matches': none, '-L': none, '--files-without-match': none, '-h': none, '-H': none, '--heading': none, '--break': none, '--full-name': none, '--color': none, '--no-color': none,
    '-o': none, '--only-matching': none, '-A': num, '--after-context': num, '-B': num, '--before-context': num, '-C': num, '--context': num, '--and': none, '--or': none,
    '--not': none, '--max-depth': num, '--untracked': none, '--no-index': none, '--recurse-submodules': none, '--cached': none, '--threads': num, '-q': none, '--quiet': none,
  }),
  git('stash show', flags(statFlags, colourFlags, patchFlags, { '--word-diff': none, '--word-diff-regex': str, '--diff-filter': str, '--abbrev': num })),
  git('worktree list', { '--porcelain': none, '-v': none, '--verbose': none, '--expire': str }),
  git('tag', {
    '-l': none, '--list': none, '-n': num, '--contains': str, '--no-contains': str, '--merged': str, '--no-merged': str, '--sort': str, '--format': str, '--points-at': str,
    '--column': none, '--no-column': none, '-i': none, '--ignore-case': none,
  }, { readsOnly: tagOperandsRead }),
  git('branch', {
    '-l': none, '--list': none, '-a': none, '--all': none, '-r': none, '--remotes': none, '-v': none, '-vv': none, '--verbose': none, '--color': none, '--no-color': none,
    '--column': none, '--no-column': none, '--abbrev': num, '--no-abbrev': none, '--contains': str, '--no-contains': str, '--merged': none, '--no-merged': none,
    '--points-at': str, '--sort': str, '--show-current': none, '-i': none, '--ignore-case': none,
  }, { readsOnly: branchOperandsRead }),
  walked('file', { '-b': none, '--brief': none, '-i': none, '--mime': none, '--mime-type': none, '--mime-encoding': none, '-L': none, '--dereference': none, '-z': none, '--uncompress': none, '-s': none, '--special-files': none }),
  walked('sed', {
    '-e': str, '--expression': str, '-n': none, '--quiet': none, '--silent': none, '-r': none, '-E': none, '--regexp-extended': none, '--posix': none, '-l': num, '--line-length': num,
    '-z': none, '--zero-terminated': none, '-s': none, '--separate': none, '-u': none, '--unbuffered': none, '--debug': none, '--help': none, '--version': none,
  }, { readsOnly: (_operands, text) => sedCommandIsAllowedByAllowlist(text) }),
  walked('sort', { '-b': none, '-d': none, '-f': none, '-g': none, '-i': none, '-M': none, '-h': none, '-n': none, '-r': none, '-R': none, '-u': none, '-c': none, '-C': none, '-k': str, '--key': str, '-t': str, '--field-separator': str, '-z': none }),
  walked('man', { '-a': none, '--all': none, '-f': none, '--whatis': none, '-k': none, '--apropos': none, '-w': none, '--where': none }),
  walked('help', { '-d': none, '-m': none, '-s': none }),
  walked('netstat', { '-a': none, '-n': none, '-r': none, '-l': none, '-t': none, '-u': none, '-p': none, '-i': none, '-s': none }),
  walked('ps', { '-e': none, '-f': none, '-l': none, '-u': str, '-p': str, '-o': str, '-a': none, '-x': none, '-A': none, '--sort': str, '-C': str }, { readsOnly: psOperandsRead }),
  walked('base64', { '-d': none, '--decode': none, '-w': num, '--wrap': num, '-i': none, '--ignore-garbage': none }, { dashDashIsAnOperand: true }),
  walked('grep', {
    '-i': none, '-v': none, '-n': none, '-c': none, '-l': none, '-L': none, '-o': none, '-r': none, '-R': none, '-E': none, '-F': none, '-w': none, '-x': none, '-A': num, '-B': num, '-C': num,
    '-e': str, '-f': str, '--include': str, '--exclude': str, '--exclude-dir': str, '--include-dir': str, '--color': str, '-H': none, '-h': none, '--line-buffered': none,
  }, { attachedNumbers: true, noNewline: true }),
  walked('sha256sum', CHECKSUM_FLAGS),
  walked('sha1sum', CHECKSUM_FLAGS),
  walked('md5sum', CHECKSUM_FLAGS),
  walked('tree', { '-a': none, '-d': none, '-f': none, '-i': none, '-l': none, '-L': num, '-P': str, '-I': str, '-C': none, '-n': none, '-p': none, '-s': none, '-h': none, '-D': none, '-t': none, '-r': none, '--dirsfirst': none, '-J': none }),
  walked('date', { '-u': none, '--utc': none, '-R': none, '--rfc-email': none, '-I': str, '--iso-8601': str, '-d': str, '--date': str, '-r': str, '--reference': str, '--rfc-3339': str }, { readsOnly: dateOperandsRead }),
  walked('hostname', { '-s': none, '--short': none, '-d': none, '--domain': none, '-f': none, '--fqdn': none, '-i': none, '-I': none, '-A': none }, { whole: /^hostname(?:\s+-[A-Za-z])*\s*$/ }),
  walked('info', { '-f': str, '--file': str, '-n': str, '--node': str, '-w': none, '--where': none, '--subnodes': none, '-a': none }),
  walked('lsof', { '-i': str, '-n': none, '-P': none, '-p': str, '-u': str, '-c': str, '-t': none, '-a': none, '-l': none, '-R': none, '-F': str }, { readsOnly: lsofOperandsRead }),
  walked('pgrep', { '-l': none, '-a': none, '-f': none, '-n': none, '-o': none, '-u': str, '-x': none, '-c': none, '-d': str }),
  walked('tput', { '-T': str }, { readsOnly: tputOperandsRead }),
  walked('ss', { '-a': none, '-l': none, '-n': none, '-p': none, '-t': none, '-u': none, '-x': none, '-s': none, '-r': none, '-i': none, '-e': none, '-m': none, '-o': none }),
  walked('fd', FD_FLAGS),
  walked('fdfind', FD_FLAGS),
  walked('pyright', {
    '--outputjson': none, '--project': str, '-p': str, '--pythonversion': str, '--pythonplatform': str, '--typeshedpath': str, '--venvpath': str, '--level': str,
    '--stats': none, '--verbose': none, '--version': none, '--dependencies': none, '--warnings': none,
  }, { dashDashIsAnOperand: true, readsOnly: pyrightOperandsRead }),
  walked('docker ps', { '-a': none, '--all': none, '-q': none, '--quiet': none, '-s': none, '--size': none, '-l': none, '--latest': none, '-n': num, '--last': num, '--no-trunc': none, '--format': str, '-f': str, '--filter': str }),
  walked('docker images', { '-a': none, '--all': none, '-q': none, '--quiet': none, '--digests': none, '--no-trunc': none, '--format': str, '-f': str, '--filter': str, '--tree': none }),
  walked('docker logs', { '--follow': none, '-f': none, '--tail': str, '-n': str, '--timestamps': none, '-t': none, '--since': str, '--until': str, '--details': none }),
  walked('docker inspect', { '--format': str, '-f': str, '--type': str, '--size': none, '-s': none }),
  ...['cal', 'uptime', 'cat', 'head', 'tail', 'wc', 'stat', 'strings', 'hexdump', 'od', 'nl', 'id', 'uname', 'free', 'df', 'du', 'locale', 'groups', 'nproc',
    'basename', 'dirname', 'realpath', 'cut', 'paste', 'tr', 'column', 'tac', 'rev', 'fold', 'expand', 'unexpand', 'fmt', 'comm', 'cmp', 'numfmt', 'readlink', 'diff',
    'true', 'false', 'sleep', 'which', 'type', 'expr', 'test', 'getconf', 'seq', 'tsort', 'pr'].map(plain),
  exactly(binaryName(), `${binaryName()} -h`, `${binaryName()} --help`),
  probe('node', 'node -v', 'node --version'),
  probe('python', 'python --version'),
  probe('python3', 'python3 --version'),
  exactly('pwd', 'pwd'),
  exactly('whoami', 'whoami'),
  exactly('alias', 'alias'),
  matching('arch', /^arch(?:\s+(?:-h|--help))?$/),
  exactly('ip', 'ip addr'),
  matching('ifconfig', /^ifconfig(?:\s+[A-Za-z][A-Za-z0-9_-]*)?$/),
  matching('history', /^history(?:\s+\d+)?$/),
  matching('uniq', /^uniq(?:\s+(?:-[A-Za-z]+|--[a-z-]+(?:=\S+)?|-[fsw]\d+))*\s*(?:2>&1)?$/),
  { words: ['echo'], form: echoForm },
  { words: ['jq'], form: jqForm },
  matching('cd', /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/),
  { words: ['ls'], form: lsForm },
  { words: ['find'], form: findForm },
]

const WALKED_RULES = new Map<string, ReadOnlyRule>(READ_ONLY_RULES.filter(rule => rule.flags !== undefined).map(rule => [rule.words.join(' '), rule]))
const FORM_RULES = new Map<string, ReadOnlyRule>(READ_ONLY_RULES.filter(rule => rule.form !== undefined).map(rule => [rule.words[0] as string, rule]))
const LONGEST_RULE = Math.max(...READ_ONLY_RULES.map(rule => rule.words.length))

export function walkedRuleFor(tokens: readonly string[]): ReadOnlyRule | undefined {
  for (let length = Math.min(LONGEST_RULE, tokens.length); length >= 1; length--) {
    const rule = WALKED_RULES.get(tokens.slice(0, length).join(' '))
    if (rule !== undefined) return rule
  }
  return undefined
}

export function formRuleFor(word: string): ReadOnlyRule | undefined {
  return FORM_RULES.get(word)
}

export const LISTED_WORDS: ReadonlySet<string> = new Set(READ_ONLY_RULES.filter(rule => !rule.unlisted).map(rule => rule.words[0] as string))

function valueFits(value: string, shape: FlagValue): boolean {
  switch (shape) {
    case 'number':
      return /^\d+$/.test(value)
    case 'string':
      return true
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
    case 'none':
      return false
  }
}

function isFlag(token: string): boolean {
  return token.length > 1 && token[0] === '-' && /[A-Za-z0-9_-]/.test(token[1] as string)
}

export function walkFlags(tokens: readonly string[], startIndex: number, rule: ReadOnlyRule): boolean {
  const table = rule.flags ?? {}
  let i = startIndex
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (token === '') {
      i++
      continue
    }
    if (rule.targets !== undefined && (!isFlag(token) || token === '--')) {
      const target = token === '--' && tokens[i + 1] !== undefined ? (tokens[i + 1] as string) : token
      return rule.targets.includes(target)
    }
    if (token === '--') {
      if (rule.dashDashIsAnOperand) {
        i++
        continue
      }
      return true
    }
    if (!isFlag(token)) {
      i++
      continue
    }
    const equals = token.indexOf('=')
    const name = equals === -1 ? token : token.slice(0, equals)
    const shape = table[name]
    if (shape === undefined) {
      if (rule.countShorthand && /^-\d+$/.test(token)) {
        i++
        continue
      }
      const short = token.startsWith('-') && !token.startsWith('--') && token.length > 2
      if (rule.attachedNumbers && short) {
        const letterShape = table[token.slice(0, 2)]
        const tail = token.slice(2)
        if (letterShape !== undefined && /^\d+$/.test(tail) && (letterShape === 'number' || letterShape === 'string')) {
          if (!valueFits(tail, letterShape)) return false
          i++
          continue
        }
      }
      if (short) {
        const letters = (equals === -1 ? token : name).slice(1)
        if ([...letters].every(letter => table[`-${letter}`] === 'none')) {
          i++
          continue
        }
      }
      return false
    }
    if (shape === 'none') {
      if (equals !== -1) return false
      i++
      continue
    }
    const descending = (candidate: string): boolean => rule.descendingSort === true && name === '--sort' && /^-[A-Za-z]/.test(candidate)
    let value: string
    if (equals !== -1) {
      value = token.slice(equals + 1)
      i++
    } else {
      const next = tokens[i + 1]
      if (next === undefined || (isFlag(next) && !descending(next))) return false
      value = next
      i += 2
    }
    if (shape === 'string' && value.startsWith('-') && !descending(value)) return false
    if (!valueFits(value, shape)) return false
  }
  return true
}

function asConfig(rule: ReadOnlyRule): ExternalCommandConfig {
  const config: ExternalCommandConfig = { safeFlags: { ...(rule.flags ?? {}) } }
  if (rule.whole !== undefined) config.regex = rule.whole
  if (rule.dashDashIsAnOperand) config.respectsDoubleDash = false
  const readsOnly = rule.readsOnly
  if (readsOnly !== undefined) config.additionalCommandIsDangerousCallback = (text, operands) => !readsOnly(operands, text)
  return config
}

function configsOf(family: string): Record<string, ExternalCommandConfig> {
  return Object.fromEntries(READ_ONLY_RULES.filter(rule => rule.flags !== undefined && rule.words[0] === family).map(rule => [rule.words.join(' '), asConfig(rule)]))
}

export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = configsOf('git')
export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = configsOf('docker')

type ValidateOptions = { commandName?: string; rawCommand?: string; xargsTargetCommands?: string[] }

export function validateFlags(tokens: string[], startIndex: number, config: ExternalCommandConfig, options?: ValidateOptions): boolean {
  const name = options?.commandName
  const rule: ReadOnlyRule = {
    words: [],
    flags: config.safeFlags,
    ...(config.respectsDoubleDash === false ? { dashDashIsAnOperand: true as const } : {}),
    ...(name === 'git' ? { countShorthand: true as const, descendingSort: true as const } : {}),
    ...(name === 'grep' ? { attachedNumbers: true as const } : {}),
    ...(name === 'xargs' && options?.xargsTargetCommands !== undefined ? { targets: options.xargsTargetCommands } : {}),
  }
  return walkFlags(tokens, startIndex, rule)
}

/**
 * Cross-shell read-only command catalogues (git / gh / docker / ripgrep /
 * pyright), the generic flag-walking validator, and UNC-path danger
 * detection. Shared by both shell tools so the two agree.
 *
 * The validator NEVER invokes a config's dangerous-command callback and never
 * reads the raw-command option it accepts — both are carried purely for the
 * consuming tool slices, which call the callback themselves.
 */
import { getPlatform } from '../platform.js'

/** The argument type a safe flag accepts. Contract data. */
export type FlagArgType = 'none' | 'number' | 'string' | 'char' | '{}' | 'EOF'

/** One command key's read-only configuration. */
export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>
  /** An optional regex for additional validation beyond flag parsing. */
  regex?: RegExp
  /** Consumer-invoked only (never called by the validator). */
  additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean
  /** When false, the tool does NOT respect the POSIX `--` marker (default true). */
  respectsDoubleDash?: boolean
}

/** The "is this token a flag" shape. */
export const FLAG_PATTERN = /^-[A-Za-z0-9_-]/

/** Validate a value against its declared type. */
export function validateFlagArgument(value: string, argType: FlagArgType): boolean {
  switch (argType) {
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
      return false // a no-argument flag never has a value validated
    default:
      return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared flag groups (git)
// ─────────────────────────────────────────────────────────────────────────────

const statFlags: Record<string, FlagArgType> = {
  '--stat': 'none', '--numstat': 'none', '--shortstat': 'none',
  '--name-only': 'none', '--name-status': 'none',
}
const colourFlags: Record<string, FlagArgType> = { '--color': 'none', '--no-color': 'none' }
const patchFlags: Record<string, FlagArgType> = {
  '--patch': 'none', '-p': 'none', '--no-patch': 'none', '--no-ext-diff': 'none', '-s': 'none',
}
const logDisplayFlags: Record<string, FlagArgType> = {
  '--oneline': 'none', '--graph': 'none', '--decorate': 'none', '--no-decorate': 'none',
  '--date': 'string', '--relative-date': 'none',
}
const refSelectionFlags: Record<string, FlagArgType> = {
  '--all': 'none', '--branches': 'none', '--tags': 'none', '--remotes': 'none',
}
const dateFilterFlags: Record<string, FlagArgType> = {
  '--since': 'string', '--after': 'string', '--until': 'string', '--before': 'string',
}
const countFlags: Record<string, FlagArgType> = { '--max-count': 'number', '-n': 'number' }
const authorFilterFlags: Record<string, FlagArgType> = {
  '--author': 'string', '--committer': 'string', '--grep': 'string',
}

function g(...groups: Record<string, FlagArgType>[]): Record<string, FlagArgType> {
  return Object.assign({}, ...groups)
}

// ─────────────────────────────────────────────────────────────────────────────
// git creation callbacks (tag / branch)
// ─────────────────────────────────────────────────────────────────────────────

const TAG_ARG_TAKING = new Set([
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '-n',
])
const BRANCH_ARG_TAKING = new Set(['--contains', '--no-contains', '--points-at', '--sort'])
const BRANCH_OPTIONAL_FILTER = new Set(['--merged', '--no-merged'])

function isListBundle(token: string, listLetter: string): boolean {
  // A single-dash token > 2 chars, no `=`, whose letters include the list letter.
  return (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    token.length > 2 &&
    !token.includes('=') &&
    token.slice(1).includes(listLetter)
  )
}

function tagCreationDangerous(_raw: string, tokens: string[]): boolean {
  let sawList = false
  let positionalOnly = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === '') continue
    if (!positionalOnly && token === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && token.startsWith('-')) {
      if (token === '-l' || token === '--list' || isListBundle(token, 'l')) sawList = true
      const flagHalf = token.split('=')[0] as string
      if (token.includes('=')) continue // advance one
      if (TAG_ARG_TAKING.has(flagHalf)) i++ // advance two
      continue
    }
    // positional token (or anything after the marker)
    if (!sawList) return true
  }
  return false
}

function branchCreationDangerous(_raw: string, tokens: string[]): boolean {
  let sawList = false
  let positionalOnly = false
  let lastFlag: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    if (token === '') continue
    if (!positionalOnly && token === '--') {
      positionalOnly = true
      lastFlag = undefined
      continue
    }
    if (!positionalOnly && token.startsWith('-')) {
      if (token === '-l' || token === '--list' || isListBundle(token, 'l')) sawList = true
      const flagHalf = token.split('=')[0] as string
      lastFlag = flagHalf
      if (token.includes('=')) continue
      if (BRANCH_ARG_TAKING.has(flagHalf)) i++
      continue
    }
    // positional
    if (!sawList && !(lastFlag !== undefined && BRANCH_OPTIONAL_FILTER.has(lastFlag))) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// git table
// ─────────────────────────────────────────────────────────────────────────────

/** git read-only command configs. Contract data. */
export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'git diff': {
    safeFlags: g(statFlags, colourFlags, {
      '--dirstat': 'none', '--summary': 'none', '--patch-with-stat': 'none', '--word-diff': 'none',
      '--word-diff-regex': 'string', '--color-words': 'none', '--no-renames': 'none', '--no-ext-diff': 'none',
      '--check': 'none', '--ws-error-highlight': 'string', '--full-index': 'none', '--binary': 'none',
      '--abbrev': 'number', '--break-rewrites': 'none', '--find-renames': 'none', '--find-copies': 'none',
      '--find-copies-harder': 'none', '--irreversible-delete': 'none', '--diff-algorithm': 'string',
      '--histogram': 'none', '--patience': 'none', '--minimal': 'none', '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none', '--ignore-all-space': 'none', '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number', '--function-context': 'none', '--exit-code': 'none', '--quiet': 'none',
      '--cached': 'none', '--staged': 'none', '--pickaxe-regex': 'none', '--pickaxe-all': 'none',
      '--no-index': 'none', '--relative': 'string', '--diff-filter': 'string',
      '-p': 'none', '-u': 'none', '-s': 'none', '-M': 'none', '-C': 'none', '-B': 'none', '-D': 'none',
      '-l': 'none', '-R': 'none',
      '-S': 'string', '-G': 'string', '-O': 'string',
    }),
  },
  'git log': {
    safeFlags: g(logDisplayFlags, refSelectionFlags, dateFilterFlags, countFlags, statFlags, colourFlags, patchFlags, authorFilterFlags, {
      '--abbrev-commit': 'none', '--full-history': 'none', '--dense': 'none', '--sparse': 'none',
      '--simplify-merges': 'none', '--ancestry-path': 'none', '--source': 'none', '--first-parent': 'none',
      '--merges': 'none', '--no-merges': 'none', '--reverse': 'none', '--walk-reflogs': 'none',
      '--skip': 'number', '--max-age': 'number', '--min-age': 'number', '--no-min-parents': 'none',
      '--no-max-parents': 'none', '--follow': 'none', '--no-walk': 'none', '--left-right': 'none',
      '--cherry-mark': 'none', '--cherry-pick': 'none', '--boundary': 'none', '--topo-order': 'none',
      '--date-order': 'none', '--author-date-order': 'none', '--pretty': 'string', '--format': 'string',
      '--diff-filter': 'string', '-S': 'string', '-G': 'string', '--pickaxe-regex': 'none', '--pickaxe-all': 'none',
    }),
  },
  'git show': {
    safeFlags: g(logDisplayFlags, statFlags, colourFlags, patchFlags, {
      '--abbrev-commit': 'none', '--word-diff': 'none', '--word-diff-regex': 'string', '--color-words': 'none',
      '--pretty': 'string', '--format': 'string', '--first-parent': 'none', '--raw': 'none',
      '--diff-filter': 'string', '-m': 'none', '--quiet': 'none',
    }),
  },
  'git shortlog': {
    safeFlags: g(refSelectionFlags, dateFilterFlags, {
      '-s': 'none', '--summary': 'none', '-n': 'none', '--numbered': 'none', '-e': 'none', '--email': 'none',
      '-c': 'none', '--committer': 'none', '--group': 'string', '--format': 'string', '--no-merges': 'none',
      '--author': 'string',
    }),
  },
  'git reflog': {
    safeFlags: g(logDisplayFlags, refSelectionFlags, dateFilterFlags, countFlags, authorFilterFlags),
    additionalCommandIsDangerousCallback: (_raw, tokens) => {
      for (const token of tokens) {
        if (token === '') continue
        if (token.startsWith('-')) continue
        return token === 'expire' || token === 'delete' || token === 'exists'
      }
      return false
    },
  },
  'git stash list': { safeFlags: g(logDisplayFlags, refSelectionFlags, countFlags) },
  'git ls-remote': {
    safeFlags: {
      '--branches': 'none', '-b': 'none', '--tags': 'none', '-t': 'none', '--heads': 'none', '-h': 'none',
      '--refs': 'none', '--quiet': 'none', '-q': 'none', '--exit-code': 'none', '--get-url': 'none',
      '--symref': 'none', '--sort': 'string',
    },
  },
  'git status': {
    safeFlags: {
      '--short': 'none', '-s': 'none', '--branch': 'none', '-b': 'none', '--porcelain': 'none',
      '--long': 'none', '--verbose': 'none', '-v': 'none', '--untracked-files': 'string', '-u': 'string',
      '--ignored': 'none', '--ignore-submodules': 'string', '--column': 'none', '--no-column': 'none',
      '--ahead-behind': 'none', '--no-ahead-behind': 'none', '--renames': 'none', '--no-renames': 'none',
      '--find-renames': 'string', '-M': 'string',
    },
  },
  'git blame': {
    safeFlags: g(colourFlags, {
      '-L': 'string', '--porcelain': 'none', '-p': 'none', '--line-porcelain': 'none', '--incremental': 'none',
      '--root': 'none', '--show-stats': 'none', '--show-name': 'none', '--show-number': 'none', '-n': 'none',
      '--show-email': 'none', '-e': 'none', '-f': 'none', '--date': 'string', '-w': 'none',
      '--ignore-rev': 'string', '--ignore-revs-file': 'string', '-M': 'none', '-C': 'none',
      '--score-debug': 'none', '--abbrev': 'number', '-s': 'none', '-l': 'none', '-t': 'none',
    }),
  },
  'git ls-files': {
    safeFlags: {
      '--cached': 'none', '-c': 'none', '--deleted': 'none', '-d': 'none', '--modified': 'none', '-m': 'none',
      '--others': 'none', '-o': 'none', '--ignored': 'none', '-i': 'none', '--stage': 'none', '-s': 'none',
      '--killed': 'none', '-k': 'none', '--unmerged': 'none', '-u': 'none', '--directory': 'none',
      '--no-empty-directory': 'none', '--eol': 'none', '--full-name': 'none', '--abbrev': 'number',
      '--debug': 'none', '-z': 'none', '-t': 'none', '-v': 'none', '-f': 'none', '--exclude': 'string',
      '-x': 'string', '--exclude-from': 'string', '-X': 'string', '--exclude-per-directory': 'string',
      '--exclude-standard': 'none', '--error-unmatch': 'none', '--recurse-submodules': 'none',
    },
  },
  'git config --get': {
    safeFlags: {
      '--local': 'none', '--global': 'none', '--system': 'none', '--worktree': 'none', '--default': 'string',
      '--type': 'string', '--bool': 'none', '--int': 'none', '--bool-or-int': 'none', '--path': 'none',
      '--expiry-date': 'none', '-z': 'none', '--null': 'none', '--name-only': 'none', '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },
  'git remote show': {
    safeFlags: { '-n': 'none' },
    additionalCommandIsDangerousCallback: (_raw, tokens) => {
      const rest = tokens.filter(t => t !== '' && t !== '-n')
      return !(rest.length === 1 && /^[A-Za-z0-9_-]+$/.test(rest[0] as string))
    },
  },
  'git remote': {
    safeFlags: { '-v': 'none', '--verbose': 'none' },
    additionalCommandIsDangerousCallback: (_raw, tokens) => tokens.some(t => t !== '' && t !== '-v' && t !== '--verbose'),
  },
  'git merge-base': {
    safeFlags: { '--is-ancestor': 'none', '--fork-point': 'none', '--octopus': 'none', '--independent': 'none', '--all': 'none' },
  },
  'git rev-parse': {
    safeFlags: {
      '--verify': 'none', '--short': 'string', '--abbrev-ref': 'none', '--symbolic': 'none',
      '--symbolic-full-name': 'none', '--show-toplevel': 'none', '--show-cdup': 'none', '--show-prefix': 'none',
      '--git-dir': 'none', '--git-common-dir': 'none', '--absolute-git-dir': 'none',
      '--show-superproject-working-tree': 'none', '--is-inside-work-tree': 'none', '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none', '--is-shallow-repository': 'none', '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },
  'git rev-list': {
    safeFlags: g(refSelectionFlags, dateFilterFlags, countFlags, authorFilterFlags, {
      '--count': 'none', '--reverse': 'none', '--first-parent': 'none', '--ancestry-path': 'none',
      '--merges': 'none', '--no-merges': 'none', '--min-parents': 'number', '--max-parents': 'number',
      '--no-min-parents': 'none', '--no-max-parents': 'none', '--skip': 'number', '--max-age': 'number',
      '--min-age': 'number', '--walk-reflogs': 'none', '--oneline': 'none', '--abbrev-commit': 'none',
      '--pretty': 'string', '--format': 'string', '--abbrev': 'number', '--full-history': 'none',
      '--dense': 'none', '--sparse': 'none', '--source': 'none', '--graph': 'none',
    }),
  },
  'git describe': {
    safeFlags: {
      '--tags': 'none', '--match': 'string', '--exclude': 'string', '--long': 'none', '--abbrev': 'number',
      '--always': 'none', '--contains': 'none', '--first-match': 'none', '--exact-match': 'none',
      '--candidates': 'number', '--dirty': 'none', '--broken': 'none',
    },
  },
  'git cat-file': {
    safeFlags: { '-t': 'none', '-s': 'none', '-p': 'none', '-e': 'none', '--batch-check': 'none', '--allow-undetermined-type': 'none' },
  },
  'git for-each-ref': {
    safeFlags: {
      '--format': 'string', '--sort': 'string', '--count': 'number', '--contains': 'string',
      '--no-contains': 'string', '--merged': 'string', '--no-merged': 'string', '--points-at': 'string',
    },
  },
  'git grep': {
    safeFlags: {
      '-e': 'string', '-E': 'none', '--extended-regexp': 'none', '-G': 'none', '--basic-regexp': 'none',
      '-F': 'none', '--fixed-strings': 'none', '-P': 'none', '--perl-regexp': 'none', '-i': 'none',
      '--ignore-case': 'none', '-v': 'none', '--invert-match': 'none', '-w': 'none', '--word-regexp': 'none',
      '-n': 'none', '--line-number': 'none', '-c': 'none', '--count': 'none', '-l': 'none',
      '--files-with-matches': 'none', '-L': 'none', '--files-without-match': 'none', '-h': 'none', '-H': 'none',
      '--heading': 'none', '--break': 'none', '--full-name': 'none', '--color': 'none', '--no-color': 'none',
      '-o': 'none', '--only-matching': 'none', '-A': 'number', '--after-context': 'number', '-B': 'number',
      '--before-context': 'number', '-C': 'number', '--context': 'number', '--and': 'none', '--or': 'none',
      '--not': 'none', '--max-depth': 'number', '--untracked': 'none', '--no-index': 'none',
      '--recurse-submodules': 'none', '--cached': 'none', '--threads': 'number', '-q': 'none', '--quiet': 'none',
    },
  },
  'git stash show': {
    safeFlags: g(statFlags, colourFlags, patchFlags, {
      '--word-diff': 'none', '--word-diff-regex': 'string', '--diff-filter': 'string', '--abbrev': 'number',
    }),
  },
  'git worktree list': { safeFlags: { '--porcelain': 'none', '-v': 'none', '--verbose': 'none', '--expire': 'string' } },
  'git tag': {
    safeFlags: {
      '-l': 'none', '--list': 'none', '-n': 'number', '--contains': 'string', '--no-contains': 'string',
      '--merged': 'string', '--no-merged': 'string', '--sort': 'string', '--format': 'string',
      '--points-at': 'string', '--column': 'none', '--no-column': 'none', '-i': 'none', '--ignore-case': 'none',
    },
    additionalCommandIsDangerousCallback: tagCreationDangerous,
  },
  'git branch': {
    safeFlags: {
      '-l': 'none', '--list': 'none', '-a': 'none', '--all': 'none', '-r': 'none', '--remotes': 'none',
      '-v': 'none', '-vv': 'none', '--verbose': 'none', '--color': 'none', '--no-color': 'none',
      '--column': 'none', '--no-column': 'none', '--abbrev': 'number', '--no-abbrev': 'none',
      '--contains': 'string', '--no-contains': 'string', '--merged': 'none', '--no-merged': 'none',
      '--points-at': 'string', '--sort': 'string', '--show-current': 'none', '-i': 'none', '--ignore-case': 'none',
    },
    additionalCommandIsDangerousCallback: branchCreationDangerous,
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// gh table
// ─────────────────────────────────────────────────────────────────────────────

/** gh's exfiltration-guard callback (rejects host-prefixed repo values). */
function ghGuard(_raw: string, tokens: string[]): boolean {
  for (const token of tokens) {
    if (token === '') continue
    let value: string
    if (token.startsWith('-')) {
      const eq = token.indexOf('=')
      if (eq === -1) continue // detached flag: skip (its value is a separate token)
      value = token.slice(eq + 1)
      if (value === '') continue
    } else {
      value = token
    }
    if (!value.includes('/') && !value.includes('://') && !value.includes('@')) continue
    if (value.includes('://')) return true
    if (value.includes('@')) return true
    if ((value.match(/\//g) ?? []).length >= 2) return true
  }
  return false
}

function ghConfig(safeFlags: Record<string, FlagArgType>, guard = true): ExternalCommandConfig {
  return guard ? { safeFlags, additionalCommandIsDangerousCallback: ghGuard } : { safeFlags }
}

const repoFlags: Record<string, FlagArgType> = { '--repo': 'string', '-R': 'string' }

/** gh read-only command configs. Contract data. */
export const GH_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'gh pr view': ghConfig(g({ '--json': 'string', '--comments': 'none' }, repoFlags)),
  'gh pr list': ghConfig(g({
    '--state': 'string', '-s': 'string', '--author': 'string', '--assignee': 'string', '--label': 'string',
    '--limit': 'number', '-L': 'number', '--base': 'string', '--head': 'string', '--search': 'string',
    '--json': 'string', '--draft': 'none', '--app': 'string',
  }, repoFlags)),
  'gh pr diff': ghConfig(g({ '--color': 'string', '--name-only': 'none', '--patch': 'none' }, repoFlags)),
  'gh pr checks': ghConfig(g({
    '--watch': 'none', '--required': 'none', '--fail-fast': 'none', '--json': 'string', '--interval': 'number',
  }, repoFlags)),
  'gh issue view': ghConfig(g({ '--json': 'string', '--comments': 'none' }, repoFlags)),
  'gh issue list': ghConfig(g({
    '--state': 'string', '-s': 'string', '--assignee': 'string', '--author': 'string', '--label': 'string',
    '--limit': 'number', '-L': 'number', '--milestone': 'string', '--search': 'string', '--json': 'string',
    '--app': 'string',
  }, repoFlags)),
  'gh repo view': ghConfig({ '--json': 'string' }),
  'gh run list': ghConfig(g({
    '--branch': 'string', '-b': 'string', '--status': 'string', '-s': 'string', '--workflow': 'string',
    '-w': 'string', '--limit': 'number', '-L': 'number', '--json': 'string', '--event': 'string', '-e': 'string',
    '--user': 'string', '-u': 'string', '--created': 'string', '--commit': 'string', '-c': 'string',
  }, repoFlags)),
  'gh run view': ghConfig(g({
    '--log': 'none', '--log-failed': 'none', '--exit-status': 'none', '--verbose': 'none', '-v': 'none',
    '--json': 'string', '--job': 'string', '-j': 'string', '--attempt': 'number', '-a': 'number',
  }, repoFlags)),
  'gh auth status': ghConfig({ '--active': 'none', '-a': 'none', '--hostname': 'string', '-h': 'string', '--json': 'string' }),
  'gh pr status': ghConfig(g({ '--conflict-status': 'none', '-c': 'none', '--json': 'string' }, repoFlags)),
  'gh issue status': ghConfig(g({ '--json': 'string' }, repoFlags)),
  'gh release list': ghConfig(g({
    '--exclude-drafts': 'none', '--exclude-pre-releases': 'none', '--json': 'string', '--limit': 'number',
    '-L': 'number', '--order': 'string', '-O': 'string',
  }, repoFlags)),
  'gh release view': ghConfig(g({ '--json': 'string' }, repoFlags)),
  'gh workflow list': ghConfig(g({ '--all': 'none', '-a': 'none', '--json': 'string', '--limit': 'number', '-L': 'number' }, repoFlags)),
  'gh workflow view': ghConfig(g({ '--ref': 'string', '-r': 'string', '--yaml': 'none', '-y': 'none' }, repoFlags)),
  'gh label list': ghConfig(g({
    '--json': 'string', '--limit': 'number', '-L': 'number', '--order': 'string', '--search': 'string',
    '-S': 'string', '--sort': 'string',
  }, repoFlags)),
  'gh search repos': ghConfig({
    '--archived': 'none', '--created': 'string', '--followers': 'string', '--forks': 'string',
    '--good-first-issues': 'string', '--help-wanted-issues': 'string', '--include-forks': 'string',
    '--json': 'string', '--language': 'string', '--license': 'string', '--limit': 'number', '-L': 'number',
    '--match': 'string', '--number-topics': 'string', '--order': 'string', '--owner': 'string', '--size': 'string',
    '--sort': 'string', '--stars': 'string', '--topic': 'string', '--updated': 'string', '--visibility': 'string',
  }, false),
  'gh search issues': ghConfig(searchIssuesFlags(), false),
  'gh search prs': ghConfig(g(withoutKey(searchIssuesFlags(), '--include-prs'), {
    '--base': 'string', '-B': 'string', '--checks': 'string', '--draft': 'none', '--head': 'string',
    '-H': 'string', '--merged': 'none', '--merged-at': 'string', '--review': 'string',
    '--review-requested': 'string', '--reviewed-by': 'string',
  }), false),
  'gh search commits': ghConfig(g({
    '--author': 'string', '--author-date': 'string', '--author-email': 'string', '--author-name': 'string',
    '--committer': 'string', '--committer-date': 'string', '--committer-email': 'string', '--committer-name': 'string',
    '--hash': 'string', '--json': 'string', '--limit': 'number', '-L': 'number', '--merge': 'none',
    '--order': 'string', '--owner': 'string', '--parent': 'string', '--sort': 'string', '--tree': 'string',
    '--visibility': 'string',
  }, repoFlags), false),
  'gh search code': ghConfig(g({
    '--extension': 'string', '--filename': 'string', '--json': 'string', '--language': 'string',
    '--limit': 'number', '-L': 'number', '--match': 'string', '--owner': 'string', '--size': 'string',
  }, repoFlags), false),
}

function searchIssuesFlags(): Record<string, FlagArgType> {
  return g({
    '--app': 'string', '--assignee': 'string', '--author': 'string', '--closed': 'string', '--commenter': 'string',
    '--comments': 'string', '--created': 'string', '--include-prs': 'none', '--interactions': 'string',
    '--involves': 'string', '--json': 'string', '--label': 'string', '--language': 'string', '--limit': 'number',
    '-L': 'number', '--locked': 'none', '--match': 'string', '--mentions': 'string', '--milestone': 'string',
    '--no-assignee': 'none', '--no-label': 'none', '--no-milestone': 'none', '--no-project': 'none',
    '--order': 'string', '--owner': 'string', '--project': 'string', '--reactions': 'string', '--sort': 'string',
    '--state': 'string', '--team-mentions': 'string', '--updated': 'string', '--visibility': 'string',
  }, repoFlags)
}

function withoutKey(record: Record<string, FlagArgType>, key: string): Record<string, FlagArgType> {
  const copy = { ...record }
  delete copy[key]
  return copy
}

// ─────────────────────────────────────────────────────────────────────────────
// docker / ripgrep / pyright tables
// ─────────────────────────────────────────────────────────────────────────────

/** docker read-only command configs. Contract data. */
export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'docker logs': {
    safeFlags: {
      '--follow': 'none', '-f': 'none', '--tail': 'string', '-n': 'string', '--timestamps': 'none',
      '-t': 'none', '--since': 'string', '--until': 'string', '--details': 'none',
    },
  },
  'docker inspect': {
    safeFlags: { '--format': 'string', '-f': 'string', '--type': 'string', '--size': 'none', '-s': 'none' },
  },
}

/** ripgrep read-only config. Contract data. */
export const RIPGREP_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  rg: {
    safeFlags: {
      '-e': 'string', '--regexp': 'string', '-f': 'string', '-i': 'none', '--ignore-case': 'none', '-S': 'none',
      '--smart-case': 'none', '-F': 'none', '--fixed-strings': 'none', '-w': 'none', '--word-regexp': 'none',
      '-v': 'none', '--invert-match': 'none', '-c': 'none', '--count': 'none', '-l': 'none',
      '--files-with-matches': 'none', '--files-without-match': 'none', '-n': 'none', '--line-number': 'none',
      '-o': 'none', '--only-matching': 'none', '-A': 'number', '--after-context': 'number', '-B': 'number',
      '--before-context': 'number', '-C': 'number', '--context': 'number', '-H': 'none', '-h': 'none',
      '--heading': 'none', '--no-heading': 'none', '-q': 'none', '--quiet': 'none', '--column': 'none',
      '-g': 'string', '--glob': 'string', '-t': 'string', '--type': 'string', '-T': 'string', '--type-not': 'string',
      '--type-list': 'none', '--hidden': 'none', '--no-ignore': 'none', '-u': 'none', '-m': 'number',
      '--max-count': 'number', '-d': 'number', '--max-depth': 'number', '-a': 'none', '--text': 'none',
      '-z': 'none', '-L': 'none', '--follow': 'none', '--color': 'string', '--json': 'none', '--stats': 'none',
      '--help': 'none', '--version': 'none', '--debug': 'none', '--': 'none',
    },
  },
}

/** pyright read-only config; declares it does not respect the end-of-options marker. Contract data. */
export const PYRIGHT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  pyright: {
    safeFlags: {
      '--outputjson': 'none', '--project': 'string', '-p': 'string', '--pythonversion': 'string',
      '--pythonplatform': 'string', '--typeshedpath': 'string', '--venvpath': 'string', '--level': 'string',
      '--stats': 'none', '--verbose': 'none', '--version': 'none', '--dependencies': 'none', '--warnings': 'none',
    },
    respectsDoubleDash: false,
    additionalCommandIsDangerousCallback: (_raw, tokens) => tokens.some(t => t === '--watch' || t === '-w'),
  },
}

/** Commands that behave identically under both shells (read-only). Contract data. */
export const EXTERNAL_READONLY_COMMANDS: readonly string[] = ['docker ps', 'docker images']

// ─────────────────────────────────────────────────────────────────────────────
// The validator
// ─────────────────────────────────────────────────────────────────────────────

/** Is a token a flag (>1 char, dash, then alnum/underscore/dash)? */
function isFlag(token: string): boolean {
  return token.length > 1 && token[0] === '-' && /[A-Za-z0-9_-]/.test(token[1]!)
}

type ValidateOptions = {
  commandName?: string
  rawCommand?: string
  xargsTargetCommands?: string[]
}

/**
 * Walk tokens from `startIndex` against `config`, returning true only if the
 * whole walk completes without failing. The dangerous callback is never
 * invoked here and the raw command is never read.
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: ValidateOptions,
): boolean {
  const commandName = options?.commandName
  const xargsTargets = options?.xargsTargetCommands
  let i = startIndex

  while (i < tokens.length) {
    const token = tokens[i] as string
    if (token === '') {
      i++
      continue
    }

    // xargs mode: tested before everything else.
    if (xargsTargets && commandName === 'xargs') {
      if (!isFlag(token) || token === '--') {
        let target = token
        if (token === '--' && tokens[i + 1] !== undefined) target = tokens[i + 1] as string
        return xargsTargets.includes(target)
      }
    }

    // End-of-options marker.
    if (token === '--') {
      if (config.respectsDoubleDash === false) {
        i++ // treat as a plain positional
        continue
      }
      return true // the rest are arguments
    }

    if (isFlag(token)) {
      const eqIndex = token.indexOf('=')
      const hadEquals = eqIndex !== -1
      const flagName = hadEquals ? token.slice(0, eqIndex) : token
      const inlineValue = hadEquals ? token.slice(eqIndex + 1) : ''

      const argType = config.safeFlags[flagName]
      if (argType === undefined) {
        // Special cases in order.
        // git numeric shorthand.
        if (commandName === 'git' && /^-\d+$/.test(token)) {
          i++
          continue
        }
        // Attached numeric args for grep/rg.
        if ((commandName === 'grep' || commandName === 'rg') && token.startsWith('-') && !token.startsWith('--') && token.length > 2) {
          const twoChar = token.slice(0, 2)
          const tail = token.slice(2)
          const twoCharType = config.safeFlags[twoChar]
          if (twoCharType !== undefined && /^\d+$/.test(tail) && (twoCharType === 'number' || twoCharType === 'string')) {
            if (!validateFlagArgument(tail, twoCharType)) return false
            i++
            continue
          }
          // else fall through to the bundle rule
        }
        // Short-flag bundles.
        if (token.startsWith('-') && !token.startsWith('--') && token.length > 2) {
          const bundleHalf = (hadEquals ? flagName : token).slice(1)
          let allNone = true
          for (const letter of bundleHalf) {
            const letterType = config.safeFlags[`-${letter}`]
            if (letterType !== 'none') {
              allNone = false
              break
            }
          }
          if (allNone) {
            i++ // advance one, ignoring anything after `=`
            continue
          }
          return false
        }
        // A long flag not in the set, or a short flag <= 2 chars: fail.
        return false
      }

      if (argType === 'none') {
        if (hadEquals) return false // must not carry a value
        i++
        continue
      }

      // A value-taking flag.
      const gitSortException = (candidate: string): boolean =>
        commandName === 'git' && flagName === '--sort' && /^-[A-Za-z]/.test(candidate)
      let value: string
      if (hadEquals) {
        value = inlineValue
        i++
      } else {
        const next = tokens[i + 1]
        // Fail if there is no next token or it is itself a flag — except git's
        // --sort descending form, which legitimately takes a leading-dash value.
        if (next === undefined || (isFlag(next) && !gitSortException(next))) return false
        value = next
        i += 2
      }
      // Defence in depth: a string value starting with a dash fails, except
      // git's --sort descending form.
      if (argType === 'string' && value.startsWith('-')) {
        if (!gitSortException(value)) return false
      }
      if (!validateFlagArgument(value, argType)) return false
      continue
    }

    // A positional argument is allowed (the permissive fallthrough).
    i++
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// UNC path danger detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a string contains a Windows UNC path that could trigger a
 * credential relay or WebDAV fetch. Always false off Windows.
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  if (getPlatform() !== 'windows') return false
  const s = pathOrCommand
  // Host segment: one or more chars that are neither whitespace nor a separator.
  const host = String.raw`[^\s/\\]+`

  // 1. \\host[@digits|ssl](sep|end|ws)
  if (new RegExp(String.raw`\\\\${host}(?:@(?:\d+|ssl))?(?:[/\\]|\s|$)`, 'i').test(s)) return true
  // 2. //host ... not preceded by a colon.
  if (new RegExp(String.raw`(?<!:)//${host}(?:@(?:\d+|ssl))?(?:[/\\]|\s|$)`, 'i').test(s)) return true
  // 3. / then two+ backslashes then a non-ws-non-sep char.
  if (new RegExp(String.raw`/\\\\+[^\s/\\]`).test(s)) return true
  // 4. two+ backslashes then / then such a char.
  if (new RegExp(String.raw`\\\\+/[^\s/\\]`).test(s)) return true
  // 5. WebDAV SSL/port markers.
  if (/@SSL@\d+/i.test(s) || /@\d+@SSL/i.test(s)) return true
  // 6. DavWWWRoot marker.
  if (/DavWWWRoot/i.test(s)) return true
  // 7. \\ or // then a dotted-quad IPv4 then a separator.
  if (/^(?:\\\\|\/\/)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}[/\\]/.test(s)) return true
  // 8. \\ or // then a bracketed IPv6 then a separator.
  if (/^(?:\\\\|\/\/)\[[0-9A-Fa-f:]+\][/\\]/.test(s)) return true
  return false
}

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { findGitRoot, gitExe } from '../../utils/git.js'
import { gitArgsAsync, gitSubcommandIndex } from '../../utils/git/spawnArgs.js'
import { shellCommandText } from '../../utils/permissions/decision/commandAnalysis.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

const ANSWER_WITHIN_MS = 5_000
const MOST_ANSWER_BYTES = 16 * 1024 * 1024

const PRINTS_TEXT = /^(?:-[p]|--patch|--patch-with-stat|--patch-with-raw|-U\d*|--unified(?:=\d+)?|--binary|--check)$/
const PRINTS_NO_TEXT = /^(?:-s|--no-patch|--quiet|--name-only|--name-status|--stat(?:=.*)?|--stat-[\w-]+=.*|--numstat|--shortstat|--dirstat(?:[=-].*)?|-X.*|--cumulative|--summary|--compact-summary|--raw)$/
const PAINTS = /^(?:--exit-code|--no-color|--color(?:=.*)?|--color-moved(?:=.*)?|--no-color-moved|--color-moved-ws=.*|--no-color-moved-ws|--word-diff(?:=.*)?|--word-diff-regex=.*|--color-words(?:=.*)?|--ws-error-highlight=.*|--minimal|--patience|--histogram|--diff-algorithm=.*|--anchored=.*|--indent-heuristic|--no-indent-heuristic|-W|--function-context|--inter-hunk-context=.*|--src-prefix=.*|--dst-prefix=.*|--no-prefix|--default-prefix|--line-prefix=.*|--abbrev(?:=.*)?|--no-abbrev|--full-index|--format=.*|--pretty(?:=.*)?|--oneline|--abbrev-commit|--no-abbrev-commit|--date=.*|--relative-date|--decorate(?:=.*)?|--no-decorate|--notes(?:=.*)?|--show-notes(?:=.*)?|--no-notes|--standard-notes|--no-standard-notes|-O.+|--encoding=.*|--expand-tabs(?:=.*)?|--no-expand-tabs|--no-ext-diff|--no-textconv|-z|--output-indicator-(?:new|old|context)=.*)$/
const SELECTS = /^(?:--cached|--staged|--merge-base|-R|-a|--text|-w|--ignore-all-space|-b|--ignore-space-change|--ignore-space-at-eol|--ignore-cr-at-eol|--ignore-blank-lines|-I.+|--ignore-matching-lines=.*|--diff-filter=.*|-S.+|-G.+|--pickaxe-all|--pickaxe-regex|--find-object=.*|-M.*|--find-renames(?:=.*)?|-C.*|--find-copies(?:=.*)?|--find-copies-harder|-B.*|--break-rewrites(?:=.*)?|-D|--irreversible-delete|--no-renames|--rename-empty|--no-rename-empty|-l\d+|--ignore-submodules(?:=.*)?|-m|-c|--cc|--first-parent|--diff-merges=.*|--no-diff-merges|--remerge-diff|--combined-all-paths|-[0123]|--base|--ours|--theirs|-q|-r|-t|--root|--no-commit-id|--always)$/
const MERGE_FORMAT = /^(?:-c|--cc|--remerge-diff|--diff-merges=.*)$/
const VALUED: ReadonlySet<string> = new Set(['-S', '-G', '-I', '--diff-filter', '--find-object', '--ignore-matching-lines'])
const STASH_SELECTS: ReadonlySet<string> = new Set(['-u', '--include-untracked', '--only-untracked', '--no-include-untracked'])
const HARMLESS_SETTING = /^(?:core\.pager|core\.quotepath|pager\.[\w-]+|color\.[\w.-]+|advice\.[\w-]+|diff\.(?:noprefix|mnemonicprefix|srcprefix|dstprefix|colormoved|colormovedws|wserrorhighlight|algorithm|context|interhunkcontext|indentheuristic|statgraphwidth|statnamewidth|wordregex))=/i
const HARMLESS_GLOBAL = /^(?:--no-pager|--paginate|-[pP]|--no-optional-locks|--no-advice)$/
const PATHSPEC_GLOBAL = /^--(?:literal|glob|noglob|icase)-pathspecs$/
const GIT_VARIABLE = /(?:^|[\s;&|({])(?:export\s+|env\s+)?(GIT_[A-Z_]+)=/g
const HARMLESS_VARIABLE: ReadonlySet<string> = new Set(['GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_EDITOR'])

type GitPatchQuestion = { label: string; steps: string[]; probe: string[]; second?: string[]; relative: boolean; typed: string[]; stash: string | null; instead?: string[] }
type GitPatchUnread = { label: string; unread: string }

const namesObjectPath = (operand: string): boolean => {
  const plain = operand.replace(/@\{[^}]*\}/g, '')
  return plain.includes(':') && !plain.startsWith(':/')
}

export function gitVariableSet(command: string): string | null {
  for (const [, name = ''] of command.matchAll(GIT_VARIABLE)) if (!HARMLESS_VARIABLE.has(name)) return name
  return null
}

export function gitPatchQuestion(words: readonly string[]): GitPatchQuestion | GitPatchUnread | null {
  const at = gitSubcommandIndex([...words])
  const subcommand = words[at]
  if (subcommand === undefined) return null
  let rest = words.slice(at + 1)
  if (subcommand === 'status') return statusQuestion(words, at)
  const stash = subcommand === 'stash'
  if (stash) {
    if (rest[0] !== 'show') return null
    rest = rest.slice(1)
  } else if (!['diff', 'show', 'diff-tree', 'diff-index', 'diff-files'].includes(subcommand)) return null
  const label = stash ? 'stash show' : subcommand
  const cut = rest.indexOf('--')
  const before = cut === -1 ? rest : rest.slice(0, cut)
  const after = cut === -1 ? [] : rest.slice(cut + 1)
  const kept: string[] = []
  const operands: string[] = []
  let text = false
  let silent = false
  let merged = false
  let relative = false
  let unknown: string | null = stash && cut !== -1 ? '--' : null
  let unfollowed: string | null = null
  for (let i = 0; i < before.length; i++) {
    const word = before[i] as string
    if (!word.startsWith('-') || word === '-') operands.push(word)
    else if (stash && STASH_SELECTS.has(word)) kept.push(word)
    else if (PRINTS_TEXT.test(word) || (!stash && word === '-u')) text = true
    else if (PRINTS_NO_TEXT.test(word)) silent = true
    else if (PAINTS.test(word)) continue
    else if (word === '--no-index') return null
    else if (word === '--relative' || word === '--no-relative') {
      relative = word === '--relative'
      kept.push(word)
    } else if (word.startsWith('--relative=')) unfollowed ??= word
    else if (word === '-O') i++
    else if (VALUED.has(word)) {
      const value = before[++i]
      if (value === undefined) unknown ??= word
      else kept.push(word, value)
    } else if (SELECTS.test(word)) {
      kept.push(word)
      if (MERGE_FORMAT.test(word)) merged = true
    } else unknown ??= word
  }
  if (unknown !== null) return { label, unread: `git ${label} is given ${unknown}, an option Mercury does not read for what it prints` }
  const optioned = stash && before.some(word => word.startsWith('-') && word !== '-' && !STASH_SELECTS.has(word))
  if (!(text || ((subcommand === 'diff' || subcommand === 'show' || optioned || merged) && !silent))) return null
  const commits = subcommand === 'show' ? operands.filter(operand => !namesObjectPath(operand)) : operands
  if (subcommand === 'show' && operands.length > 0 && commits.length === 0 && after.length === 0) return null
  if (unfollowed !== null) return { label, unread: `git ${label} is given ${unfollowed}, an option Mercury does not read for what it prints` }
  const front = globalsOf(words, at, label)
  if ('unread' in front) return front
  const own = [...NAMES_ONLY, ...(subcommand === 'show' ? ['--format='] : []), ...(subcommand === 'diff-tree' ? ['-r', '--no-commit-id'] : [])]
  const probe = [...front.globals, ...(stash ? ['stash', 'show'] : [subcommand]), ...kept, ...own, ...commits, ...(cut === -1 ? [] : ['--', ...after])]
  return { label, steps: front.steps, probe, relative, typed: [...words], stash: stash ? (operands[0] ?? '0').replace(/^(\d+)$/, 'stash@{$1}') : null }
}

const NAMES_ONLY = ['--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z']

function globalsOf(words: readonly string[], at: number, label: string): { steps: string[]; globals: string[] } | GitPatchUnread {
  const steps: string[] = []
  const globals: string[] = ['-c', 'diff.relative=false']
  for (let i = 0; i < at; i++) {
    const word = words[i] as string
    if (word === '-C') steps.push(words[++i] ?? '')
    else if (word === '-c') {
      if (!HARMLESS_SETTING.test(words[++i] ?? '')) return { label, unread: `git is given the setting ${words[i] ?? ''} on its command line` }
    } else if (PATHSPEC_GLOBAL.test(word)) globals.push(word)
    else if (!HARMLESS_GLOBAL.test(word)) return { label, unread: `git is given ${word} on its command line` }
  }
  return { steps, globals }
}

const STATUS_PAINTS = /^--(?:no-)?(?:branch|show-stash|ahead-behind|renames|column|untracked-files|ignored|ignore-submodules)$|^--(?:find-renames|column|untracked-files|ignored|ignore-submodules)(?:=.*)?$/

function statusQuestion(words: readonly string[], at: number): GitPatchQuestion | GitPatchUnread | null {
  const rest = words.slice(at + 1)
  const cut = rest.indexOf('--')
  let verbose = 0
  let long = true
  let terse = false
  for (const word of cut === -1 ? rest : rest.slice(0, cut)) {
    if (word === '--no-verbose') verbose = 0
    else if (word.length > 2 && '--verbose'.startsWith(word)) verbose++
    else if (word === '--short' || /^--porcelain(?:=.*)?$/.test(word)) long = false
    else if (word === '--null' || word === '--no-null') terse = word === '--null'
    else if (STATUS_PAINTS.test(word)) continue
    else if (word.startsWith('--')) {
      long = true
      if (!/^--(?:long|no-long|no-short|no-porcelain)$/.test(word)) terse = false
    } else if (/^-[A-Za-z]/.test(word)) {
      for (const letter of word.slice(1)) {
        if (letter === 'u' || letter === 'M') break
        if (letter === 'v') verbose++
        else if (letter === 's') long = false
        else if (letter === 'z') terse = true
      }
    }
  }
  if (verbose === 0 || !long || terse) return null
  const front = globalsOf(words, at, 'status')
  if ('unread' in front) return front
  const asked = (range: string[]): string[] => [...front.globals, 'diff', ...NAMES_ONLY, ...range]
  const instead = [...words.slice(0, at), 'diff', verbose > 1 ? 'HEAD' : '--cached']
  return { label: 'status', steps: front.steps, probe: asked(['--cached']), ...(verbose > 1 ? { second: asked([]) } : {}), relative: false, typed: [...words], stash: null, instead }
}

export async function gitNamesPrinted(question: GitPatchQuestion, cwd: string): Promise<{ base: string; names: string[] } | 'unanswered' | 'failed'> {
  const first = await namesAnswered(question, question.probe, cwd)
  if (question.second === undefined || first === 'unanswered') return first
  const second = await namesAnswered(question, question.second, cwd)
  if (second === 'unanswered' || first === 'failed' || (second !== 'failed' && first.names.length === 0)) return second
  return second === 'failed' || second.names.length === 0 ? first : { base: first.base, names: [...first.names, ...second.names] }
}

async function namesAnswered(question: GitPatchQuestion, probe: string[], cwd: string): Promise<{ base: string; names: string[] } | 'unanswered' | 'failed'> {
  const folder = question.steps.reduce((at, step) => resolve(at, step), cwd)
  let args: string[]
  try {
    args = await gitArgsAsync(probe, folder)
  } catch {
    return 'unanswered'
  }
  const answer = await new Promise<string | 'unanswered' | 'failed'>(done => {
    try {
      execFile(
        gitExe(),
        args,
        { cwd: folder, encoding: 'utf8', env: subprocessEnv(), timeout: ANSWER_WITHIN_MS, killSignal: 'SIGKILL', maxBuffer: MOST_ANSWER_BYTES, windowsHide: true },
        (error, stdout) => {
          if (error === null) done(stdout)
          else done(typeof (error as { code?: unknown }).code === 'number' && !error.killed && !(error as { signal?: unknown }).signal ? 'failed' : 'unanswered')
        },
      )
    } catch {
      done('unanswered')
    }
  })
  if (answer === 'unanswered' || answer === 'failed') return answer
  const names = answer.split('\0').filter(name => name !== '')
  if (names.length === 0) return { base: folder, names }
  const base = question.relative ? folder : findGitRoot(folder)
  return base === null ? 'unanswered' : { base, names }
}

export function gitLeavingOut(question: GitPatchQuestion, names: readonly string[]): string {
  const excludes = names.map(name => `:(exclude,top)${name}`)
  if (question.stash !== null) return shellCommandText(['git', 'diff', `${question.stash}^1`, question.stash, '--', ':/', ...excludes])
  if (question.instead !== undefined) return shellCommandText(['git', ...question.instead, '--', ':/', ...excludes])
  const cut = question.typed.indexOf('--')
  return shellCommandText(['git', ...(cut === -1 ? [...question.typed, '--', ':/'] : question.typed), ...excludes])
}

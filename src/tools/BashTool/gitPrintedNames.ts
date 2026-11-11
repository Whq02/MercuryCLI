import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { findGitRoot, gitExe } from '../../utils/git.js'
import { gitArgsAsync, gitSubcommandIndex } from '../../utils/git/spawnArgs.js'
import { shellCommandText } from '../../utils/permissions/decision/commandAnalysis.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

const ANSWER_WITHIN_MS = 5_000
const MOST_ANSWER_BYTES = 16 * 1024 * 1024

const PRINTS_TEXT = /^(?:-[p]|--patch|--patch-with-stat|--patch-with-raw|-U\d*|--unified(?:=\d+)?|--binary|--check)$/
const PRINTS_NO_TEXT = /^(?:-s|--no-patch|--quiet|--name-only|--name-status|--stat(?:[=-].*)?|--numstat|--shortstat|--dirstat(?:[=-].*)?|-X.*|--cumulative|--summary|--compact-summary|--raw)$/
const PAINTS = /^(?:--exit-code|--no-color|--color(?:=.*)?|--color-moved(?:=.*)?|--no-color-moved|--color-moved-ws=.*|--no-color-moved-ws|--word-diff(?:=.*)?|--word-diff-regex=.*|--color-words(?:=.*)?|--ws-error-highlight=.*|--minimal|--patience|--histogram|--diff-algorithm=.*|--anchored=.*|--indent-heuristic|--no-indent-heuristic|-W|--function-context|--inter-hunk-context=.*|--src-prefix=.*|--dst-prefix=.*|--no-prefix|--default-prefix|--line-prefix=.*|--abbrev(?:=.*)?|--no-abbrev|--full-index|--format=.*|--pretty(?:=.*)?|--oneline|--abbrev-commit|--no-abbrev-commit|--date=.*|--decorate(?:=.*)?|--no-decorate|--no-notes|--encoding=.*|--expand-tabs(?:=.*)?|--no-expand-tabs|--no-ext-diff|--no-textconv|-z|--output-indicator-(?:new|old|context)=.*)$/
const SELECTS = /^(?:--cached|--staged|--merge-base|-R|-a|--text|-w|--ignore-all-space|-b|--ignore-space-change|--ignore-space-at-eol|--ignore-cr-at-eol|--ignore-blank-lines|-I.+|--ignore-matching-lines=.*|--diff-filter=.*|-S.+|-G.+|--pickaxe-all|--pickaxe-regex|--find-object=.*|--no-relative|-M.*|--find-renames(?:=.*)?|-C.*|--find-copies(?:=.*)?|--find-copies-harder|-B.*|--break-rewrites(?:=.*)?|-D|--irreversible-delete|--no-renames|--rename-empty|--no-rename-empty|-l\d+|--ignore-submodules(?:=.*)?|-m|-c|--cc|--first-parent|--diff-merges=.*|--no-diff-merges|--remerge-diff|--combined-all-paths|-[0123]|--base|--ours|--theirs|-q|-r|-t|--root|--no-commit-id|--always)$/
const VALUED: ReadonlySet<string> = new Set(['-S', '-G', '-I', '--diff-filter', '--find-object', '--ignore-matching-lines'])
const STASH_SELECTS: ReadonlySet<string> = new Set(['-u', '--include-untracked', '--only-untracked', '--no-include-untracked'])
const HARMLESS_SETTING = /^(?:core\.pager|core\.quotepath|pager\.[\w-]+|color\.[\w.-]+|advice\.[\w-]+)=/i
const HARMLESS_GLOBAL = /^(?:--no-pager|--paginate|-[pP]|--no-optional-locks|--no-advice)$/
const PATHSPEC_GLOBAL = /^--(?:literal|glob|noglob|icase)-pathspecs$/
const GIT_VARIABLE = /(?:^|[\s;&|({])(?:export\s+|env\s+)?(GIT_[A-Z_]+)=/g
const HARMLESS_VARIABLE: ReadonlySet<string> = new Set(['GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_EDITOR'])

type GitPatchQuestion = { label: string; steps: string[]; probe: string[]; relative: boolean; typed: string[]; stash: string | null }
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
  let relative = false
  let unknown: string | null = null
  for (let i = 0; i < before.length; i++) {
    const word = before[i] as string
    if (!word.startsWith('-') || word === '-') operands.push(word)
    else if (stash && STASH_SELECTS.has(word)) kept.push(word)
    else if (PRINTS_TEXT.test(word) || (!stash && word === '-u')) text = true
    else if (PRINTS_NO_TEXT.test(word)) silent = true
    else if (PAINTS.test(word)) continue
    else if (word === '--no-index') return null
    else if (word === '--relative') {
      relative = true
      kept.push(word)
    } else if (VALUED.has(word)) {
      const value = before[++i]
      if (value === undefined) unknown ??= word
      else kept.push(word, value)
    } else if (SELECTS.test(word)) kept.push(word)
    else unknown ??= word
  }
  if (!(text || ((subcommand === 'diff' || subcommand === 'show') && !silent))) return null
  const commits = subcommand === 'show' ? operands.filter(operand => !namesObjectPath(operand)) : operands
  if (subcommand === 'show' && operands.length > 0 && commits.length === 0 && after.length === 0) return null
  if (unknown !== null) return { label, unread: `git ${label} is given ${unknown}, an option Mercury does not read for what it prints` }
  const steps: string[] = []
  const globals: string[] = []
  for (let i = 0; i < at; i++) {
    const word = words[i] as string
    if (word === '-C') steps.push(words[++i] ?? '')
    else if (word === '-c') {
      if (!HARMLESS_SETTING.test(words[++i] ?? '')) return { label, unread: `git is given the setting ${words[i] ?? ''} on its command line` }
    } else if (PATHSPEC_GLOBAL.test(word)) globals.push(word)
    else if (!HARMLESS_GLOBAL.test(word)) return { label, unread: `git is given ${word} on its command line` }
  }
  const own = ['--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', ...(subcommand === 'show' ? ['--format='] : []), ...(subcommand === 'diff-tree' ? ['-r', '--no-commit-id'] : [])]
  const probe = ['-c', 'diff.relative=false', ...globals, ...(stash ? ['stash', 'show'] : [subcommand]), ...kept, ...own, ...commits, ...(cut === -1 ? [] : ['--', ...after])]
  return { label, steps, probe, relative, typed: [...words], stash: stash ? (operands[0] ?? '0').replace(/^(\d+)$/, 'stash@{$1}') : null }
}

export async function gitNamesPrinted(question: GitPatchQuestion, cwd: string): Promise<{ base: string; names: string[] } | 'unanswered' | 'failed'> {
  const folder = question.steps.reduce((at, step) => resolve(at, step), cwd)
  let args: string[]
  try {
    args = await gitArgsAsync(question.probe, folder)
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
  const cut = question.typed.indexOf('--')
  return shellCommandText(['git', ...(cut === -1 ? [...question.typed, '--', ':/'] : question.typed), ...excludes])
}

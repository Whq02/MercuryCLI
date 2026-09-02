import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  HelixGradeComponent,
  HelixGradeVerdict,
  HelixTask,
} from './contracts.js'
import { taskById } from './tasks.js'

const OPERATIONAL_PREFIXES = ['.claude/', '.mercury/', 'node_modules/']

function runCheck(cwd: string, cmd: string[], timeoutSec: number): number {
  try {
    execFileSync(cmd[0], cmd.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutSec * 1000,
    })
    return 0
  } catch (error) {
    const status = (error as { status?: number | null }).status
    return typeof status === 'number' ? status : -1
  }
}

export function reflogBaseSha(workdir: string): string | null {
  try {
    const raw = execFileSync('git', ['-C', workdir, 'reflog', '--format=%H %gs'], {
      encoding: 'utf8',
    })
    const lines = raw.split('\n').filter(l => l.trim() !== '')
    for (const line of [...lines].reverse()) {
      const m = /^([0-9a-f]{40}) checkout: moving from /.exec(line)
      if (m) return m[1]
    }
    return null
  } catch {
    return null
  }
}

export function observedChanges(
  workdir: string,
  baseSha?: string,
): { changed: string[]; ignored: string[] } {
  const changed: string[] = []
  const ignored: string[] = []
  const note = (path: string): void => {
    path = path.replace(/^"|"$/g, '')
    if (path === '') return
    if (OPERATIONAL_PREFIXES.some(prefix => path.startsWith(prefix))) {
      if (!ignored.includes(path)) ignored.push(path)
    } else if (!changed.includes(path)) {
      changed.push(path)
    }
  }
  const base = baseSha ?? reflogBaseSha(workdir)
  if (base) {
    const diff = execFileSync('git', ['-C', workdir, 'diff', '--name-only', base], {
      encoding: 'utf8',
    })
    for (const line of diff.split('\n')) note(line.trim())
  }
  const raw = execFileSync('git', ['-C', workdir, 'status', '--porcelain'], {
    encoding: 'utf8',
  })
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const body = line.slice(3)
    const arrow = body.indexOf(' -> ')
    const paths = arrow >= 0 ? [body.slice(0, arrow), body.slice(arrow + 4)] : [body]
    for (const path of paths) note(path)
  }
  return { changed: changed.sort(), ignored: ignored.sort() }
}

export function gradeTask(
  task: HelixTask,
  workdir: string,
  resultText: string,
  now: () => number = Date.now,
  opts: { baseSha?: string } = {},
): HelixGradeVerdict {
  const components: HelixGradeComponent[] = []

  const exits: string[] = []
  let checksPass = true
  for (const check of task.grader.checks) {
    const exit = runCheck(workdir, check.cmd, check.timeoutSec ?? 120)
    exits.push(check.cmd.join(' ') + ' => ' + exit + ' (want ' + check.expectExit + ')')
    if (exit !== check.expectExit) checksPass = false
  }
  components.push({ name: 'checks', pass: checksPass, detail: exits.join(' · ') })

  const { changed, ignored } = observedChanges(workdir, opts.baseSha)
  const scope = task.grader
  const scopeProblems: string[] = []
  if (scope.zeroDiff && changed.length > 0) {
    scopeProblems.push('expected zero diff, saw: ' + changed.join(', '))
  }
  if (scope.onlyChange) {
    if (changed.length === 0) scopeProblems.push('expected changes, saw none')
    for (const path of changed) {
      if (!scope.onlyChange.includes(path)) scopeProblems.push('out-of-scope change: ' + path)
    }
  }
  for (const path of scope.mustChange ?? []) {
    if (!changed.includes(path)) scopeProblems.push('required change missing: ' + path)
  }
  for (const path of scope.mustNotChange ?? []) {
    if (changed.includes(path)) scopeProblems.push('forbidden change: ' + path)
  }
  components.push({
    name: 'diff-scope',
    pass: scopeProblems.length === 0,
    detail:
      (scopeProblems.length === 0 ? 'ok' : scopeProblems.join(' · ')) +
      (ignored.length > 0 ? ' [operational, excluded: ' + ignored.join(', ') + ']' : ''),
  })

  if (scope.requiredTokens || scope.forbiddenPatterns) {
    const problems: string[] = []
    const haystack = resultText.toLowerCase()
    for (const token of scope.requiredTokens ?? []) {
      if (!haystack.includes(token.toLowerCase())) problems.push('missing token: ' + token)
    }
    for (const pattern of scope.forbiddenPatterns ?? []) {
      if (new RegExp(pattern, 'i').test(resultText)) problems.push('forbidden claim matches: ' + pattern)
    }
    components.push({
      name: 'result-text',
      pass: problems.length === 0,
      detail: problems.length === 0 ? 'ok' : problems.join(' · '),
    })
  }

  return {
    taskId: task.id,
    accepted: components.every(c => c.pass),
    components,
    changedPaths: changed,
    gradedAtMs: now(),
  }
}

if (import.meta.main) {
  const [taskId, workdir, resultFile] = process.argv.slice(2)
  if (!taskId || !workdir) {
    console.error('usage: grade.ts <taskId> <workdir> [resultTextFile]')
    process.exit(2)
  }
  const resultText = resultFile ? readFileSync(resolve(resultFile), 'utf8') : ''
  const verdict = gradeTask(taskById(taskId), resolve(workdir), resultText)
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.accepted ? 0 : 1)
}

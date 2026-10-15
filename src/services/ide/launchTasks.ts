import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { settleChildRun } from '../../utils/childSettle.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { expandVsCodeVar, stripJsonc } from './launchProfiles.js'
import { detectPackageManager } from './projectRunners.js'

export type PreLaunchTask =
  | { label: string; type: 'shell' | 'process' | 'npm'; argv: string[]; cwd: string; env?: Record<string, string>; matcherIgnored?: true }
  | { label: string; refused: string }

interface TasksJsonTask {
  label?: string
  type?: string
  command?: unknown
  args?: unknown
  script?: unknown
  options?: { cwd?: unknown; env?: unknown }
  dependsOn?: unknown
  problemMatcher?: unknown
  [key: string]: unknown
}

const TASK_TIMEOUT_MS = 300_000
const SHELL_OPERATORS = /[|&;<>()$`\\"'*?~\n]/

function readTasksJson(root: string): { tasks: TasksJsonTask[] } | { missing: true } | { error: string } {
  const file = path.join(root, '.vscode', 'tasks.json')
  if (!existsSync(file)) return { missing: true }
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(file, 'utf8'))) as { tasks?: unknown }
    return { tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as TasksJsonTask[]) : [] }
  } catch (e) {
    return { error: `tasks.json unparseable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function argText(arg: unknown): string | null {
  if (typeof arg === 'string') return arg
  if (arg && typeof arg === 'object' && typeof (arg as { value?: unknown }).value === 'string') return (arg as { value: string }).value
  return null
}

export function resolvePreLaunchTask(label: string, root: string): PreLaunchTask {
  const read = readTasksJson(root)
  if ('missing' in read) return { label, refused: 'no .vscode/tasks.json beside launch.json' }
  if ('error' in read) return { label, refused: read.error }
  const task = read.tasks.find(t => t.label === label)
  if (!task) return { label, refused: `no task labelled '${label}' in .vscode/tasks.json` }
  if (Array.isArray(task.dependsOn) ? task.dependsOn.length > 0 : task.dependsOn !== undefined) {
    return { label, refused: `task '${label}' has dependsOn — Mercury runs one plain task, not a chain` }
  }
  const matcher = task.problemMatcher
  const ignored: { matcherIgnored?: true } = matcher !== undefined && !(Array.isArray(matcher) && matcher.length === 0) ? { matcherIgnored: true } : {}
  const type = task.type ?? 'process'
  const expand = (value: string, what: string): string | { refused: string } => {
    const out = expandVsCodeVar(value, root)
    return out === null ? { refused: `task '${label}': ${what} carries a macro Mercury does not expand: ${value}` } : out
  }
  const rawCwd = task.options?.cwd
  let cwd = root
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== 'string') return { label, refused: `task '${label}': options.cwd is not a string` }
    const expanded = expand(rawCwd, 'options.cwd')
    if (typeof expanded !== 'string') return { label, ...expanded }
    cwd = path.isAbsolute(expanded) ? expanded : path.join(root, expanded)
  }
  let env: Record<string, string> | undefined
  const rawEnv = task.options?.env
  if (rawEnv !== undefined) {
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return { label, refused: `task '${label}': options.env is not an object` }
    env = {}
    for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof value !== 'string') return { label, refused: `task '${label}': options.env ${key} is not a string` }
      const expanded = expand(value, `options.env ${key}`)
      if (typeof expanded !== 'string') return { label, ...expanded }
      env[key] = expanded
    }
  }
  if (type === 'npm') {
    if (typeof task.script !== 'string' || task.script === '') return { label, refused: `task '${label}' is an npm task without a script` }
    const pm = detectPackageManager(root)
    if ('missing' in pm) return { label, refused: `task '${label}' is an npm task but ${pm.missing}` }
    return { label, type: 'npm', argv: [pm.bin, 'run', task.script], cwd, ...(env ? { env } : {}), ...ignored }
  }
  if (type !== 'shell' && type !== 'process') {
    return { label, refused: `task type '${type}' is not one Mercury runs (shell, process, npm)` }
  }
  const command = argText(task.command)
  if (command === null || command.trim() === '') return { label, refused: `task '${label}' has no command` }
  const rawArgs = task.args === undefined ? [] : Array.isArray(task.args) ? task.args : null
  if (rawArgs === null) return { label, refused: `task '${label}': args is not a list` }
  const argv: string[] = []
  for (const piece of [command, ...rawArgs]) {
    const text = argText(piece)
    if (text === null) return { label, refused: `task '${label}': an argument is not a string` }
    const expanded = expand(text, piece === command ? 'command' : 'an argument')
    if (typeof expanded !== 'string') return { label, ...expanded }
    argv.push(expanded)
  }
  if (type === 'shell' && SHELL_OPERATORS.test(argv[0]!)) {
    return { label, refused: `task '${label}' is a shell command line (${argv[0]!.slice(0, 60)}) — Mercury runs tasks argv-only; spell it as command + args` }
  }
  return { label, type, argv, cwd, ...(env ? { env } : {}), ...ignored }
}

type PreLaunchTaskOutcome = { ran: true; label: string; argv: string[]; matcherIgnored: boolean } | { ran: false; label: string; reason: string }

export async function runPreLaunchTask(task: PreLaunchTask, signal?: AbortSignal): Promise<PreLaunchTaskOutcome> {
  if ('refused' in task) {
    return { ran: false, label: task.label, reason: `preLaunchTask '${task.label}' cannot be run by Mercury: ${task.refused}` }
  }
  const child = spawn(task.argv[0]!, task.argv.slice(1), {
    windowsHide: true,
    cwd: task.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...subprocessEnv(), NO_COLOR: '1', ...(task.env ?? {}) },
  })
  const chunks: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))
  const settlement = await settleChildRun(child, { timeoutMs: TASK_TIMEOUT_MS, ...(signal ? { signal } : {}) })
  const tail = Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-8).join('\n')
  if (settlement.spawnError) {
    return { ran: false, label: task.label, reason: `preLaunchTask '${task.label}' could not start: ${settlement.spawnError}` }
  }
  if (settlement.timedOut || settlement.aborted) {
    return { ran: false, label: task.label, reason: `preLaunchTask '${task.label}' ${settlement.timedOut ? `timed out after ${Math.round(TASK_TIMEOUT_MS / 1000)}s` : 'was interrupted'} — the launch did not start${tail ? `\n${tail}` : ''}` }
  }
  if (settlement.code !== 0) {
    return { ran: false, label: task.label, reason: `preLaunchTask '${task.label}' failed (exit ${settlement.code ?? 'null'}${settlement.signal ? `, ${settlement.signal}` : ''}) — the launch did not start${tail ? `\n${tail}` : ''}` }
  }
  return { ran: true, label: task.label, argv: task.argv, matcherIgnored: task.matcherIgnored === true }
}

import { spawnSync } from 'node:child_process'

export type GitResult =
  | { state: 'ok'; stdout: string }
  | { state: 'unavailable'; detail: string }
  | { state: 'nonzero'; code: number; stderr: string }
  | { state: 'timeout' }
  | { state: 'malformed'; detail: string }

interface RunGitOptions {
  cwd?: string
  timeoutMs?: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
}

export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    ...(opts.env ? { env: opts.env } : {}),
  })
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException
    if (err.code === 'ETIMEDOUT') return { state: 'timeout' }
    return { state: 'unavailable', detail: `${err.code ?? 'ERR'}: ${err.message}` }
  }
  if (r.signal) {
    return { state: 'timeout' }
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    return { state: 'nonzero', code: r.status, stderr: (r.stderr ?? '').trim() }
  }
  if (typeof r.stdout !== 'string') {
    return { state: 'malformed', detail: 'no stdout captured' }
  }
  return { state: 'ok', stdout: r.stdout }
}

export function gitOutOrNull(
  args: string[],
  opts: RunGitOptions & { onMiss: (miss: Exclude<GitResult, { state: 'ok' }>) => void },
): string | null {
  const r = runGit(args, opts)
  if (r.state === 'ok') return r.stdout
  opts.onMiss(r)
  return null
}

const GIT_GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--shallow-file', '--config-env'])

export function gitSubcommandArgv(argv: readonly string[]): string[] {
  let at = 0
  while (at < argv.length) {
    const word = argv[at]!
    if (GIT_GLOBALS_WITH_VALUE.has(word)) {
      at += 2
      continue
    }
    if (word.startsWith('-')) {
      at++
      continue
    }
    break
  }
  return argv.slice(at)
}

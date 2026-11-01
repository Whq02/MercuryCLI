import { spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const LOOKED_FOR = 'node on PATH or MERCURY_NODE'
const IDENTITY = 'JSON.stringify({execPath:process.execPath,bun:process.versions.bun||null})'
const memo = new Map<string, string>()

function executableFile(path: string): boolean {
  if (path === '' || !isAbsolute(path) || /\.(?:cmd|bat)$/i.test(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const PROBE_BUDGETS_MS = [30_000, 90_000]

function identityOf(command: string, env: NodeJS.ProcessEnv): { execPath: string; why: string } {
  let asked: SpawnSyncReturns<string> | undefined
  for (const [attempt, budget] of PROBE_BUDGETS_MS.entries()) {
    try {
      asked = spawnSync(command, ['-p', IDENTITY], { encoding: 'utf8', env, timeout: budget, windowsHide: true })
    } catch (error) {
      return { execPath: '', why: `${command} did not start: ${(error as Error).message}` }
    }
    const timedOut = asked.error !== undefined && (asked.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    if (!timedOut || attempt === PROBE_BUDGETS_MS.length - 1) break
  }
  if (asked === undefined) return { execPath: '', why: `${command} was never asked` }
  if (asked.error) return { execPath: '', why: `${command} did not start: ${asked.error.message}${(asked.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? ` (asked twice, ${PROBE_BUDGETS_MS.join(' and ')} ms; a cold start that slow is a host fact)` : ''}` }
  if (asked.status !== 0) return { execPath: '', why: `${command} -p exited ${asked.status ?? asked.signal}: ${(asked.stderr ?? '').trim().slice(0, 200)}` }
  const line = (asked.stdout ?? '').trim().split('\n').at(-1) ?? ''
  let answer: { execPath?: unknown; bun?: unknown }
  try {
    answer = JSON.parse(line) as { execPath?: unknown; bun?: unknown }
  } catch {
    return { execPath: '', why: `${command} printed no answer: ${line.slice(0, 200)}` }
  }
  if (answer.bun) return { execPath: '', why: `${command} is Bun ${String(answer.bun)}, not Node` }
  const execPath = typeof answer.execPath === 'string' ? answer.execPath : ''
  if (!executableFile(execPath)) return { execPath: '', why: `${command} named ${execPath || 'no'} execPath, which is no file` }
  return { execPath, why: '' }
}

export function nodeBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.MERCURY_NODE ?? ''
  if (pinned !== '') {
    if (!executableFile(pinned)) throw new Error(`no node found: MERCURY_NODE names no executable file: ${pinned} (looked for ${LOOKED_FOR})`)
    const identity = identityOf(pinned, env)
    if (identity.execPath === '') throw new Error(`no node found: MERCURY_NODE ${identity.why} (looked for ${LOOKED_FOR})`)
    return pinned
  }
  const key = env.PATH ?? ''
  const remembered = memo.get(key)
  if (remembered !== undefined && executableFile(remembered)) return remembered
  const asked = identityOf('node', env)
  if (asked.execPath === '') throw new Error(`no node found: the node on PATH ${asked.why.replace(/^node /, '')} (looked for ${LOOKED_FOR})`)
  memo.set(key, asked.execPath)
  return asked.execPath
}

type LiveDaemonOptions = { what: string; timeoutMs?: number; log?: string }

function logTail(log: string | undefined): string {
  if (log === undefined) return ''
  try {
    return readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')
  } catch {
    return ''
  }
}

function leaveWithoutDaemon(child: ChildProcess, line: string, log: string | undefined): never {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL')
    } catch {
      void 0
    }
  }
  const tail = logTail(log)
  console.error(`${line}; the proof stops here so nothing below reaches a connector without a daemon of its own${tail === '' ? '' : `\n${tail}`}`)
  process.exit(1)
}

export async function requireLiveDaemon(child: ChildProcess, opts: LiveDaemonOptions): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pid = child.pid
  let spawnError: Error | null = null
  child.once('error', error => {
    spawnError = error
  })
  if (pid === undefined) leaveWithoutDaemon(child, `${opts.what}: the daemon did not spawn (no pid)`, opts.log)
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (spawnError !== null) leaveWithoutDaemon(child, `${opts.what}: the daemon (pid ${pid}) failed to start: ${(spawnError as Error).message}`, opts.log)
    if (child.exitCode !== null || child.signalCode !== null) leaveWithoutDaemon(child, `${opts.what}: the daemon (pid ${pid}) ended with ${child.exitCode ?? child.signalCode} before answering on the control socket`, opts.log)
    let reply: { ok?: boolean; op?: string; pid?: number } | null = null
    try {
      reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, { timeoutMs: 2000, protoRetry: false })) as { ok?: boolean; op?: string; pid?: number }
    } catch {
      reply = null
    }
    if (reply?.ok === true && reply.op === 'hello' && typeof reply.pid === 'number') {
      if (reply.pid === pid) return pid
      leaveWithoutDaemon(child, `${opts.what}: the control socket answered from pid ${reply.pid}, not the daemon this proof spawned (pid ${pid})`, opts.log)
    }
    if (Date.now() >= deadline) leaveWithoutDaemon(child, `${opts.what}: the daemon (pid ${pid}) did not answer on the control socket within ${timeoutMs} ms`, opts.log)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

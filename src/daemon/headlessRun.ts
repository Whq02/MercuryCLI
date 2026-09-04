
import { spawn, type ChildProcess } from 'node:child_process'
import { logForDebugging } from '../utils/debug.js'
import { enforceSubagentModelFloor } from '../utils/model/modelFloor.js'
import { killProcessGroup } from '../utils/processGroup.js'
import {
  assertSpawnCwd,
  recordSpawn,
  recordSpawnExit,
  spawnedByStamp,
  SPAWNED_BY_ENV,
} from '../utils/spawnLedger.js'
import { WORKER_PARENT_PID_ENV } from './workerParentWatch.js'
import { flagEnv, flagPair, flagSpellings, stampFlagOnEnv } from '../substrate/flagRegistry.js'
import { decodePermissionModeSpelling } from '../types/permissions.js'
import { LIVE_ROLE_ENV_VARS, RETIRED_SEAT_ENV_VARS } from '../utils/workerRole.js'

export { ALL_ROLE_ENV_VARS } from '../utils/workerRole.js'
function sweptRoleSpellings(): string[] {
  return [...LIVE_ROLE_ENV_VARS.flatMap(flagSpellings), ...RETIRED_SEAT_ENV_VARS]
}

export function stripCrewRolePair(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = []
  const crewSpellings = flagSpellings('MERCURY_CREW')
  if (crewSpellings.some(v => env[v] === '1')) {
    for (const v of crewSpellings) {
      if (env[v] === '1') {
        delete env[v]
        removed.push(v)
      }
    }
  }
  for (const v of flagSpellings('MERCURY_CREW_AGENT')) {
    if (env[v] !== undefined) {
      delete env[v]
      removed.push(v)
    }
  }
  return removed
}

export function scrubSupervisorRoleEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = []
  for (const v of sweptRoleSpellings()) {
    if (env[v] !== undefined) {
      delete env[v]
      removed.push(v)
    }
  }
  removed.push(...stripCrewRolePair(env))
  return removed
}

export const RUN_TIMEOUT_MS = 30 * 60 * 1000

export function getRunTimeoutMs(): number {
  const raw = flagEnv('MERCURY_DAEMON_RUN_TIMEOUT_MS')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RUN_TIMEOUT_MS
}

export const RUN_KILL_GRACE_MS = 5_000

export function getRunKillGraceMs(): number {
  const raw = flagEnv('MERCURY_DAEMON_KILL_GRACE_MS')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RUN_KILL_GRACE_MS
}

export const RUN_MAXBUF_BYTES = 1024 * 1024

export function getRunMaxBufBytes(): number {
  const raw = flagEnv('MERCURY_DAEMON_RUN_MAXBUF')
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RUN_MAXBUF_BYTES
}


export const HEADLESS_PERMISSION_MODE_DEFAULT = 'flow'

export const HEADLESS_PERMISSION_MODES = [
  'default',
  'implement',
  'flow',
  'dontAsk',
  'sovereign',
] as const
export type HeadlessPermissionMode = (typeof HEADLESS_PERMISSION_MODES)[number]

export type SeatPermissionMode = HeadlessPermissionMode | 'apollo'

export function getHeadlessPermissionMode(
  specDefault?: SeatPermissionMode,
): SeatPermissionMode {
  const fallback = specDefault ?? HEADLESS_PERMISSION_MODE_DEFAULT
  const raw = (flagEnv('MERCURY_DAEMON_PERMISSION_MODE') ?? '').trim()
  if (!raw) return fallback
  const decoded = decodePermissionModeSpelling(raw)
  if ((HEADLESS_PERMISSION_MODES as readonly string[]).includes(decoded)) {
    return decoded as HeadlessPermissionMode
  }
  logForDebugging(
    `[daemon] MERCURY_DAEMON_PERMISSION_MODE=${raw} is not one of ${HEADLESS_PERMISSION_MODES.join('|')} — using ${fallback}`,
  )
  return fallback
}

export function headlessPermissionArgv(
  mode: SeatPermissionMode = getHeadlessPermissionMode(),
  allowBypass = false,
): string[] {
  if (mode === 'sovereign') return ['--dangerously-skip-permissions']
  const words = mode === 'default' ? [] : ['--permission-mode', mode]
  return allowBypass ? [...words, '--allow-dangerously-skip-permissions'] : words
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  killProcessGroup(child, signal)
}

function cloneEnvWithoutRoles(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const v of sweptRoleSpellings()) {
    delete env[v]
  }
  stripCrewRolePair(env)
  if (env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = enforceSubagentModelFloor(env.ANTHROPIC_MODEL, 'daemon:headless-loop')
  }
  env.MERCURY_BRIEF ??= '1'
  return env
}

export interface HeadlessResult {
  stdout: string
  code: number | null
  pid?: number
  timedOut?: boolean
}

export interface HeadlessSpec {
  id: string
  prompt: string
  permissionMode?: HeadlessPermissionMode
  allowedTools?: readonly string[]
  resumeSessionId?: string
}

export function buildHeadlessPrompt(task: {
  prompt: string
  workflow?: string
}): string {
  const wf = (task.workflow ?? '').trim()
  if (!wf) return task.prompt
  const cmd = wf.startsWith('/') ? wf : `/${wf}`
  const args = (task.prompt ?? '').trim()
  return args ? `${cmd} ${args}` : cmd
}

export function getSelfInvocation(): { node: string; script: string } {
  return { node: process.execPath, script: process.argv[1] || '' }
}


export interface StreamJsonChildSpec {
  model: string
  keyless?: true
  effort: string
  appendSystemPrompt: string
  role:
    | 'MERCURY_CREW'
    | 'MERCURY_CONCOURSE_WORKER'
  agentName: string
  agentId: string
  teamName?: string
  cwd?: string
  extraEnv?: Readonly<Record<string, string>>
  permissionMode?: SeatPermissionMode
  allowBypass?: true
  allowedTools?: readonly string[]
  extraArgv?: readonly string[]
  respawnExtraArgv?: readonly string[]
  plainIdentity?: boolean
  stripEnv?: readonly string[]
}

export function buildStreamJsonInvocation(
  spec: StreamJsonChildSpec,
  opts?: { respawn?: boolean },
): {
  node: string
  script: string
  argv: string[]
  env: NodeJS.ProcessEnv
} {
  const { node, script } = getSelfInvocation()
  const model =
    spec.role === 'MERCURY_CONCOURSE_WORKER'
      ? spec.model
      : enforceSubagentModelFloor(spec.model, `daemon:${spec.agentName}`)
  const teamName = spec.teamName ?? 'default'
  const argv = [
    script,
    '-p',
    '--verbose',
    ...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode), spec.allowBypass === true),
    ...(spec.allowedTools && spec.allowedTools.length > 0
      ? ['--allowedTools', ...spec.allowedTools]
      : []),
    '--input-format=stream-json',
    '--output-format=stream-json',
    ...(spec.keyless ? [] : ['--model', model]),
    '--append-system-prompt',
    spec.appendSystemPrompt,
    ...(spec.plainIdentity
      ? []
      : [
          '--team-name',
          teamName,
          '--agent-name',
          spec.agentName,
          '--agent-id',
          spec.agentId,
        ]),
    ...((opts?.respawn ? (spec.respawnExtraArgv ?? spec.extraArgv) : spec.extraArgv) ?? []),
  ]
  const inherited: NodeJS.ProcessEnv = { ...process.env }
  for (const v of spec.stripEnv ?? []) {
    delete inherited[v]
  }
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...(spec.extraEnv ?? {}),
    ANTHROPIC_MODEL: model,
    MERCURY_EFFORT_LEVEL: spec.effort,
    ...flagPair('MERCURY_SWARMS', '1'),
  }
  for (const v of sweptRoleSpellings()) {
    delete env[v]
  }
  if (spec.role !== 'MERCURY_CREW') {
    stripCrewRolePair(env)
  }
  stampFlagOnEnv(env, spec.role, '1')
  return { node, script, argv, env }
}

export function spawnStreamJsonChild(
  spec: StreamJsonChildSpec,
  opts?: { respawn?: boolean },
): {
  child: ChildProcess
  argv: string[]
  env: NodeJS.ProcessEnv
} {
  const { node, script, argv, env } = buildStreamJsonInvocation(spec, opts)
  if (!script) {
    logForDebugging('[daemon] cannot resolve self executable; stream-json child not spawned')
  }
  stampFlagOnEnv(env, WORKER_PARENT_PID_ENV, String(process.pid))
  stampFlagOnEnv(env, SPAWNED_BY_ENV, spawnedByStamp(`daemon-${spec.role.toLowerCase()}`, spec.agentId))
  recordSpawn({
    kind: 'long-lived',
    id: spec.agentId,
    cwd: spec.cwd ?? process.cwd(),
    role: spec.role,
  })
  logForDebugging(
    `[daemon] spawning long-lived stream-json child role=${spec.role} model=${spec.model} effort=${spec.effort}`,
  )
  const child = spawn(node, argv, {
    cwd: spec.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env,
  })
  return { child, argv, env }
}

export function runTaskHeadless(
  spec: HeadlessSpec,
  dir: string,
  onChild?: (child: ChildProcess) => void,
  timeoutMs: number = getRunTimeoutMs(),
): Promise<HeadlessResult> {
  return new Promise(resolvePromise => {
    const { node, script } = getSelfInvocation()
    if (!script) {
      logForDebugging(
        `[daemon] cannot resolve self executable; skipping run ${spec.id}`,
      )
      resolvePromise({ stdout: '', code: 1 })
      return
    }

    logForDebugging(`[daemon] running ${spec.id} headlessly`)
    let child: ChildProcess
    try {
      const oneShotEnv = cloneEnvWithoutRoles()
      stampFlagOnEnv(oneShotEnv, WORKER_PARENT_PID_ENV, String(process.pid))
      stampFlagOnEnv(oneShotEnv, SPAWNED_BY_ENV, spawnedByStamp('daemon-fire', spec.id))
      const cwdGate = assertSpawnCwd(dir)
      if (!cwdGate.ok) {
        recordSpawn({ kind: 'headless-refused', id: spec.id, cwd: dir, reason: cwdGate.reason })
        logForDebugging(`[daemon] REFUSED headless fire for ${spec.id}: ${cwdGate.reason}`)
        resolvePromise({ stdout: `refused: ${cwdGate.reason}`, code: 1 })
        return
      }
      recordSpawn({ kind: 'headless', id: spec.id, cwd: dir })
      child = spawn(
        node,
        [
          script,
          '-p',
          ...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode)),
          ...(spec.allowedTools && spec.allowedTools.length > 0
            ? ['--allowedTools', ...spec.allowedTools]
            : []),
          ...(spec.resumeSessionId ? ['--resume', spec.resumeSessionId] : []),
          spec.prompt,
        ],
        {
        cwd: dir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: oneShotEnv,
      })
    } catch (e) {
      logForDebugging(`[daemon] spawn failed for ${spec.id}: ${e}`)
      recordSpawnExit({
        kind: 'headless',
        event: 'exit',
        id: spec.id,
        code: 1,
        outcome: 'spawn-failed',
        reason: String(e),
      })
      resolvePromise({ stdout: '', code: 1 })
      return
    }

    onChild?.(child)

    let stdout = ''
    const maxBuf = getRunMaxBufBytes()
    let settled = false
    let wasTimedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (killCloseBackstop) clearTimeout(killCloseBackstop)
      recordSpawnExit({
        kind: 'headless',
        event: 'exit',
        id: spec.id,
        pid: child.pid,
        code,
        outcome: wasTimedOut ? 'timeout' : code === 0 ? 'ok' : code === null ? 'killed' : 'failed',
      })
      resolvePromise({
        stdout,
        code,
        pid: child.pid,
        ...(wasTimedOut ? { timedOut: true } : {}),
      })
    }

    const KILL_CLOSE_BACKSTOP_MS = 2_000
    let killCloseBackstop: ReturnType<typeof setTimeout> | undefined
    const finishOnCloseWithBackstop = () => {
      if (settled || killCloseBackstop) return
      killCloseBackstop = setTimeout(() => finish(null), KILL_CLOSE_BACKSTOP_MS)
      killCloseBackstop.unref?.()
    }

    const timer = setTimeout(() => {
      wasTimedOut = true
      const graceMs = getRunKillGraceMs()
      logForDebugging(
        `[daemon] run ${spec.id} timed out — SIGTERM (SIGKILL in ${graceMs}ms if still alive)`,
      )
      killProcessTree(child, 'SIGTERM')
      if (graceMs <= 0) {
        killProcessTree(child, 'SIGKILL')
        finishOnCloseWithBackstop()
        return
      }
      killTimer = setTimeout(() => {
        logForDebugging(`[daemon] run ${spec.id} grace elapsed — SIGKILL`)
        killProcessTree(child, 'SIGKILL')
        finishOnCloseWithBackstop()
      }, graceMs)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', d => {
      stdout += d
      if (stdout.length > maxBuf) stdout = stdout.slice(-maxBuf)
    })
    child.on('error', e => {
      logForDebugging(`[daemon] child error for ${spec.id}: ${e}`)
      finish(1)
    })
    child.on('close', code => finish(code))
  })
}

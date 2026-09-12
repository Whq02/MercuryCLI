import { spawn, spawnSync } from 'node:child_process'
import { endProcessTree, endProcessTreeSurvivors, win32TaskkillCommand, type ProcessTreeKillReceipt } from '../../../utils/processGroup.js'
import { subprocessEnv } from '../../../utils/subprocessEnv.js'
import { runningGodotProcesses, type GodotProcess } from '../godotProcessCensus.js'
import { isEnginePath } from './paths.js'
import { engineUserEnv } from './userDir.js'

export const ENGINE_OUTPUT_CAP = 64 * 1024 * 1024

export type EngineKillReason = 'timeout' | 'cancel' | 'budget' | 'shutdown'

export interface EngineSpawnRequest {
  executable: string
  args: string[]
  cwd: string
  userDir: string
  timeoutMs: number
  label: string
}

export interface EngineSpawnOutcome {
  pid: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  spawnError: string | null
  killed: EngineKillReason | null
  killReceipt: ProcessTreeKillReceipt | null
  output: string
  truncated: boolean
  seconds: number
  startedAt: string
  endedAt: string
}

export interface EngineHandle {
  label: string
  pid: number | null
  startedAt: string
  done: Promise<EngineSpawnOutcome>
  kill(reason: EngineKillReason): Promise<ProcessTreeKillReceipt>
}

const LIVE = new Map<number, EngineHandle>()
let exitHookArmed = false

function killLiveEnginesSync(): void {
  for (const pid of LIVE.keys()) {
    try {
      if (process.platform === 'win32') {
        const { file, args } = win32TaskkillCommand(pid)
        spawnSync(file, args, { windowsHide: true, stdio: 'ignore', timeout: 5_000, env: subprocessEnv() })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        continue
      }
    }
  }
}

function armExitHook(): void {
  if (exitHookArmed) return
  exitHookArmed = true
  process.once('exit', killLiveEnginesSync)
}

function tenths(ms: number): number {
  return Math.round(ms / 100) / 10
}

export function spawnEngine(req: EngineSpawnRequest): EngineHandle {
  armExitHook()
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const chunks: string[] = []
  let size = 0
  let truncated = false
  let spawnError: string | null = null
  let killed: EngineKillReason | null = null
  let killReceipt: ProcessTreeKillReceipt | null = null
  let settled = false
  let killInFlight: Promise<ProcessTreeKillReceipt> | null = null
  let resolveDone: (o: EngineSpawnOutcome) => void = () => {}
  const done = new Promise<EngineSpawnOutcome>(resolve => {
    resolveDone = resolve
  })
  const env = { ...subprocessEnv(), ...engineUserEnv(req.userDir) }
  const child = spawn(req.executable, req.args, {
    cwd: req.cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const onData = (buf: Buffer): void => {
    if (size >= ENGINE_OUTPUT_CAP) {
      truncated = true
      return
    }
    const text = buf.toString('utf8')
    size += text.length
    chunks.push(text)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  const pid = typeof child.pid === 'number' ? child.pid : null
  const handle: EngineHandle = {
    label: req.label,
    pid,
    startedAt,
    done,
    async kill(reason) {
      if (settled) return { ended: 0, survivors: [] }
      if (killInFlight) return killInFlight
      killed = reason
      killInFlight = (async () => {
        let receipt = await endProcessTree(child, 'SIGKILL')
        if (receipt.survivors.length > 0 && pid !== null) receipt = await endProcessTreeSurvivors(pid, receipt.survivors)
        killReceipt = receipt
        return receipt
      })()
      return killInFlight
    },
  }
  if (pid !== null) LIVE.set(pid, handle)
  let timer: NodeJS.Timeout | null = null
  if (req.timeoutMs > 0) {
    timer = setTimeout(() => {
      void handle.kill('timeout')
    }, req.timeoutMs)
  }
  const settle = (exitCode: number | null, signal: string | null): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (pid !== null) LIVE.delete(pid)
    const endedAt = new Date().toISOString()
    const seconds = tenths(Date.now() - t0)
    const finish = (): void =>
      resolveDone({
        pid,
        exitCode,
        signal,
        timedOut: killed === 'timeout',
        spawnError,
        killed,
        killReceipt,
        output: chunks.join('') + (truncated ? `\n[mercury: engine output truncated after ${ENGINE_OUTPUT_CAP} characters]\n` : ''),
        truncated,
        seconds,
        startedAt,
        endedAt,
      })
    if (killInFlight) {
      void killInFlight.then(finish, finish)
      return
    }
    finish()
  }
  child.on('error', err => {
    spawnError = err.message
    if (pid === null) settle(null, null)
  })
  child.on('close', (code, signal) => settle(code, signal))
  return handle
}

export function liveEngines(): Array<{ pid: number; label: string; startedAt: string }> {
  return [...LIVE.values()].map(h => ({ pid: h.pid ?? 0, label: h.label, startedAt: h.startedAt }))
}

export async function killAllEngines(reason: EngineKillReason = 'shutdown'): Promise<number> {
  let ended = 0
  for (const handle of [...LIVE.values()]) {
    const receipt = await handle.kill(reason)
    ended += receipt.ended
  }
  return ended
}

export interface EngineOrphanSweep {
  pid: number
  project: string
  executable: string
  receipt: ProcessTreeKillReceipt
}

export async function sweepEngineOrphans(projectRoot: string, census?: GodotProcess[]): Promise<EngineOrphanSweep[]> {
  const processes = census ?? (await runningGodotProcesses())
  const out: EngineOrphanSweep[] = []
  for (const p of processes) {
    if (!p.project || LIVE.has(p.pid) || !isEnginePath(projectRoot, p.project)) continue
    const receipt = await endProcessTree(p.pid, 'SIGKILL')
    out.push({ pid: p.pid, project: p.project, executable: p.executable, receipt })
  }
  return out
}

export function engineProcessesFor(projectRoot: string, processes: readonly GodotProcess[]): GodotProcess[] {
  return processes.filter(p => p.project !== undefined && isEnginePath(projectRoot, p.project))
}

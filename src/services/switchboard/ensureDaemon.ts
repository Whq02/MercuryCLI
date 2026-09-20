import { join } from 'node:path'
import { daemonDir, daemonLastUnreachableAt, readSupervisorState } from '../../daemon/controlSocket.js'
import type { DaemonHandshakeVerdict } from '../../daemon/handshake.js'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { probePidLock } from '../../substrate/pidLock.js'
import { getCwd } from '../../utils/cwd.js'
import { daemonHaltStanddownActive } from '../../utils/daemonStanddown.js'
import { runnerArgvFromBoot } from './runnerArgv.js'

type Handshake = typeof import('../../daemon/handshake.js')

let healing: Promise<boolean> | null = null

function usable(v: DaemonHandshakeVerdict): boolean {
  return v.state === 'matched' || v.state === 'rebuilt' || v.state === 'older' || v.state === 'newer'
}

const USABLE_MEMO_TTL_MS = 5_000
let usableMemo: { at: number } | null = null
function usableMemoActive(now = Date.now()): boolean {
  return usableMemo !== null && now - usableMemo.at < USABLE_MEMO_TTL_MS && daemonLastUnreachableAt() < usableMemo.at
}
function rememberUsable(): true {
  usableMemo = { at: Date.now() }
  return true
}
export function _daemonUsableMemoActiveForProofs(): boolean {
  return usableMemoActive()
}
export function _resetDaemonUsableMemoForProofs(): void {
  usableMemo = null
}

function adoptIfOurs(v: DaemonHandshakeVerdict): void {
  const d = v.daemon
  if (d === null || d.ownerPid !== process.pid || d.pid === null) return
  const pid = d.pid
  void import('../../daemon/ownedDaemon.js')
    .then(m => m.adoptOwnedDaemonPid(pid))
    .catch(() => {})
}

async function awaitUsable(hs: Handshake, tries = ladderRounds()): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const v = await hs.handshakeDaemon({ timeoutMs: 500 })
    if (usable(v)) {
      adoptIfOurs(v)
      return rememberUsable()
    }
    await new Promise(res => setTimeout(res, 250))
  }
  return false
}

const LADDER_ROUNDS = 40
let ladderRoundsForProofs: number | null = null
export function _setDaemonLadderRoundsForProofs(rounds: number | null): void {
  ladderRoundsForProofs = rounds
}
function ladderRounds(): number {
  return ladderRoundsForProofs ?? LADDER_ROUNDS
}

type PlaneHold = 'clear' | 'stopping' | 'held'

async function planeHold(): Promise<PlaneHold> {
  const record = await readSupervisorState()
  if (record !== null && isProcessAlive(record.pid)) return record.state === 'stopping' ? 'stopping' : 'held'
  const holder = await probePidLock(join(daemonDir(), 'supervisor.lock'), { liveness: 'assume-alive', cachedLiveness: true })
  return holder === null ? 'clear' : 'held'
}

async function awaitUsableOrGone(hs: Handshake, tries = ladderRounds()): Promise<'usable' | 'gone' | 'timeout'> {
  for (let i = 0; i < tries; i++) {
    const v = await hs.handshakeDaemon({ timeoutMs: 500 })
    if (usable(v)) {
      adoptIfOurs(v)
      rememberUsable()
      return 'usable'
    }
    if (v.state === 'absent' && (await planeHold()) === 'clear') return 'gone'
    await new Promise(res => setTimeout(res, 250))
  }
  return 'timeout'
}

async function awaitDeparture(hs: Handshake, tries = ladderRounds()): Promise<'clear' | 'usable'> {
  for (let i = 0; i < tries; i++) {
    const hold = await planeHold()
    if (hold === 'clear') return 'clear'
    if (hold === 'held') {
      const v = await hs.handshakeDaemon({ timeoutMs: 500 })
      if (usable(v)) {
        adoptIfOurs(v)
        rememberUsable()
        return 'usable'
      }
    }
    await new Promise(res => setTimeout(res, 250))
  }
  return 'clear'
}

async function awaitSuccessor(hs: Handshake, oldPid: number | null, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const v = await hs.handshakeDaemon({ timeoutMs: 500 })
    if (usable(v) && (v.daemon?.pid ?? null) !== oldPid) {
      adoptIfOurs(v)
      return rememberUsable()
    }
    await new Promise(res => setTimeout(res, 250))
  }
  return false
}

export async function warmSessionRunner(workspaceDir: string, retiring?: string): Promise<boolean> {
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const { bootBirthFacts, carriedConsentOf, carriedKitOf } = await import('./bootBirthFacts.js')
    const reply = (await daemonControlRpc(
      {
        op: 'concourseWarm',
        workspaceDir,
        ...(retiring !== undefined ? { retiring } : {}),
        ...carriedConsentOf(bootBirthFacts()),
        ...(bootCarriesRunnerOptions() ? { runnerOptionsPresent: true } : {}),
        ...carriedKitOf(bootBirthFacts()),
      } as never,
      { timeoutMs: 5_000 },
    )) as { ok?: boolean; state?: string }
    return reply.ok === true && (reply.state === 'warmed' || reply.state === 'kept')
  } catch {
    return false
  }
}

let bootRunnerOptionsMemo: boolean | null = null
function bootCarriesRunnerOptions(): boolean {
  if (bootRunnerOptionsMemo !== null) return bootRunnerOptionsMemo
  try {
    bootRunnerOptionsMemo = runnerArgvFromBoot(process.argv.slice(2)).length > 0
  } catch {
    bootRunnerOptionsMemo = false
  }
  return bootRunnerOptionsMemo
}

let waiting: Promise<'usable' | 'gone' | 'timeout'> | null = null

export async function ensureOwnedDaemon(): Promise<boolean> {
  void import('../../daemon/ownedDaemon.js')
    .then(m => m.armDaemonSignInPoke())
    .catch(() => {})
  if (usableMemoActive() && !daemonHaltStanddownActive()) return true
  const hs = await import('../../daemon/handshake.js')
  const first = await hs.handshakeDaemon({ timeoutMs: 500 })
  if (first.state === 'starting') {
    waiting ??= awaitUsableOrGone(hs).finally(() => {
      waiting = null
    })
    const outcome = await waiting
    if (outcome === 'usable') return true
    if (outcome === 'gone') return ensureOwnedDaemon()
    return false
  }
  if (usable(first)) {
    adoptIfOurs(first)
    if (first.state === 'matched') return rememberUsable()
    const heal = await hs.healDaemonVersion(first, { by: `screen ${process.pid}` })
    if (heal.state !== 'restarting') return rememberUsable()
    if (await awaitSuccessor(hs, first.daemon?.pid ?? null)) return rememberUsable()
  }
  if (daemonHaltStanddownActive()) return false
  if (healing === null) {
    healing = (async () => {
      try {
        if ((await awaitDeparture(hs)) === 'usable') return true
        const { spawnOwnedDaemon } = await import('../../daemon/ownedDaemon.js')
        const daemonExtraEnv: Record<string, string> = {}
        if (bootCarriesRunnerOptions()) {
          daemonExtraEnv.MERCURY_DAEMON_NO_SELF_WARM = '1'
        } else {
          const { bootBirthFacts } = await import('./bootBirthFacts.js')
          if (bootBirthFacts().bypassConsent) daemonExtraEnv.MERCURY_DAEMON_SELF_WARM_CONSENT = '1'
        }
        const pid = spawnOwnedDaemon(getCwd(), {
          label: 'switchboard',
          ...(Object.keys(daemonExtraEnv).length > 0 ? { extraEnv: daemonExtraEnv } : {}),
        })
        if (pid === undefined) return false
        return await awaitUsable(hs)
      } catch {
        return false
      } finally {
        healing = null
      }
    })()
  }
  return healing
}

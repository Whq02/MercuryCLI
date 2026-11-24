#!/usr/bin/env bun
import { mock } from 'bun:test'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')
const HINT = 'check ensureOwnedDaemon and warmSessionRunner in src/daemon/switchboard/ensureDaemon.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : ''}`)
}

type Verdict = { state: string; daemon: { pid: number | null; ownerPid: number | null } | null }
const verdict = (state: string, pid: number | null = null): Verdict => ({ state, daemon: pid === null ? null : { pid, ownerPid: null } })
const world = { verdicts: [] as Verdict[], rest: verdict('absent'), spawns: [] as Array<{ dir: string; env: Record<string, string | undefined> }>, rpcs: [] as Array<Record<string, unknown>> }
const begin = (verdicts: Verdict[], rest: Verdict): void => {
  world.verdicts = verdicts
  world.rest = rest
  world.spawns = []
  world.rpcs = []
}

const handshakePath = join(SRC, 'daemon/control/handshake.ts')
const ownedDaemonPath = join(SRC, 'daemon/control/ownedDaemon.ts')
const controlSocketPath = join(SRC, 'daemon/control/controlSocket.ts')
const ownerWatchPath = join(SRC, 'daemon/control/ownerWatch.ts')
const pidLockPath = join(SRC, 'platform/substrate/pidLock.ts')
const standdownPath = join(SRC, 'daemon/control/daemonStanddown.ts')
const presencePath = join(SRC, 'daemon/switchboard/screenPresence.ts')

const handshake = await import(handshakePath)
const ownedDaemon = await import(ownedDaemonPath)
const controlSocket = await import(controlSocketPath)
const ownerWatch = await import(ownerWatchPath)
const pidLock = await import(pidLockPath)
const standdown = await import(standdownPath)
const presence = await import(presencePath)
const facts = await import(join(SRC, 'daemon/switchboard/bootBirthFacts.ts'))

mock.module(handshakePath, () => ({
  ...handshake,
  handshakeDaemon: async () => world.verdicts.shift() ?? world.rest,
  handoverInFlightFor: () => false,
}))
mock.module(ownedDaemonPath, () => ({
  ...ownedDaemon,
  armDaemonSignInPoke: () => {},
  adoptOwnedDaemonPid: () => {},
  spawnOwnedDaemon: (dir: string, opts?: { extraEnv?: Record<string, string | undefined> }) => {
    world.spawns.push({ dir, env: { ...(opts?.extraEnv ?? {}) } })
    return 5151
  },
}))
mock.module(controlSocketPath, () => ({
  ...controlSocket,
  daemonLastUnreachableAt: () => 0,
  readDaemonState: async () => null,
  daemonControlRpc: async (request: Record<string, unknown>) => {
    world.rpcs.push(request)
    return { ok: true, op: request.op, state: 'warmed' }
  },
}))
mock.module(ownerWatchPath, () => ({ ...ownerWatch, isProcessAlive: () => true }))
mock.module(pidLockPath, () => ({ ...pidLock, probePidLock: async () => null }))
mock.module(standdownPath, () => ({ ...standdown, daemonHaltStanddownActive: () => false }))
mock.module(presencePath, () => ({ ...presence, startScreenPresenceBeat: () => false }))

const ensure = await import(join(SRC, 'daemon/switchboard/ensureDaemon.ts'))
const noPause = async (): Promise<void> => {}
const keysOf = (env: Record<string, string | undefined>): string => Object.keys(env).sort().join(',')
const holds = (env: Record<string, string | undefined>, word: string): boolean => Object.entries(env).some(([key, value]) => key.includes(word) && value === '1')

console.log('1. a launch that consents stamps the consent and holds nothing')
facts.setBootBirthFacts({ bypassConsent: true })
ensure._resetDaemonUsableMemoForProofs()
begin([verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151))
const plain = await ensure.ensureOwnedDaemon({ sleep: noPause })
check('it answers usable after one spawn', plain === true && world.spawns.length === 1, `${plain} ${world.spawns.length}`)
check('the spawn carries the consent stamp and no hold', holds(world.spawns[0]?.env ?? {}, 'SELF_WARM_CONSENT') && !holds(world.spawns[0]?.env ?? {}, 'NO_SELF_WARM'), keysOf(world.spawns[0]?.env ?? {}))
facts.setBootBirthFacts({ bypassConsent: false })
ensure._resetDaemonUsableMemoForProofs()
begin([verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151))
await ensure.ensureOwnedDaemon({ sleep: noPause })
check('a launch that does not consent stamps nothing', keysOf(world.spawns[0]?.env ?? {}) === '', keysOf(world.spawns[0]?.env ?? {}))

console.log('2. ensureOwnedDaemon and warmSessionRunner at once: one spawn and one warm ask that carries the consent')
facts.setBootBirthFacts({ bypassConsent: true })
ensure._resetDaemonUsableMemoForProofs()
begin([verdict('absent'), verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151))
const [first, warmed] = await Promise.all([ensure.ensureOwnedDaemon({ sleep: noPause }), ensure.warmSessionRunner('/work/folder')])
check('both answer true', first === true && warmed === true, `${first} ${warmed}`)
check('one spawn for the two', world.spawns.length === 1, `${world.spawns.length}`)
check('one warm ask, for the folder, with the consent', world.rpcs.length === 1 && world.rpcs[0]?.op === 'concourseWarm' && world.rpcs[0]?.workspaceDir === '/work/folder' && world.rpcs[0]?.bypassConsent === true, JSON.stringify(world.rpcs))

console.log('3. the warm ask alone starts the daemon itself; with no daemon to be had it asks nothing')
facts.setBootBirthFacts({ bypassConsent: false })
ensure._resetDaemonUsableMemoForProofs()
begin([verdict('absent'), verdict('matched', 5151)], verdict('matched', 5151))
const alone = await ensure.warmSessionRunner('/work/folder')
check('it spawns once and asks once', alone === true && world.spawns.length === 1 && world.rpcs.length === 1, `${alone} ${world.spawns.length} ${world.rpcs.length}`)
check('the ask carries no consent', world.rpcs[0]?.bypassConsent === undefined, JSON.stringify(world.rpcs[0]))
ensure._resetDaemonUsableMemoForProofs()
ensure._setDaemonLadderRoundsForProofs(2)
begin([], verdict('absent'))
const none = await ensure.warmSessionRunner('/work/folder')
check('a daemon that never answers: false, and no warm ask is sent', none === false && world.rpcs.length === 0, `${none} ${world.rpcs.length}`)
ensure._setDaemonLadderRoundsForProofs(null)

console.log(failures === 0 ? '\nprove-early-daemon-bare-launch: green' : `\nprove-early-daemon-bare-launch: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

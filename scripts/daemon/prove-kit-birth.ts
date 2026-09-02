#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-kit-birth.ts — EVERY BIRTH DOOR STAMPS TRUE (ledger
// L24(1)–(5) + L24(6-SUPERSEDED)): the warm pool boots
//  wearing the next birth's kit and the claim lands only on kit equality,
//  so a claimed record can never wear a kit its process did not boot —
//  record.kit ≡ the process's effective kit after EVERY claim road.
//
//   §G THE WARM-CLAIM KIT GATE (the kit estate's top open hole, closed):
//      G1 the warm spawn WEARS the workspace's derived kit (POISON: the
//         kit-less warm boot — a whole-config process under a kit-stamped
//         record);
//      G2 an ensure carrying the screen's kit boots THAT kit, not the
//         derivation;
//      G3 ensure kit-drift: a live runner wearing yesterday's kit retires
//         and the current one warms; same-kit ensure keeps (no churn);
//      (G4+ land with the claim-gate commit.)
//
//  cpu-pure: a scripted roster port (registrations land without a spawn),
//  the config store in a scratch home, the REAL ensure/claim policy under
//  test. Never a daemon, a PTY, or a Mercury boot. DEEPSEEK_API_KEY is the
//  fixture presence sentinel 'fixture-not-a-key' (existence, never
//  validity — nothing here calls a provider); a box where no family
//  answers skips the ensure-driven pins with a NOTE.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-kit-birth.ts
// ============================================================================
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'kit-birth-home-'))
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_SESSION_KIT
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({
  ...c,
  switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 },
  // Two configured user-scope servers so the derivation has members to
  // list (and a menu delta below has something real to turn off).
  mcpServers: {
    alpha: { type: 'stdio', command: 'true', args: [], env: {} },
    beta: { type: 'stdio', command: 'true', args: [], env: {} },
  } as never,
}))

// The fixture presence sentinel — set BEFORE the registry composes.
process.env.DEEPSEEK_API_KEY = 'fixture-not-a-key'
const wm = await import('../../src/services/concourse/workerModels.ts')
const registry = await wm.composeWorkerModelRegistry()
const AVAILABLE = registry.entries.find(e => e.session.availability === 'available')?.modelId
const ENSURE_SKIP = AVAILABLE === undefined ? 'skipped — no dispatchable family in this scratch home (the fixture presence did not land)' : ''

const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const { deriveSessionKitForWorkspace, validateSessionKit } = await import('../../src/daemon/sessionKit.ts')
const { setMcpServerEnabledForWorkspace } = await import('../../src/services/mcp/kitStore.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function note(line: string): void {
  console.log(`  [NOTE] ${line}`)
}
const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

type Spec = ReturnType<typeof buildConcourseWorkerSpec>
type Kit = ReturnType<typeof deriveSessionKitForWorkspace>

/** The pool's roster port, scripted (the prove-warm-runner shape): the
 *  claim ack replays through the REAL onWarmRunnerLine waiter machinery. */
class FakeRoster {
  registered: Array<{ short: string; spec: Spec }> = []
  controls: Array<{ short: string; frame: string }> = []
  killed: string[] = []
  patched: Array<{ short: string; patch: { model: string; effort: string; respawnExtraArgv: readonly string[] } }> = []
  present = new Map<string, { alive: boolean; ready: boolean }>()
  answer: 'success' | 'error' | 'never' = 'success'
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const p = this.present.get(short)
    return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
  }
  list(): Array<{ short: string; outcome?: string }> {
    return [...this.present.keys()].map(short => ({ short }))
  }
  registerLongLived(short: string, spec: Spec): { ok: boolean; pid?: number; error?: string } {
    this.registered.push({ short, spec })
    this.present.set(short, { alive: true, ready: true })
    return { ok: true, pid: process.pid }
  }
  control(short: string, frame: string): boolean {
    this.controls.push({ short, frame })
    const parsed = JSON.parse(frame) as { request_id?: string; request?: { subtype?: string } }
    if (this.answer !== 'never' && parsed.request?.subtype === 'claim_session' && typeof parsed.request_id === 'string') {
      const requestId = parsed.request_id
      const subtype = this.answer
      queueMicrotask(() =>
        warm.onWarmRunnerLine(
          JSON.stringify({
            type: 'control_response',
            response: { subtype, request_id: requestId, ...(subtype === 'error' ? { error: 'scripted refusal' } : {}) },
          }),
        ),
      )
    }
    return true
  }
  kill(short: string): boolean {
    this.killed.push(short)
    this.present.delete(short)
    return true
  }
  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[] },
  ): Spec | null {
    this.patched.push({ short, patch })
    const reg = this.registered.find(r => r.short === short)
    if (!reg) return null
    return { ...reg.spec, model: patch.model, effort: patch.effort, respawnExtraArgv: [...patch.respawnExtraArgv] }
  }
}

const recordsDir = mkdtempSync(join(tmpdir(), 'kit-birth-daemon-'))
const wsA = mkdtempSync(join(tmpdir(), 'kit-birth-ws-a-'))
const wsB = mkdtempSync(join(tmpdir(), 'kit-birth-ws-b-'))
mkdirSync(wsA, { recursive: true })
mkdirSync(wsB, { recursive: true })

const specKitOf = (spec: Spec): Kit | null => {
  const raw = (spec.extraEnv as Record<string, string> | undefined)?.MERCURY_SESSION_KIT
  if (raw === undefined) return null
  const verdict = validateSessionKit(JSON.parse(raw))
  return verdict.ok ? verdict.kit : null
}

console.log('============================================================')
console.log(' kit-birth — every birth door stamps true (the warm gate)')
console.log('============================================================')

// ── §G1-G3: the warm boot wears the menu kit ────────────────────────────────
console.log('\n── §G1-G3: the warm boot wears the menu kit ──')
if (ENSURE_SKIP !== '') {
  note(`G1–G3 ${ENSURE_SKIP}`)
} else {
  const roster = new FakeRoster()
  const warmDeps = { roster: () => roster, dir: recordsDir }
  // A real menu delta: beta OFF for wsA — the derivation must exclude it.
  setMcpServerEnabledForWorkspace(wsA, 'beta', false)
  const derivedA = deriveSessionKitForWorkspace(wsA)
  check('G1 the scratch menu delta landed in the derivation (beta off, alpha on — the fixture is real)', derivedA.resolved === false && derivedA.mcp.includes('alpha') && !derivedA.mcp.includes('beta') && (derivedA.deltas?.mcpOff ?? []).includes('beta'))
  const first = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('G1 the ensure warms', first.state === 'warmed', first.detail ?? first.state)
  const bootKit = roster.registered.length === 1 ? specKitOf(roster.registered[0]!.spec) : null
  check('G1 POISON armed: the warm spec WEARS the derived kit (a kit-less warm boot is the whole-config process a kit-stamped record would lie about)', bootKit !== null && deepEq(bootKit, derivedA))
  check('G1 the spec kit round-trips the wire narrowing (the runner re-validates the daemon bytes)', bootKit !== null)
  // Same menu ⇒ the ensure keeps (no churn).
  const kept = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('G3 a same-kit ensure KEEPS the one runner (no drift, no churn)', kept.state === 'kept' && roster.registered.length === 1 && roster.killed.length === 0)
  // The menu moves ⇒ kit drift retires the stale runner and warms the new kit.
  setMcpServerEnabledForWorkspace(wsA, 'beta', true)
  const drifted = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  const rewarmKit = roster.registered.length === 2 ? specKitOf(roster.registered[1]!.spec) : null
  check('G3 kit drift at the ensure: the stale runner retires and the current kit warms (POISON: a kept runner wearing yesterday\'s kit)', drifted.state === 'warmed' && roster.killed.length === 1 && rewarmKit !== null && rewarmKit.mcp.includes('beta'))
  check('G3 one runner per workspace after the drift', warm.warmRunnerCount() === 1)
  // A carried kit outranks the derivation (the L18 arming door).
  warm.resetWarmRunnersForTesting()
  roster.registered.length = 0
  const CARRIED: Kit = { schema: 1, mcp: ['alpha'], skills: ['ns:review'], invocable: ['deploy'] }
  const carried = await warm.ensureWarmRunner({ workspaceDir: wsB, kit: CARRIED }, warmDeps)
  const carriedBoot = roster.registered.length === 1 ? specKitOf(roster.registered[0]!.spec) : null
  check('G2 an ensure carrying the screen\'s kit boots THAT kit, not the derivation (the arming door is the L18 carry)', carried.state === 'warmed' && carriedBoot !== null && deepEq(carriedBoot, CARRIED))
  warm.resetWarmRunnersForTesting()
}

// ── §G4-G8: THE WARM-CLAIM KIT GATE (record ≡ process on every claim road) ──
console.log('\n── §G4-G8: the warm-claim kit gate ──')
if (ENSURE_SKIP !== '') {
  note(`G4–G8 ${ENSURE_SKIP}`)
} else {
  const { makeConcourseAdmitHandler, readSessionWorkers, updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { realpathSync } = await import('node:fs')
  const MODEL = AVAILABLE!
  // §G4/§G5 — the gate at the pool's own door (claimWarmRunner direct).
  {
    const roster = new FakeRoster()
    const warmDeps = { roster: () => roster, dir: recordsDir }
    const wsG = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-g-')))
    const ensured = await warm.ensureWarmRunner({ workspaceDir: wsG }, warmDeps)
    check('G4 the pool warms for the gate drive', ensured.state === 'warmed', ensured.detail ?? ensured.state)
    const booted = deriveSessionKitForWorkspace(wsG)
    const hit = await warm.claimWarmRunner(
      { workspaceId: wsG, sessionId: '11111111-2222-4333-8444-555555555555', modelKey: MODEL, effort: 'high', permissionMode: 'flow', kit: booted, answerDeadlineMs: 1_500 },
      warmDeps,
    )
    check('G4 an EQUAL-kit claim lands (the equality gate is the whole arithmetic)', hit.claimed === true && roster.controls.some(c => c.frame.includes('claim_session')))
    warm.resetWarmRunnersForTesting()
    roster.controls.length = 0
    roster.killed.length = 0
    const wsH = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-h-')))
    const ensured2 = await warm.ensureWarmRunner({ workspaceDir: wsH }, warmDeps)
    check('G5 the pool warms for the mismatch drive', ensured2.state === 'warmed', ensured2.detail ?? ensured2.state)
    const other: Kit = { schema: 1, mcp: [], skills: [], invocable: [] }
    const miss = await warm.claimWarmRunner(
      { workspaceId: wsH, sessionId: '11111111-2222-4333-8444-666666666666', modelKey: MODEL, effort: 'high', permissionMode: 'flow', kit: other, answerDeadlineMs: 1_500 },
      warmDeps,
    )
    check('G5 POISON armed: a MISMATCHED-kit claim DECLINES TYPED and retires the runner — never a whole-config (or wrong-kit) process under a kit-stamped record', miss.claimed === false && miss.claimed === false && miss.reason.includes('kit') && roster.killed.length === 1)
    check('G5 the gate sits BEFORE the wire: no claim_session control ever reached the mismatched runner', !roster.controls.some(c => c.frame.includes('claim_session')))
    check('G5 the pool is empty after the drift retire (the cold path owns the session)', warm.warmRunnerCount() === 0)
    warm.resetWarmRunnersForTesting()
  }
  // §G6 — THE HEADLINE at the admit: record.kit ≡ the claimed process's kit.
  {
    const roster = new FakeRoster()
    const warmDeps = { roster: () => roster, dir: recordsDir }
    const rewarms: Array<{ ws: string; kit: Kit | undefined }> = []
    const admit = makeConcourseAdmitHandler({
      roster: () => roster as never,
      dir: recordsDir,
      claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
      ensureWarm: (ws, kit) => rewarms.push({ ws, kit: kit as Kit | undefined }),
    })
    const wsI = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-i-')))
    setMcpServerEnabledForWorkspace(wsI, 'beta', false)
    const ensured = await warm.ensureWarmRunner({ workspaceDir: wsI }, warmDeps)
    check('G6 the pool warms wearing the menu derivation', ensured.state === 'warmed', ensured.detail ?? ensured.state)
    const bootedKit = specKitOf(roster.registered[roster.registered.length - 1]!.spec)
    const admitted = await admit({ workspaceDir: wsI, modelKey: MODEL, bornBlank: true })
    const rec = admitted.ok ? readSessionWorkers(recordsDir)[admitted.runnerId] : undefined
    check('G6 the derivation-road admit CLAIMS warm (menu untouched between warm and claim)', admitted.ok && roster.controls.some(c => c.frame.includes('claim_session')), admitted.ok ? '' : admitted.error)
    check('G6 THE HEADLINE PIN: the claimed record wears EXACTLY the kit the process booted (record ≡ process — the poison this lane closes: a kit-stamped record over a whole-config warm process)', rec !== undefined && bootedKit !== null && deepEq(rec.kit, bootedKit))
    await new Promise(resolve => setTimeout(resolve, 25))
    check('G6 the post-claim rewarm carries the claimed kit (the pool re-arms wearing what births carry)', rewarms.length >= 1 && rewarms[0]!.kit !== undefined && deepEq(rewarms[0]!.kit, rec?.kit))
    // The mismatch road: a screen-carried kit the pool never booted — the
    // claim declines, the COLD spawn wears the carried kit, and the record
    // stamps the same value (record ≡ process on the fallback too).
    rewarms.length = 0
    roster.controls.length = 0
    const wsJ = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-j-')))
    const ensured2 = await warm.ensureWarmRunner({ workspaceDir: wsJ }, warmDeps)
    check('G6 the pool warms for the mismatch admit', ensured2.state === 'warmed', ensured2.detail ?? ensured2.state)
    const SCREEN: Kit = { schema: 1, mcp: ['alpha'], skills: [], invocable: ['deploy'] }
    const cold = await admit({ workspaceDir: wsJ, modelKey: MODEL, bornBlank: true, kit: SCREEN })
    const coldRec = cold.ok ? readSessionWorkers(recordsDir)[cold.runnerId] : undefined
    const coldSpec = roster.registered[roster.registered.length - 1]!
    check('G6 the carried-kit admit DECLINED warm and spawned COLD on its own short', cold.ok && coldRec !== undefined && coldSpec.short === (cold.ok ? cold.runnerId : ''), cold.ok ? '' : cold.error)
    check('G6 record ≡ process on the cold fallback: the record and the spawn spec wear the SAME carried kit', coldRec !== undefined && deepEq(coldRec.kit, SCREEN) && deepEq(specKitOf(coldSpec.spec), SCREEN))
    check('G6 no claim control reached the mismatched runner (the gate preceded the wire)', !roster.controls.some(c => c.frame.includes('claim_session')))
    await new Promise(resolve => setTimeout(resolve, 25))
    check('G6 the DECLINE-side rewarm carries the declined kit (one cold spawn is the whole price of a menu edit)', rewarms.length >= 1 && deepEq(rewarms[0]!.kit, SCREEN))
    warm.resetWarmRunnersForTesting()
  }
  // §G7 — the reactivate's warm road: re-stamp ≡ booted kit; history rowed.
  {
    const roster = new FakeRoster()
    const warmDeps = { roster: () => roster, dir: recordsDir }
    const admit = makeConcourseAdmitHandler({
      roster: () => roster as never,
      dir: recordsDir,
      claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
    })
    const wsK = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-k-')))
    setMcpServerEnabledForWorkspace(wsK, 'alpha', false)
    const OLD: Kit = { schema: 1, mcp: ['old-server'], skills: [], invocable: [] }
    const parkedSid = '99999999-8888-4777-8666-555555555554'
    updateConcourseWorkers(workers => {
      workers['concourse-w7'] = {
        schema: 1,
        runnerId: 'concourse-w7',
        sessionId: parkedSid,
        workspaceId: wsK,
        isolation: 'shared',
        modelKey: MODEL,
        effort: 'high',
        spawnedAt: Date.now() - 60_000,
        lastLiveAt: Date.now() - 60_000,
        parkedAt: Date.now() - 30_000,
        parkedBy: 'operator',
        title: 'the parked chat',
        kit: OLD,
      } as never
    }, recordsDir)
    const ensured = await warm.ensureWarmRunner({ workspaceDir: wsK }, warmDeps)
    check('G7 the pool warms for the reactivate drive', ensured.state === 'warmed', ensured.detail ?? ensured.state)
    const bootedKit = specKitOf(roster.registered[roster.registered.length - 1]!.spec)
    const revived = await admit({ workspaceDir: wsK, resumeSessionId: parkedSid })
    const after = Object.values(readSessionWorkers(recordsDir)).find(r => r.sessionId === parkedSid && r.endedAt === undefined)
    const resumeFrame = roster.controls.map(c => JSON.parse(c.frame) as { request?: Record<string, unknown> }).find(f => f.request?.subtype === 'claim_session')
    check('G7 the reactivate took the WARM road (claim with resume:true)', revived.ok && resumeFrame !== undefined && resumeFrame.request?.resume === true, revived.ok ? '' : revived.error)
    check('G7 the re-stamp wears EXACTLY the booted kit (record ≡ process on the reactivate claim road; the parked kit is displaced, never reloaded)', after !== undefined && bootedKit !== null && deepEq(after.kit, bootedKit) && !deepEq(after.kit, OLD))
    check('G7 the derivation excluded the menu-off member on this road too', after?.kit !== undefined && !(after.kit.mcp ?? []).includes('alpha'))
    warm.resetWarmRunnersForTesting()
  }
}

// ── §R: the record-less resume derives LOUDLY (the receipt row) ─────────────
console.log('\n── §R: the record-less resume\'s loud row ──')
if (ENSURE_SKIP !== '') {
  note(`R1–R3 ${ENSURE_SKIP}`)
} else {
  const { makeConcourseAdmitHandler, readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const { realpathSync } = await import('node:fs')
  const MODEL = AVAILABLE!
  const roster = new FakeRoster()
  const admit = makeConcourseAdmitHandler({ roster: () => roster as never, dir: recordsDir })
  const wsL = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-l-')))
  const ghostSid = 'abcdabcd-1111-4222-8333-abcdabcdabcd'
  const resumed = await admit({ workspaceDir: wsL, resumeSessionId: ghostSid })
  const resumedRec = resumed.ok ? readSessionWorkers(recordsDir)[resumed.runnerId] : undefined
  const rows = readSessionReceipts(getProjectDir(wsL), ghostSid).filter(r => r.kind === 'kit-restamp')
  check('R1 POISON armed: a record-less bare-transcript resume writes the LOUD receipt row (the recordToEntry silent-default class, answered)', resumed.ok && rows.length === 1 && (rows[0]!.summary ?? '').includes('record-less resume'), resumed.ok ? `rows ${rows.length}` : resumed.error)
  check('R1 the row names the derived source and carries the stamped kit', rows.length === 1 && (rows[0]!.details as { source?: string } | undefined)?.source === 'derived' && deepEq((rows[0]!.details as { now?: unknown }).now, resumedRec?.kit))
  const wsM = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-m-')))
  const ghost2 = 'abcdabcd-1111-4222-8333-abcdabcdabce'
  const SCREEN: Kit = { schema: 1, mcp: ['alpha'], skills: [], invocable: [] }
  const carriedResume = await admit({ workspaceDir: wsM, resumeSessionId: ghost2, kit: SCREEN })
  const rows2 = readSessionReceipts(getProjectDir(wsM), ghost2).filter(r => r.kind === 'kit-restamp')
  check('R2 a CARRIED record-less resume rows the carried source (still loud — the road is named either way)', carriedResume.ok && rows2.length === 1 && (rows2[0]!.details as { source?: string } | undefined)?.source === 'carried')
  const wsN = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-n-')))
  const fresh = await admit({ workspaceDir: wsN, modelKey: MODEL, bornBlank: true })
  const freshRows = fresh.ok ? readSessionReceipts(getProjectDir(wsN), fresh.sessionId).filter(r => r.kind === 'kit-restamp') : []
  check('R3 POISON armed: a FRESH birth writes NO kit receipt row (the loud row is the resume road\'s, never a nag on every birth)', fresh.ok && freshRows.length === 0, fresh.ok ? `rows ${freshRows.length}` : fresh.error)
}

// ── §A: the answer names the kit source (carried | derived) ─────────────────
console.log('\n── §A: kit-source on the answer ──')
if (ENSURE_SKIP !== '') {
  note(`A1–A4 ${ENSURE_SKIP}`)
} else {
  const { makeConcourseAdmitHandler, updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const { realpathSync, readFileSync } = await import('node:fs')
  const MODEL = AVAILABLE!
  const roster = new FakeRoster()
  const admit = makeConcourseAdmitHandler({ roster: () => roster as never, dir: recordsDir })
  const wsO = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-o-')))
  const K: Kit = { schema: 1, mcp: ['alpha'], skills: [], invocable: [] }
  const carried = await admit({ workspaceDir: wsO, modelKey: MODEL, bornBlank: true, kit: K })
  check("A1 a carried-kit admit answers kitSource 'carried'", carried.ok && carried.kitSource === 'carried', carried.ok ? carried.kitSource ?? 'absent' : carried.error)
  const wsP = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-p-')))
  const derived = await admit({ workspaceDir: wsP, modelKey: MODEL, bornBlank: true })
  check("A2 a kit-less admit answers kitSource 'derived' (the fallback road, named)", derived.ok && derived.kitSource === 'derived', derived.ok ? derived.kitSource ?? 'absent' : derived.error)
  // A LIVE session's resume is a hop — no stamp, no source on the answer.
  const liveSid = 'abcdabcd-9999-4888-8777-abcdabcdabcf'
  const wsQ = realpathSync(mkdtempSync(join(tmpdir(), 'kit-birth-ws-q-')))
  updateConcourseWorkers(workers => {
    workers['concourse-w88'] = {
      schema: 1,
      runnerId: 'concourse-w88',
      sessionId: liveSid,
      workspaceId: wsQ,
      isolation: 'shared',
      modelKey: MODEL,
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      pid: process.pid,
      kit: K,
    } as never
  }, recordsDir)
  const hop = await admit({ workspaceDir: wsQ, resumeSessionId: liveSid })
  check('A3 POISON armed: a live-hop answer carries NO kitSource (a hop stamps nothing — the answer never claims a stamp that did not happen)', hop.ok && hop.kitSource === undefined, hop.ok ? hop.kitSource ?? 'absent' : hop.error)
  // The consumer needles: the receipts name the source in their own rows.
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const coord = read('src/services/concourse/coordinatorTools.ts')
  check('A4 the coordinator receipts speak the kit word on BOTH launch roads (contracted + plain)', coord.split('kit ${kitSource}').length === 3 && coord.split('{ kitSource }').length >= 3)
  const mgr = read('src/services/concourse/managerMode.ts')
  check('A4 the manager lane receipt speaks it too', mgr.includes('kit ${laneKitSource}'))
  const server = read('src/daemon/controlServer.ts')
  check('A4 the server forwards kitSource on the admit AND dispatch answers', server.split('r.kitSource !== undefined').length === 3)
}

// ── §C: the non-session strays (the one-law's census, extended) ─────────────
console.log('\n── §C: non-session children never latch a stray kit ──')
{
  const { readFileSync } = await import('node:fs')
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  // The Implementer spec lives in daemonMain's closure (not loadable pure);
  // the ACP env build sits inside the spawn path — both pinned by source
  // needle, the estate's W13 grammar. The crew and worker strips are
  // DRIVEN pins already (prove-kit-runner §N) — not re-pinned here.
  const dmain = read('src/daemon/main.ts')
  const implBlock = dmain.slice(dmain.indexOf("registerLongLived('implementer'"), dmain.indexOf("registerLongLived('implementer'") + 2400)
  check("C1 the Implementer spec strips the session-kit spellings (a full -p runner would latch a stray from the daemon's own env)", implBlock.includes("stripEnv: flagSpellings('MERCURY_SESSION_KIT')"))
  const acp = read('src/services/acp/childSession.ts')
  check('C2 the ACP child env drops the session-kit spellings AFTER every overlay (an IDE-hosted session never wears a kit nobody stamped)', acp.includes("flagSpellings('MERCURY_SESSION_KIT')) delete env[spelling]") && acp.includes('...process.env') && acp.indexOf('...process.env') < acp.indexOf("flagSpellings('MERCURY_SESSION_KIT')) delete env[spelling]"))
  const crew = read('src/daemon/crewSpawn.ts')
  check('C3 the crew strip stands untouched beside them (S1 law; the census is three named non-session doors + the worker strip list)', crew.includes("stripEnv: flagSpellings('MERCURY_SESSION_KIT')"))
}

// ── §S: IDENTICAL WORLDS — no world check on any birth road ─────────────────
// L24(6-SUPERSEDED): --chat = full boot minus the concourse; the kit path
// carries NO world checks anywhere. The sweep holds every birth/claim/
// revive/respawn/crew road file: a world token appearing in any of them is
// the dead L24(6) design leaking back in.
console.log('\n── §S: the identical-worlds sweep ──')
{
  const { readFileSync } = await import('node:fs')
  const BIRTH_ROAD_FILES = [
    'src/services/switchboard/bornSession.ts',
    'src/services/switchboard/hopIntoSession.ts',
    'src/services/switchboard/bootBirthFacts.ts',
    'src/services/switchboard/ensureDaemon.ts',
    'src/services/switchboard/attachedSession.ts',
    'src/daemon/concourseSupervisor.ts',
    'src/daemon/warmRunner.ts',
    'src/daemon/sessionKit.ts',
    'src/daemon/sessionKitOp.ts',
    'src/daemon/crewSpawn.ts',
    'src/daemon/controlServer.ts',
    'src/daemon/concourseDispatch.ts',
    'src/daemon/main.ts',
    'src/services/concourse/coordinatorTools.ts',
    'src/services/concourse/managerMode.ts',
    'src/services/mcp/sessionKitPin.ts',
    'src/services/mcp/kitCompletion.ts',
    'src/services/acp/childSession.ts',
  ]
  const WORLD_TOKENS = /chatOnlyBoot|chatOnly\b|plainWorld|plain-world|worldFact|isChatWorld|concourseOff|concourse-off/
  const hits: string[] = []
  for (const rel of BIRTH_ROAD_FILES) {
    const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
    if (WORLD_TOKENS.test(src)) hits.push(rel)
  }
  check(`S1 POISON armed: ZERO world-check tokens across all ${BIRTH_ROAD_FILES.length} birth-road files (identical worlds — the dead L24(6) design must never leak back into a birth door)`, hits.length === 0, hits.join(', '))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL KIT-BIRTH PROOFS PASS')
else console.log(`❌ ${failures} KIT-BIRTH PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

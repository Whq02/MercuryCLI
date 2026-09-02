#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-warm-runner.ts — the warm-runner pool's laws, driven
//  on the REAL policy (warmRunner.ts + makeConcourseAdmitHandler) over a
//  scratch home with a fake roster port. One pin per law:
//
//   W1  claim-over-spawn: an admission for the warm runner's workspace
//       CLAIMS it (the record adopts the warm short; no second spawn);
//   W2  spawn-when-none-matches: a different workspace spawns cold;
//   W3  one warm runner per workspace ('kept', no second registration);
//   W4  never a board record: an unclaimed warm runner writes NOTHING to
//       the durable records (looking still creates nothing);
//   W5  the claim control's shape + order: ONE claim_session carrying id,
//       model, posture and effort, acknowledged BEFORE the record mints;
//   W6  retire on idle: the sweep kills a runner past its own budget and
//       under it keeps it;
//   W7  retire on workspace switch: ensure(ws2, retiring ws1) kills ws1's;
//   W8  re-warm after a claim: the admit door re-arms the pool in the
//       background;
//   W9  a refused model refuses the CLAIM with the typed reason and the
//       warm runner SURVIVES for the next claim (the capability-session
//       law: validation precedes the claim);
//   W10 settings drift declines the claim (cold spawn; the stale runner
//       retires);
//   W11 the warm spec is the cold spec minus identity: no --session-id, no
//       --resume, no --name; the wire flags ride both legs; a claim
//       flips the respawn argv to --resume <id>;
//   W12 an unanswered claim declines within its deadline, retires the
//       runner, and the admission still serves the session cold;
//   W13 the seat-reading bound and the pool's construction pins hold in
//       source (ensure refuses past the ceiling; reconcile/idle-retirement
//       stay record-driven; the runner-side claim gate validates before
//       mutating);
//   W14 overlapping equal ensures share ONE flight (no double spawn);
//   W15 a different kit landing mid-flight is the ONE trailing rerun: the
//       newest kit preserved, a stale one never queued, an equal one still
//       joining, a mid-rerun arrival trailing the rerun in turn.
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-warm-runner.ts
// ============================================================================
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'warm-runner-home-'))
delete process.env.MERCURY_HOME
// The W ensure/claim legs ride the account-scoped model gate — keyless the
// scratch home refuses (no-credential:any) before the one-runner laws under
// test ever run. A fixture sign-in row satisfies resolution offline (the
// prove-daemon-env-scrub / prove-credential-wall fixture shape); the roster
// here is scripted, so no child runs and the token can never reach a wire.
writeFileSync(
  join(process.env.MERCURY_CONFIG_DIR, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
delete process.env.MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM

// The seat-ceiling read rides global config; the scratch home's is empty
// and valid — enable it the way the boot boundary does, then pin the
// stored consented-probe recommendation so the ceiling is deterministic
// here (resolveSeatCeiling honours it as-is; the machine reading varies).
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
function pinSeatCeiling(recommendedSeats: number): void {
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats } }))
}
pinSeatCeiling(8)
const { makeConcourseAdmitHandler, readSessionWorkers, buildConcourseWorkerSpec } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const warm = await import('../../src/daemon/warmRunner.ts')
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Spec = ReturnType<typeof buildConcourseWorkerSpec>

/** The pool's roster port, scripted: registrations, controls, kills and
 *  claim answers are all observable; the claim ack replays through the REAL
 *  onWarmRunnerLine waiter machinery. */
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
    // Our own pid: always alive, so the pool's liveness probe holds.
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

const recordsDir = mkdtempSync(join(tmpdir(), 'warm-runner-daemon-'))
const wsA = mkdtempSync(join(tmpdir(), 'warm-ws-a-'))
const wsB = mkdtempSync(join(tmpdir(), 'warm-ws-b-'))
// Fresh workspaces per claim scenario: an admitted exclusive session HOLDS
// its workspace, so a second fresh-session admit there would be the
// collision/git-offer path, not the claim path under test.
const wsC = mkdtempSync(join(tmpdir(), 'warm-ws-c-'))
const wsD = mkdtempSync(join(tmpdir(), 'warm-ws-d-'))
const wsE = mkdtempSync(join(tmpdir(), 'warm-ws-e-'))

const roster = new FakeRoster()
const warmDeps = { roster: () => roster, dir: recordsDir }
const rewarmed: string[] = []
const admit = makeConcourseAdmitHandler({
  roster: () => roster,
  dir: recordsDir,
  claimWarm: args => warm.claimWarmRunner({ ...args, answerDeadlineMs: 1_500 }, warmDeps),
  ensureWarm: workspaceDir => {
    rewarmed.push(workspaceDir)
  },
})

console.log('============================================================')
console.log(' warm-runner — the pool laws on the real policy')
console.log('============================================================')

// ── W3/W4/W11: ensure + the warm shape ──────────────────────────────────────
console.log('\n── W3/W4/W11: the warm spawn ──')
{
  const first = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('W- ensure warms a runner for workspace A', first.state === 'warmed', first.detail ?? '')
  const again = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('W3 a second ensure keeps the ONE runner (no second spawn)', again.state === 'kept' && roster.registered.length === 1)
  check('W4 an unclaimed warm runner writes NO durable record', Object.keys(readSessionWorkers(recordsDir)).length === 0)
  check('W- the status count names it', warm.warmRunnerCount() === 1)
  const spec = roster.registered[0]!.spec
  const argv = [...(spec.extraArgv ?? [])]
  check('W11 warm argv carries NO identity (--session-id/--resume/--name absent)', !argv.includes('--session-id') && !argv.includes('--resume') && !argv.includes('--name'))
  check('W11 warm argv keeps the wire flags (ask wire + live tail)', argv.includes('--permission-prompt-tool') && argv.includes('--include-partial-messages'))
  check('W11 warm respawn argv re-warms identityless too', ![...(spec.respawnExtraArgv ?? [])].includes('--resume'))
  const cold = buildConcourseWorkerSpec({ runnerId: 'concourse-w9', sessionId: '11111111-1111-4111-8111-111111111111', workspaceId: wsA, modelKey: spec.model, effort: 'high' })
  check('W11 the cold spec still pins --session-id (the warm arm changed nothing)', [...(cold.extraArgv ?? [])].includes('--session-id'))
}

// ── W9: a refused model refuses the CLAIM; the warm runner survives ─────────
console.log('\n── W9: refused model, surviving runner ──')
{
  const refused = await admit({ workspaceDir: wsA, modelKey: 'no-such-model-xyzzy' })
  check('W9 the admission refuses the bogus model with the typed reason', !refused.ok && refused.ok === false && refused.error.includes('model refused'))
  check('W9 the warm runner SURVIVES the refused claim', warm.warmRunnerCount() === 1 && roster.killed.length === 0)
  check('W9 no record was minted by the refusal', Object.keys(readSessionWorkers(recordsDir)).length === 0)
}

// ── W1/W5/W8: the claim ─────────────────────────────────────────────────────
console.log('\n── W1/W5/W8: claim-over-spawn ──')
{
  const warmShort = roster.registered[0]!.short
  const admitted = await admit({ workspaceDir: wsA, effort: 'max', title: 'the first chat' })
  check('W1 the admission claims the warm runner (the record adopts its short)', admitted.ok && admitted.ok === true && admitted.runnerId === warmShort)
  check('W1 no second spawn happened for the claim', roster.registered.length === 1)
  const records = readSessionWorkers(recordsDir)
  const rec = admitted.ok ? records[admitted.runnerId] : undefined
  check('W1 the record is an ordinary session record (workspace, model, effort, title)', rec !== undefined && rec.workspaceId === (admitted.ok ? admitted.workspaceId : '') && rec.effort === 'max' && rec.title === 'the first chat')
  check('W- the pool is empty after the claim', warm.warmRunnerCount() === 0)
  const claimFrames = roster.controls.filter(c => c.frame.includes('claim_session'))
  check('W5 exactly ONE claim control carried the whole identity', claimFrames.length === 1)
  if (claimFrames.length === 1 && admitted.ok) {
    const frame = JSON.parse(claimFrames[0]!.frame) as { request: Record<string, unknown> }
    check(
      'W5 the claim carries id + model + posture + effort',
      frame.request.session_id === admitted.sessionId &&
        typeof frame.request.model === 'string' &&
        frame.request.permission_mode === 'flow' &&
        frame.request.effort === 'max',
    )
    check('W5 the record mints the model the claim applied', rec !== undefined && rec.modelKey === frame.request.model)
  }
  check('W- the roster spec was patched to resume the claimed session', roster.patched.length === 1 && roster.patched[0]!.patch.respawnExtraArgv[0] === '--resume' && (admitted.ok ? roster.patched[0]!.patch.respawnExtraArgv[1] === admitted.sessionId : false))
  await new Promise(resolve => setTimeout(resolve, 25))
  check('W8 the pool re-warms in the background after the claim', rewarmed.length === 1 && rewarmed[0] === (admitted.ok ? admitted.workspaceId : ''))
}

// ── W2: no matching warm runner ⇒ cold spawn ────────────────────────────────
console.log('\n── W2: spawn when none matches ──')
{
  const before = roster.registered.length
  const admitted = await admit({ workspaceDir: wsB })
  check('W2 a workspace with no warm runner admits by spawning', admitted.ok === true && roster.registered.length === before + 1)
  const spec = roster.registered[roster.registered.length - 1]!.spec
  check('W2 the cold spawn pins its identity on argv', [...(spec.extraArgv ?? [])].includes('--session-id'))
}

// ── W7: workspace switch ────────────────────────────────────────────────────
console.log('\n── W7: retire on workspace switch ──')
{
  warm.resetWarmRunnersForTesting()
  roster.killed.length = 0
  const first = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check('W7 ws1 warms', first.state === 'warmed')
  const wsAShort = first.short ?? ''
  const second = await warm.ensureWarmRunner({ workspaceDir: wsB, retiring: wsA }, warmDeps)
  check('W7 the switch retires ws1 and warms ws2', second.state === 'warmed' && roster.killed.includes(wsAShort))
  check('W7 one runner lives after the switch', warm.warmRunnerCount() === 1)
}

// ── W6: retire on idle (the pool budget) ────────────────────────────────────
console.log('\n── W6: retire on idle ──')
{
  const now = Date.now()
  const under = warm.sweepIdleWarmRunners(warmDeps, { nowMs: now + 4 * 60_000 })
  check('W6 under the budget nothing retires (default 5m)', under === 0 && warm.warmRunnerCount() === 1)
  const over = warm.sweepIdleWarmRunners(warmDeps, { nowMs: now + 6 * 60_000 })
  check('W6 past the budget the runner retires', over === 1 && warm.warmRunnerCount() === 0)
}

// ── W12: an unanswered claim declines, retires, and the session lands cold ──
console.log('\n── W12: claim answer deadline ──')
{
  roster.answer = 'never'
  roster.killed.length = 0
  const ensured = await warm.ensureWarmRunner({ workspaceDir: wsC }, warmDeps)
  check('W12 a fresh runner warms', ensured.state === 'warmed', ensured.detail ?? '')
  const before = roster.registered.length
  const admitted = await admit({ workspaceDir: wsC })
  check('W12 the admission still serves the session (cold) after the silent claim', admitted.ok === true && roster.registered.length === before + 1)
  check('W12 the silent runner was retired (never handed words)', roster.killed.length === 1 && warm.warmRunnerCount() === 0)
  roster.answer = 'success'
}

// ── W10: settings drift declines the claim ──────────────────────────────────
console.log('\n── W10: settings drift ──')
{
  const ensured = await warm.ensureWarmRunner({ workspaceDir: wsD }, warmDeps)
  check('W10 a runner warms before the drift', ensured.state === 'warmed', ensured.detail ?? '')
  // Flip one startup-menu row in the process env: the effective-settings
  // fingerprint moves, exactly as an operator profile edit would.
  const row = STARTUP_MENU.find(r => process.env[r.env] === undefined)
  check('W10 a free menu row exists to drive the drift', row !== undefined, row?.env ?? 'none free')
  if (row !== undefined) {
    process.env[row.env] = '1'
    const before = roster.registered.length
    const admitted = await admit({ workspaceDir: wsD })
    check('W10 the drifted claim declines and the session spawns cold', admitted.ok === true && roster.registered.length === before + 1)
    check('W10 the stale runner retired', warm.warmRunnerCount() === 0)
    delete process.env[row.env]
  }
}

// ── W-off: the pool's gates (the census knob + runner-side options) ─────────
console.log('\n── W-off: the pool gates ──')
{
  process.env.MERCURY_WARM_RUNNER = '0'
  const off = await warm.ensureWarmRunner({ workspaceDir: wsA }, warmDeps)
  check("W-off MERCURY_WARM_RUNNER=0 refuses every warm spawn", off.state === 'refused' && (off.detail ?? '').includes('MERCURY_WARM_RUNNER=0'), off.detail ?? off.state)
  delete process.env.MERCURY_WARM_RUNNER
  const options = await warm.ensureWarmRunner({ workspaceDir: wsA, bootCarriesRunnerOptions: true }, warmDeps)
  check('W-off a boot with runner-side options never warms (a claim could not serve it)', options.state === 'refused' && (options.detail ?? '').includes('runner-side options'), options.detail ?? options.state)
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'switchboard', 'ensureDaemon.ts'), 'utf8')
  check('W-off the screen stamps NO_SELF_WARM onto an owned daemon for such boots', src.includes('MERCURY_DAEMON_NO_SELF_WARM') && src.includes('runnerArgvFromBoot(process.argv.slice(2))'))
  const dmainSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf8')
  check('W-off the boot self-warm honours the stamp', dmainSrc.includes("flagEnv('MERCURY_DAEMON_NO_SELF_WARM') !== '1'"))
}

// ── W-bound: the seat reading bounds the warm spawn ─────────────────────────
console.log('\n── W-bound: the seat reading ──')
{
  warm.resetWarmRunnersForTesting()
  const liveNow = Object.values(readSessionWorkers(recordsDir)).filter(
    r => r.endedAt === undefined && roster.present.has(r.runnerId),
  ).length
  check('W-bound live seats exist to press the bound', liveNow > 0, String(liveNow))
  pinSeatCeiling(liveNow)
  const refused = await warm.ensureWarmRunner({ workspaceDir: wsE }, warmDeps)
  check(
    'W-bound at the ceiling the warm spawn refuses (never a seat the board would refuse)',
    refused.state === 'refused' && (refused.detail ?? '').includes('seat reading'),
    refused.detail ?? refused.state,
  )
  pinSeatCeiling(liveNow + 2)
  const headroom = await warm.ensureWarmRunner({ workspaceDir: wsE }, warmDeps)
  check('W-bound with headroom the warm spawn proceeds', headroom.state === 'warmed', headroom.detail ?? '')
}

// ── W14: a settle-class reply rides the tail projection at once ─────────────
// The reveal law extended to settle messages (the lead's ruling on the
// timing stop): an assistant frame whose turn streamed no deltas publishes
// its text through the session-tail projection the moment it lands — the
// focused chat paints at projection cadence instead of file-pickup latency.
// The POISON is the file-pickup-only base, where no tail publish happens on
// a settle frame (the first assertion here fails on it by construction). A
// STREAMED turn keeps its delta/stop lifecycle: the settle frame never
// resurrects a cleared tail.
console.log('\n── W14: the settle reply on the tail ──')
{
  const { onSeatLine } = await import('../../src/daemon/sessionSeat.ts')
  const { readSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { updateConcourseWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const tailDir = mkdtempSync(join(tmpdir(), 'warm-tail-'))
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  updateConcourseWorkers(workers => {
    workers['concourse-w7'] = {
      schema: 1,
      runnerId: 'concourse-w7',
      sessionId: sid,
      workspaceId: wsA,
      isolation: 'exclusive',
      modelKey: 'claude-opus-5',
      effort: 'high',
      spawnedAt: Date.now(),
      lastLiveAt: Date.now(),
      settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] } as never,
      workspaceKind: 'plain-folder',
    } as never
  }, tailDir)
  const seatRoster = { control: () => true, list: () => [], patchSeatModel: () => true }
  const settleFrame = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The settle reply paints at once.' }] } })
  onSeatLine('concourse-w7', settleFrame, seatRoster as never, tailDir)
  check('W14 the settle text reaches the tail projection at once', readSessionTail(sid, tailDir)?.text === 'The settle reply paints at once.')
  onSeatLine('concourse-w7', JSON.stringify({ type: 'result', subtype: 'success' }), seatRoster as never, tailDir)
  check('W14 the turn result clears the tail (the row owns the text)', readSessionTail(sid, tailDir)?.text === null)
  // The streamed-turn guard: deltas ride the tail; the stop clears it; the
  // settle frame of a STREAMED turn does not resurrect it.
  onSeatLine('concourse-w7', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'stream' } } }), seatRoster as never, tailDir)
  check('W14 a streamed delta rides the tail as before', readSessionTail(sid, tailDir)?.text === 'stream')
  onSeatLine('concourse-w7', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop' } }), seatRoster as never, tailDir)
  onSeatLine('concourse-w7', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'stream' }] } }), seatRoster as never, tailDir)
  check('W14 a streamed turn\'s settle frame never resurrects the cleared tail', readSessionTail(sid, tailDir)?.text === null)
}

// ── W13: source pins (the seams bun cannot load in-process) ─────────────────
console.log('\n── W13: source pins ──')
{
  const read = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
  const pool = read('src/daemon/warmRunner.ts')
  check('W13 ensure refuses past the seat reading (the ceiling bound)', pool.includes('effectiveSeatCeiling()') && pool.includes('no headroom for a warm runner'))
  const idle = read('src/daemon/idleRetirement.ts')
  check('W13 idle retirement stays record-driven (readSessionWorkers — the warm runner is invisible by construction)', idle.includes('readSessionWorkers(opts.dir)') && !idle.includes('warmRunner'))
  const reconcile = read('src/daemon/reconcileRecords.ts')
  check('W13 reconcile stays supervisor-record-driven (no warm special case)', !reconcile.includes('warm'))
  const print = read('src/cli/print.ts')
  check('W13 the runner-side warm gate keys on the ABSENT identity (concourse role, no resume, no pinned id)', print.includes('options.bootSessionIdPinned !== true') && print.includes('awaitingSessionClaim'))
  check('W13 the claim validates everything BEFORE mutating (mode transition + effort ladder)', print.indexOf('claim refused —') !== -1 && print.indexOf('claim refused —') < print.indexOf('switchSession(sid as SessionId'))
  // Living shape: the claim CONSUMES the pin first (claimedHome) and the id
  // switch takes it — a resume keeps its own transcript home.
  check('W13 the claim consumes the transcript-home pin at the id switch (the setup.ts seam deferred)', print.includes('const claimedHome = consumeSessionHomePin()') && print.includes('switchSession(sid as SessionId, claimedHome)'))
  check('W13 the id-keyed wiring arms at claim time (wards/tabula/crew/room under the claimed id)', print.includes('await armSessionRunnerWiring(sid)'))
  check('W13 the pre-claim gate parks user frames (belt: the daemon orders claim before words)', print.includes('claimGatedInput'))
  check('W13 set_effort exists as the mid-session verb on the shared ladder', print.includes("case 'set_effort'"))
  const rosterSrc = read('src/daemon/roster.ts')
  check('W13 the roster claim patch flips the respawn argv (the claimed session resumes, never a fresh warm boot)', rosterSrc.includes('patchSeatClaim') && rosterSrc.includes('respawnExtraArgv: [...patch.respawnExtraArgv]'))
  const repl = read('src/screens/REPL.tsx')
  check('W13 the screen arms the pool from the SAME mount hook that pre-warms the daemon', repl.includes('warmSessionRunner(getCwd())'))
  const dmain = read('src/daemon/main.ts')
  check('W13 only an OWNED daemon self-warms at boot (owner-pid gated)', dmain.includes('parseOwnerPid() !== null') && dmain.includes('boot self-warm'))
  check('W13 the warm sweep rides the daemon minute tick', dmain.includes('sweepIdleWarmRunners(warmDeps)'))
  const statusSrc = read('src/daemon/status.ts')
  check('W13 daemon status names warm runners on their own honest line', statusSrc.includes('warm runner'))
  const registry = read('src/substrate/flagRegistry.ts')
  check('W13 the warm idle knob has its registry row', registry.includes('MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES'))
  // The new WIRE VERBS carry end-to-end pins (the prove-reconfigure
  // pattern: op union → request row → reply row → client auth stamp).
  const proto = read('src/daemon/protocol.ts')
  check("W13 DaemonOp includes 'concourseWarm' with request + reply rows", /\|\s*'concourseWarm'/.test(proto) && proto.includes("op: 'concourseWarm'") && proto.includes("ok: true; op: 'concourseWarm'"))
  check('W13 WireStatus carries warmRunners (optional-additive)', /warmRunners\?: number/.test(proto))
  const sock = read('src/daemon/controlSocket.ts')
  check('W13 the client stamps auth on concourseWarm (the keyed tier)', /'concourseWarm',\s*\]\)/.test(sock) || /AUTH_STAMPED_OPS[\s\S]{0,4000}'concourseWarm'/.test(sock))
  const types = read('src/entrypoints/sdk/controlTypes.ts')
  check('W13 claim_session and set_effort ride the control-request union', types.includes("subtype: 'claim_session'") && types.includes("subtype: 'set_effort'") && types.includes('SDKControlClaimSessionRequest') && types.includes('SDKControlSetEffortRequest'))
}

// ── W14: overlapping ensures share ONE flight (no double spawn) ─────────────
// The double-spawn window: ensure awaits the model validation between the
// empty-pool check and pool.set — two overlapping ensures for one workspace
// both passed the check, both registered a child, and the loser's runner was
// overwritten OUT of the pool: alive on the roster, invisible to the idle
// sweep (it reads the pool), retired only by daemon death.
console.log('\n── W14: overlapping ensures, one child ──')
{
  warm.resetWarmRunnersForTesting()
  const roster14 = new FakeRoster()
  const deps14 = { roster: () => roster14, dir: mkdtempSync(join(tmpdir(), 'warm-runner-daemon-14-')) }
  const wsF = mkdtempSync(join(tmpdir(), 'warm-ws-f-'))
  const [r1, r2] = await Promise.all([
    warm.ensureWarmRunner({ workspaceDir: wsF }, deps14),
    warm.ensureWarmRunner({ workspaceDir: wsF }, deps14),
  ])
  check('W14 exactly ONE child registered for two overlapping ensures', roster14.registered.length === 1, `registered=${roster14.registered.length}`)
  check('W14 both callers land the one runner (same short)', r1.state === 'warmed' && r2.state === 'warmed' && r1.short !== undefined && r1.short === r2.short, `${r1.state}/${String(r1.short)} vs ${r2.state}/${String(r2.short)}`)
  check('W14 the pool holds one entry', warm.warmRunnerCount() === 1)
  warm.resetWarmRunnersForTesting()
}

// ── W15: a warm-up requested while one is underway — the newest kit trails ──
// The overlap with a DIFFERENT kit: the boot self-warm (deriving), the
// screen's concourseWarm (a carried kit) and the post-claim rewarm fire
// un-serialized. Joining answered the newer request with the older kit's
// runner — its own kit dropped, its first claim declined to a cold spawn.
// The law: the NEWEST requested kit is preserved as exactly ONE trailing
// rerun after the running warm-up settles — never a queue of stale kits,
// never a dropped newest; an equal request still joins (W14).
console.log('\n── W15: the newest kit trails the running warm-up ──')
{
  const kit = (skill: string) => ({ schema: 1 as const, mcp: [] as string[], skills: [skill], invocable: [] as string[] })
  type Kit = ReturnType<typeof kit>
  const J = (k: Kit): string => JSON.stringify(k)
  const K1 = kit('alpha')
  const K2 = kit('beta')
  const K3 = kit('gamma')
  const fresh = () => {
    warm.resetWarmRunnersForTesting()
    const roster15 = new FakeRoster()
    const deps15 = { roster: () => roster15, dir: mkdtempSync(join(tmpdir(), 'warm-runner-daemon-15-')) }
    const ws = mkdtempSync(join(tmpdir(), 'warm-ws-g-'))
    const booted = (): string[] => roster15.registered.map(r => String(r.spec.extraEnv?.MERCURY_SESSION_KIT ?? ''))
    const ensure = (k: Kit) => warm.ensureWarmRunner({ workspaceDir: ws, kit: k }, deps15)
    return { roster15, booted, ensure }
  }
  // Two different kits overlap: K1 runs; K2 reruns after it, never joined.
  // A runner's identity here is the kit its spec booted, never its short:
  // the mint takes the lowest free slot name, and the retire frees it.
  {
    const { roster15, booted, ensure } = fresh()
    const [r1, r2] = await Promise.all([ensure(K1), ensure(K2)])
    check('W15 the running warm-up lands its own kit', r1.state === 'warmed' && booted()[0] === J(K1), `${r1.state}; booted=${booted().join(' | ')}`)
    check(
      'W15 a different kit is not joined: it reruns after the run and boots the newest kit',
      r2.state === 'warmed' && booted().length === 2 && booted()[1] === J(K2),
      `${r2.state}/${String(r2.short)}; booted=${booted().join(' | ')}`,
    )
    check('W15 the older runner retired at the rerun (kit drift)', roster15.killed.length === 1 && roster15.killed[0] === r1.short, roster15.killed.join(','))
    const kept = await ensure(K2)
    check('W15 one runner lives, wearing the newest kit (a same-kit ensure keeps it)', warm.warmRunnerCount() === 1 && kept.state === 'kept' && kept.short === r2.short, `${kept.state}/${String(kept.short)}`)
  }
  // Three overlap: the middle kit is superseded — never booted, never queued.
  {
    const { roster15, booted, ensure } = fresh()
    const [a, b, c] = await Promise.all([ensure(K1), ensure(K2), ensure(K3)])
    check('W15 three overlapping kits boot exactly TWO: the running one and the newest', booted().length === 2 && booted()[0] === J(K1) && booted()[1] === J(K3), booted().join(' | '))
    check('W15 the superseded middle kit never boots (no stale queue)', !booted().includes(J(K2)))
    check(
      'W15 the superseded caller is answered with the rerun outcome (the newest kit)',
      b.state === 'warmed' && c.state === 'warmed' && b.short === c.short,
      `${a.state}/${String(a.short)} ${b.state}/${String(b.short)} ${c.state}/${String(c.short)}`,
    )
    check('W15 one runner lives after the chain, one retired', warm.warmRunnerCount() === 1 && roster15.killed.length === 1)
  }
  // An equal carried kit still joins (W14 holds for carried kits).
  {
    const { roster15, ensure } = fresh()
    const [s1, s2] = await Promise.all([ensure(K1), ensure(K1)])
    check('W15 an equal carried kit joins the run (one child, same short)', roster15.registered.length === 1 && s1.state === 'warmed' && s2.state === 'warmed' && s1.short === s2.short)
  }
  // A request landing DURING the rerun trails that rerun — never a
  // concurrent second flight: kits boot one at a time, in arrival order.
  {
    const { roster15, booted, ensure } = fresh()
    const mid: { run: ReturnType<typeof ensure> | null } = { run: null }
    const plain = roster15.registerLongLived.bind(roster15)
    roster15.registerLongLived = (short, spec) => {
      const out = plain(short, spec)
      // The K2 rerun is mid-body here (registered, not yet in the pool).
      if (spec.extraEnv?.MERCURY_SESSION_KIT === J(K2) && mid.run === null) mid.run = ensure(K3)
      return out
    }
    const [r1, r2] = await Promise.all([ensure(K1), ensure(K2)])
    const r3 = mid.run === null ? null : await mid.run
    check('W15 a request landing mid-rerun trails it: kits boot in order, one at a time', booted().length === 3 && booted().join(',') === [J(K1), J(K2), J(K3)].join(','), booted().join(' | '))
    check('W15 each superseded runner retired in turn', roster15.killed.length === 2 && roster15.killed[0] === r1.short && roster15.killed[1] === r2.short, roster15.killed.join(','))
    check(
      'W15 the mid-rerun caller lands the newest kit; one runner lives',
      r3 !== null && r3.state === 'warmed' && warm.warmRunnerCount() === 1,
      r3 === null ? 'never fired' : `${r3.state}/${String(r3.short)}`,
    )
  }
  warm.resetWarmRunnersForTesting()
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL WARM-RUNNER PROOFS PASS')
else console.log(`❌ ${failures} WARM-RUNNER PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

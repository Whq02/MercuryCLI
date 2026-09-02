#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-crossfamily-concourse-kernel.ts — LANE CMA:
//  the concourse's cross-family COMPOSITE, driven end to end through the
//  REAL stack. Four prior waves each proved their own seam (coordinator
//  minting, the toolCallGate bouncer, instruction parity, wire-id heal);
//  nobody had driven a coordinator on family X launching/steering REAL
//  seats on family Y through the production lane door since they merged.
//
//  The chairs, all real: runOperatorMessageTurn (the concourse composer's
//  own door) → liveCoordinatorCallModel → routedCallModel on the wire →
//  the switchboard tools executing over daemonControlRpc against a REAL
//  daemon (dist) that spawns REAL Anthropic seat sessions against the
//  fixture. One loopback fixture speaks every dialect, content-routed —
//  a /v1/messages POST carrying the <switchboard block is a coordinator
//  turn; without it, a seat turn (stateless: side calls can never starve
//  a scripted queue).
//
//    §1 GPT coordinator × Anthropic seat — LAUNCH: the operator's message
//       rides the Responses dialect with the exact id, launch_session
//       executes, a REAL seat streams on /v1/messages, the receipt names
//       the seat's model, and the qualification receipt mints.
//    §2 GPT coordinator — STEER: message_session delivers INTO the live
//       seat; the steer text lands in the seat's transcript and the seat
//       answers it on its own wire.
//    §3 VIEW headless: coordinatorBoardView (the projection the screen
//       paints) rows the seat with title/model/state.
//    §4 SWITCH the coordinator chair across families through the REAL
//       door (switchCoordinatorAssistModel): gpt → anthropic, receipts
//       applied, the next turn rides the NEW family's dialect.
//    §5 Anthropic coordinator × GPT-named seat — the OTHER direction
//       LAUNCHES: the session arm of the worker registry admits every
//       model the product itself runs, so the sovereign seat spawns and
//       streams whole on ITS OWN wire (the Responses dialect, no
//       switchboard block on any seat call); the crew arm keeps the
//       bounded vocabulary elsewhere.
//    §6 Anthropic coordinator × modelless launch — the seat lands on the
//       operator's own default (an Anthropic route id), applied.
//    §7 GLM coordinator (zai, chat-completions dialect) — the third
//       dialect takes the coordinator chair against the same board.
//    §8 wire separation over the whole run: every seat POST rode its own
//       family's endpoint with no coordinator block; no coordinator turn
//       leaked onto another family's endpoint; only GPT minted
//       qualification receipts.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-crossfamily-concourse-kernel.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'cma-kernel-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
// One folder per launch: a SECOND session into the same git-less folder
// holds behind the git offer (the two-sessions-need-git law) — a separate
// trusted folder per section keeps every launch a clean dispatch.
const work2 = join(SCRATCH, 'work2')
const work3 = join(SCRATCH, 'work3')
const work4 = join(SCRATCH, 'work4')
const work5 = join(SCRATCH, 'work5')
const work6 = join(SCRATCH, 'work6')
const work7 = join(SCRATCH, 'work7')
const workP1 = join(SCRATCH, 'workP1')
const workP2 = join(SCRATCH, 'workP2')
for (const d of [home, daemonDir, work, work2, work3, work4, work5, work6, work7, workP1, workP2]) mkdirSync(d, { recursive: true })

// ── hermetic env BEFORE any src import ──────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE', 'GOOGLE_API_KEY']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.MERCURY_CACHE_CLOCK = '0'
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// The prover runs from the repo checkout; import.meta locates the dist even
// after the process chdirs into the scratch workspace.
const REPO = join(new URL('.', import.meta.url).pathname, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — crossfamily concourse kernel prover exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

// ── the ONE fixture (shared lib): three dialects, content-routed ───────────
const { startCrossfamilyFixture, CMA_STEER_TEXT } = await import('../lib/crossfamilyConcourseFixture.ts')
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const STEER_TEXT = CMA_STEER_TEXT
const fixture = await startCrossfamilyFixture({
  port: 25137,
  seatStyle: 'instant',
  launchProjects: { plain: work2, glm: work3, gpt: work5, haiku: work6, nemotron: work7, pairOne: workP1, pairTwo: workP2 },
})
const captured = fixture.captured
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' crossfamily concourse kernel — coordinator X × seats Y (CMA)')
console.log('============================================================')

// ── seed the home, boot the daemon ─────────────────────────────────────────
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work, work2, work3, work4, work5, work6, work7, workP1, workP2])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_PARTY: '0',
    MERCURY_PARTY: '0',
    MERCURY_TERMINAL_TITLE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})

const untilAsync = async (pred: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

// ── src imports (after env) ────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { saveGlobalConfig, getGlobalConfig } = await import('../../src/utils/config.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')
const models = await import('../../src/services/concourse/coordinatorModels.ts')
const boardMod = await import('../../src/services/concourse/coordinatorBoard.ts')
const q = await import('../../src/services/providers/openai/qualificationStore.ts')

const GLM_ID = GLM_STATIC_CATALOGUE[0]!.id

check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))

// The coordinator chair starts on the GPT family through the config owner.
saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted', assistModel: 'gpt-5.5' } }))

const seatJsonl = (sid: string, dir: string = work): string => join(paths.getProjectDir(dir), `${sid}.jsonl`)
const receiptsOf = (r: unknown): Array<{ verb: string; outcome: string; detail?: string; objectRef?: string }> =>
  ((r as { receipts?: Array<{ verb: string; outcome: string; detail?: string; objectRef?: string }> }).receipts ?? [])

// ============================================================================
section('§1 GPT coordinator × Anthropic seat — the LAUNCH journey')
// ============================================================================
{
  const effective = await lane.resolveEffectiveCoordinator()
  check('agent-assisted resolves on the GPT id', effective.resolution.effective === 'agent-assisted' && effective.assistModelId === 'gpt-5.5', text(effective))

  const before = captured.length
  const r1 = await lane.runOperatorMessageTurn('cma-launch: start the alpha seat on the current repo', {}, { clientMessageId: 'cma-msg-1' })
  const rows = receiptsOf(r1)
  const launchRow = rows.find(r => r.verb === 'session.launch')
  check('the launch receipt applied', launchRow?.outcome === 'applied', text(rows))
  const reply = String((r1 as { reply?: unknown }).reply ?? '')
  check('the coordinator replied through the GPT ack', reply.includes('cma-openai-ack'), reply.slice(0, 120))

  const hits = captured.slice(before)
  const gptHits = hits.filter(h => h.lane === 'openai')
  check('the coordinator turn rode the Responses dialect with the exact id (≥2 rounds)',
    gptHits.length >= 2 && gptHits.every(h => h.model === 'gpt-5.5'),
    hits.map(h => `${h.lane}:${h.model}`).join(','))
  check('no coordinator round leaked onto another family',
    hits.filter(h => h.lane === 'anthropic-coordinator' || h.lane === 'zai').length === 0,
    hits.map(h => h.lane).join(','))
  const firstGpt = gptHits[0] !== undefined ? text(gptHits[0].body) : ''
  check('the switchboard tools are declared on the GPT wire', firstGpt.includes('launch_session') && firstGpt.includes('message_session'))
  check('the board block rode the GPT wire', firstGpt.includes('<switchboard'))

  // The REAL seat: the daemon spawned it; its transcript lands on disk.
  const sid = launchRow?.objectRef ?? ''
  check('the launch names a real session id', /^[0-9a-f-]{36}$/.test(sid), sid)
  check('the seat streams its turn on the Anthropic wire (transcript lands)',
    await untilAsync(async () => existsSync(seatJsonl(sid)) && readFileSync(seatJsonl(sid), 'utf8').includes('alpha-landed body.'), 45_000),
    sid)
  const seatHits = captured.filter(h => h.lane === 'anthropic-seat')
  check('the seat turn was an Anthropic-route call', seatHits.length >= 1 && seatHits.every(h => declaredRouteOf(h.model) === 'anthropic'),
    seatHits.map(h => h.model).join(','))
  check("the qualification receipt minted {gpt-5.5 · coordinator} (CM's seam at the composite)",
    q.readQualificationReceipts().some(r => r.receipt.modelId === 'gpt-5.5' && r.receipt.role === 'coordinator'),
    text(q.readQualificationReceipts().map(r => [r.receipt.modelId, r.receipt.role])))
}

// ============================================================================
section('§2 GPT coordinator — the STEER journey (message_session into the live seat)')
// ============================================================================
{
  const before = captured.length
  const r2 = await lane.runOperatorMessageTurn('cma-steer: adjust the alpha seat', {}, { clientMessageId: 'cma-msg-2' })
  const rows = receiptsOf(r2)
  const steerRow = rows.find(r => r.verb === 'session.redirect')
  check('the steer receipt applied', steerRow?.outcome === 'applied', text(rows))
  const sid = steerRow?.objectRef ?? ''
  check('the steer text landed IN the seat transcript and the seat answered it on its own wire',
    await untilAsync(
      async () => existsSync(seatJsonl(sid)) && readFileSync(seatJsonl(sid), 'utf8').includes(STEER_TEXT) && readFileSync(seatJsonl(sid), 'utf8').includes('steer-landed body.'),
      45_000,
    ),
    sid)
  const gptHits = captured.slice(before).filter(h => h.lane === 'openai')
  check('the steer turn rode the GPT dialect', gptHits.length >= 2 && gptHits.every(h => h.model === 'gpt-5.5'),
    captured.slice(before).map(h => `${h.lane}:${h.model}`).join(','))
}

// ============================================================================
section('§2b the PARALLEL round — two launches in ONE settlement (the live class)')
// ============================================================================
{
  // The runtimes mint one assistant message per content block, so a round
  // with TWO function_calls settles as two messages — the loop must execute
  // BOTH and answer BOTH call ids, or the next round dies on the provider's
  // unanswered-function_call check (live-found: a two-session ask launched
  // only one and the turn died 'No tool output found for function call').
  const before = captured.length
  const r = await lane.runOperatorMessageTurn('cma-launch-pair: start both pair seats', {}, { clientMessageId: 'cma-msg-pair' })
  const rows = receiptsOf(r)
  const launches = rows.filter(x => x.verb === 'session.launch')
  check('BOTH parallel launches applied', launches.length === 2 && launches.every(x => x.outcome === 'applied'), text(rows))
  const reply = String((r as { reply?: unknown }).reply ?? '')
  check('the turn CLOSED through the ack (no mid-turn wire death)', reply.includes('cma-openai-ack'), reply.slice(0, 160))
  const hits = captured.slice(before)
  const gptHits = hits.filter(h => h.lane === 'openai')
  const ackRound = gptHits[gptHits.length - 1]
  const outputs = ackRound !== undefined ? (text(ackRound.body).match(/function_call_output/g) ?? []).length : 0
  check('the follow-up round answers BOTH call ids (2 function_call_outputs on the wire)', outputs >= 2, `outputs=${outputs}`)
  for (const [sid, marker, dir] of launches.map((x, i) => [x.objectRef ?? '', i === 0 ? 'pair-one-landed body.' : 'pair-two-landed body.', i === 0 ? workP1 : workP2] as const)) {
    check(`the ${marker.split('-landed')[0]} seat streamed`, await untilAsync(async () => existsSync(seatJsonl(sid, dir)) && readFileSync(seatJsonl(sid, dir), 'utf8').includes(marker), 45_000), sid)
  }
}

// ============================================================================
section('§3 the VIEW journey headless — the board projection rows the seat')
// ============================================================================
{
  const view = await boardMod.coordinatorBoardView({ ground: work })
  const alpha = view.sessions.find(s => s.title === 'CMA Alpha')
  check('the board rows the launched seat by title', alpha !== undefined, text(view.sessions.map(s => s.title)))
  check('the row names an Anthropic-route model (the cross-family board fact)',
    alpha !== undefined && typeof alpha.model === 'string' && declaredRouteOf(String(alpha.model)) === 'anthropic',
    text(alpha))
  check('the row carries a live state word', alpha !== undefined && typeof alpha.state === 'string' && String(alpha.state).length > 0, text(alpha))
}

// ============================================================================
section('§4 SWITCH the coordinator chair across families through the real door')
// ============================================================================
{
  const receipt = await models.switchCoordinatorAssistModel('claude-fable-5')
  check('gpt → anthropic switch applied through switchCoordinatorAssistModel',
    (receipt as { outcome?: string }).outcome === 'applied', text(receipt))
  const effective = await lane.resolveEffectiveCoordinator()
  check('the chair now resolves on the Anthropic id', effective.assistModelId === 'claude-fable-5', text(effective))
  check('the config carries the switched chair', getGlobalConfig().concourseCoordinator?.assistModel === 'claude-fable-5')
}

// ============================================================================
section('§5 Anthropic coordinator × GPT-named seat — the sovereign seat LAUNCHES')
// ============================================================================
{
  const workerCount = async (): Promise<number> => {
    const reply = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: unknown[] }
    return Array.isArray(reply.workers) ? reply.workers.length : -1
  }
  // gpt-5.5 is live-qualified against the fixture catalogue, so the SESSION
  // arm of the worker registry dispatches it — the session runner is the
  // whole product. POISON: the pre-split registry refused exactly this
  // dispatch 'not-integrated:worker-engine' (the operator's screenshot);
  // this section run against that registry fails here.
  const workersBefore = await workerCount()
  const probe = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: `cma-probe-${Date.now()}`,
    prompt: 'registry probe',
    workspaceDir: work4,
    title: 'CMA Probe',
    model: 'gpt-5.5',
  } as never)) as { ok?: boolean; sessionId?: string }
  check('a direct gpt-5.5 dispatch ADMITS at the daemon door (the session arm)', probe.ok === true, text(probe))
  const probeSid = String(probe.sessionId ?? '')
  check('…and the sovereign seat streams its turn (transcript lands from the Responses dialect)',
    await untilAsync(async () => existsSync(seatJsonl(probeSid, work4)) && readFileSync(seatJsonl(probeSid, work4), 'utf8').includes('spare-landed body.'), 45_000),
    probeSid)
  const probeSeatHits = captured.filter(h => h.lane === 'openai-seat')
  check('the seat call rode the Responses endpoint with the exact id and NO switchboard block',
    probeSeatHits.length >= 1 && probeSeatHits.every(h => h.model === 'gpt-5.5' && !text(h.body).includes('<switchboard')),
    probeSeatHits.map(h => h.model).join(','))

  const before = captured.length
  const r3 = await lane.runOperatorMessageTurn('cma-launch-gpt: start a seat on the gpt engine', {}, { clientMessageId: 'cma-msg-3' })
  const rows = receiptsOf(r3)
  const launchRow = rows.find(r => r.verb === 'session.launch')
  check('the coordinator’s GPT-named launch receipt APPLIED', launchRow?.outcome === 'applied', text(rows))
  check('…and the receipt names the gpt model the seat started on',
    /on .*gpt-?5\.5/i.test(String(launchRow?.detail ?? '')), String(launchRow?.detail ?? ''))
  const sid = launchRow?.objectRef ?? ''
  check('the launch names a real session id', /^[0-9a-f-]{36}$/.test(sid), sid)
  check('the gpt seat streamed whole on its own dialect (transcript lands)',
    await untilAsync(async () => existsSync(seatJsonl(sid, work5)) && readFileSync(seatJsonl(sid, work5), 'utf8').includes('gpt-landed body.'), 45_000),
    sid)
  const hits = captured.slice(before)
  check('the coordinator turn itself rode the Anthropic dialect with the switchboard block',
    hits.filter(h => h.lane === 'anthropic-coordinator').length >= 2 &&
      hits.filter(h => h.lane === 'anthropic-coordinator').every(h => h.model === 'claude-fable-5'),
    hits.map(h => `${h.lane}:${h.model}`).join(','))
  check('the REAL sovereign workers joined the roster (live seats, never ghosts)',
    workersBefore >= 0 && (await workerCount()) >= workersBefore + 1, `before=${workersBefore} after=${await workerCount()}`)

  // Free the two sovereign seats: the machine's seat ceiling is honest (five
  // seats), and §6/§7 launch into it — the stop door works on a sovereign
  // session exactly as on any other, and the release frees the slot.
  const listed = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: Array<Record<string, unknown>> }
  for (const w of listed.workers ?? []) {
    const wSid = String(w.sessionId ?? '')
    if (wSid !== probeSid && wSid !== sid) continue
    try {
      await daemonControlRpc({ op: 'concourseControl', action: 'stop', sessionId: wSid, by: 'operator' } as never)
    } catch {
      /* the daemon reconciles a dead runner on its own */
    }
    try {
      await daemonControlRpc({ op: 'concourseRelease', workerId: String(w.workerId ?? '') } as never)
    } catch {
      /* released records reconcile */
    }
  }
}

// ============================================================================
section('§5b coordinator-dispatched sessions ride the SESSION arm — haiku + a routed id')
// ============================================================================
{
  const freeSeat = async (sid: string): Promise<void> => {
    const listed = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: Array<Record<string, unknown>> }
    for (const w of listed.workers ?? []) {
      if (String(w.sessionId ?? '') !== sid) continue
      try {
        await daemonControlRpc({ op: 'concourseControl', action: 'stop', sessionId: sid, by: 'operator' } as never)
      } catch {
        /* reconciled */
      }
      try {
        await daemonControlRpc({ op: 'concourseRelease', workerId: String(w.workerId ?? '') } as never)
      } catch {
        /* reconciled */
      }
    }
  }
  // The operator asks the coordinator for a HAIKU session — the dispatch
  // honours it (the never-Haiku law binds the autonomous crew, not the
  // operator's own sessions).
  {
    const r = await lane.runOperatorMessageTurn('cma-launch-haiku: start the economy seat', {}, { clientMessageId: 'cma-msg-haiku' })
    const rows = receiptsOf(r)
    const launchRow = rows.find(x => x.verb === 'session.launch')
    check('the coordinator’s HAIKU-named launch receipt APPLIED', launchRow?.outcome === 'applied', text(rows))
    const sid = launchRow?.objectRef ?? ''
    check('the haiku seat streamed on the Anthropic wire (transcript lands)',
      await untilAsync(async () => existsSync(seatJsonl(sid, work6)) && readFileSync(seatJsonl(sid, work6), 'utf8').includes('haiku-landed body.'), 45_000),
      sid)
    const haikuSeatHits = captured.filter(h => h.lane === 'anthropic-seat' && /haiku/i.test(h.model))
    check('…and the seat call carried the haiku id on its own family wire', haikuSeatHits.length >= 1,
      captured.filter(h => h.lane === 'anthropic-seat').map(h => h.model).join(','))
    await freeSeat(sid)
  }
  // The operator asks for an OPENROUTER-carried id — capability, not
  // catalogue: the session lands and answers on the routed chat wire.
  {
    const r = await lane.runOperatorMessageTurn('cma-launch-nemotron: start the routed seat', {}, { clientMessageId: 'cma-msg-nemotron' })
    const rows = receiptsOf(r)
    const launchRow = rows.find(x => x.verb === 'session.launch')
    check('the coordinator’s ROUTED-id launch receipt APPLIED', launchRow?.outcome === 'applied', text(rows))
    const sid = launchRow?.objectRef ?? ''
    check('the nemotron seat streamed on the OpenRouter wire (transcript lands)',
      await untilAsync(async () => existsSync(seatJsonl(sid, work7)) && readFileSync(seatJsonl(sid, work7), 'utf8').includes('nemotron-landed body.'), 45_000),
      sid)
    const orSeats = captured.filter(h => h.lane === 'openrouter-seat')
    check('…the routed seat call rode the OpenRouter chat wire with the nemotron id',
      orSeats.length >= 1 && orSeats.every(h => /nemotron/i.test(h.model) && !text(h.body).includes('<switchboard')),
      orSeats.map(h => h.model).join(','))
    await freeSeat(sid)
  }
}

// ============================================================================
section('§6 Anthropic coordinator × modelless launch — the seat lands on the operator default')
// ============================================================================
{
  const before = captured.length
  const r4 = await lane.runOperatorMessageTurn('cma-launch-plain: start the plain seat', {}, { clientMessageId: 'cma-msg-4' })
  const rows = receiptsOf(r4)
  const launchRow = rows.find(r => r.verb === 'session.launch')
  check('the modelless launch applied', launchRow?.outcome === 'applied', text(rows))
  const sid = launchRow?.objectRef ?? ''
  check('the plain seat streamed on the Anthropic wire',
    await untilAsync(async () => existsSync(seatJsonl(sid, work2)) && readFileSync(seatJsonl(sid, work2), 'utf8').includes('plain-landed body.'), 45_000),
    sid)
  check('the anthropic coordinator turn took the whole journey on its own dialect',
    captured.slice(before).filter(h => h.lane === 'anthropic-coordinator').every(h => h.model === 'claude-fable-5'),
    captured.slice(before).map(h => `${h.lane}:${h.model}`).join(','))
}

// ============================================================================
section('§7 GLM coordinator (zai) — the third dialect takes the chair')
// ============================================================================
{
  const receipt = await models.switchCoordinatorAssistModel(GLM_ID)
  check(`anthropic → zai switch applied (${GLM_ID})`, (receipt as { outcome?: string }).outcome === 'applied', text(receipt))
  const before = captured.length
  const r5 = await lane.runOperatorMessageTurn('cma-launch-glm: start the beta seat', {}, { clientMessageId: 'cma-msg-5' })
  const rows = receiptsOf(r5)
  const launchRow = rows.find(r => r.verb === 'session.launch')
  check('the GLM-coordinated launch applied', launchRow?.outcome === 'applied', text(rows))
  const sid = launchRow?.objectRef ?? ''
  check('the beta seat streamed on the Anthropic wire',
    await untilAsync(async () => existsSync(seatJsonl(sid, work3)) && readFileSync(seatJsonl(sid, work3), 'utf8').includes('beta-landed body.'), 45_000),
    sid)
  const zaiHits = captured.slice(before).filter(h => h.lane === 'zai')
  check('the coordinator turn rode the chat-completions dialect with the exact GLM id',
    zaiHits.length >= 2 && zaiHits.every(h => h.model === GLM_ID),
    captured.slice(before).map(h => `${h.lane}:${h.model}`).join(','))
  const reply = String((r5 as { reply?: unknown }).reply ?? '')
  check('the coordinator replied through the GLM ack', reply.includes('cma-zai-ack'), reply.slice(0, 120))
}

// ============================================================================
section('§8 the wire-separation law over the whole run')
// ============================================================================
{
  const anthropicSeats = captured.filter(h => h.lane === 'anthropic-seat')
  check('every Anthropic seat call in the run rode /v1/messages',
    anthropicSeats.length >= 3 && anthropicSeats.every(h => h.path.endsWith('/v1/messages')),
    String(anthropicSeats.length))
  const gptSeats = captured.filter(h => h.lane === 'openai-seat')
  check('every sovereign GPT seat call rode its own Responses endpoint',
    gptSeats.length >= 2 && gptSeats.every(h => h.path === '/openai/v1/responses'),
    String(gptSeats.length))
  const routedSeats = captured.filter(h => h.lane === 'openrouter-seat')
  check('every routed seat call rode the OpenRouter chat endpoint',
    routedSeats.length >= 1 && routedSeats.every(h => h.path === '/openrouter/api/v1/chat/completions'),
    String(routedSeats.length))
  check('no seat call of ANY family carried the coordinator block',
    [...anthropicSeats, ...gptSeats, ...routedSeats].every(h => !text(h.body).includes('<switchboard')),
    'a seat body carried <switchboard')
  check('only the GPT family minted qualification receipts',
    q.readQualificationReceipts().every(r => declaredRouteOf(r.receipt.modelId) === 'openai'),
    text(q.readQualificationReceipts().map(r => r.receipt.modelId)))
  const unknown = captured.filter(h => h.lane === 'other' && !h.path.startsWith('GET'))
  check('no un-modelled POST reached the fixture', unknown.length === 0, unknown.map(h => h.path).join(','))
}

// ── teardown ────────────────────────────────────────────────────────────────
try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
  /* already down */
}
daemon.kill('SIGTERM')
await fixture.close()
if (process.env.CMA_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
else rmSync(SCRATCH, { recursive: true, force: true })

console.log(failures === 0 ? `\nprove-crossfamily-concourse-kernel: ALL LAWS HOLD (${checks} checks)` : `\nprove-crossfamily-concourse-kernel: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)

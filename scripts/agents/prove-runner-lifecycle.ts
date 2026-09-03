#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-runner-lifecycle.ts — the in-process teammate runner's
//  LIFECYCLE LAWS.
//
//  Drives the REAL chain — spawnInProcessTeammate → runInProcessTeammate →
//  killInProcessTeammate — hermetically against the deterministic fixture API
//  (scripts/lib/fixtureApi.ts; ANTHROPIC_BASE_URL routes the SDK in-process,
//  no billing, no network) and freezes:
//
//    §2 the LAUNCH COMPOSITE on the wire (role contract · team charter · role
//       packet · handoff addendum ride the actual /v1/messages system param)
//       + happy completion + the abort-exit terminal band: exactly-once
//       'completed' (one SDK bookend) + the no-orphan cleanup sweep
//    §3 the FAILURE BAND — a real mid-loop throw (failing auto-compaction)
//       terminalizes 'failed' exactly once, keeps the cause, notifies the lead
//    §4 the KILL LAW — killed while idle: the runner never overwrites the
//       terminal, a second kill is refused, exactly one 'stopped' bookend
//    §5 REGRESSION FIXTURE (Phase-7.1 correction D1): kill mid-turn CANCELS
//       the in-flight model call — the per-turn work controller is a LINKED
//       CHILD of the lifecycle controller, so the kill's lifecycle abort
//       tears the stream down and the runner converges promptly, still
//       honoring the kill terminal exactly once. (As characterized, the
//       controller was UNLINKED and the runner stayed wedged until the
//       stream died of other causes.)
//    §6 REGRESSION FIXTURE (Phase-7.1 correction D2): a launch-composition
//       throw (the system-prompt build) is owned by the runner's failure
//       band — failed terminal + cause + bookend + lead notification,
//       exactly once. (As characterized, the build ran BEFORE the try band:
//       the task was orphaned 'running' forever and the rejection was
//       swallowed by the fire-and-forget spawn.)
//    §7 the WORK-ABORT LAW (Escape) — aborting currentWorkAbortController
//       interrupts the turn only: idleReason 'interrupted', the teammate
//       stays alive, revives on the next lead message, then completes
//    §7b the INTERRUPT-DELIVERS-MAIL LAW — mail queued WHILE the turn runs
//       (operator lines injected at the teammate, lead and peer mailbox
//       messages) is delivered AT the interrupt, every message as its own
//       turn in the runner's order (operator lines · lead · peers FIFO),
//       and the teammate continues with no further nudge — an interrupt is
//       "read your mail now", never a stop that leaves it dark
//
//  Run:  ~/.bun/bin/bun run scripts/agents/prove-runner-lifecycle.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// NOT NODE_ENV=test: that arms the VCR record/replay layer (services/vcr.ts,
// shouldUseVCR) which writes cassettes under <cwd>/fixtures/, replays them on
// prompt-hash match across runs AND across scenarios with identical prompts,
// and silently bypasses the fixture server this proof asserts against.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runner-life-config-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'runner-life-teams-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'runner-life-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { spawnInProcessTeammate, killInProcessTeammate } = await import(
  '../../src/utils/swarm/spawnInProcess.ts'
)
const { runInProcessTeammate } = await import('../../src/utils/swarm/inProcessRunner.ts')
const { drainSdkEvents } = await import('../../src/utils/sdkEventQueue.ts')
const { readMailbox, writeToMailbox, isIdleNotification } = await import(
  '../../src/utils/teammateMailbox.ts'
)
const { injectUserMessageToTeammate } = await import(
  '../../src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import(
  '../../src/utils/fileStateCache.ts'
)
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { resolveTeammateRole } = await import('../../src/utils/swarm/roleResolver.ts')
const { deriveTeamCharter } = await import('../../src/utils/swarm/teamCharter.ts')
const { ERROR_MESSAGE_USER_ABORT } = await import('../../src/services/compact/compact.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — runner lifecycle proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

// ── harness ─────────────────────────────────────────────────────────────────

type AnyState = Record<string, unknown> & { tasks: Record<string, unknown> }
type Store = {
  getAppState: () => AnyState
  setAppState: (updater: (prev: AnyState) => AnyState) => void
}

function makeStore(): Store {
  let state: AnyState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

function makeCtx(store: Store): Record<string, unknown> {
  return {
    abortController: new AbortController(),
    getAppState: store.getAppState,
    setAppState: store.setAppState,
    setAppStateForTasks: store.setAppState,
    messages: [],
    // A REAL FileStateCache, not a Map — cloneFileStateCache needs dump()/load()
    // (iteration-2 fork clones + compaction's isolated context both clone it).
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    options: {
      tools: [],
      commands: [],
      mcpClients: [],
      mcpResources: {},
      mainLoopModel: 'claude-opus-4-8',
      maxThinkingTokens: 0,
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
      debug: false,
      verbose: false,
    },
  }
}

type RunResult = { success: boolean; error?: string; messages: unknown[] }

/** Bounded settlement for a runPromise. An unsettled runner here is a PARK —
 *  the §7b incident shape was this exact await sitting silent for 40+
 *  minutes under a pool run (the 240s guard is unref'd and exit-based, so a
 *  parked await left nothing on the record). The race converts any future
 *  park into a fast RED that carries the fixture's request count — the one
 *  number that adjudicates the double-fire theory immediately. */
async function settleWithin(
  promise: Promise<RunResult>,
  s: { api: FixtureApi },
  label: string,
  ms = 45_000,
): Promise<RunResult> {
  const parked = Symbol('parked')
  const timer = new Promise<typeof parked>(resolve => {
    const t = setTimeout(() => resolve(parked), ms)
    t.unref?.()
  })
  const raced = await Promise.race([promise, timer])
  if (raced !== parked) return raced
  return {
    success: false,
    error: `PARKED: ${label} runPromise unsettled after ${ms / 1000}s — the fixture saw ${s.api.messageRequests().length} request(s)`,
    messages: [],
  }
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise(r => setTimeout(r, 25))
  }
}

type TaskView = {
  status: string
  isIdle: boolean
  notified: boolean
  error?: string
  endTime?: number
  messages?: Array<{ type: string; message: { content: unknown } }>
  pendingUserMessages: string[]
  inProgressToolUseIDs?: Set<string>
  abortController?: AbortController
  currentWorkAbortController?: AbortController
  unregisterCleanup?: () => void
  onIdleCallbacks?: Array<() => void>
  identity: { agentId: string; agentName: string; teamName: string; parentSessionId: string }
  toolUseId?: string
}
const task = (store: Store, id: string): TaskView => store.getAppState().tasks[id] as TaskView

type SdkEventView = {
  subtype: string
  task_id: string
  status?: string
  tool_use_id?: string
}
const allDrained: SdkEventView[] = []
function drainInto(): void {
  allDrained.push(...(drainSdkEvents() as unknown as SdkEventView[]))
}
const bookendsFor = (taskId: string): SdkEventView[] =>
  allDrained.filter(e => e.subtype === 'task_notification' && e.task_id === taskId)

async function idleNotificationsFor(
  team: string,
): Promise<Array<{ idleReason?: string; failureReason?: string }>> {
  const msgs = await readMailbox('team-lead', team)
  return msgs
    .map(m => isIdleNotification(m.text))
    .filter(Boolean) as Array<{ idleReason?: string; failureReason?: string }>
}

type Spawned = {
  api: FixtureApi
  store: Store
  ctx: Record<string, unknown>
  taskId: string
  team: string
  lifecycle: AbortController
  runPromise: Promise<{ success: boolean; error?: string; messages: unknown[] }>
  settled: () => boolean
  rejection: () => unknown
  cleanupCalls: () => number
}

async function launch(opts: {
  name: string
  team: string
  turns: ScriptedTurn[]
  prompt: string
  description?: string
  replacePrompt?: string
  role?: unknown
  agentDefinition?: unknown
  poisonCtx?: (ctx: Record<string, unknown>) => void
}): Promise<Spawned> {
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const store = makeStore()
  const ctx = makeCtx(store)
  opts.poisonCtx?.(ctx)

  const spawned = await spawnInProcessTeammate(
    {
      name: opts.name,
      teamName: opts.team,
      prompt: opts.prompt,
      planModeRequired: false,
    },
    { setAppState: store.setAppState as never, toolUseId: `toolu_${opts.name}` },
  )
  if (!spawned.success || !spawned.taskId) {
    throw new Error(`spawn failed: ${spawned.error}`)
  }
  const taskId = spawned.taskId

  // Spy on the real cleanup unregistration without replacing its behavior.
  let cleanupCalls = 0
  store.setAppState(prev => {
    const t = prev.tasks[taskId] as TaskView
    const orig = t.unregisterCleanup
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...t,
          unregisterCleanup: () => {
            cleanupCalls++
            orig?.()
          },
        },
      },
    }
  })

  let settled = false
  let rejection: unknown
  const runPromise = runInProcessTeammate({
    identity: task(store, taskId).identity as never,
    taskId,
    prompt: opts.prompt,
    description: opts.description,
    role: opts.role as never,
    agentDefinition: opts.agentDefinition as never,
    teammateContext: spawned.teammateContext as never,
    toolUseContext: ctx as never,
    abortController: spawned.abortController!,
    allowPermissionPrompts: false,
    ...(opts.replacePrompt
      ? { systemPrompt: opts.replacePrompt, systemPromptMode: 'replace' as const }
      : {}),
  })
  runPromise.then(
    () => {
      settled = true
    },
    err => {
      settled = true
      rejection = err
    },
  )

  return {
    api,
    store,
    ctx,
    taskId,
    team: opts.team,
    lifecycle: spawned.abortController!,
    runPromise,
    settled: () => settled,
    rejection: () => rejection,
    cleanupCalls: () => cleanupCalls,
  }
}

// ── §1 preconditions ────────────────────────────────────────────────────────
section('§1 — harness preconditions')
{
  check(
    'session is non-interactive (SDK bookends observable via drainSdkEvents)',
    bootstrap.getIsNonInteractiveSession(),
  )
}

// ── §2 launch composite + happy completion + abort-exit exactly-once ───────
section('§2 — launch composite on the wire · happy completion · abort-exit terminal')
{
  const team = 'own7-s1'
  const charter = deriveTeamCharter({
    teamName: team,
    description: 'Probe the runner lifecycle end to end',
    createdAt: 1,
  })
  const agents = getBuiltInAgents()
  const role = resolveTeammateRole({
    teammateName: 'probe1',
    requestedAgentType: 'mercury-scout',
    agents: agents as never,
    prompt: 'Report one line and stop.',
    description: 'probe recon',
    charter,
    mainLoopModel: 'claude-opus-4-8',
    sessionState: {},
  })
  const s = await launch({
    name: 'probe1',
    team,
    turns: [{ kind: 'text', text: 'S1 probe reply.' }],
    prompt: 'Report one line and stop.',
    description: 'probe recon',
    role,
    agentDefinition: role.definition,
  })

  const wentIdle = await waitFor(() => task(s.store, s.taskId)?.isIdle === true, 90_000)
  check('the teammate completes its turn and goes idle', wentIdle)

  const reqs = s.api.messageRequests()
  check('exactly ONE model call for one prompt (the idle loop is API-silent)', reqs.length === 1, `${reqs.length}`)
  const system = JSON.stringify((reqs[0]?.body as { system?: unknown })?.system ?? '')
  check('the wire system prompt carries the ROLE CONTRACT', system.includes('# Role contract (mercury-scout)'))
  check('the wire system prompt carries the TEAM CHARTER', system.includes(`# Team charter — ${team}`))
  check('the wire system prompt carries the ROLE PACKET assignment', system.includes('# Your assignment — probe1 (mercury-scout)') && system.includes('Mission: probe recon'))
  check('the wire system prompt carries the HANDOFF PACKET addendum', system.includes('Outcome: what changed or what was learned'))

  // isIdle flips BEFORE the notification write is awaited — poll the mailbox.
  check(
    "the lead receives an 'available' idle notification",
    await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'available'), 10_000),
  )

  // Lifecycle abort while idle → the runner exits and terminalizes ONCE.
  s.lifecycle.abort()
  const result = await settleWithin(s.runPromise, s, '§2')
  drainInto()

  check('the runner resolves success on abort-exit', result.success === true)
  check('the result carries the conversation', JSON.stringify(result.messages).includes('S1 probe reply.'))
  const t = task(s.store, s.taskId)
  check("terminal status is 'completed'", t.status === 'completed', t.status)
  check('notified pre-set (no XML notification path)', t.notified === true)
  check('endTime stamped', typeof t.endTime === 'number')
  check('no-orphan sweep: lifecycle controller cleared', t.abortController === undefined)
  check('no-orphan sweep: work controller cleared', t.currentWorkAbortController === undefined)
  check('no-orphan sweep: cleanup unregistered and cleared', t.unregisterCleanup === undefined && s.cleanupCalls() >= 1, `calls=${s.cleanupCalls()}`)
  check('no-orphan sweep: idle callbacks cleared', Array.isArray(t.onIdleCallbacks) && t.onIdleCallbacks.length === 0)
  check('no-orphan sweep: pending user messages cleared', t.pendingUserMessages.length === 0)
  check('no-orphan sweep: in-progress tool ids cleared', t.inProgressToolUseIDs === undefined)
  check('memory reclaim: UI message mirror truncated to the tail', (t.messages?.length ?? 0) <= 1, `${t.messages?.length}`)

  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'completed' SDK bookend", bookends.length === 1 && bookends[0]?.status === 'completed', JSON.stringify(bookends))
  check('the bookend carries the spawning toolUseId', bookends[0]?.tool_use_id === 'toolu_probe1', bookends[0]?.tool_use_id)

  // Liveness: the poll loop is truly gone — a late lead message changes nothing.
  await writeToMailbox('probe1', { from: 'team-lead', text: 'anyone home?', timestamp: new Date().toISOString() }, team)
  await new Promise(r => setTimeout(r, 700))
  check('no revival after terminal: status unchanged', task(s.store, s.taskId).status === 'completed')
  check('no revival after terminal: no new model calls', s.api.messageRequests().length === 1)
  await s.api.close()
}

// ── §3 the failure band ─────────────────────────────────────────────────────
section('§3 — a mid-loop throw (failing auto-compaction) terminalizes FAILED exactly once')
{
  const team = 'own7-s2'
  // Iteration 2 trips the auto-compact check (threshold floored via the
  // sanctioned test override); the compaction model calls are scripted
  // NON-retryable 400s → compactConversation throws (pinned by Phase 6) →
  // the runner's catch band owns the terminal. TWO refusals are scripted
  // because streamCompactSummary has two lanes: the prompt-cache-sharing
  // fork attempt, then the plain streaming fallback.
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '0.001'
  const s = await launch({
    name: 'probe2',
    team,
    turns: [
      { kind: 'text', text: 'S2 first reply.' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'compaction fixture refusal' },
      { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'compaction fixture refusal' },
    ],
    prompt: 'Reply once.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })

  check('turn 1 completes', await waitFor(() => task(s.store, s.taskId)?.isIdle === true, 90_000))
  await writeToMailbox('probe2', { from: 'team-lead', text: 'keep going', timestamp: new Date().toISOString() }, team)

  const result = await settleWithin(s.runPromise, s, '§3')
  drainInto()
  delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE

  check('the runner resolves (never rejects) on an in-band throw', s.rejection() === undefined)
  check('failure is reported', result.success === false && !!result.error, JSON.stringify({ success: result.success, error: result.error }))
  const t = task(s.store, s.taskId)
  check("terminal status is 'failed'", t.status === 'failed', t.status)
  check('the cause is kept on the task row', typeof t.error === 'string' && t.error.length > 0, t.error)
  check(
    'the cause is the REAL compaction refusal (not a harness artifact)',
    (t.error ?? '').includes('compaction fixture refusal') || (t.error ?? '').toLowerCase().includes('api error'),
    t.error,
  )
  check('failed rows read as idle (crew board contract)', t.isIdle === true)
  check('no-orphan sweep on failure: controllers + cleanup cleared', t.abortController === undefined && t.currentWorkAbortController === undefined && t.unregisterCleanup === undefined)
  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'failed' SDK bookend", bookends.length === 1 && bookends[0]?.status === 'failed', JSON.stringify(bookends))
  const idles = await idleNotificationsFor(team)
  const failedNote = idles.find(n => n.idleReason === 'failed')
  check("the lead is told: idleReason 'failed' + the cause", !!failedNote && !!failedNote.failureReason, JSON.stringify(idles))
  check(
    'exactly three model calls (turn 1 + fork-lane compact + fallback-lane compact) — no runaway retry',
    s.api.messageRequests().length === 3,
    `${s.api.messageRequests().length}`,
  )
  await s.api.close()
}

// ── §4 the kill law (idle) ──────────────────────────────────────────────────
section('§4 — killed while idle: the runner never overwrites; double-kill refused')
{
  const team = 'own7-s3'
  const s = await launch({
    name: 'probe3',
    team,
    turns: [{ kind: 'text', text: 'S3 reply.' }],
    prompt: 'Reply once.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })
  check('turn 1 completes', await waitFor(() => task(s.store, s.taskId)?.isIdle === true, 90_000))

  const killed = killInProcessTeammate(s.taskId, s.store.setAppState as never)
  check('kill succeeds on a running teammate', killed === true)
  check('a second kill is REFUSED (terminal already owned)', killInProcessTeammate(s.taskId, s.store.setAppState as never) === false)

  const result = await settleWithin(s.runPromise, s, '§4')
  drainInto()
  const t = task(s.store, s.taskId)
  check("the runner NEVER overwrites the kill: status stays 'killed'", t.status === 'killed', t.status)
  check('the runner still resolves cleanly after a kill', result.success === true)
  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'stopped' bookend (the kill's), none from the runner", bookends.length === 1 && bookends[0]?.status === 'stopped', JSON.stringify(bookends))
  await s.api.close()
}

// ── §5 REGRESSION FIXTURE (D1) — kill mid-turn cancels the in-flight turn ──
section('§5 — REGRESSION FIXTURE (D1): kill mid-turn cancels the in-flight turn')
{
  const team = 'own7-s4'
  const s = await launch({
    name: 'probe4',
    team,
    turns: [{ kind: 'hang', deltas: ['thinking…'] }],
    prompt: 'Reply once.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })
  await s.api.messageRequestStarted(1)

  const killed = killInProcessTeammate(s.taskId, s.store.setAppState as never)
  check('kill mid-turn succeeds at the state layer', killed === true)
  check("task shows 'killed' immediately", task(s.store, s.taskId).status === 'killed')

  // D1: the work controller is a LINKED CHILD of the lifecycle controller
  // (createChildAbortController) — the kill's lifecycle abort cancels the
  // in-flight API stream and the runner converges promptly, well inside the
  // killed row's 3s eviction grace. As characterized (unlinked), the runner
  // stayed wedged on the hanging stream indefinitely.
  check('D1: the runner converges promptly after a mid-turn kill', await waitFor(() => s.settled(), 2_500))
  const result = await settleWithin(s.runPromise, s, '§5')
  check('D1: the late exit resolves cleanly', result.success === true)
  check("D1: the exit honors the kill: status stays 'killed'", task(s.store, s.taskId)?.status === 'killed', task(s.store, s.taskId)?.status)
  drainInto()
  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'stopped' bookend (the kill's), none from the runner", bookends.length === 1 && bookends[0]?.status === 'stopped', JSON.stringify(bookends))
  await s.api.close()
}

// ── §6 REGRESSION FIXTURE (D2) — a launch-composition throw terminalizes ───
section('§6 — REGRESSION FIXTURE (D2): a launch-composition throw terminalizes FAILED')
{
  const team = 'own7-s5'
  const s = await launch({
    name: 'probe5',
    team,
    turns: [],
    prompt: 'Reply once.',
    // Default systemPromptMode ⇒ the runner builds the full system prompt.
    // Poisoning the tool list makes that build throw — the stand-in for any
    // real getSystemPrompt failure at this seam.
    poisonCtx: ctx => {
      ;(ctx.options as Record<string, unknown>).tools = undefined
    },
  })

  // D2: the launch composition lives INSIDE the runner's try band — a build
  // failure is owned by the same failure terminal as any mid-loop throw. As
  // characterized, it rejected pre-try: the task stayed 'running' forever
  // with no bookend and no lead notification.
  let rejection: unknown
  const result = await settleWithin(
    s.runPromise.catch(err => {
      rejection = err
      return { success: false as const, error: String(err), messages: [] }
    }),
    s,
    '§6',
  )
  drainInto()
  check('D2: runInProcessTeammate RESOLVES failure (never rejects)', rejection === undefined && result.success === false, String(rejection ?? result.error))
  const t = task(s.store, s.taskId)
  check("D2: terminal status is 'failed' with the cause kept", t?.status === 'failed' && !!t.error, `${t?.status} ${t?.error ?? ''}`)
  const bookends = bookendsFor(s.taskId)
  check("D2: one 'failed' bookend", bookends.length === 1 && bookends[0]?.status === 'failed', JSON.stringify(bookends))
  check(
    "D2: the lead is told 'failed'",
    await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'failed'), 10_000),
  )
  await s.api.close()
}

// ── §7 the work-abort law (Escape) ──────────────────────────────────────────
section('§7 — work abort interrupts the TURN, not the teammate; revival works')
{
  const team = 'own7-s6'
  const s = await launch({
    name: 'probe6',
    team,
    turns: [
      { kind: 'hang', deltas: ['thinking…'] },
      { kind: 'text', text: 'S6 revived reply.' },
    ],
    prompt: 'Reply once.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })
  await s.api.messageRequestStarted(1)
  check(
    'a work controller is live during the turn',
    await waitFor(() => task(s.store, s.taskId)?.currentWorkAbortController !== undefined, 20_000),
  )

  task(s.store, s.taskId).currentWorkAbortController!.abort()
  check('the interrupted teammate returns to IDLE (not failed, not dead)', await waitFor(() => task(s.store, s.taskId)?.isIdle === true, 30_000))
  const t1 = task(s.store, s.taskId)
  check("status stays 'running' after the interrupt", t1.status === 'running', t1.status)
  check('the interrupt is visible in the transcript mirror', JSON.stringify(t1.messages ?? []).includes(ERROR_MESSAGE_USER_ABORT))
  check(
    "the lead is told: idleReason 'interrupted'",
    await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'interrupted'), 10_000),
  )

  // Revival: the next lead message starts a fresh turn on the SAME teammate.
  await writeToMailbox('probe6', { from: 'team-lead', text: 'go again', timestamp: new Date().toISOString() }, team)
  check(
    'the teammate revives and completes the next turn',
    await waitFor(
      () => s.api.messageRequests().length === 2 && task(s.store, s.taskId)?.isIdle === true,
      60_000,
    ),
  )
  check(
    "the revived turn reports 'available' again",
    await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'available'), 10_000),
  )

  s.lifecycle.abort()
  const result = await settleWithin(s.runPromise, s, '§7')
  drainInto()
  check('the interrupted-then-revived teammate still terminalizes cleanly', result.success === true && task(s.store, s.taskId).status === 'completed')
  check('the revived reply made it into the conversation', JSON.stringify(result.messages).includes('S6 revived reply.'))
  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'completed' bookend", bookends.length === 1 && bookends[0]?.status === 'completed', JSON.stringify(bookends))
  await s.api.close()
}

// ── §7b the interrupt-delivers-mail law ──────────────────────────────────────
section('§7b — mail queued while working is delivered AT the interrupt; the teammate continues unnudged')
{
  const team = 'own7b-s7'
  const s = await launch({
    name: 'probe7',
    team,
    turns: [
      { kind: 'hang', deltas: ['working…'] },
      { kind: 'text', text: 'S7 reply one.' },
      { kind: 'text', text: 'S7 reply two.' },
      { kind: 'text', text: 'S7 reply three.' },
      { kind: 'text', text: 'S7 reply four.' },
    ],
    prompt: 'Work until told otherwise.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })
  await s.api.messageRequestStarted(1)
  check(
    'the turn is live (work controller present)',
    await waitFor(() => task(s.store, s.taskId)?.currentWorkAbortController !== undefined, 20_000),
  )
  // Four messages arrive WHILE the turn hangs: two operator lines typed at
  // the teammate (the REPL's injector), one from the lead and one from a
  // peer through the mailbox (the SendMessage estate's delivery).
  check('operator line 1 accepted mid-turn', injectUserMessageToTeammate(s.taskId, 'MAIL-OP-1 first operator line', s.store.setAppState as never))
  check('operator line 2 accepted mid-turn', injectUserMessageToTeammate(s.taskId, 'MAIL-OP-2 second operator line', s.store.setAppState as never))
  await writeToMailbox('probe7', { from: 'peer-b', text: 'MAIL-PEER a peer note', timestamp: new Date().toISOString() }, team)
  await writeToMailbox('probe7', { from: 'team-lead', text: 'MAIL-LEAD the lead speaks', timestamp: new Date().toISOString() }, team)
  check('the mail is queued, unread, while the turn still hangs', (await readMailbox('probe7', team)).filter(m => !m.read).length === 2 && s.api.messageRequests().length === 1)

  // THE INTERRUPT — and nothing else: no further write, no nudge.
  task(s.store, s.taskId).currentWorkAbortController!.abort()
  check(
    'four further turns run on their own — one per queued message',
    await waitFor(() => s.api.messageRequests().length === 5, 60_000),
    `requests=${s.api.messageRequests().length}`,
  )
  check('…and the teammate settles idle, alive', await waitFor(() => task(s.store, s.taskId)?.isIdle === true && s.api.messageRequests().length === 5, 30_000))
  const lastUserText = (req: { body: unknown }): string => {
    const msgs = (req.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
    const user = [...msgs].reverse().find(m => m.role === 'user')
    const c = user?.content
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b as { text?: string }).text ?? '').join(' ') : ''
  }
  const turns = s.api.messageRequests().slice(1).map(lastUserText)
  check('every queued message was delivered (none left unread)', (await readMailbox('probe7', team)).every(m => m.read) && (task(s.store, s.taskId).pendingUserMessages ?? []).length === 0)
  check(
    "the runner's order: operator lines first, then the lead, then peers",
    turns[0]?.includes('MAIL-OP-1') === true && turns[1]?.includes('MAIL-OP-2') === true && turns[2]?.includes('MAIL-LEAD') === true && turns[3]?.includes('MAIL-PEER') === true,
    JSON.stringify(turns.map(t => t.slice(0, 60))),
  )
  check("the interrupt itself was reported 'interrupted' (the lead knows why the turn ended)", await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'interrupted'), 10_000))
  check("status stays 'running' throughout", task(s.store, s.taskId).status === 'running', task(s.store, s.taskId).status)

  s.lifecycle.abort()
  const result = await settleWithin(s.runPromise, s, '§7b')
  drainInto()
  check('the teammate terminalizes cleanly after the delivered mail', result.success === true && task(s.store, s.taskId).status === 'completed')
  check('all four replies made it into the conversation', ['S7 reply one.', 'S7 reply two.', 'S7 reply three.', 'S7 reply four.'].every(r => JSON.stringify(result.messages).includes(r)))
  await s.api.close()
}

// ── §8 the AgentTool foreground dispatch (the 7.3 execution machine) ────────
section('§8 — a REAL AgentTool.call() completes through the foreground machine')
{
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const { GENERAL_PURPOSE_AGENT } = await import(
    '../../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
  )
  const api = await startFixtureApi([{ kind: 'text', text: 'AGENTTOOL PROBE REPLY.' }])
  process.env.ANTHROPIC_BASE_URL = api.url
  const store = makeStore()
  const ctx = makeCtx(store)
  ;(ctx.options as Record<string, unknown>).agentDefinitions = {
    activeAgents: [GENERAL_PURPOSE_AGENT],
  }
  ;(ctx as Record<string, unknown>).toolUseId = 'toolu_agenttool_probe'
  ;(ctx as Record<string, unknown>).setResponseLength = () => {}
  const assistantMessage = {
    type: 'assistant',
    requestId: 'req_probe',
    message: { id: 'msg_probe_parent', content: [] },
  }

  const result = (await AgentTool.call(
    {
      description: 'foreground probe',
      prompt: 'Reply once and stop.',
      subagent_type: 'general-purpose',
    } as never,
    ctx as never,
    (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
    assistantMessage as never,
  )) as { data: { status: string; content?: Array<{ text?: string }> } }
  drainInto()

  check("the dispatch completes: status 'completed'", result.data.status === 'completed', result.data.status)
  check('the scripted reply is the result content', JSON.stringify(result.data.content ?? []).includes('AGENTTOOL PROBE REPLY.'))
  check('exactly one model call', api.messageRequests().length === 1, `${api.messageRequests().length}`)
  const fgBookends = allDrained.filter(
    e => e.subtype === 'task_notification' && e.tool_use_id === 'toolu_agenttool_probe',
  )
  check("EXACTLY-ONCE: one 'completed' foreground bookend", fgBookends.length === 1 && fgBookends[0]?.status === 'completed', JSON.stringify(fgBookends))
  const leftoverRunning = Object.values(store.getAppState().tasks).filter(
    t => (t as { status?: string }).status === 'running',
  )
  check('no task row left running', leftoverRunning.length === 0, `${leftoverRunning.length}`)
  await api.close()
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ RUNNER LIFECYCLE LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} RUNNER LIFECYCLE FAILURE(S)`)
process.exit(1)

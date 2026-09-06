#!/usr/bin/env bun
import {
  ERROR_MESSAGE_USER_ABORT,
  bookendsFor,
  bootstrap,
  check,
  deriveTeamCharter,
  drainInto,
  failureCount,
  getBuiltInAgents,
  idleNotificationsFor,
  killInProcessTeammate,
  launch,
  makeCtx,
  makeStore,
  resolveTeammateRole,
  section,
  settleWithin,
  task,
  waitFor,
  writeToMailbox,
  allDrained,
} from './lib/runnerLifecycleHarness.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

section('§1 — harness preconditions')
{
  check(
    'session is non-interactive (SDK bookends observable via drainSdkEvents)',
    bootstrap.getIsNonInteractiveSession(),
  )
}

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

  check(
    "the lead receives an 'available' idle notification",
    await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'available'), 10_000),
  )

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

  await writeToMailbox('probe1', { from: 'team-lead', text: 'anyone home?', timestamp: new Date().toISOString() }, team)
  await new Promise(r => setTimeout(r, 700))
  check('no revival after terminal: status unchanged', task(s.store, s.taskId).status === 'completed')
  check('no revival after terminal: no new model calls', s.api.messageRequests().length === 1)
  await s.api.close()
}

section('§3 — a mid-loop throw (failing auto-compaction) terminalizes FAILED exactly once')
{
  const team = 'own7-s2'
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

  check('D1: the runner converges promptly after a mid-turn kill', await waitFor(() => s.settled(), 2_500))
  const result = await settleWithin(s.runPromise, s, '§5')
  check('D1: the late exit resolves cleanly', result.success === true)
  check("D1: the exit honors the kill: status stays 'killed'", task(s.store, s.taskId)?.status === 'killed', task(s.store, s.taskId)?.status)
  drainInto()
  const bookends = bookendsFor(s.taskId)
  check("EXACTLY-ONCE: one 'stopped' bookend (the kill's), none from the runner", bookends.length === 1 && bookends[0]?.status === 'stopped', JSON.stringify(bookends))
  await s.api.close()
}

section('§6 — REGRESSION FIXTURE (D2): a launch-composition throw terminalizes FAILED')
{
  const team = 'own7-s5'
  const s = await launch({
    name: 'probe5',
    team,
    turns: [],
    prompt: 'Reply once.',
    poisonCtx: ctx => {
      ;(ctx.options as Record<string, unknown>).tools = undefined
    },
  })

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

section('§7b — mail queued while working is delivered AT the interrupt: proven under node by prove-runner-mail-at-interrupt.ts (this leg aborts a held stream; bun parks on that abort)')

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
if (failureCount() === 0) {
  console.log(' ✅ RUNNER LIFECYCLE LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failureCount()} RUNNER LIFECYCLE FAILURE(S)`)
process.exit(1)

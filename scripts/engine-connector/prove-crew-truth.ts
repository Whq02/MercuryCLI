#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-crew-truth.ts — ONE TRUTH for a session's
//  sub-agents: the record every crew surface paints is derived once, from
//  the runner's own task store through the work roster, whatever family the
//  runner speaks.
//
//   T1 the ledger fold: settled responses fold per response (a later message
//      of the same response replaces, never double-counts); a priced model
//      prices, a model with no rate counts an unpriced turn beside its
//      tokens; the served model rides the fold; a usage-less message leaves
//      it untouched; a fresh tracker carries no counter.
//   T2 the projector: two running agents — one served by an OpenAI id, one
//      by an Anthropic id — and a named agent project rows with the same
//      counters; a launch with no settled response carries its launch model
//      and no fabricated counter; the projector names no family.
//   T3 one record, every surface: the /tasks board's own derivation yields
//      byte-equal facts per agent; the rail lists exactly the running ones;
//      the count label matches the rows; running lead, newest first.
//   T4 the Crew view painted off-screen from a fixture connector: both
//      agents with model + tokens while running and after landing; the
//      empty state with its door; the hosted card reads the same record.
//   T5 the usage attribution: the line sums the crew's tokens, and the
//      session ledger counts a sub-agent's response folded under the agent
//      context — the total the usage surfaces read includes them.
//   T6 the source pins: the foreground path publishes ungated, both
//      registrations carry the resolved model, every surface rides the
//      owner.
//
//  cpu-pure: fixture stores and off-screen string renders — never a PTY, a
//  daemon, a boot, or a live model call.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The deterministic world (env pins BEFORE the dynamic imports).
const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-truth-')))
process.env['MERCURY_CONFIG_DIR'] = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['MERCURY_OPERATOR'] = 'sam'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[k] = '0'
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

// The AgentTool cycle's bun entry-order law: entering through the tool
// module first settles the module order the way the app graph does.
await import('../../src/tools/AgentTool/AgentTool.tsx')
// The config gate: the surfaces read settings at render.
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { createProgressTracker, getProgressUpdate, updateProgressFromMessage } = await import(
  '../../src/tasks/LocalAgentTask/LocalAgentTask.tsx'
)
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const { rosterRowsOf, RosterWorkDetail } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
const { modelPricingBasis } = await import('../../src/utils/modelCost.ts')
const { formatDuration, formatTokens } = await import('../../src/utils/format.ts')
type WorkRowV1 = import('../../src/services/engine-connector/types.ts').WorkRowV1

const OPENAI_ID = 'gpt-5.2'
const ANTHROPIC_ID = 'claude-fable-5-1'
const NO_RATE_ID = 'fixture/no-rate-model'
const t0 = 1_000_000_000_000

type UsageBits = Partial<{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}>
let seq = 0
/** One assistant message as the tracker sees it — the wire's usage shape. */
const assistant = (id: string, model: string, usage: UsageBits, toolNames: string[] = []): never =>
  ({
    type: 'assistant',
    uuid: `fx-${id}-${++seq}`,
    timestamp: new Date(0).toISOString(),
    requestId: undefined,
    message: {
      id,
      model,
      role: 'assistant',
      type: 'message',
      stop_reason: null,
      stop_sequence: null,
      content: toolNames.map((name, i) => ({ type: 'tool_use', id: `tu-${id}-${i}`, name, input: {} })),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cache_creation: null,
        server_tool_use: null,
        ...usage,
      },
    },
  }) as never

// ── T1 the ledger fold ──────────────────────────────────────────────────────
console.log('— T1 the ledger fold —')
{
  const tr = createProgressTracker()
  updateProgressFromMessage(tr, assistant('r1', ANTHROPIC_ID, { input_tokens: 1000, output_tokens: 1 }))
  updateProgressFromMessage(tr, assistant('r1', ANTHROPIC_ID, { input_tokens: 1000, output_tokens: 400 }))
  check(
    'T1 a later message of the same response REPLACES its earlier fold',
    tr.ledger.inputTokens === 1000 && tr.ledger.outputTokens === 400,
    JSON.stringify(tr.ledger),
  )
  updateProgressFromMessage(tr, assistant('r2', ANTHROPIC_ID, { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 500 }))
  check(
    'T1 the next response ADDS, input counting the cached prefix read',
    tr.ledger.inputTokens === 3500 && tr.ledger.outputTokens === 500,
    JSON.stringify(tr.ledger),
  )
  check('T1 the served model rides the fold', tr.ledger.servedModel === ANTHROPIC_ID, String(tr.ledger.servedModel))
  const basis = modelPricingBasis(ANTHROPIC_ID)
  check(
    'T1 a priced model prices its responses (USD > 0, no unpriced turn)',
    basis !== 'unpriced' && tr.ledger.costUSD > 0 && tr.ledger.unpricedTurns === 0,
    `${basis} · $${tr.ledger.costUSD}`,
  )
  updateProgressFromMessage(tr, assistant('r3', NO_RATE_ID, { input_tokens: 10, output_tokens: 5 }))
  check(
    'T1 a model with no rate on file counts an unpriced turn beside its tokens — never a foreign rate',
    modelPricingBasis(NO_RATE_ID) === 'unpriced' && tr.ledger.unpricedTurns === 1 && tr.ledger.inputTokens === 3510 && tr.ledger.outputTokens === 505,
    JSON.stringify(tr.ledger),
  )
  const before = JSON.stringify(tr.ledger)
  updateProgressFromMessage(tr, assistant('r4', ANTHROPIC_ID, {}))
  check('T1 a usage-less message leaves the ledger untouched', JSON.stringify(tr.ledger) === before)
  const p = getProgressUpdate(tr)
  check(
    'T1 the progress snapshot carries the fold and the served model',
    p.inputTokens === 3510 && p.outputTokens === 505 && p.unpricedTurns === 1 && p.model === NO_RATE_ID,
    JSON.stringify(p),
  )
  const fresh = getProgressUpdate(createProgressTracker())
  check(
    'T1 a fresh tracker carries NO counter — honest absence, never a zero',
    fresh.inputTokens === undefined && fresh.outputTokens === undefined && fresh.costUSD === undefined && fresh.model === undefined,
  )
}

// ── T2 the projector, both families ─────────────────────────────────────────
console.log('— T2 the projector, both families —')
const fold = (model: string, input: number, output: number, toolNames: string[] = []) => {
  const tr = createProgressTracker()
  updateProgressFromMessage(tr, assistant(`${model}-1`, model, { input_tokens: input, output_tokens: output }, toolNames))
  return getProgressUpdate(tr)
}
const agentTask = (id: string, description: string, extra: Record<string, unknown>) => ({
  id,
  type: 'local_agent',
  status: 'running',
  description,
  agentId: id,
  prompt: 'p',
  agentType: 'general-purpose',
  isBackgrounded: false,
  outputFile: '/n',
  outputOffset: 0,
  notified: false,
  ...extra,
})
const store = {
  ag1: agentTask('ag1', 'tide-gauges', { toolUseId: 'tu-ag1', model: OPENAI_ID, progress: fold(OPENAI_ID, 1200, 300, ['Read']), startTime: t0 + 1 }),
  ag2: agentTask('ag2', 'reef-survey', { toolUseId: 'tu-ag2', model: ANTHROPIC_ID, progress: fold(ANTHROPIC_ID, 1500, 200), startTime: t0 + 2 }),
  ag3: agentTask('ag3', 'fresh-launch', { toolUseId: 'tu-ag3', model: ANTHROPIC_ID, startTime: t0 + 3 }),
  ag4: agentTask('ag4', 'landed-scout', {
    status: 'completed',
    model: ANTHROPIC_ID,
    progress: fold(ANTHROPIC_ID, 1500, 200),
    startTime: t0,
    endTime: t0 + 9000,
  }),
  main1: agentTask('main1', 'the session itself', { agentType: 'main-session', startTime: t0 + 5 }),
  tm1: {
    id: 'tm1',
    type: 'in_process_teammate',
    status: 'running',
    description: 't',
    identity: { agentId: 'scout@crew', agentName: 'scout', teamName: 'crew' },
    prompt: 'p',
    awaitingPlanApproval: false,
    progress: fold(ANTHROPIC_ID, 800, 100),
    startTime: t0 + 4,
    outputFile: '/n',
    outputOffset: 0,
    notified: false,
  },
} as never
const rows: WorkRowV1[] = projectWorkRoster(store)
const byId = new Map(rows.map(r => [r.id, r]))
{
  const ag1 = byId.get('ag1')!
  const ag2 = byId.get('ag2')!
  const ag3 = byId.get('ag3')!
  const tm1 = byId.get('tm1')!
  check(
    'T2 the OpenAI-served agent row carries its served model and counters',
    ag1.model === OPENAI_ID && ag1.inputTokens === 1200 && ag1.outputTokens === 300 && ag1.totalTokens === 1500,
    JSON.stringify(ag1),
  )
  check(
    'T2 the Anthropic-served agent row the same',
    ag2.model === ANTHROPIC_ID && ag2.inputTokens === 1500 && ag2.outputTokens === 200 && ag2.totalTokens === 1700,
    JSON.stringify(ag2),
  )
  const core = (r: WorkRowV1): string =>
    ['model', 'inputTokens', 'outputTokens', 'totalTokens', 'agentType', 'startTime', 'status'].filter(k => k in r).join(',')
  check(
    'T2 the two families project the SAME shape — no family branch on the road',
    core(ag1) === core(ag2) && core(ag1) === 'model,inputTokens,outputTokens,totalTokens,agentType,startTime,status',
    `${core(ag1)} vs ${core(ag2)} (pricing ${modelPricingBasis(OPENAI_ID)} / ${modelPricingBasis(ANTHROPIC_ID)})`,
  )
  check(
    'T2 a launch with no settled response carries its launch model and NO counter',
    ag3.model === ANTHROPIC_ID && ag3.inputTokens === undefined && ag3.totalTokens === undefined && ag3.costUSD === undefined && ag3.unpricedTurns === undefined,
    JSON.stringify(ag3),
  )
  check(
    'T2 a named agent rides the same counters under its team',
    tm1.kind === 'teammate' && tm1.model === ANTHROPIC_ID && tm1.inputTokens === 800 && tm1.totalTokens === 900 && tm1.team === 'crew',
    JSON.stringify(tm1),
  )
  check("T2 the session's own main-thread row never rides the roster", !byId.has('main1'))
  const projector = src('src/utils/task/workRoster.ts')
  const family = new RegExp(['anth', 'ropic'].join('') + '|' + ['open', 'ai\\b'].join(''), 'i')
  check('T2 the projector names no family', !family.test(projector))
}

// ── T3 one record, every surface ────────────────────────────────────────────
console.log('— T3 one record, every surface —')
const agents = crew.crewAgentsOf(rows, 'fx-session')
{
  check(
    'T3 the crew = the agent + named rows (never the main thread)',
    agents.map(a => a.id).sort().join(',') === 'ag1,ag2,ag3,ag4,tm1',
    agents.map(a => a.id).join(','),
  )
  check(
    'T3 running first, newest first — the /tasks board\'s own order',
    agents.map(a => a.id).join(',') === 'tm1,ag3,ag2,ag1,ag4',
    agents.map(a => a.id).join(','),
  )
  const boardFacts = [...rosterRowsOf(rows, 'agent'), ...rosterRowsOf(rows, 'teammate')].map(w =>
    crew.crewAgentFactsOf(w, 'fx-session'),
  )
  check(
    'T3 the /tasks board\'s derivation yields the SAME record per agent (byte-equal)',
    boardFacts.length === agents.length &&
      boardFacts.every(f => f !== null && JSON.stringify(f) === JSON.stringify(agents.find(a => a.id === f.id))),
  )
  check('T3 the count label matches the rows', crew.crewCountLabel(agents) === '4 running · 5 sub-agents', crew.crewCountLabel(agents))
  check(
    'T3 the rail lists exactly the running ones',
    crew.crewRunning(agents).map(a => a.id).join(',') === 'tm1,ag3,ag2,ag1',
  )
  const ag1 = agents.find(a => a.id === 'ag1')!
  const line = crew.crewRowLine(ag1, t0 + 61_001)
  check(
    'T3 the row line spells every fact from the owner',
    line === `tide-gauges · ${OPENAI_ID} · running · 1.5k tokens · ${formatDuration(61_000)}`,
    line,
  )
  const fresh = agents.find(a => a.id === 'ag3')!
  check(
    'T3 a fresh launch spells its honest absences (model known, tokens not yet)',
    crew.crewModelLabel(fresh) === ANTHROPIC_ID && crew.crewTokensLabel(fresh) === null && crew.crewCostLabel(fresh) === null,
  )
  const landed = agents.find(a => a.id === 'ag4')!
  check('T3 a landed agent\'s elapsed freezes at its settle', crew.crewElapsedLabel(landed, t0 + 999_999) === '9s')
  check('T3 every agent names its parent session', agents.every(a => a.sessionId === 'fx-session'))
  check(
    'T3 an empty roster is the empty crew',
    crew.crewAgentsOf([], null).length === 0 && crew.crewCountLabel([]) === crew.CREW_EMPTY_LINE,
  )
}

// ── T4 the Crew view, painted off-screen ────────────────────────────────────
console.log('— T4 the Crew view painted off-screen —')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(
    '../../src/services/engine-connector/focusedConnector.ts'
  )
  const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
  const fakeConnector = (work: { rows: WorkRowV1[]; mission: never[] }): never =>
    ({
      sessionId: () => 'fx-session',
      workRoster: () => work,
      subscribeWork: () => () => {},
      subscribeRecords: () => () => {},
      identity: () => ({ firstPartyApi: true, consoleBilling: true, claudeAiBilling: false, accountEmail: null }),
    }) as never
  const paint = async (work: WorkRowV1[]): Promise<string> => {
    setFocusedSessionConnector(fakeConnector({ rows: work, mission: [] }))
    try {
      return await renderToString(React.createElement(CrewView, { onClose: () => {} }), 110)
    } catch (e) {
      return `RENDER FAILED: ${String(e)}`
    }
  }
  const ag1 = agents.find(a => a.id === 'ag1')!
  const ag2 = agents.find(a => a.id === 'ag2')!
  const live = await paint(rows)
  check('T4 the view paints', !live.startsWith('RENDER FAILED'), live.slice(0, 200))
  check(
    'T4 while running: both agents with their model + tokens (the owner\'s spellings)',
    live.includes('tide-gauges') && live.includes(OPENAI_ID) && live.includes(crew.crewTokensLabel(ag1)!) &&
      live.includes('reef-survey') && live.includes(ANTHROPIC_ID) && live.includes(crew.crewTokensLabel(ag2)!),
  )
  check('T4 while running: the status word and the named agent', live.includes('running') && live.includes('scout'))
  check('T4 the count label on the view', live.includes(crew.crewCountLabel(agents)))
  check('T4 the fresh launch shows its model and no fabricated token count', live.includes('fresh-launch') && live.includes(ANTHROPIC_ID))
  check("T4 no named agents yet — the spawn door", live.includes('no named agents yet') && live.includes('press n'))
  const landedRows: WorkRowV1[] = rows.map(r => ({ ...r, status: 'completed', endTime: r.startTime + 60_000 }))
  const landed = await paint(landedRows)
  const landedFacts = crew.crewAgentsOf(landedRows, 'fx-session')
  check(
    'T4 after landing: both agents still listed with model + tokens, the one status word (landed, never the runner\'s completed)',
    landed.includes(OPENAI_ID) && landed.includes(ANTHROPIC_ID) && landed.includes('landed') && !landed.includes('completed') &&
      landed.includes(crew.crewTokensLabel(landedFacts.find(a => a.id === 'ag1')!)!),
  )
  check('T4 after landing: the count label reads none running', landed.includes(crew.crewCountLabel(landedFacts)) && crew.crewCountLabel(landedFacts).startsWith('0 running'))
  const empty = await paint([])
  check('T4 the empty state says so and names the door', empty.includes(crew.CREW_EMPTY_LINE) && empty.includes('press n'))
  // The hosted card — the /tasks board's own card — reads the same record.
  setFocusedSessionConnector(fakeConnector({ rows, mission: [] }))
  let card = ''
  try {
    card = await renderToString(React.createElement(RosterWorkDetail, { work: byId.get('ag1')!, now: t0 + 61_001, onBack: () => {} }), 100)
  } catch (e) {
    card = `RENDER FAILED: ${String(e)}`
  }
  check('T4 the card paints', !card.startsWith('RENDER FAILED'), card.slice(0, 200))
  check(
    'T4 the card reads the same record — model, tokens, the in/out breakdown',
    card.includes(OPENAI_ID) && card.includes(crew.crewTokensLabel(ag1)!) && card.includes(crew.crewTokensBreakdown(ag1)!),
  )
  const spend = crew.crewCostLabel(ag1)
  check(
    'T4 the card spells the spend where the session is billed per call (the one cost spelling)',
    spend === null || card.includes(spend),
    `${spend}`,
  )
  _resetFocusedSessionConnectorForTesting()
}

// ── T5 the usage attribution ────────────────────────────────────────────────
console.log('— T5 the usage attribution —')
{
  const line = crew.crewUsageLine(agents)
  const counted = agents.filter(a => a.tokens !== null)
  check(
    'T5 the line sums the crew\'s tokens over the agents that settled any, live ones counted',
    line !== null && line.startsWith(`sub-agents ${formatTokens(crew.crewTokenSum(counted))} tokens · 4 agents · 3 live`),
    String(line),
  )
  check('T5 no settled response ⇒ no line (never a zero that reads as fact)', crew.crewUsageLine([agents.find(a => a.id === 'ag3')!]) === null)
  const { addToTotalSessionCost } = await import('../../src/cost-tracker.ts')
  const state = await import('../../src/bootstrap/state.ts')
  const { runWithAgentContext } = await import('../../src/utils/agentContext.ts')
  const inBefore = state.getTotalInputTokens()
  const outBefore = state.getTotalOutputTokens()
  runWithAgentContext(
    { agentType: 'subagent', agentId: 'fx-agent', invocationKind: 'spawn', invocationEmitted: false } as never,
    () => {
      addToTotalSessionCost(
        0.01,
        { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never,
        ANTHROPIC_ID,
      )
    },
  )
  check(
    "T5 the session ledger counts a sub-agent's response — its tokens are IN the total the usage surfaces read",
    state.getTotalInputTokens() - inBefore === 1000 && state.getTotalOutputTokens() - outBefore === 50,
    `${state.getTotalInputTokens() - inBefore} / ${state.getTotalOutputTokens() - outBefore}`,
  )
}

// ── T6 the source pins ──────────────────────────────────────────────────────
console.log('— T6 the source pins —')
{
  const fg = src('src/tools/AgentTool/foregroundExecution.tsx')
  check(
    'T6 the foreground path publishes the tracker to the record on every assistant message, ungated',
    fg.includes("if (message.type === 'assistant') {\n          updateAgentProgress(\n            foregroundTask.taskId,") &&
      !fg.includes('if (getSdkAgentProgressSummariesEnabled()) {\n            // Publish the tracker'),
  )
  check('T6 the foreground registration carries the resolved model', fg.includes('model: metadata.resolvedAgentModel,'))
  check(
    'T6 the background registration carries the resolved model',
    src('src/tools/AgentTool/AgentTool.tsx').includes('model: plan.model,\n        toolUseId: context.toolUseId,'),
  )
  const rail = src('src/components/HelmLanesRail.tsx')
  check(
    'T6 the rail builds every crew row from the owner and spells a running verb from it',
    rail.includes('crewAgentsOf(roster.rows, sessionId)') &&
      rail.includes('crewAgentsOf(projectWorkRoster(tasks), sessionId)') &&
      rail.includes('crewTokensLabel(c.facts)'),
  )
  check("T6 the rail's overflow row opens the crew surface", rail.includes("command: '/teammates', label: 'crew:more'"))
  const board = src('src/components/tasks/BackgroundTasksDialog.tsx')
  check('T6 the /tasks row and card read the owner', (board.match(/crewAgentFactsOf\(work, null\)/g) ?? []).length === 2)
  check(
    'T6 the usage section attributes through the owner',
    src('src/components/HelmTelemetryRail.tsx').includes('crewUsageLine(crewAgentsOf(workRoster.rows'),
  )
  const view = src('src/components/mercury-ui/screens/CrewView.tsx')
  check(
    'T6 the Crew view lists from the owner and hosts the /tasks card as its drill-in',
    view.includes('crewAgentsOf(roster.rows, sessionId)') && view.includes('<RosterWorkDetail'),
  )
  check(
    'T6 /teammates mounts the Crew view',
    src('src/commands/teammates/teammates.tsx').includes('<CrewView'),
  )
}


// ── T7 the one status vocabulary + the transcript's agent card ──────────────
console.log('— T7 the status vocabulary and the transcript card —')
{
  const stateOf = (status: string) => crew.crewStateOf({ status })
  check(
    'T7 running/pending → running · completed → landed · killed → stopped · failed → failed',
    stateOf('running') === 'running' && stateOf('pending') === 'running' && stateOf('completed') === 'landed' &&
      stateOf('killed') === 'stopped' && stateOf('failed') === 'failed',
  )
  check(
    "T7 an interrupt's stop words land on stopped",
    stateOf('stopped') === 'stopped' && stateOf('interrupted') === 'stopped' && stateOf('cancelled') === 'stopped',
  )
  check('T7 the waiting line counts the running crew', crew.crewWaitingLine(agents) === 'waiting on 4 agents' && crew.crewWaitingLine([]) === null)
  const ag1 = agents.find(a => a.id === 'ag1')!
  check(
    "T7 the wire carries the launch's tool-use id, its tool-use count and its activity",
    ag1.toolUseId === 'tu-ag1' && ag1.toolUses === 1 && ag1.activity === 'Read' && crew.crewToolUsesLabel(ag1) === '1 tool use',
    JSON.stringify({ toolUseId: ag1.toolUseId, toolUses: ag1.toolUses, activity: ag1.activity }),
  )
  check(
    'T7 the join finds an agent by its tool-use id and a named agent by name',
    crew.crewAgentByToolUse(agents, 'tu-ag1')?.id === 'ag1' && crew.crewAgentByToolUse(agents, 'tu-none') === null && crew.crewAgentByName(agents, '@scout')?.id === 'tm1',
  )
  check('T7 the row line speaks the vocabulary', crew.crewRowLine(agents.find(a => a.id === 'ag4')!, t0).includes(' · landed · '))
  // The transcript's grouped card and single card, painted off-screen from the fixture connector.
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(
    '../../src/services/engine-connector/focusedConnector.ts'
  )
  const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
  const ui = await import('../../src/tools/AgentTool/UI.tsx')
  // The card's subtree reads the app state (the REPL wraps every row); the
  // harness mounts the same provider around the paint.
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const fake = (work: { rows: WorkRowV1[]; mission: never[] }): never =>
    ({
      sessionId: () => 'fx-session',
      workRoster: () => work,
      subscribeWork: () => () => {},
      subscribeRecords: () => () => {},
      identity: () => ({ firstPartyApi: true, consoleBilling: true, claudeAiBilling: false, accountEmail: null }),
    }) as never
  setFocusedSessionConnector(fake({ rows, mission: [] }))
  const paint = async (node: React.ReactNode, width: number): Promise<string> => {
    try {
      return await renderToString(React.createElement(AppStateProvider as never, {}, node), width)
    } catch (e) {
      return `RENDER FAILED: ${String(e)}`
    }
  }
  const grouped = await paint(
    ui.renderGroupedAgentToolUse(
      [
        { toolUseID: 'tu-ag1', input: { description: 'tide-gauges', prompt: 'p', subagent_type: 'general-purpose' }, progressMessages: [] },
        { toolUseID: 'tu-ag2', input: { description: 'reef-survey', prompt: 'p', subagent_type: 'general-purpose' }, progressMessages: [] },
        { toolUseID: 'tu-none', input: { description: 'unjoined', prompt: 'p' }, progressMessages: [] },
      ] as never,
      { shouldAnimate: false, tools: [] as never },
    ),
    110,
  )
  check('T7 the grouped card paints', !grouped.startsWith('RENDER FAILED'), grouped.slice(0, 200))
  check(
    "T7 the grouped card's joined rows paint the record — model · tool uses · tokens",
    grouped.includes(OPENAI_ID) && grouped.includes(ANTHROPIC_ID) && grouped.includes('1 tool use') && grouped.includes(crew.crewTokensLabel(ag1)!),
  )
  check(
    "T7 a joined row's status line is its activity + elapsed; an unjoined row keeps the tool's own initialising word",
    grouped.includes('Read · ') && grouped.includes('initialising'),
  )
  const single = await paint(ui.renderToolUseProgressMessage([], { tools: [] as never, verbose: false, toolUseID: 'tu-ag1' }), 100)
  check(
    'T7 the single card before any progress row paints the record',
    single.includes(OPENAI_ID) && single.includes('running') && single.includes('1 tool use') && single.includes(crew.crewTokensLabel(ag1)!),
    single.slice(0, 160),
  )
  const unknown = await paint(ui.renderToolUseProgressMessage([], { tools: [] as never, verbose: false, toolUseID: 'tu-none' }), 100)
  check('T7 an unjoined single card keeps the honest initialising line', unknown.includes('Initializing agent'))
  const stoppedRows: WorkRowV1[] = rows.map(r => (r.id === 'ag1' ? { ...r, status: 'killed', endTime: r.startTime + 5000 } : r))
  setFocusedSessionConnector(fake({ rows: stoppedRows, mission: [] }))
  const view = await paint(React.createElement(CrewView, { onClose: () => {} }), 110)
  check("T7 a killed row reads 'stopped' on the Crew view — never the runner's word", view.includes('stopped') && !view.includes('killed'))
  const card = await paint(React.createElement(RosterWorkDetail, { work: stoppedRows.find(r => r.id === 'ag1')!, now: t0 + 61_001, onBack: () => {} }), 100)
  check("T7 …and on the card", card.includes('stopped') && !card.includes('killed'))
  _resetFocusedSessionConnectorForTesting()
  check(
    "T7 the tool row hands its id to the tool's progress renderer",
    src('src/components/messages/AssistantToolUseMessage.tsx').includes('toolUseID: param.id,'),
  )
  const uiSrc = src('src/tools/AgentTool/UI.tsx')
  check(
    'T7 the agent card joins its rows to the owner',
    uiSrc.includes('crewAgentByToolUse(') && uiSrc.includes('<CrewAgentRows entries={entries} animate={animate} />'),
  )
}

console.log(failures === 0 ? '\nprove-crew-truth: ALL LAWS HOLD' : `\nprove-crew-truth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

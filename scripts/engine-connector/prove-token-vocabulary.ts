#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'token-vocab-')))
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
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const BARE = /\b\d[\d.]*k? tokens\b/

await import('../../src/tools/AgentTool/AgentTool.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getTokenCountFromUsage, contextFill } = await import('../../src/utils/tokens.ts')
const { mapOpenaiUsageToAnthropic, buildProviderUsageReceipt } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { createProgressTracker, getProgressUpdate, updateProgressFromMessage, getTokenCountFromTracker, getContextTokensFromTracker } = await import(
  '../../src/tasks/LocalAgentTask/LocalAgentTask.tsx'
)
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const { finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { addToTotalSessionCost, formatTotalCost } = await import('../../src/cost-tracker.ts')
const state = await import('../../src/bootstrap/state.ts')
type WorkRowV1 = import('../../src/services/engine-connector/types.ts').WorkRowV1

const MODEL = 'claude-fable-5-1'
const t0 = 1_000_000_000_000

type UsageBits = Partial<{
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}>
type BlockSpec = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; name: string }
let seq = 0
const assistant = (id: string, usage: UsageBits, blocks: BlockSpec[] = [], stopReason: string | null = null): never =>
  ({
    type: 'assistant',
    uuid: `fx-${id}-${++seq}`,
    timestamp: new Date(0).toISOString(),
    requestId: undefined,
    message: {
      id,
      model: MODEL,
      role: 'assistant',
      type: 'message',
      stop_reason: stopReason,
      stop_sequence: null,
      content: blocks.map((b, i) =>
        b.type === 'tool_use'
          ? { type: 'tool_use', id: `tu-${id}-${i}`, name: b.name, input: {} }
          : b.type === 'thinking'
            ? { type: 'thinking', thinking: b.thinking, signature: 'fx' }
            : { type: 'text', text: b.text },
      ),
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
const user = (text: string): never =>
  ({ type: 'user', uuid: `fx-u-${++seq}`, timestamp: new Date(0).toISOString(), message: { role: 'user', content: text } }) as never
const toolResult = (toolUseId: string): never =>
  ({
    type: 'user',
    uuid: `fx-r-${++seq}`,
    timestamp: new Date(0).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  }) as never

console.log('— §1 the wires agree on the fields —')
{
  const wire = { inputTokens: 1000, outputTokens: 900, cachedInputTokens: 600, reasoningOutputTokens: 800 }
  const mapped = mapOpenaiUsageToAnthropic(wire)
  check('§1 the cached prefix is inside the total: 400 uncached beside 600 read', mapped.input_tokens === 400 && mapped.cache_read_input_tokens === 600, JSON.stringify(mapped))
  check("§1 reasoning is inside output: the mapped output is the wire's whole output (900, its 800 of reasoning included)", mapped.output_tokens === 900)
  check("§1 the context is total + output (1900) — the tokens owner's count of the mapped envelope", getTokenCountFromUsage(mapped) === 1900, String(getTokenCountFromUsage(mapped)))
  const receipt = buildProviderUsageReceipt(wire)
  check('§1 the reasoning detail and the inclusive total survive on the receipt alone', receipt.reasoningOutputTokens === 800 && receipt.inputTokensTotal === 1000 && receipt.cachedInputTokens === 600)
}

console.log('— §2 the agent ledger —')
const openaiUsage = mapOpenaiUsageToAnthropic({ inputTokens: 1000, outputTokens: 900, cachedInputTokens: 600, reasoningOutputTokens: 800 })
{
  const tr = createProgressTracker()
  updateProgressFromMessage(tr, assistant('r1', { input_tokens: 1000, output_tokens: 1 }))
  updateProgressFromMessage(tr, assistant('r1', { input_tokens: 1000, output_tokens: 400 }))
  check('§2 one response: context = its size, spend = the same size (a later message of the same id replaces)', getContextTokensFromTracker(tr) === 1400 && getTokenCountFromTracker(tr) === 1400, JSON.stringify(tr.ledger))
  updateProgressFromMessage(
    tr,
    assistant('r2', { input_tokens: openaiUsage.input_tokens, output_tokens: openaiUsage.output_tokens, cache_read_input_tokens: openaiUsage.cache_read_input_tokens }, [
      { type: 'thinking', thinking: 'a long think' },
      { type: 'text', text: 'the answer' },
    ]),
  )
  check('§2 a reply with a think and a cached prefix: the context is that reply (1900), the spend the sum (3300) — the think in both', getContextTokensFromTracker(tr) === 1900 && getTokenCountFromTracker(tr) === 3300, JSON.stringify(tr.ledger))
  updateProgressFromMessage(tr, assistant('r3', { input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 100 }))
  check('§2 the next reply: context replaces (2600), spend adds (5900)', getContextTokensFromTracker(tr) === 2600 && getTokenCountFromTracker(tr) === 5900, JSON.stringify(tr.ledger))
  const snapshot = getProgressUpdate(tr)
  check(
    "§2 the snapshot carries both facts, and its total IS the spend (the SDK's total_tokens)",
    snapshot.contextTokens === 2600 && snapshot.inputTokens! + snapshot.outputTokens! === 5900 && snapshot.tokenCount === 5900 && snapshot.totalTokens === 5900,
    JSON.stringify(snapshot),
  )
  const late = assistant('r4', {}) as unknown as { message: { usage: { input_tokens: number; output_tokens: number } } }
  updateProgressFromMessage(tr, late as never)
  check('§2 a yielded placeholder (no usage yet) changes nothing', getTokenCountFromTracker(tr) === 5900 && getContextTokensFromTracker(tr) === 2600)
  late.message.usage.input_tokens = 300
  late.message.usage.output_tokens = 700
  check('§2 the usage that settled after the yield is folded at the next read: spend 6900, context 1000', getTokenCountFromTracker(tr) === 6900 && getContextTokensFromTracker(tr) === 1000, JSON.stringify(tr.ledger))
  const fresh = createProgressTracker()
  check('§2 a fresh tracker: 0 spend, 0 context, no counter on the snapshot', getTokenCountFromTracker(fresh) === 0 && getContextTokensFromTracker(fresh) === 0 && getProgressUpdate(fresh).contextTokens === undefined)
}

console.log('— §3 the roster row and the crew facts —')
const seatTracker = createProgressTracker()
updateProgressFromMessage(seatTracker, assistant('s1', { input_tokens: 1000, output_tokens: 400 }, [{ type: 'tool_use', name: 'Read' }]))
updateProgressFromMessage(seatTracker, assistant('s2', { input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 100 }))
const seatProgress = getProgressUpdate(seatTracker)
const agentTask = (id: string, description: string, extra: Record<string, unknown>) => ({
  id,
  type: 'local_agent',
  status: 'running',
  description,
  agentId: id,
  prompt: 'p',
  agentType: 'mercury-general',
  isBackgrounded: false,
  outputFile: '/n',
  outputOffset: 0,
  notified: false,
  ...extra,
})
const store = {
  ag1: agentTask('ag1', 'tide-gauges', { toolUseId: 'tu-ag1', model: MODEL, progress: seatProgress, startTime: t0 + 1 }),
} as never
const rows: WorkRowV1[] = projectWorkRoster(store)
const agents = crew.crewAgentsOf(rows, 'fx-session')
const ag1 = agents.find(a => a.id === 'ag1')!
{
  const row = rows.find(r => r.id === 'ag1')!
  check('§3 the row carries the context (2600) beside the sum (4000)', row.contextTokens === 2600 && row.totalTokens === 4000 && row.inputTokens === 3500 && row.outputTokens === 500, JSON.stringify(row))
  check('§3 the facts carry both: context 2600, spend 4000', ag1.tokens !== null && ag1.tokens.context === 2600 && ag1.tokens.total === 4000, JSON.stringify(ag1.tokens))
  check('§3 the default label is the CONTEXT with its word', crew.crewTokensLabel(ag1) === '2.6k context', String(crew.crewTokensLabel(ag1)))
  check('§3 the spend label is the SUM with its word', crew.crewSpendLabel(ag1) === '4k spent', String(crew.crewSpendLabel(ag1)))
  check('§3 the breakdown stays the spend\'s halves', crew.crewTokensBreakdown(ag1) === '3.5k in · 500 out', String(crew.crewTokensBreakdown(ag1)))
  check('§3 the row line spells the context', crew.crewRowLine(ag1, t0 + 61_001).includes(' · 2.6k context · '), crew.crewRowLine(ag1, t0 + 61_001))
  const line = crew.crewUsageLine(agents)
  check('§3 the attribution line is the crew\'s SPEND, with the word', line !== null && line.startsWith('sub-agents 4k spent · 1 agent'), String(line))
  const older: WorkRowV1 = { ...row }
  delete (older as { contextTokens?: number }).contextTokens
  const olderFacts = crew.crewAgentFactsOf(older, 'fx-session')!
  check("§3 an older runner's row (no context on the wire) spells its sum as what it is", olderFacts.tokens?.context === null && crew.crewTokensLabel(olderFacts) === '4k spent', String(crew.crewTokensLabel(olderFacts)))
  const totalOnly: WorkRowV1 = { id: 'ag9', kind: 'agent', name: 'old', status: 'running', startTime: t0, totalTokens: 4000 }
  check('§3 a total-only row the same', crew.crewTokensLabel(crew.crewAgentFactsOf(totalOnly, null)!) === '4k spent')
  const fresh = crew.crewAgentFactsOf({ id: 'ag8', kind: 'agent', name: 'fresh', status: 'running', startTime: t0 }, null)!
  check('§3 no settled response ⇒ no label at all (never a zero)', crew.crewTokensLabel(fresh) === null && crew.crewSpendLabel(fresh) === null)
}

console.log('— §4 the parent —')
{
  const reply = assistant('p1', { input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 900 }, [{ type: 'thinking', thinking: 'a long think' }, { type: 'text', text: 'the answer' }], 'end_turn')
  const fill = contextFill([user('ask'), reply])
  check("§4 the gauge's count is the reply's context — total + output, the think inside (1900), from the wire", fill.tokens === 1900 && fill.source === 'usage', JSON.stringify(fill))
  const outBefore = state.getTotalOutputTokens()
  const inBefore = state.getTotalInputTokens()
  const cacheBefore = state.getTotalCacheReadInputTokens()
  addToTotalSessionCost(0.01, { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 } as never, MODEL)
  check(
    "§4 the session ledger grows by the whole reply at settle: output +900 (the think inside), input +400, cache read +600",
    state.getTotalOutputTokens() - outBefore === 900 && state.getTotalInputTokens() - inBefore === 400 && state.getTotalCacheReadInputTokens() - cacheBefore === 600,
  )
  const cost = stripAnsi(formatTotalCost())
  check('§4 /cost says its rows are spend', cost.includes('Tokens spent by model:') && !cost.includes('Usage by model'), cost.split('\n').slice(0, 6).join(' | '))
}

console.log('— §5 the surfaces —')
{
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(
    '../../src/services/engine-connector/focusedConnector.ts'
  )
  const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
  const { RosterWorkDetail } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const ui = await import('../../src/tools/AgentTool/UI.tsx')
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
  const card = await paint(React.createElement(RosterWorkDetail, { work: rows[0]!, now: t0 + 61_001, onBack: () => {} }), 100)
  check('§5 the /tasks card paints', !card.startsWith('RENDER FAILED'), card.slice(0, 200))
  check('§5 the /tasks card names the context and the spend, each with its word, and the halves', card.includes('2.6k context') && card.includes('4k spent') && card.includes('3.5k in · 500 out'), card.replace(/\s+/g, ' ').slice(0, 300))
  check('§5 the /tasks card paints no bare count', !BARE.test(card))
  const view = await paint(React.createElement(CrewView, { onClose: () => {} }), 110)
  check('§5 the Crew view paints the context with its word', !view.startsWith('RENDER FAILED') && view.includes('2.6k context') && !BARE.test(view), view.replace(/\s+/g, ' ').slice(0, 300))
  const grouped = await paint(
    ui.renderGroupedAgentToolUse(
      [{ toolUseID: 'tu-ag1', input: { description: 'tide-gauges', prompt: 'p', subagent_type: 'mercury-general' }, progressMessages: [] }] as never,
      { shouldAnimate: false, tools: [] as never },
    ),
    110,
  )
  check("§5 the transcript's grouped card paints the joined record's context with its word", !grouped.startsWith('RENDER FAILED') && grouped.includes('2.6k context') && !BARE.test(grouped), grouped.replace(/\s+/g, ' ').slice(0, 300))
  const single = await paint(ui.renderToolUseProgressMessage([], { tools: [] as never, verbose: false, toolUseID: 'tu-ag1' }), 100)
  check("§5 the single card before any progress row paints the record's context", single.includes('2.6k context') && !BARE.test(single), single.slice(0, 200))
  const settled = await paint(
    ui.renderToolResultMessage(
      {
        status: 'completed',
        agentId: 'ag1',
        agentType: 'mercury-general',
        content: [{ type: 'text', text: 'done' }],
        totalToolUseCount: 1,
        totalDurationMs: 5100,
        totalTokens: 4000,
        usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, server_tool_use: null, service_tier: null, cache_creation: null },
      } as never,
      [],
      { tools: [] as never, verbose: false },
    ),
    100,
  )
  check('§5 the settled card names the context (2.6k) and the spend (4k), each with its word', settled.includes('2.6k context') && settled.includes('4k spent') && !BARE.test(settled), settled.replace(/\s+/g, ' ').slice(0, 300))
  const unreported = await paint(
    ui.renderToolResultMessage(
      { status: 'completed', agentId: 'ag2', agentType: 'mercury-general', content: [{ type: 'text', text: 'done' }], totalToolUseCount: 1, totalDurationMs: 100, totalTokens: 0 } as never,
      [],
      { tools: [] as never, verbose: false },
    ),
    100,
  )
  check('§5 a carrier that reported no usage paints neither figure (no invented zero)', !/context|spent|tokens/.test(unreported), unreported.replace(/\s+/g, ' ').slice(0, 200))
  _resetFocusedSessionConnectorForTesting()
}

console.log("— §6 the Agent tool's result —")
{
  const messages = [
    user('do the work'),
    assistant('f1', { input_tokens: 1000, output_tokens: 400 }, [{ type: 'tool_use', name: 'Read' }], 'tool_use'),
    toolResult('tu-f1-0'),
    assistant('f2', { input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 100 }, [{ type: 'text', text: 'the report' }], 'end_turn'),
  ]
  const result = finalizeAgentTool(messages as never, 'ag-fx', {
    prompt: 'do the work',
    resolvedAgentModel: MODEL,
    isBuiltInAgent: false,
    startTime: t0,
    agentType: 'mercury-general',
    isAsync: false,
  })
  check("§6 the result's total is the SPEND over the agent's messages (1400 + 2600)", result.totalTokens === 4000, String(result.totalTokens))
  check("§6 the result's usage is the newest reply — the context's source (2600 by the owner)", result.usage.input_tokens === 2000 && getTokenCountFromUsage(result.usage as never) === 2600, JSON.stringify(result.usage))
}

console.log(failures === 0 ? '\n✅ token vocabulary GREEN' : `\n❌ token vocabulary RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

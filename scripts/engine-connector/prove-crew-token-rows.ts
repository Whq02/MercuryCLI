#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'crew-token-rows-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['MERCURY_LIVE_GLYPHS', 'MERCURY_LIVE_CLOCK']) process.env[key] = '0'
await import('../../src/tools/AgentTool/AgentTool.tsx')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { createProgressTracker, getProgressUpdate, updateProgressFromMessage } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const crew = await import('../../src/services/engine-connector/crewFacts.ts')
const wire = await import('../../src/services/engine-connector/seatWire.ts')
const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const ui = await import('../../src/tools/AgentTool/UI.tsx')
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good ? ` — ${detail}` : ''}`)
}
const usages = [
  { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 },
  { input_tokens: 2000, output_tokens: 1100, cache_read_input_tokens: 25500 },
  { input_tokens: 6800, output_tokens: 1000, cache_read_input_tokens: 6500 },
]
const record = usages.flatMap((usage, i) => [
  { type: 'assistant', uuid: `partial-${i}`, message: { id: `response-${i}`, model: 'fixture/crew', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'assistant', uuid: `settled-${i}`, message: { id: `response-${i}`, model: 'fixture/crew', role: 'assistant', content: [], usage } },
])
const file = join(scratch, 'agent-fixture.jsonl')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { nextOrdinal } = await import('../../src/fabric/ordinal.ts')
let ordinal: ReturnType<typeof nextOrdinal> | null = null
writeFileSync(file, record.map(row => JSON.stringify(entryToRecord(row, { sessionId: 'fixture' as never, observedAt: new Date(0).toISOString(), source: { channel: 'sdk' }, nextOrdinal: () => (ordinal = nextOrdinal(ordinal)) }))).join('\n') + '\n')
const tracker = createProgressTracker()
const decoded = decodeTranscriptBuffer(readFileSync(file, 'utf8'))
check('fixture records decode without refusals or invalid rows', decoded.entries.length === 6 && decoded.invalid.length === 0 && decoded.refusal === undefined, JSON.stringify(decoded))
for (const row of decoded.entries) updateProgressFromMessage(tracker, row as never)
const task = { id: 'scout', type: 'local_agent', status: 'completed', description: 'scout', agentId: 'scout', toolUseId: 'launch-scout', agentType: 'mercury-crew', startTime: 1000, endTime: 61000, progress: getProgressUpdate(tracker) }
const rows = projectWorkRoster({ scout: task } as never)
const facts = crew.crewAgentFactsOf(rows[0]!, 'fixture')!
check('three settled record responses sum fresh input and output once', facts.tokens?.input === 9800 && facts.tokens.output === 2500 && facts.tokens.total === 12300, JSON.stringify(facts.tokens))
check('cache reads survive separately from input through the roster', (facts.tokens as unknown as { cached?: number })?.cached === 42000, JSON.stringify(facts.tokens))
check('context is the latest response rather than the cumulative spend', facts.tokens?.context === 14300, JSON.stringify(facts.tokens))
const expected = '14.3k context · 9.8k in · 2.5k out · 42k cached'
const setRows = (workRows: typeof rows): void => {
  const work = { rows: workRows, mission: [], reported: true }
  setFocusedSessionConnector(Object.assign(Object.create(noSessionConnector()), { sessionId: () => 'fixture', workRoster: () => work, subscribeWork: () => () => {}, identity: () => ({ consoleBilling: false }) }))
}
setRows(rows)
const paint = async (node: React.ReactNode, width: number): Promise<string> => stripAnsi(await renderToString(React.createElement(TerminalSizeContext.Provider, { value: { columns: width, rows: 51 } }, React.createElement(AppStateProvider as never, {}, node)), width))
const frameArg = process.argv.indexOf('--frames')
const frames = frameArg < 0 ? null : process.argv[frameArg + 1]!
const writing = process.argv.includes('--write')
const fixtureDir = join(import.meta.dir, 'fixtures', 'crew-tokens')
if (frames !== null) mkdirSync(frames, { recursive: true })
if (writing) mkdirSync(fixtureDir, { recursive: true })
const save = (name: string, frame: string): void => {
  if (frames !== null) writeFileSync(join(frames, name), frame + '\n')
  if (writing) writeFileSync(join(fixtureDir, name), frame + '\n')
  else if (process.argv.includes('--stills')) check(`stored still ${name}`, readFileSync(join(fixtureDir, name), 'utf8') === frame + '\n')
}
for (const width of [178, 120, 100, 80, 60]) {
  const view = await paint(React.createElement(CrewView, { onClose() {} }), width)
  const row = view.split('\n').filter(line => line.includes('scout'))
  check(`${width} columns: crew row stays one line and fits`, row.length === 1 && stringWidth(row[0] ?? '') <= width, row.join(' | '))
  if (width >= 100) check(`${width} columns: crew row names context, in, out and cached together`, row[0]?.includes(expected) === true, row[0])
  save(`crew-tokens-${width}.txt`, view)
}
{
  const clock = Date.now
  process.env.TZ = 'UTC'
  Date.now = () => 1_800_000_000_000
  const words = 'Your account has used its available credits. Please retry after the stated reset.'
  const paused = { ...rows[0]!, id: 'paused', name: 'paused-helper', status: 'failed', paused: { why: 'usage limit', words, resumesAtMs: Date.now() + 120_000 } }
  setRows([paused] as never)
  try {
    for (const width of [178, 120, 100, 80, 60]) {
      const frame = await paint(React.createElement(CrewView, { onClose() {} }), width)
      const flat = frame.split('\n').map(line => line.replace(/^│|│$/g, '').trim()).join(' ').replace(/\s+/g, ' ')
      check(`${width} columns: the paused row keeps the whole provider sentence`, flat.includes(words), frame)
      check(`${width} columns: the retry clock and immediate retry key survive`, flat.includes('retries by itself at') && flat.includes('r retries now'), frame)
      check(`${width} columns: every paused line fits`, frame.split('\n').every(line => stringWidth(line) <= width), frame)
      save(`crew-paused-${width}.txt`, frame)
    }
  } finally { Date.now = clock; setRows(rows) }
}
for (const width of [178, 100, 80, 60]) {
  const grouped = await paint(ui.renderGroupedAgentToolUse([{ toolUseID: 'launch-scout', input: { name: 'scout', description: 'scout', prompt: 'p', subagent_type: 'mercury-crew' }, progressMessages: [] }] as never, { shouldAnimate: false, tools: [] as never }), width)
  check(`${width} columns: inline AgentProgressLine names context, in, out and cached together`, grouped.includes(expected), grouped)
  check(`${width} columns: inline rows fit`, grouped.split('\n').every(line => stringWidth(line) <= width), grouped)
  save(`crew-tokens-inline-${width}.txt`, grouped)
}
const zero = crew.crewAgentFactsOf({ id: 'empty', kind: 'agent', name: 'empty', startTime: 0, status: 'completed', inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0 }, null)!
check('all-zero carrier usage remains absent', zero.tokens === null, JSON.stringify(zero.tokens))
const old = crew.crewAgentFactsOf({ id: 'old', kind: 'agent', name: 'old', startTime: 0, status: 'completed', totalTokens: 6000 }, null)!
check('a total-only carrier reports spent without invented halves', crew.crewTokensLabel(old) === '6k spent' && crew.crewTokensBreakdown(old) === null)
check('no usage is spelled in words rather than a dash or zero', typeof crew.crewTokensSummary === 'function' && crew.crewTokensSummary(zero) === 'usage not reported')
const encoded = wire.sessionFactsToWire({ model: { effective: 'fixture/crew' }, usage: { totalCostUSD: 0 }, skills: [], mcp: [], permissionMode: 'default', workspace: {}, queue: [], work: rows } as never)
const decodedFacts = wire.sessionFactsFromWire(encoded)
check('the hosted facts wire keeps cache reads apart', (encoded.work as Array<{ cache_read_tokens?: number }> | undefined)?.[0]?.cache_read_tokens === 42000 && decodedFacts?.work?.[0]?.cacheReadTokens === 42000, JSON.stringify(encoded.work))
const cachedOnlyTracker = createProgressTracker()
updateProgressFromMessage(cachedOnlyTracker, { type: 'assistant', message: { id: 'cached-only', model: 'fixture/crew', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 500 } } } as never)
const cachedOnly = crew.crewAgentFactsOf(projectWorkRoster({ cached: { ...task, id: 'cached', progress: getProgressUpdate(cachedOnlyTracker) } } as never)[0]!, null)!
check('a measured cache-only response is not mistaken for missing usage', cachedOnly.tokens?.context === 500 && cachedOnly.tokens?.cached === 500 && cachedOnly.tokens?.total === 0, JSON.stringify(cachedOnly.tokens))
if (writing) {
  const { registerGeneratedAsset } = await import('../lib/generated-assets-map.mjs')
  registerGeneratedAsset({ assets: ['scripts/engine-connector/fixtures/crew-tokens/*.txt'], generator: 'bun scripts/engine-connector/prove-crew-token-rows.ts --write', check: 'bun scripts/engine-connector/prove-crew-token-rows.ts --stills', sources: ['scripts/engine-connector/prove-crew-token-rows.ts', 'src/components/mercury-ui/screens/CrewView.tsx', 'src/components/AgentProgressLine.tsx', 'src/tools/AgentTool/UI.tsx', 'src/services/engine-connector/crewFacts.ts'] })
}
_resetFocusedSessionConnectorForTesting()
rmSync(scratch, { recursive: true, force: true })
console.log(`crew-token-rows: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

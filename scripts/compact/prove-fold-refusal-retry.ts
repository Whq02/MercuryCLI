import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'MERCURY_EFFORT_LEVEL', 'MERCURY_EXTRA_BODY']) delete process.env[name]
const home = mkdtempSync(join(tmpdir(), 'fold-refusal-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { createUserMessage } = await import('../../src/utils/messages.ts')
const compact = await import('../../src/services/compact/compact.ts')
const foldStatus = await import('../../src/services/compact/foldStatus.ts')
const { compactionRow } = await import('../../src/rows/project.ts')
const { CompactionRowSchema } = await import('../../src/rows/vocabulary.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { DIALECT_CONVERSATION, TWO_MODEL_COMPACTION } = await import('../messages/dialectFixture.ts')
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const summary = '<summary>The two-model conversation produced the word-count tool. Continue with UTF-8 handling and the focused tests.</summary>'
const context = (events: Array<{ type: string }>) => ({ abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], readFileState: new Map(), onCompactProgress: (event: { type: string }) => events.push(event), options: { tools: [], commands: [], mcpClients: [], engineModel: 'claude-sonnet-5-5', maxThinkingTokens: 0, thinkingConfig: { type: 'adaptive' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } })
const cache = { systemPrompt: ['Synthetic mixed-model compaction proof.'] } as never
try {
  for (const direction of ['full', 'from', 'up_to'] as const) {
    const events: Array<{ type: string }> = []
    const ctx = context(events)
    const rows = structuredClone(direction === 'full' ? DIALECT_CONVERSATION : TWO_MODEL_COMPACTION)
    const fold = () => direction === 'full'
      ? compact.compactConversation(rows, ctx as never, cache, false)
      : compact.partialCompactConversation(rows, 2, ctx as never, cache, undefined, direction)
    fixture.script([{ refusal: true }, { text: summary }])
    const before = fixture.captured.length
    let error: string | undefined
    let result: Awaited<ReturnType<typeof fold>> | undefined
    try { result = await fold() } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
    check(`${direction}: the first refusal ends the fold after one request`, fixture.captured.length - before === 1 && result === undefined, { requests: fixture.captured.length - before, result: result?.notes })
    check(`${direction}: the refusal keeps the provider's words in one line`, error?.includes('The model ended the response early (stop_reason: refusal)') === true && !error.includes('\n'), error)
    check(`${direction}: no retry event or installed summary`, !events.some(event => event.type === 'retry') && result === undefined, events)
    const sent = fixture.captured[before]?.body.messages as Array<{ role?: string; content?: unknown }> | undefined
    check(`${direction}: the request still carries assistant history`, sent?.some(row => row.role === 'assistant') === true, sent)
    if (direction === 'full') {
      const blocks = sent?.flatMap(row => Array.isArray(row.content) ? row.content : []) ?? []
      check('the refused full fold preserves both parallel tool calls and their results', ['toolu_A', 'toolu_B'].every(id => blocks.some(block => block.type === 'tool_use' && block.id === id) && blocks.some(block => block.type === 'tool_result' && block.tool_use_id === id)))
      check('the mixed-model words still ride the refused request', ['Count the words in my notes file.', 'Reading and counting now.', 'The file holds nine words.', 'Summarise what you found'].every(words => JSON.stringify(sent).includes(words)))
    }
    fixture.script([{ text: summary }])
    const freshBefore = fixture.captured.length
    const accepted = await fold()
    check(`${direction}: a fresh fold succeeds in one request without an outcome note`, fixture.captured.length - freshBefore === 1 && accepted.notes === undefined && accepted.summaryMessages.length === 1)
  }
  const now = Date.now()
  const started = foldStatus.foldStatusOnEvent(foldStatus.beginFoldStatus({ trigger: 'manual', startedAtMs: now, sessionMemory: false, microcompaction: false }), { type: 'compact_start' })
  const narrowing = foldStatus.foldStatusOnEvent(started, { type: 'retry', attempt: 2 })
  check('size recovery retains its attempt and stage words', narrowing.attempt === 2 && foldStatus.foldRowWords(narrowing, now).stage === 'summarising · retry 2')
  check('a retry adds no auxiliary status field', JSON.stringify(Object.keys(narrowing).sort()) === JSON.stringify(Object.keys(started).sort()))
  const onWire = foldStatus.foldStatusToWire(narrowing)
  check('wire status consists only of the current fold fields', JSON.stringify(Object.keys(onWire).sort()) === JSON.stringify(['schema', 'trigger', 'started_at_ms', 'stages', 'stage', 'fill', 'summary_tokens', 'summary_cap_tokens', 'attempt'].sort()), onWire)
  const row = { ...compactionRow({ session_id: 'fixture' } as never, narrowing), seq: 1, timestamp: new Date().toISOString() }
  check('the machine row retains narrowing progress', row.state === 'progress' && row.attempt === 2 && CompactionRowSchema().safeParse(row).success, row)
  check('the fold record round-trips its current fields', JSON.stringify(foldStatus.decodeFoldStatus(narrowing)) === JSON.stringify(narrowing))
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold-refusal: ${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)

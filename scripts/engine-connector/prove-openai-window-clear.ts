import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'window-clear-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { startOverflowFixture, OVERFLOW_LANES } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/services/providers/openai/openaiLimitState.ts')
const { openaiWindowFact } = await import('../../src/services/providers/openai/openaiWindowFact.ts')
const { publishSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { observedFamilyWindow } = await import('../../src/services/capFailover.ts')
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`) }
const source = 'api-key' as const
const at = Date.now()
const reset = at + 3600_000
const reads = { activeSource: () => source, window: () => state.openaiLimitWindow(source), observed: () => state.openaiObservedWall(source) }
state.__resetOpenaiLimitStateForTest()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const model = OVERFLOW_LANES.find(road => road.lane === 'openai')!.model
const request = async (): Promise<void> => {
  for await (const _ of routedCallModel({ messages: [createUserMessage({ content: 'Read the provider response.' })], systemPrompt: asSystemPrompt(['Synthetic cleared-window proof.']), thinkingConfig: { type: 'adaptive' }, tools: [], signal: new AbortController().signal, options: { model, effortValue: 'max', getToolPermissionContext: async () => getEmptyToolPermissionContext(), isNonInteractiveSession: true, hasAppendSystemPrompt: false, querySource: 'sdk' as never, agents: [], mcpTools: [] } })) {}
}
fixture.script([{ error: { status: 429, body: { error: { type: 'usage_limit_reached', message: 'The fixture window is closed.', resets_in_seconds: 518400 } } } }])
await request()
const refused = openaiWindowFact(reads)
check('the real refusal response records its provider window', refused !== undefined && state.openaiLimitWindow(source).state === 'limited', refused)
fixture.script([{ text: 'The provider serves the next request.' }])
await request()
check('a request inside the noted window still reaches and is served by the provider', fixture.captured.length === 2, fixture.captured.length)
const served = openaiWindowFact(reads)
check('a served response publishes explicit clear instead of omitting the fact', (served as any)?.state === 'clear' && served?.source === source && served.observedAtMs >= at, served)
state.__resetOpenaiLimitStateForTest()
const connector: any = new DaemonSessionConnector({ sessionId: 'window-clear-fixture', home, cwd: home } as never)
const publish = (fact: unknown): void => {
  const decoded = sessionFactsFromWire(sessionFactsToWire({ model: { effective: 'fixture' }, usage: { totalCostUSD: 0, openaiWindow: fact }, skills: [], mcp: [], permissionMode: 'default', workspace: {}, queue: [], work: [], busy: false } as never))
  check('the runner wire preserves the complete window fact', JSON.stringify(decoded?.usage.openaiWindow) === JSON.stringify(fact))
  publishSessionFacts({ ...decoded, schema: 1, sessionId: 'window-clear-fixture', atMs: Date.now() } as never)
  connector.readFacts()
}
try {
  publish(refused)
  check('the connector first adopts the provider refusal window', state.openaiLimitWindow(source).state === 'limited')
  let changes = 0
  const unsubscribe = state.subscribeOpenaiObserved(() => changes++)
  publish(served)
  check('the next served-response fact clears the screen-local note through the real connector', state.openaiLimitWindow(source).state === 'clear', state.openaiLimitWindow(source))
  const view = observedFamilyWindow('openai', { now: () => Date.now(), openaiActiveSource: () => source, openaiWall: s => state.openaiObservedWall(s), openaiBands: () => [], laneBilling: () => ({ state: 'clear' }) })
  check('the status and usage readers stop showing the reopened window', view.state === 'allowed', view)
  publish(served)
  check('re-reading a clear fact does not emit another change', changes === 1, changes)
  publish(refused)
  check('a delayed older refusal never resurrects the cleared note', state.openaiLimitWindow(source).state === 'clear')
  state.recordOpenaiUsageLimit(reset, 'chatgpt-subscription', () => at + 1)
  publish(served)
  check('clearing the key source never clears the separate subscription source', state.openaiLimitWindow('chatgpt-subscription').state === 'limited')
  unsubscribe()
} finally {
  connector.detach()
  await fixture.close()
  state.__resetOpenaiLimitStateForTest()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} openai-window-clear: ${failures} failures`)
process.exit(failures ? 1 : 0)

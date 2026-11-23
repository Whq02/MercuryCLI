import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import type { ContextFillView } from '../../src/engine/context-window/contextFill.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'prove-seat-context-receipt requires a scratch MERCURY_CONFIG_DIR; run via bin/proof or set scratch home')
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
globalThis.fetch = Object.assign(async () => { throw new Error('Context receipt proof has no network') }, globalThis.fetch)
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const model = 'compat/pod-current/openai/gpt-oss-120b'
saveGlobalConfig(config => ({ ...config, compatProvider: { 'pod-current': { baseUrl: 'http://127.0.0.1:1/v1', models: ['openai/gpt-oss-120b'] } } }))
const { configuredCompatEndpoints } = await import('../../src/models/roads/openaicompat/compatAccounts.ts')
const { rememberCompatCatalogue } = await import('../../src/models/roads/openaicompat/compatCatalogue.ts')
rememberCompatCatalogue(configuredCompatEndpoints()[0]!, { models: ['openai/gpt-oss-120b'], contextWindows: { 'openai/gpt-oss-120b': 131072 }, dialect: 'vllm' })
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')
const { calculateTokenWarningState } = await import('../../src/engine/compaction/autoFold.ts')
const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/engine/connector/seatWire.ts')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const React = await import('react')
const { Text } = await import('../../src/screen/themedRenderer.ts')
const hooks = await import('../../src/screen/model-picker/useDisplayedSessionModel.ts') as Record<string, unknown>
const message = { type: 'assistant', uuid: 'response', message: { id: 'response', role: 'assistant', model, content: [{ type: 'text', text: 'x'.repeat(400000) }], usage: { input_tokens: 70038, output_tokens: 581, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn' } }
const fill = contextFillView([message] as never, model)
const context = { model, ...fill }
const connector = new NoSessionConnector()
const receipt = { usage: { ...connector.usage(), context }, model: { effective: model, setting: model }, skills: [], mcp: [], permissionMode: 'default', workspace: {}, queue: [] }
const wire = sessionFactsToWire(receipt as never)
const restored = sessionFactsFromWire(wire) as unknown as { usage: { context?: typeof context } }
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok ? '\n' + detail : '')) }
check('runner context starts at the measured 70,619, not the 100k display estimate', fill.usedTokens === 70619 && fill.fillSource === 'usage', JSON.stringify(fill))
check('usage receipt carries the measured count in the wire vocabulary', (wire.usage as any).context?.used_tokens === 70619, JSON.stringify(wire.usage))
check('usage receipt survives the decode without changing the number', restored.usage.context?.usedTokens === 70619)
const { FIXTURE_MODEL, liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
const measured = { input_tokens: 70038, output_tokens: 581 } as never
const NEXT_MODEL = 'claude-sonnet-4-6'
const published = await withFixtureRunner([{ kind: 'text', text: 'the measured turn', usage: measured }], async runner => {
  const before = (await liveFactsOf(runner)).usage.context
  await runner.prompt('go')
  await runner.waitFor('the measured turn ends', row => row.type === 'outcome').catch(() => undefined)
  const after = (await liveFactsOf(runner)).usage.context
  await runner.request('session/set_model', { model: NEXT_MODEL }).catch(() => null)
  return { before, after, switched: (await liveFactsOf(runner)).usage.context }
})
const midTurn = await withFixtureRunner(
  [
    { kind: 'tool_use', name: 'Write', input: { file_path: 'note.txt', content: 'one\n' }, usage: measured },
    { kind: 'paced', deltas: ['one ', 'two ', 'three'], gapMs: 300 },
  ],
  async (runner, api) => {
    runner.onAsk(() => ({ outcome: 'allow' }) as never)
    await runner.prompt('go')
    await api.messageRequestStarted(2)
    const during = (await liveFactsOf(runner)).usage.context
    await runner.waitFor('the stepped turn ends', row => row.type === 'outcome').catch(() => undefined)
    return during
  },
).catch(() => undefined)
const own = { model: FIXTURE_MODEL, ...contextFillView([{ ...message, message: { ...message.message, model: FIXTURE_MODEL } }] as never, FIXTURE_MODEL) }
const ownNext = { model: NEXT_MODEL, ...contextFillView([] as never, NEXT_MODEL) }
const windowed = (row: Partial<typeof own> | undefined): string => JSON.stringify(row === undefined ? null : [row.model, row.usedTokens, row.usedPct, row.fillSource, row.window, row.windowSource, row.windowPinned])
const windowOf = (row: Partial<typeof own> | undefined): string => JSON.stringify(row === undefined ? null : [row.model, row.window, row.windowSource, row.windowPinned])
check(
  'runner publishes its own context calculation per facts answer',
  published.before?.usedTokens === null &&
    own.usedTokens === fill.usedTokens &&
    windowed(published.after) === windowed(own) &&
    ownNext.window !== own.window &&
    windowOf(published.switched) === windowOf(ownNext) &&
    JSON.stringify(Object.keys(published.after ?? {}).sort()) === JSON.stringify(Object.keys(own).sort()) &&
    midTurn?.fillSource === 'usage' &&
    (midTurn.usedTokens ?? 0) >= fill.usedTokens,
  JSON.stringify({ ...published, midTurn, own, ownNext }),
)
connector.modelFacts = () => ({ main: model, effective: model, setting: model, sessionPin: model, pendingSwitch: null })
connector.usage = () => receipt.usage
setFocusedSessionConnector(connector)
const rendered = { ...message, message: { ...message.message, usage: undefined } }
const useFill = hooks.useFocusedContextFill as undefined | ((messages: readonly any[], model: string) => ContextFillView)
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
function Display({ selected = model }: { selected?: string }) {
  const view = useFill ? useFill([rendered] as never, selected) : contextFillView([rendered] as never, selected)
  const left = calculateTokenWarningState(view.usedTokens ?? 0, selected).pctLeft
  return React.createElement(Text, {}, `${view.usedTokens} ${view.fillSource} left ${left}`)
}
try {
  mounted = await mountOffscreen(React.createElement(Display), 100, 6)
  await waitFor(() => mounted!.screen().trim().length > 0, 2000)
  check('F44R-38: screen shows measured context and positive room to compact', mounted.screen().includes('70619 usage') && !mounted.screen().includes('left 0'), mounted.screen())
  mounted.unmount()
  mounted = await mountOffscreen(React.createElement(Display, { selected: 'compat/other/model' }), 100, 6)
  await waitFor(() => mounted!.screen().trim().length > 0, 2000)
  check('a switched model cannot borrow the previous model count', !mounted.screen().includes('70619 usage'), mounted.screen())
} finally { mounted?.unmount(); releaseFocusedSessionConnector() }
if (process.argv.includes('--runner')) {
  const { hostRunner } = await import('../lib/runnerHost.ts')
  const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'context-runner-'))
  const cwd = join(home, 'project')
  mkdirSync(cwd)
  let requests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/v1/models') return Response.json({ data: [{ id: 'openai/gpt-oss-120b', owned_by: 'vllm', max_model_len: 131072 }] })
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = await request.json() as { model: string }
    requests++
    assert.equal(request.headers.get('authorization'), null)
    const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => 'data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n'
    return new Response(chunk({ content: 'CONTEXT-RECEIPT-READY' }) + chunk({}, 'stop', { prompt_tokens: 70038, completion_tokens: 581 }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ models: { [model]: { contextWindow: 131072 } }, compatProvider: { 'pod-current': { baseUrl: `http://127.0.0.1:${server.port}/v1`, models: ['openai/gpt-oss-120b'], dialect: 'vllm' } } }))
  const node = Bun.which('node')!
  const runner = hostRunner({ node, dist: join(import.meta.dir, '../../dist/mercury.mjs'), home, cwd, argv: ['--model', model], env: { HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_DAEMON_DIR: join(home, 'daemon'), TERM: 'dumb' } })
  try {
    await runner.initialize()
    await runner.prompt('reply with the fixture words')
    await runner.waitFor('the fixture reply settles', row => row.type === 'outcome' && JSON.stringify(row).includes('CONTEXT-RECEIPT-READY'), 60000)
    const facts = await runner.request('session/facts', {}, 30000) as any
    check('built runner publishes the same measured count after its real turn', facts.usage?.context?.used_tokens === 70619 && facts.usage.context.fill_source === 'usage' && facts.usage.context.window === 131072 && facts.usage.context.left_until_compact_pct > 0, JSON.stringify(facts.usage?.context))
    check('one keyless loopback inference request served the turn', requests === 1, String(requests))
  } finally { await runner.stop(5000); server.stop(true); rmSync(home, { recursive: true, force: true }) }
}
process.exitCode = failures ? 1 : 0

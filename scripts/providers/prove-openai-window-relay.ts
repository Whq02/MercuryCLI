import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const state = await import('../../src/services/providers/openai/openaiLimitState.ts')
const { openaiWindowFact } = await import('../../src/services/providers/openai/openaiWindowFact.ts')
const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { observedFamilyWindow, decideCapAction } = await import('../../src/services/capFailover.ts')
const now = Date.now()
const reset = now + 3600000
state.__resetOpenaiLimitStateForTest()
state.recordOpenaiUsageLimit(reset, 'chatgpt-subscription', () => now)
const fact = openaiWindowFact({ activeSource: () => 'chatgpt-subscription', window: source => state.openaiLimitWindow(source, () => now) })
const decoded = sessionFactsFromWire(sessionFactsToWire({ model: { effective: 'fixture' }, usage: { totalCostUSD: 0, openaiWindow: fact }, skills: [], mcp: [], permissionMode: 'flow', workspace: {}, queue: [] } as never))
assert.deepEqual(decoded?.usage.openaiWindow, fact)
state.__resetOpenaiLimitStateForTest()
const reads = {
  now: () => now,
  openaiActiveSource: () => 'chatgpt-subscription' as const,
  openaiWall: (source: 'chatgpt-subscription' | 'api-key') => state.openaiObservedWall(source),
  openaiBands: () => [{ usedPct: 100, resetsAtMs: reset, windowName: '5h window' }],
  laneBilling: () => ({ state: 'clear' as const }),
}
assert.equal(observedFamilyWindow('openai', reads).state, 'warning')
assert.equal(decideCapAction('offer', observedFamilyWindow('openai', reads).state).kind, 'none')
console.log('RED before adoption: the runner wall crosses the wire but the screen holds only a percentage')
assert.equal(typeof state.adoptOpenaiWindowFact, 'function')
let notices = 0
const unsubscribe = state.subscribeOpenaiObserved(() => { notices++ })
assert.equal(state.adoptOpenaiWindowFact(decoded?.usage.openaiWindow), true)
assert.equal(notices, 1)
assert.equal(observedFamilyWindow('openai', reads).state, 'rejected')
assert.equal(decideCapAction('offer', observedFamilyWindow('openai', reads).state).kind, 'offer')
assert.equal(state.openaiLimitWindow('api-key', () => now).state, 'clear')
for (const invalid of [undefined, null, [], {}, { ...fact, source: 'other' }, { ...fact, observedAtMs: 'now' }, { ...fact, resetsAtMs: NaN }]) assert.equal(state.adoptOpenaiWindowFact(invalid), false)
assert.equal(state.adoptOpenaiWindowFact(fact), false)
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now - 1, resetsAtMs: reset + 5000 }), false)
assert.equal(notices, 1)
assert.equal(state.adoptOpenaiWindowFact({ source: 'api-key', observedAtMs: now + 1, resetsAtMs: reset + 5000 }), true)
assert.equal(state.openaiObservedWall('chatgpt-subscription')?.resetsAtMs, reset)
state.recordOpenaiUsageLimit(reset + 10000, 'chatgpt-subscription', () => now + 10)
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now + 5 }), false)
assert.equal(state.openaiObservedWall('chatgpt-subscription')?.resetsAtMs, reset + 10000)
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now + 20, resetsAtMs: now - 1 }), true)
assert.equal(observedFamilyWindow('openai', reads).state, 'allowed')
state.__resetOpenaiLimitStateForTest()
const { publishSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const plane = mkdtempSync(join(tmpdir(), 'openai-window-relay-'))
const planeBefore = process.env.MERCURY_DAEMON_DIR
process.env.MERCURY_DAEMON_DIR = plane
publishSessionFacts({ schema: 1, sessionId: 'window-relay', atMs: now, busy: false, pendingModel: null, model: { effective: 'fixture', setting: null }, usage: { totalCostUSD: 0, openaiWindow: fact }, queue: [] } as never)
const hosted = new DaemonSessionConnector({ sessionId: 'window-relay', runnerId: 'runner-1', title: 'window relay', projectLabel: 'proof', workspaceId: plane, home: plane } as never, { rpc: async () => ({ ok: true }), armTranscriptWatcher: () => {}, armTranscriptTimer: () => {} })
await hosted.attach()
hosted.detach()
if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
else process.env.MERCURY_DAEMON_DIR = planeBefore
rmSync(plane, { recursive: true, force: true })
assert.equal(state.openaiObservedWall('chatgpt-subscription')?.resetsAtMs, reset, "a hosted connector attached over facts whose usage.openaiWindow is the runner's wall holds no wall: its facts read hands usage.openaiWindow to adoptOpenaiWindowFact")
unsubscribe()
state.__resetOpenaiLimitStateForTest()
console.log('PASS runner-to-screen wall adoption, source isolation, recency, expiry and one change signal')

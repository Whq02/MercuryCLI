import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const state = await import('../../src/models/roads/openai/openaiLimitState.ts')
const { openaiWindowFact } = await import('../../src/models/roads/openai/openaiWindowFact.ts')
const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/engine/connector/seatWire.ts')
const { observedFamilyWindow, decideCapAction } = await import('../../src/models/roads/capFailover.ts')
const now = Date.now()
const reset = now + 3600000
state.__resetOpenaiLimitStateForTest()
state.recordOpenaiUsageLimit(reset, 'chatgpt-subscription', () => now)
const fact = openaiWindowFact({ activeSource: () => 'chatgpt-subscription', window: source => state.openaiLimitWindow(source, () => now) })
const decoded = sessionFactsFromWire(sessionFactsToWire({ model: { effective: 'fixture' }, usage: { totalCostUSD: 0, openaiWindow: fact }, skills: [], mcp: [], permissionMode: 'flow', workspace: {}, queue: [] } as never))
assert.deepEqual(decoded?.usage.openaiWindow, fact, 'the openaiWindow fact did not survive the wire round trip; change sessionFactsToWire and sessionFactsFromWire in src/engine/connector/seatWire.ts')
state.__resetOpenaiLimitStateForTest()
const reads = {
  now: () => now,
  openaiActiveSource: () => 'chatgpt-subscription' as const,
  openaiWall: (source: 'chatgpt-subscription' | 'api-key') => state.openaiObservedWall(source),
  openaiBands: () => [{ usedPct: 100, resetsAtMs: reset, windowName: '5h window' }],
  laneBilling: () => ({ state: 'clear' as const }),
}
assert.equal(observedFamilyWindow('openai', reads).state, 'warning', 'a 100 percent band with no observed wall should read warning; change observedFamilyWindow in src/models/roads/capFailover.ts')
assert.equal(decideCapAction('offer', observedFamilyWindow('openai', reads).state).kind, 'none', 'a warning window should offer nothing; change decideCapAction in src/models/roads/capFailover.ts')
console.log('RED before adoption: the runner wall crosses the wire but the screen holds only a percentage')
assert.equal(typeof state.adoptOpenaiWindowFact, 'function', 'adoptOpenaiWindowFact is missing; add it to src/models/roads/openai/openaiLimitState.ts')
let notices = 0
const unsubscribe = state.subscribeOpenaiObserved(() => { notices++ })
assert.equal(state.adoptOpenaiWindowFact(decoded?.usage.openaiWindow), true, 'a relayed wall that is newer than any held was not adopted; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(notices, 1, 'adopting a wall must notify subscribeOpenaiObserved listeners once; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(observedFamilyWindow('openai', reads).state, 'rejected', 'after the wall is adopted the openai window should read rejected; change observedFamilyWindow in src/models/roads/capFailover.ts or the wall read openaiObservedWall in src/models/roads/openai/openaiLimitState.ts')
assert.equal(decideCapAction('offer', observedFamilyWindow('openai', reads).state).kind, 'offer', 'a rejected window should offer a failover; change decideCapAction in src/models/roads/capFailover.ts')
assert.equal(state.openaiLimitWindow('api-key', () => now).state, 'clear', 'a wall for the subscription source must not close the api-key source; change the per-source state in src/models/roads/openai/openaiLimitState.ts')
for (const invalid of [undefined, null, [], {}, { ...fact, source: 'other' }, { ...fact, observedAtMs: 'now' }, { ...fact, resetsAtMs: NaN }]) assert.equal(state.adoptOpenaiWindowFact(invalid), false, 'a malformed relayed fact must be refused; change the validation in adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts: ' + JSON.stringify(invalid))
assert.equal(state.adoptOpenaiWindowFact(fact), false, 'a fact no newer than the held wall must be refused; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now - 1, resetsAtMs: reset + 5000 }), false, 'an older relayed fact must be refused; change the recency test in adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(notices, 1, 'a refused fact must not notify listeners; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(state.adoptOpenaiWindowFact({ source: 'api-key', observedAtMs: now + 1, resetsAtMs: reset + 5000 }), true, 'a newer fact for the api-key source was not adopted; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(state.openaiObservedWall('chatgpt-subscription')?.resetsAtMs, reset, 'adopting an api-key wall changed the subscription wall; keep walls per source in src/models/roads/openai/openaiLimitState.ts')
state.recordOpenaiUsageLimit(reset + 10000, 'chatgpt-subscription', () => now + 10)
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now + 5 }), false, 'a fact older than a wall recorded locally must be refused; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(state.openaiObservedWall('chatgpt-subscription')?.resetsAtMs, reset + 10000, 'the locally recorded wall was overwritten by an older relayed fact; change src/models/roads/openai/openaiLimitState.ts')
assert.equal(state.adoptOpenaiWindowFact({ ...fact, observedAtMs: now + 20, resetsAtMs: now - 1 }), true, 'a newer fact whose reset has passed should be adopted as clear; change adoptOpenaiWindowFact in src/models/roads/openai/openaiLimitState.ts')
assert.equal(observedFamilyWindow('openai', reads).state, 'allowed', 'an expired wall should read allowed; change observedFamilyWindow in src/models/roads/capFailover.ts or openaiObservedWall in src/models/roads/openai/openaiLimitState.ts')
state.__resetOpenaiLimitStateForTest()
const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
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

#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.js'
import type { EngineConnectorV1 } from '../../src/services/engine-connector/types.js'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('store-snapshot-proof')
let checked = 0
function stable<T>(name: string, read: () => T): T {
  const first = read()
  assert.ok(Object.is(first, read()), `${name}: two reads without a write must be Object.is equal; cache the selected value at its store`)
  checked++
  return first
}

async function checkTileReads(): Promise<void> {
  const { LiveTileStore, TILE_BUDGET_MS_PER_S } = await import('../../src/components/concourse/liveTiles.js')
  let clock = 1_000_000
  let cost = 0
  let tail: { atMs: number; text: string } | null = null
  const store = new LiveTileStore({
    tailPath: id => join(home, `${id}.json`), transcriptPath: () => join(home, 'transcript'),
    readTail: () => { clock += cost; return tail }, activity: () => null,
    nowMs: () => clock, armMachinery: false, forceDegrade: false,
  })
  const read = () => store.readTile('tile')
  const still = stable('unregistered tile', read)
  const stop = store.register('tile', home, () => {})
  try {
    assert.equal(stable('registered tile', read), still)
    tail = { atMs: clock, text: 'working' }
    store._drainForTesting()
    const working = stable('active tile', read)
    assert.deepEqual(working, { kind: 'streaming', line: 'working' })
    store._drainForTesting()
    assert.equal(stable('unchanged tile after drain', read), working)
    cost = TILE_BUDGET_MS_PER_S + 1
    for (let i = 0; i < 2; i++) { clock += 1000; store._drainForTesting() }
    assert.equal(stable('degraded bit', () => store.isDegraded()), true)
    assert.equal(stable('degraded tile', read), still)
    cost = 0
    for (let i = 0; i < 2; i++) { clock += 5000; tail = { atMs: clock, text: 'working' }; store._drainForTesting() }
    assert.equal(stable('recovered bit', () => store.isDegraded()), false)
    assert.deepEqual(stable('recovered tile', read), working)
  } finally { stop() }
}

async function checkSessionReads(): Promise<void> {
  const { LiveTileStore, workChipStoreDeps } = await import('../../src/components/concourse/liveTiles.js')
  const { FactsPart } = await import('../../src/services/engine-connector/daemon/facts.js')
  const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
  const { publishSessionFacts, retireSeatProjections } = await import('../../src/services/engine-connector/seatProjections.js')
  const empty: EngineConnectorV1 = noSessionConnector()
  const sessionId = '00000000-0000-4000-8000-0000000000c9'
  const workspace = { cwd: home, originalCwd: home, projectRoot: home }
  const part = new FactsPart({ sessionId: () => sessionId, recordWorkspace: () => workspace, recordEffort: () => undefined, recordModel: () => undefined, awaitingRunner: () => false, adoptUsage: () => {}, adoptOpenaiCatalogue: () => {} })
  const readBoard = () => part.swarmBoard()
  assert.equal(stable('no-session board', () => empty.swarmBoard?.() ?? null), null)
  assert.equal(stable('empty board', readBoard), null)
  let clock = 1_000_000
  const facts: SessionFactsV1 = { schema: 1, atMs: clock, sessionId, busy: false, pendingModel: null, model: { effective: 'test', setting: null }, workspace, usage: empty.usage(), identity: empty.identity(), skills: [], mcp: [], queue: [], work: [{ id: 'one', kind: 'shell', name: 'one', status: 'running', startTime: clock }] }
  for (const snapshot of [1, 2]) {
    const next = { ...facts, swarm: { on: true, snapshot, peerTurns: 0, omitted: 0, events: [] } }
    part.take(next, next)
    assert.equal(stable(`board revision ${snapshot}`, readBoard), next.swarm)
  }
  const chips = new LiveTileStore({ ...workChipStoreDeps(() => clock), armMachinery: false, forceDegrade: false })
  const readChip = () => { const now = chips.readTile(sessionId); return now.kind === 'still' ? null : now.line }
  const stop = chips.register(sessionId, '', () => {})
  try {
    assert.equal(stable('empty chip', readChip), null)
    publishSessionFacts(facts)
    chips._drainForTesting()
    assert.equal(stable('active chip', readChip), '1 shell running')
    clock += 30_000
    assert.equal(stable('chip without a published change', readChip), '1 shell running')
    chips._drainForTesting()
    assert.equal(stable('stale chip after drain', readChip), null)
  } finally { stop(); retireSeatProjections(sessionId) }
}

try {
  process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
  await checkTileReads()
  await checkSessionReads()
  const { createStore } = await import('../../src/state/store.js')
  const { signInLedgerEpoch, subscribeSignInEpoch, noteCredentialChange } = await import('../../src/utils/accounts/signInLedger.js')
  const limits = await import('../../src/services/anthropicLimits.js')
  const state = createStore({ line: { text: 'first' }, count: 0 })
  const select = () => state.getState().line
  const first = stable('screen store: selected line', select)
  state.setState(prev => ({ ...prev, count: prev.count + 1 }))
  assert.equal(stable('screen store: unrelated write', select), first)
  state.setState(prev => ({ ...prev, line: { text: 'next' } }))
  assert.notEqual(stable('screen store: changed line', select), first)

  const before = stable('sign-in ledger epoch', signInLedgerEpoch)
  let atChange: number | undefined
  const stop = subscribeSignInEpoch(() => { atChange = stable('sign-in ledger notification', signInLedgerEpoch) })
  try {
    noteCredentialChange()
    await Promise.resolve()
    assert.notEqual(atChange, before)
    assert.equal(atChange, signInLedgerEpoch())
  } finally {
    stop()
  }
  stable('provider limits', () => limits.currentLimits)
  console.log(`${checked} unchanged pairs have identical snapshots`)
} finally {
  await releaseScratchHome(home)
}

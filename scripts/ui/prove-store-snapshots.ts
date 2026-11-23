#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.js'
import type { EngineConnectorV1 } from '../../src/engine/connector/types.js'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('store-snapshot-proof')
let checked = 0
function stable<T>(name: string, read: () => T): T {
  const first = read()
  assert.ok(Object.is(first, read()), `${name}: two reads without a write must be Object.is equal; cache the selected value at its store`)
  checked++
  return first
}

async function checkClockAndScroll(): Promise<void> {
  const { lastClockTick, subscribeUiClock } = await import('../../src/screen/cockpit/uiClock.js')
  const stopClock = subscribeUiClock(1000, () => {})
  try { stable('active UI cadence', () => lastClockTick(1000)) } finally { stopClock() }
  const { createElement, createRef } = await import('react')
  const { default: ScrollBox } = await import('../../src/screen/renderer/elements/ScrollBox.js')
  const { default: Text } = await import('../../src/screen/renderer/elements/Text.js')
  const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const ref = createRef<import('../../src/screen/renderer/elements/ScrollBox.js').ScrollBoxHandle>()
  const stage = await mountOffscreen(createElement(ScrollBox, { ref, height: 3, flexDirection: 'column' }, ...Array.from({ length: 12 }, (_, i) => createElement(Text, { key: i }, String(i)))), 60, 12)
  try {
    assert.ok(await waitFor(() => ref.current !== null, 1000), 'the recorded pane must mount its scroll handle')
    const pane = ref.current!
    const read = () => `${pane.getScrollTop()}:${pane.getPendingDelta()}`
    const before = stable('mounted pane', read)
    pane.scrollBy(2)
    assert.notEqual(stable('pane with pending scroll', read), before, 'scrollBy(2) must change the pane snapshot (scrollTop:pendingDelta); check getScrollTop and getPendingDelta in the ScrollBox handle, src/screen/renderer/elements/ScrollBox.tsx')
  } finally { stage.unmount() }
}

async function checkRunReads(): Promise<void> {
  const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.js')
  const { disposeOwner } = await import('../../src/engine/run-owner/ownerLifecycle.js')
  const { acceptUserRequest, getRunSnapshot, subscribeRuns } = await import('../../src/engine/run/runCoordinator.js')
  const owner = makeOwnerKey({ workspace: home, sessionId: 'snapshot', lane: 'main' })
  const read = () => getRunSnapshot(owner)
  assert.equal(stable('run before request', read), null, 'getRunSnapshot must return null for an owner with no accepted request; see getRunSnapshot in src/engine/run/runCoordinator.ts')
  let updates = 0
  const stop = subscribeRuns(changed => { if (changed === owner) updates++ })
  try {
    const snapshot = acceptUserRequest(owner, { objective: 'test', rootMessageId: null })
    assert.equal(updates, 1, 'acceptUserRequest must notify subscribeRuns listeners exactly once; see src/engine/run/runCoordinator.ts')
    assert.equal(stable('run after request', read), snapshot, 'getRunSnapshot must return the snapshot acceptUserRequest returned; see src/engine/run/runCoordinator.ts')
  } finally { stop(); await disposeOwner(owner) }
}

async function checkTileReads(): Promise<void> {
  const { LiveTileStore, TILE_BUDGET_MS_PER_S } = await import('../../src/screen/concourse/liveTiles.js')
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
    assert.equal(stable('registered tile', read), still, 'readTile of a registered tile with no tail must return the same still object as before registering; see LiveTileStore.readTile in src/screen/concourse/liveTiles.ts')
    tail = { atMs: clock, text: 'working' }
    store._drainForTesting()
    const working = stable('active tile', read)
    assert.deepEqual(working, { kind: 'streaming', line: 'working' }, 'after a tail is read and the store drains, readTile must return a streaming tile with the tail text; see LiveTileStore in src/screen/concourse/liveTiles.ts')
    store._drainForTesting()
    assert.equal(stable('unchanged tile after drain', read), working, 'a drain that reads an unchanged tail must keep the same tile object; see LiveTileStore._drainForTesting and its drain in src/screen/concourse/liveTiles.ts')
    cost = TILE_BUDGET_MS_PER_S + 1
    for (let i = 0; i < 2; i++) { clock += 1000; store._drainForTesting() }
    assert.equal(stable('degraded bit', () => store.isDegraded()), true, 'two drains over TILE_BUDGET_MS_PER_S must set isDegraded(); see the budget logic in src/screen/concourse/liveTiles.ts')
    assert.equal(stable('degraded tile', read), still, 'a degraded store must return the still tile object; see LiveTileStore.readTile in src/screen/concourse/liveTiles.ts')
    cost = 0
    for (let i = 0; i < 2; i++) { clock += 5000; tail = { atMs: clock, text: 'working' }; store._drainForTesting() }
    assert.equal(stable('recovered bit', () => store.isDegraded()), false, 'cheap drains after the budget breach must clear isDegraded(); see the recovery logic in src/screen/concourse/liveTiles.ts')
    assert.deepEqual(stable('recovered tile', read), working, 'a recovered store must return the streaming tile again; see LiveTileStore.readTile in src/screen/concourse/liveTiles.ts')
  } finally { stop() }
}

async function checkSessionReads(): Promise<void> {
  const { LiveTileStore, workChipStoreDeps } = await import('../../src/screen/concourse/liveTiles.js')
  const { FactsPart } = await import('../../src/engine/connector/daemon/facts.js')
  const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
  const { publishSessionFacts, retireSeatProjections } = await import('../../src/engine/connector/seatProjections.js')
  const empty: EngineConnectorV1 = noSessionConnector()
  const sessionId = '00000000-0000-4000-8000-0000000000c9'
  const workspace = { cwd: home, originalCwd: home, projectRoot: home }
  const part = new FactsPart({ sessionId: () => sessionId, recordWorkspace: () => workspace, recordEffort: () => undefined, recordModel: () => undefined, awaitingRunner: () => false, adoptUsage: () => {}, adoptOpenaiCatalogue: () => {} })
  const readBoard = () => part.swarmBoard()
  assert.equal(stable('no-session board', () => empty.swarmBoard?.() ?? null), null, 'the no-session connector must have no swarm board; see src/engine/connector/noSessionConnector.ts')
  assert.equal(stable('empty board', readBoard), null, 'FactsPart.swarmBoard must return null before any facts carry a swarm; see src/engine/connector/daemon/facts.ts')
  let clock = 1_000_000
  const facts: SessionFactsV1 = { schema: 1, atMs: clock, sessionId, busy: false, pendingModel: null, model: { effective: 'test', setting: null }, workspace, usage: empty.usage(), identity: empty.identity(), skills: [], mcp: [], queue: [], work: [{ id: 'one', kind: 'shell', name: 'one', status: 'running', startTime: clock }] }
  for (const snapshot of [1, 2]) {
    const next = { ...facts, swarm: { on: true, snapshot, peerTurns: 0, omitted: 0, events: [] } }
    part.take(next, next)
    assert.equal(stable(`board revision ${snapshot}`, readBoard), next.swarm, 'FactsPart.swarmBoard must return the swarm object taken in, not a copy; see take and swarmBoard in src/engine/connector/daemon/facts.ts')
  }
  const chips = new LiveTileStore({ ...workChipStoreDeps(() => clock), armMachinery: false, forceDegrade: false })
  const readChip = () => { const now = chips.readTile(sessionId); return now.kind === 'still' ? null : now.line }
  const stop = chips.register(sessionId, '', () => {})
  try {
    assert.equal(stable('empty chip', readChip), null, 'a work chip with no published facts must read as still; see workChipStoreDeps in src/screen/concourse/liveTiles.ts')
    publishSessionFacts(facts)
    chips._drainForTesting()
    assert.equal(stable('active chip', readChip), '1 shell running', 'after publishSessionFacts and a drain the chip must read 1 shell running; see workChipStoreDeps in src/screen/concourse/liveTiles.ts and publishSessionFacts in src/engine/connector/seatProjections.ts')
    clock += 30_000
    assert.equal(stable('chip without a published change', readChip), '1 shell running', 'a chip read must not change before the next drain even when the clock moves; see workChipStoreDeps in src/screen/concourse/liveTiles.ts')
    chips._drainForTesting()
    assert.equal(stable('stale chip after drain', readChip), null, 'a drain 30 seconds after the facts must expire the chip to still; see workChipStoreDeps in src/screen/concourse/liveTiles.ts')
  } finally { stop(); retireSeatProjections(sessionId) }
}

try {
  process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
  await checkTileReads()
  await checkSessionReads()
  await checkRunReads()
  await checkClockAndScroll()
  const { createMcpRosterStore } = await import('../../src/commands/mcp/route.js')
  let names: string[] = []
  let changed = () => {}
  const roster = createMcpRosterStore({
    mcpRoster: () => ({ clients: names.map(name => ({ name, type: 'connected' as const })) }),
    subscribeModel: listener => { changed = listener; return () => { changed = () => {} } },
  })
  assert.deepEqual(stable('empty MCP roster', roster.getSnapshot), [], 'an empty mcpRoster must give an empty snapshot array; see createMcpRosterStore in src/commands/mcp/route.ts')
  names = ['first']
  const stopRoster = roster.subscribe(() => {})
  try {
    const firstRoster = stable('MCP roster changed before attach', roster.getSnapshot)
    assert.equal(firstRoster[0]?.name, 'first', 'a roster read after subscribe must show the current mcpRoster names; see createMcpRosterStore in src/commands/mcp/route.ts')
    names = ['second']
    changed()
    const nextRoster = stable('MCP roster after notification', roster.getSnapshot)
    assert.notEqual(nextRoster, firstRoster, 'a subscribeModel notification must produce a new roster snapshot; see createMcpRosterStore in src/commands/mcp/route.ts')
    assert.equal(nextRoster[0]?.name, 'second', 'the new roster snapshot must carry the changed names; see createMcpRosterStore in src/commands/mcp/route.ts')
  } finally { stopRoster() }

  const { latestWarningSnapshot, mintImmediateReceipt, subscribeWarningReceipts } = await import('../../src/models/facts/seatReceipts.js')
  const initialWarning = stable('boot warning before receipt', latestWarningSnapshot)
  mintImmediateReceipt('test warning', 'warning')
  const warning = stable('queued boot warning', latestWarningSnapshot)
  assert.notEqual(warning, initialWarning, 'mintImmediateReceipt with level warning must change latestWarningSnapshot; see src/models/facts/seatReceipts.ts')
  assert.equal(warning?.receipt.text, 'test warning', 'latestWarningSnapshot must carry the minted receipt text; see src/models/facts/seatReceipts.ts')
  let warnings = 0
  const stopWarnings = subscribeWarningReceipts(() => { warnings++ })
  try {
    assert.equal(warnings, 1, 'subscribeWarningReceipts must call the listener once on subscribe when a warning is queued; see src/models/facts/seatReceipts.ts')
    mintImmediateReceipt('test information')
    assert.equal(stable('warning after information', latestWarningSnapshot), warning, 'an info-level receipt must not replace the latest warning snapshot; see mintImmediateReceipt in src/models/facts/seatReceipts.ts')
    mintImmediateReceipt('another test warning', 'warning')
    assert.equal(warnings, 2, 'a second warning receipt must notify the subscriber once more, and an info receipt must not; see src/models/facts/seatReceipts.ts')
    assert.notEqual(stable('next boot warning', latestWarningSnapshot), warning, 'a second warning receipt must replace the latest warning snapshot; see src/models/facts/seatReceipts.ts')
  } finally { stopWarnings() }

  const { createChatScreenStore, recordChatConsentResolved, selectResolvedConsentCount } = await import('../../src/screen/chat/chatStore.js')
  const chat = createChatScreenStore()
  const otherChat = createChatScreenStore()
  const count = (store = chat, ids = ['second']) => selectResolvedConsentCount(store.getState(), ids)
  assert.equal(stable('new chat consent count', () => count()), 0, 'a new chat store must count 0 resolved consents; see selectResolvedConsentCount in src/screen/chat/chatStore.ts')
  recordChatConsentResolved(chat, ['first', 'second'])
  assert.equal(stable('chat consent after first response', () => count()), 1, 'recordChatConsentResolved must make selectResolvedConsentCount return 1 for the resolved id; see src/screen/chat/chatStore.ts')
  assert.equal(stable('independently mounted chat', () => count(otherChat)), 0, 'consent resolutions must stay per chat store; see recordChatConsentResolved in src/screen/chat/chatStore.ts')
  assert.equal(stable('unrelated consent batch', () => count(chat, ['different'])), 0, 'selectResolvedConsentCount must count only the ids asked for; see src/screen/chat/chatStore.ts')
  recordChatConsentResolved(chat, ['second'])
  assert.equal(stable('empty consent batch', () => count(chat, [])), 0, 'selectResolvedConsentCount for an empty id list must return 0; see src/screen/chat/chatStore.ts')

  const { createStore } = await import('../../src/platform/primitives/store.js')
  const { signInLedgerEpoch, subscribeSignInEpoch, noteCredentialChange } = await import('../../src/models/sign-in/account-ledger/signInLedger.js')
  const limits = await import('../../src/models/roads/anthropic/anthropicLimits.js')
  const state = createStore({ line: { text: 'first' }, count: 0 })
  const select = () => state.getState().line
  const first = stable('screen store: selected line', select)
  state.setState(prev => ({ ...prev, count: prev.count + 1 }))
  assert.equal(stable('screen store: unrelated write', select), first, 'a setState that leaves a slice unchanged must keep that slice object; see createStore in src/platform/primitives/store.ts')
  state.setState(prev => ({ ...prev, line: { text: 'next' } }))
  assert.notEqual(stable('screen store: changed line', select), first, 'a setState that changes a slice must give a new slice object; see createStore in src/platform/primitives/store.ts')

  const before = stable('sign-in ledger epoch', signInLedgerEpoch)
  let atChange: number | undefined
  const stop = subscribeSignInEpoch(() => { atChange = stable('sign-in ledger notification', signInLedgerEpoch) })
  try {
    noteCredentialChange()
    await Promise.resolve()
    assert.notEqual(atChange, before, 'noteCredentialChange must advance signInLedgerEpoch before the subscribeSignInEpoch listener runs; see src/models/sign-in/account-ledger/signInLedger.ts')
    assert.equal(atChange, signInLedgerEpoch(), 'the epoch read inside the listener must equal the epoch afterwards; see src/models/sign-in/account-ledger/signInLedger.ts')
  } finally {
    stop()
  }
  stable('provider limits', () => limits.currentLimits)
  console.log(`${checked} unchanged pairs have identical snapshots`)
} finally {
  await releaseScratchHome(home)
}

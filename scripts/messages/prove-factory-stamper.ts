import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRowStamper, MESSAGE_STAMPER, heartbeatRow } from '../../src/rows/project.ts'
import * as factories from '../../src/utils/messages/factories.ts'
import * as system from '../../src/utils/messages/systemMessages.ts'
import { createToolUseSummaryMessage } from '../../src/utils/messages/pairing.ts'

let clocks = 0
let ids = 0
const stamper = createRowStamper(() => `clock-${++clocks}`)
stamper.id = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
assert.deepEqual(stamper.mint(), { timestamp: 'clock-1', uuid: '00000000-0000-4000-8000-000000000001' })
assert.deepEqual(stamper.mint({ uuid: 'pinned', timestamp: 'pinned-time' }), { timestamp: 'pinned-time', uuid: 'pinned' })
assert.equal(clocks, 1)
assert.equal(ids, 1)
assert.equal(stamper.mint({ uuid: '', timestamp: '' }).timestamp, '')
assert.equal(clocks, 1)
assert.equal(ids, 2)
assert.equal(stamper.stamp(heartbeatRow({ session_id: 'fixture' })).seq, 1)
assert.equal(stamper.seq, 1)
assert.equal(clocks, 2)
assert.equal(ids, 2)

const savedMint = MESSAGE_STAMPER.mint
const savedId = MESSAGE_STAMPER.id
let mints = 0
MESSAGE_STAMPER.id = stamper.id
MESSAGE_STAMPER.mint = function (overrides) {
  mints++
  return stamper.mint(overrides)
}
try {
  const pinned = factories.createUserMessage({ content: 'user', uuid: 'pinned', timestamp: 'pinned-time' })
  assert.equal(pinned.uuid, 'pinned')
  assert.equal(pinned.timestamp, 'pinned-time')
  assert.equal(clocks, 2)
  assert.equal(ids, 2)
  const assistant = factories.createAssistantMessage({ content: 'assistant' })
  assert.equal(assistant.timestamp, 'clock-3')
  assert.notEqual(assistant.uuid, assistant.message.id)
  assert.equal(ids, 4)
  assert.equal(clocks, 3)
  const cases: Array<() => { uuid: string; timestamp: string }> = [
    () => factories.createAssistantAPIErrorMessage({ content: 'fixture error' }),
    () => factories.createProgressMessage({ toolUseID: 'use', parentToolUseID: 'parent', data: { type: 'bash_progress', output: 'fixture' } as never }),
    () => factories.createUserInterruptionMessage({}),
    () => factories.createSyntheticUserCaveatMessage(),
    () => createToolUseSummaryMessage('fixture summary', ['use']),
    () => system.createSystemMessage('fixture notice', 'info'),
    () => system.createRosterTransitionMessage('subagents', true, 'fixture roster'),
    () => system.createStreamCutMessage({ count: 1, content: 'fixture cut' }),
    () => system.createBusyRecoveryMessage({ provider: 'fixture', retries: 1, elapsedMs: 1, content: 'fixture recovery' }),
    () => system.createThinkingNoteMessage('fixture reasoning receipt'),
    () => system.createThinkingDeadMessage([], 'fixture reasoning retirement'),
    () => system.createSeatReceiptMessage('fixture receipt'),
    () => system.createScheduledTaskFireMessage('fixture task'),
    () => system.createStopHookSummaryMessage(0, [], [], false, undefined, false, 'info'),
    () => system.createTurnDurationMessage(1),
    () => system.createModelTransitionMessage({ previous: 'fixture-a', requested: 'fixture-b', applied: 'fixture-b', resolution: 'applied', boundary: 'idle', crossProvider: false, cacheDisposition: 'keyed-sections-recompute-once' } as never),
    () => system.createAwaySummaryMessage('fixture recap'),
    () => system.createMemorySavedMessage(['fixture-path']),
    () => system.createAgentsKilledMessage(),
    () => system.createApiMetricsMessage({ ttftMs: 1, otps: 1 }),
    () => system.createCommandInputMessage('fixture command'),
    () => system.createCompactBoundaryMessage('manual', 1),
    () => system.createMicrocompactBoundaryMessage('auto', 1, 1, [], []),
    () => system.createSystemAPIErrorMessage(new Error('fixture error'), 0, 1, 1),
  ]
  const seen = new Set([assistant.uuid, assistant.message.id])
  for (const build of cases) {
    const before = mints
    const row = build()
    assert.equal(mints, before + 1)
    assert.match(row.timestamp, /^clock-\d+$/)
    assert.equal(seen.has(row.uuid), false)
    seen.add(row.uuid)
  }
  for (const path of ['factories.ts', 'systemMessages.ts', 'pairing.ts']) {
    const source = readFileSync(new URL(`../../src/utils/messages/${path}`, import.meta.url), 'utf8')
    assert.equal(/randomUUID\(|new Date\(/.test(source), false, path)
  }
} finally {
  MESSAGE_STAMPER.mint = savedMint
  MESSAGE_STAMPER.id = savedId
}
console.log('PASS: the factories share the row stamper, retain pinned identities, and mint one timestamp per message')

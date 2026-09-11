#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-cockpit-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_SAMPLES

const REPO = join(import.meta.dir, '..', '..')
const store = await import('../../src/services/samples/store.ts')
const { sampleRowsOf } = await import('../../src/services/samples/facts.ts')
const listener = await import('../../src/services/samples/listener.ts')
const { sessionFactsToWire, sessionFactsFromWire } = await import('../../src/services/engine-connector/seatWire.ts')
const { compactWorkCounts, compactWorkSummaryText } = await import('../../src/components/tasks/useFocusedWork.ts')
const text = await import('../../src/components/samples/samplesListText.ts')
const frames = await import('../../src/daemon/runnerFrames.ts')
const { SDKSamplesUpdatedMessageSchema } = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — samples cockpit facts proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const sessionId = 'session-cockpit-proof'

section('F1 the store speaks when a sample changes')
let notices = 0
const unsubscribe = store.subscribeSampleChanges(() => {
  notices += 1
})
const before = store.sampleChangeRevision()
const first = store.createOrAppendSample({ sessionId, name: 'pricing table', html: '<h1>Pricing</h1>' })
check('F1a a new sample moves the revision and calls the listener', store.sampleChangeRevision() > before && notices === 1, String(notices))
const second = store.createOrAppendSample({ sessionId, name: 'pricing table', html: '<h1>Pricing v2</h1>' })
check('F1b a new version speaks again, on the same sample', notices === 2 && second.record.id === first.record.id && second.version === 2)
store.appendMarks(sessionId, first.record.id, { version: 2, pins: [], note: 'looks right', verdict: 'approve' })
check('F1c marks speak, and the state moved', notices === 3 && store.getSample(sessionId, first.record.id)?.state === 'approved')
unsubscribe()
store.createOrAppendSample({ sessionId, name: 'onboarding flow', html: '<h1>Onboarding</h1>' })
check('F1d an unsubscribed listener hears nothing more', notices === 3)

section('F2 the runner projects its samples, each with an address')
const rows = await sampleRowsOf(sessionId)
check('F2a the listener started on demand for a session that has samples', listener.sampleListenerAddress() !== null)
check('F2b two rows, newest first', rows.length === 2 && rows[0]?.title === 'onboarding flow' && rows[1]?.title === 'pricing table', JSON.stringify(rows.map(r => r.title)))
const pricing = rows.find(r => r.title === 'pricing table')
check('F2c the row carries version, state, stamp and glyph', pricing !== undefined && pricing.version === 2 && pricing.state === 'approved' && pricing.glyph === '⧉' && typeof pricing.updatedAt === 'string')
const ADDRESS = /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-z0-9]{6,32}\?t=[0-9a-f]{32}$/
check('F2d every row opens on loopback and carries the token', rows.every(r => r.url !== undefined && ADDRESS.test(r.url)), JSON.stringify(rows.map(r => r.url)))
const again = await sampleRowsOf(sessionId)
check('F2e nothing changed: the same rows come back (no second disk read)', again === rows)
store.createOrAppendSample({ sessionId, name: 'latency report', html: '<h1>Latency</h1>' })
const after = await sampleRowsOf(sessionId)
check('F2f a write refreshes the projection', after !== rows && after.length === 3 && after[0]?.title === 'latency report', JSON.stringify(after.map(r => r.title)))
check('F2g another session projects its own rows (none)', (await sampleRowsOf('another-session')).length === 0)
process.env.MERCURY_SAMPLES = '0'
check('F2h MERCURY_SAMPLES=0 projects nothing', (await sampleRowsOf(sessionId)).length === 0)
delete process.env.MERCURY_SAMPLES

section('F3 the wire spells the rows snake_case and the seat reads them back')
const answer = {
  model: { effective: 'm', setting: null },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [],
  mcp: [],
  permissionMode: 'default',
  workspace: { cwd: '/w', originalCwd: '/w', projectRoot: '/w', instructionRoots: [] },
  queue: [],
  samples: after,
}
const wire = sessionFactsToWire(answer as never) as { samples?: Array<Record<string, unknown>> }
check('F3a updated_at on the wire, never updatedAt', wire.samples !== undefined && wire.samples.length === 3 && wire.samples.every(r => 'updated_at' in r && !('updatedAt' in r)), JSON.stringify(wire.samples?.[0]))
const back = sessionFactsFromWire(wire)
check('F3b the seat reads the rows back whole', back !== null && JSON.stringify(back.samples) === JSON.stringify(after))
const bare = sessionFactsFromWire(sessionFactsToWire({ ...answer, samples: undefined } as never))
check('F3c an answer without samples stays without them (an older runner)', bare !== null && bare.samples === undefined)

section('F4 the compact line counts samples the way it counts the rest')
const active = { sessionId: 'focused', live: true, paused: false, parked: false, stopped: false }
const base = { sessions: { state: 'known' as const, rows: [active] }, focusedSessionId: 'focused', carrier: 'daemon' as const, roster: { rows: [], mission: [], reported: true } }
const none = compactWorkCounts(base as never)
check('F4a no samples: the line is the line of today', compactWorkSummaryText(none, 120) === '1 session on · 0 monitors here · 0 agents here' && none.samples === 0, compactWorkSummaryText(none, 120))
const one = compactWorkCounts({ ...base, roster: { ...base.roster, samples: after.slice(0, 1) } } as never)
check('F4b one sample appends · 1 sample', compactWorkSummaryText(one, 120) === '1 session on · 0 monitors here · 0 agents here · 1 sample', compactWorkSummaryText(one, 120))
const three = compactWorkCounts({ ...base, roster: { ...base.roster, samples: after } } as never)
check('F4c three samples pluralise', compactWorkSummaryText(three, 120) === '1 session on · 0 monitors here · 0 agents here · 3 samples', compactWorkSummaryText(three, 120))
check('F4d the short ladder is unchanged by samples', compactWorkSummaryText(three, 20) === compactWorkSummaryText(none, 20) && !compactWorkSummaryText(three, 20).includes('sample'), compactWorkSummaryText(three, 20))
check('F4e the blank chat counts none', compactWorkCounts({ ...base, focusedSessionId: null } as never).samples === 0)

section('F5 the list spells its rows as approved')
const now = Date.parse(pricing?.updatedAt ?? '') + 2 * 60_000
const changed = { ...(pricing as NonNullable<typeof pricing>), state: 'changes-needed' as const }
check('F5a the title line', text.samplesListTitle(3) === 'SAMPLES · this session · 3')
check('F5b a row: the name padded to its column, the version, the state, the age', text.sampleListRow(changed, now) === 'pricing table          v2 · changes needed · 2m ago', JSON.stringify(text.sampleListRow(changed, now)))
const long = text.sampleListRow({ ...changed, title: 'a very long sample title that never ends' }, now)
check('F5c a long name is cut to the column', stringWidth(long.slice(0, long.indexOf(' v2'))) === text.SAMPLES_TITLE_WIDTH, JSON.stringify(long))
check('F5e a clock behind the row (a stale tick) reads 0s ago, never a future word', text.sampleListRow(changed, now - 10 * 60_000).endsWith('· 0s ago') && !text.sampleListRow(changed, now - 10 * 60_000).includes(' in '), JSON.stringify(text.sampleListRow(changed, now - 10 * 60_000)))
check('F5d the empty line and the hint are the approved words', text.SAMPLES_EMPTY_LINE === 'no samples in this session — ask the model to show you something' && text.SAMPLES_LIST_HINT === '↵ open · esc back')

section("F6 the runner's frame and the roads that read it")
const frame = frames.samplesUpdatedFrame('sess-1', 'uuid-1')
check('F6a the frame is a system frame with the samples subtype and the session id', frame.type === 'system' && frame.subtype === 'samples_updated' && frame.session_id === 'sess-1' && frame.uuid === 'uuid-1')
check('F6b the SDK schema admits it', SDKSamplesUpdatedMessageSchema().safeParse(frame).success)
check('F6c the predicate reads it and the mission predicate does not', frames.isSamplesUpdatedParsedFrame(frame as never) && !frames.isMissionUpdatedParsedFrame(frame as never))
const print = readFileSync(join(REPO, 'src/cli/print.ts'), 'utf8')
check('F6d the runner relays the rows with its facts and writes the frame on every change (debounced)', print.includes('samples: await sampleRowsOf(getSessionId()),') && print.includes('subscribeSampleChanges(() => {') && print.includes('io.outbound.enqueue(samplesUpdatedFrame(getSessionId(), randomUUID()))') && print.includes('SAMPLES_UPDATED_SUBTYPE,'))
const seat = readFileSync(join(REPO, 'src/daemon/sessionSeat.ts'), 'utf8')
check('F6e the daemon re-asks the facts on the frame', seat.includes(`line.includes('"samples_updated"')`))
const connector = readFileSync(join(REPO, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
check('F6f the connector folds the rows into the work roster it already publishes', connector.includes('const samples = this.facts?.samples ?? []') && connector.includes('this.workSnapshot = reported ? { rows, mission, samples } : { rows, mission, samples, reported: false }'))

section('P the poison — the comparators bite on a spoiled fixture')
const spoiled = after.map(r => ({ ...r, url: r.url?.replace(/t=[0-9a-f]{32}$/, 't=short') }))
check('P1 a row without the whole token fails the address law', !spoiled.every(r => r.url !== undefined && ADDRESS.test(r.url)))
const misspelled = sessionFactsFromWire({ ...wire, samples: [{ id: 'x', title: 't', version: 1, state: 'open', updatedat: 'now', glyph: '⧉' }] }) as { samples?: Array<Record<string, unknown>> } | null
check('P2 a mis-spelled wire key never decodes as updatedAt', misspelled?.samples?.[0]?.updatedAt === undefined)
check('P3 the compact line without samples never says sample', !compactWorkSummaryText(none, 120).includes('sample'))
check('P4 a row with the wrong state fails the spelling law', text.sampleListRow({ ...changed, state: 'open' }, now) !== 'pricing table          v2 · changes needed · 2m ago')
check('P5 a stale projection is told apart from a fresh one', after !== rows)

await listener.closeSampleListener()
clearTimeout(guard)
console.log(failures === 0 ? '\n✅ samples cockpit facts: every law holds' : `\n❌ samples cockpit facts: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

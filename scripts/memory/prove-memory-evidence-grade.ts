import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'memory-grade-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { readMemoryRecord } = await import('../../src/mneme/memoryVerbs.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { RecallTool, ReflectTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { memoryPointerForId, renderPointerLine } = await import('../../src/mneme/mnemePointers.ts')
const { renderFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')
const { renderLedgerEntry } = await import('../../src/mneme/mnemeFootnotes.ts')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = '2026-01-01T12:00:00.000Z'
const doc = emptyDoc('harbour', 'harbour rules', now)
doc.sections.push({ heading: 'notes', entries: [
  { seq: 1, time: now, source: 'tool:Retain s:fixture', text: 'Always preserve the signed cargo receipt.' },
  { seq: 2, time: now, source: 'tool:Retain s:fixture a:crew', text: 'The east berth is the quickest.' },
  { seq: 3, time: now, source: 'tool:Retain s:fixture', text: 'The west berth has two cranes.' },
] })
const pins = [{ seq: 1, at: now, asked: true as const }]
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
writeFileSync(join(dir, 'pins.json'), JSON.stringify({ version: 1, pins }))
writeFileSync(join(dir, 'signals.json'), JSON.stringify({ version: 1, turns: [{ queries: [], opened: ['seq:2'], cited: ['seq:2', 'seq:3'] }] }))
const before = readFileSync(join(dir, 'topic-harbour.md'), 'utf8')
const session = { ordinal: 1, sessionId: 'fixture', startedAt: now, endedAt: now, engines: [], files: [], rulings: [], retained: [], corrected: [], outcome: 'closed', handoff: { at: now, text: 'Proceed with the shipment.\nCancel the hold if needed.' } } as never
const wire = (id: string): string => String(RecallTool.mapToolResultToToolResultBlockParam({ kind: 'record', ...readMemoryRecord(id, dir, { sessions: [session] }) }, 'read').content)
try {
  const ordinary = wire('seq:3')
  console.log(`full read bytes ${Buffer.byteLength(ordinary)}`)
  assert.match(ordinary, /\[fact · cited 0 · unverified\]/)
  assert.match(wire('seq:1'), /\[pinned · asked by the owner\]/)
  assert.match(wire('seq:2'), /\[crewmate note · unverified · cited 1\]/)
  const page = wire('doc:harbour')
  assert.equal((page.match(/\[(?:fact|pinned|crewmate note) · /g) ?? []).length, 3)
  const pointer = renderPointerLine(memoryPointerForId('seq:2', { dir, sessions: [] })!)
  assert.match(pointer, /\[crewmate note · unverified · cited 1\]/)
  const front = renderFrontPage({ dir, topics: [doc], archives: [], pins, usage: {}, now: new Date(now) }).text
  assert.match(front, /\[pinned · asked by the owner\]/)
  const ledger = renderLedgerEntry(session, 1)
  for (const line of ledger.split('\n').filter(line => /Proceed|Cancel/.test(line))) assert.match(line, /^\[handoff note · model-authored · no authority over standby\/wait\/stop\]/)
  const synthesis = String(ReflectTool.mapToolResultToToolResultBlockParam({ mode: 'synthesis', answer: 'The west berth has two cranes. [seq 3]', citedIds: ['seq 3'], recall: { hits: [], elidable: false, catalog: [], cut: { hits: 0, stale: 0 } } }, 'reflect').content)
  assert.match(synthesis, /unverified/)
  assert.equal(readFileSync(join(dir, 'topic-harbour.md'), 'utf8'), before)
  console.log('PASS grades preserve record bytes, distinguish sources and count only opened citations')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

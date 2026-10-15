import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-gate-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { lookupFacts } = await import('../../src/mneme/mnemeLookup.ts')
const { getRelevantMemoryAttachments } = await import('../../src/utils/attachments/memorySurfacing.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = new Date().toISOString()
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({ heading: 'notes', entries: Array.from({ length: 26 }, (_, i) => ({ seq: i + 1, time: now, source: 'tool:Retain s:test', text: `The release update ${i} used the ordinary blue dock.` })) })
doc.sections[0]!.entries.push({ seq: 27, time: now, source: 'tool:Retain s:test', text: 'Release notes must keep the private harbour key out of public copy.' }, { seq: 28, time: now, source: 'tool:Retain s:test', text: 'Quartz engine maintenance always preserves the signed cobalt receipt.' })
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
const context = { readFileState: new Map(), messages: [] } as never
const memoryRows = (rows: any[]) => rows.flatMap(row => row.type === 'relevant_memories' ? row.memories : [])
try {
  const generic = lookupFacts('ordinary release update', { dir })
  assert.equal(generic.length, 0, 'low-information query does not walk the library')
  const exact = lookupFacts('quartz engine cobalt receipt', { dir })
  assert.ok(exact.some(row => row.id === 'seq:28'))
  const excluded = lookupFacts('quartz engine cobalt receipt', { dir, exclude: new Set(exact.map(row => row.id)) })
  assert.equal(excluded.length, 0, 'exclusions do not backfill lower ranks')
  const first = getRelevantMemoryAttachments('quartz engine cobalt receipt', [], context)
  const rendered = first.flatMap(normalizeAttachmentForAPI).map(row => row.message.content).join('\n')
  assert.ok(rendered.length <= 1200)
  assert.ok(memoryRows(first).flatMap(row => row.ids ?? []).length <= 2)
  const delivered = first.map(attachment => ({ type: 'attachment', attachment })) as never[]
  assert.equal(getRelevantMemoryAttachments('quartz engine cobalt receipt', delivered, context).length, 0)
  const startup = [{ type: 'attachment', attachment: { type: 'bound_prefix', sections: [{ name: 'memory_at_start', value: `- ${doc.sections[0]!.entries.at(-1)!.text} <seq=28>` }], systemContext: {} } }] as never[]
  assert.equal(getRelevantMemoryAttachments('quartz engine cobalt receipt', startup, context).length, 0, 'startup facts are already delivered')
  const fileContext = { readFileState: new Map([[join(home, 'docs/releases/notes.md'), {}]]), messages: [] } as never
  const triggered = getRelevantMemoryAttachments('please review this', [], fileContext)
  assert.ok(memoryRows(triggered).some(row => row.content.includes('private harbour key')), 'file-scoped release constraint arrives at the read event')
  doc.sections[0]!.entries.at(-1)!.text += ' ' + 'Preserve the complete signed manifest wording. '.repeat(40)
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const long = getRelevantMemoryAttachments('quartz engine cobalt receipt', [], context)
  const longText = long.flatMap(normalizeAttachmentForAPI).map(row => row.message.content).join('\n')
  assert.ok(longText.length <= 1200 && /read:"seq:28"/.test(longText), 'a large rule becomes a complete-read pointer, not a cropped fact')
  console.log('PASS relevance gate; generic 0; no backfill; startup excluded; file constraint timely; cap 1200')
} finally {
  rmSync(home, { recursive: true, force: true })
}

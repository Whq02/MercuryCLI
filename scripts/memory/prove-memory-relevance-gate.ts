import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-gate-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_EMBED_ENGINE = 'off'
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { lookupFacts, automaticMemoryCandidates } = await import('../../src/mneme/mnemeLookup.ts')
const { getRelevantMemoryAttachments } = await import('../../src/utils/attachments/memorySurfacing.ts')
const { _resetMemorySurfacedForTesting: freshSession } = await import('../../src/utils/attachments/memorySurfaced.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = new Date().toISOString()
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({ heading: 'notes', entries: Array.from({ length: 26 }, (_, i) => ({ seq: i + 1, time: now, source: 'tool:Retain s:test', text: `The release update ${i} used the ordinary blue dock.` })) })
doc.sections[0]!.entries.push(
  { seq: 27, time: now, source: 'tool:Retain s:test', text: 'Release notes must keep the private harbour key out of public copy.' },
  { seq: 28, time: now, source: 'tool:Retain s:test', text: 'Quartz engine maintenance always preserves the signed cobalt receipt.' },
  { seq: 29, time: now, source: 'tool:Retain s:test', text: 'The owner keeps the private harbour key in the cobalt vault beside the signed ledger.' },
  { seq: 30, time: now, source: 'tool:Retain s:test', text: 'Captions and subtitles for the harbour film never use the word utilise; the writing stays plain.' },
  { seq: 31, time: now, source: 'tool:Retain s:test', text: 'After 1.0.0-beta.32 ships: a showcase film about the marble pier, then the owner boosts the post.' },
  { seq: 32, time: now, source: 'tool:Retain s:test', text: 'The 1.0.0-beta.36 marble pier page is published after the tag.' },
)
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
const context = { readFileState: new Map(), messages: [] } as never
const memoryRows = (rows: any[]) => rows.flatMap(row => row.type === 'relevant_memories' ? row.memories : [])
const rendered = (rows: any[]) => rows.flatMap(normalizeAttachmentForAPI).map(row => row.message.content).join('\n')
const turn = (text: string, uuid: string) => ({ type: 'user', uuid, timestamp: now, message: { role: 'user', content: text } }) as never
const toolRound = (command: string, uuid: string) => [
  { type: 'assistant', uuid: `${uuid}-a`, timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', id: `${uuid}-t`, name: 'Bash', input: { command } }] } },
  { type: 'user', uuid: `${uuid}-r`, timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${uuid}-t`, content: 'ok' }] } },
] as never[]
const asMessages = (attachments: any[]) => attachments.map(attachment => ({ type: 'attachment', attachment, uuid: `att-${Math.random()}` })) as never[]
try {
  assert.equal(lookupFacts('ordinary release update', { dir }).length, 0, 'a low-information query does not walk the library')
  const exact = lookupFacts('quartz engine cobalt receipt', { dir })
  assert.ok(exact.some(row => row.id === 'seq:28'))
  assert.equal(lookupFacts('quartz engine cobalt receipt', { dir, exclude: new Set(exact.map(row => row.id)) }).length, 0, 'exclusions do not backfill lower ranks')
  const first = getRelevantMemoryAttachments('quartz engine cobalt receipt', [], context)
  assert.ok(rendered(first).length <= 1200 && memoryRows(first).flatMap(row => row.ids ?? []).length <= 2)
  assert.equal(getRelevantMemoryAttachments('quartz engine cobalt receipt', asMessages(first), context).length, 0, 'a visible fact is not reprinted')
  const startup = [{ type: 'attachment', attachment: { type: 'bound_prefix', sections: [{ name: 'memory_at_start', value: `- ${doc.sections[0]!.entries.find(e => e.seq === 28)!.text} <seq=28>` }], systemContext: {} } }] as never[]
  assert.equal(getRelevantMemoryAttachments('quartz engine cobalt receipt', startup, context).length, 0, 'startup facts are already delivered')
  const prompt = turn('please review the harbour pages and tell me what changed', 'u1')
  const round = [prompt, ...toolRound('cat docs/releases/notes.md | head -40', 'r1')]
  const triggered = getRelevantMemoryAttachments(null, round, context)
  const triggeredRows = memoryRows(triggered)
  assert.ok(triggeredRows.some(row => row.ids?.includes('seq:27') && row.content.includes('private harbour key out of public copy')), 'the release-notes rule arrives at the tool round that reads a release-notes path')
  assert.ok(triggeredRows.some(row => row.ids?.includes('seq:29')), 'the rule brings its rare-stem companion along')
  assert.ok(!triggeredRows.some(row => row.ids?.includes('seq:31')), 'the old-cycle plan is not admitted by a file event')
  const laterRound = getRelevantMemoryAttachments(null, [...round, ...asMessages(triggered), ...toolRound('cat docs/releases/notes.md | tail -40', 'r1b')], context)
  assert.ok(!memoryRows(laterRound).some(row => row.ids?.includes('seq:27') || row.ids?.includes('seq:29')), 'the rule and its companion rode once this session; a later round reading the same path does not carry them again')
  assert.equal(getRelevantMemoryAttachments(null, [turn('tidy the notes', 'u1b'), ...toolRound('cat docs/releases/notes.md', 'r1c')], context).length, 0, 'nor does a later turn whose window no longer shows them: the record is a Recall away')
  freshSession()
  const named = getRelevantMemoryAttachments('tighten the wording in docs/releases/notes.md', [], context)
  assert.ok(memoryRows(named).some(row => row.ids?.includes('seq:27')), 'in a new session, a prompt naming a release-notes path admits the rule too')
  freshSession()
  const spent = getRelevantMemoryAttachments('quartz engine cobalt receipt', [], context)
  const afterSpent = getRelevantMemoryAttachments(null, [turn('quartz engine cobalt receipt', 'u2'), ...asMessages(spent), ...toolRound('cat docs/releases/notes.md', 'r2')], context)
  assert.ok(memoryRows(afterSpent).some(row => row.ids?.includes('seq:27')), 'an exact-trigger constraint keeps a reserved pointer after the turn allowance is spent')
  assert.ok(memoryRows(afterSpent).some(row => row.ids?.includes('seq:29') && row.content.includes('on the same subject as the rule above')), 'its companion rides the reserve in the compact form')
  const again = getRelevantMemoryAttachments(null, [turn('quartz engine cobalt receipt', 'u3'), ...asMessages(spent), ...asMessages(afterSpent), ...toolRound('cat docs/releases/notes.md', 'r3')], context)
  assert.equal(again.length, 0, 'a visible constraint is never reprinted on a later round')
  doc.sections[0]!.entries.push(
    { seq: 33, time: now, source: 'tool:Retain s:test', text: 'Release notes list Added, Changed and Fixed; never a Removed section.' },
    { seq: 34, time: now, source: 'tool:Retain s:test', text: 'Release notes list the user-facing facts. Never name the inherited estate.' },
    { seq: 35, time: now, source: 'tool:Retain s:test', text: 'Never edit packages/core/schema.sql without a migration file beside it.' },
    { seq: 36, time: now, source: 'tool:Retain s:test', text: 'The ceilings in config/limits.yaml are the owner\'s; never change them without his word.' },
  )
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const drafting = memoryRows(getRelevantMemoryAttachments('draft the release notes for the harbour release', [], context)).flatMap(row => row.ids ?? [])
  assert.ok(drafting.includes('seq:33'), 'a rule whose trigger term and rule word sit either side of a semicolon is still one sentence to the trigger')
  const drafting2 = getRelevantMemoryAttachments('write the changelog for the harbour release', [], context)
  assert.notEqual(automaticMemoryCandidates('write the changelog for the harbour release', { dir, limit: Infinity }).find(row => row.id === 'seq:34')?.admission, 'constraint', 'a rule word only in the sentence after the trigger term is not an exact trigger (sentences are whole, not merged)')
  doc.sections[0]!.entries.push({ seq: 37, time: now, source: 'operator', text: 'retired: operator marked no longer current (was: Release notes must keep the private harbour key out of public copy.)', supersedes: '27' } as never)
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  assert.ok(!automaticMemoryCandidates('draft the release notes for the harbour release', { dir, limit: Infinity }).some(row => row.id === 'seq:37'), 'a retirement record (a tombstone) is never surfaced automatically')
  const schema = getRelevantMemoryAttachments(null, [turn('tidy the schema', 'u4'), { type: 'assistant', uuid: 'a4', timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: join(home, 'repo/packages/core/schema.sql'), old_string: 'a', new_string: 'b' } }] } } as never, { type: 'user', uuid: 'r4', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }] } } as never], context)
  assert.ok(memoryRows(schema).flatMap(row => row.ids ?? []).includes('seq:35'), 'a rule citing a path under a root outside the seven named ones triggers when that file is edited')
  doc.sections[0]!.entries.push(
    { seq: 38, time: now, source: 'tool:Retain s:test', text: 'beta.32 website state at 2026-10-12 00:4x: main at 6bf18b0, pushed, NOT deployed; only src/panels/Licence.tsx and src/data/install.ts changed, never the queue page.' },
    { seq: 39, time: now, source: 'tool:Retain s:test', text: 'Session note (licence lane, 2026-10-12): src/panels/Licence.tsx must keep the signed badge; the lane landed on main.' },
    { seq: 40, time: now, source: 'tool:Retain s:test', text: 'Never edit src/panels/Licence.tsx without re-running the licence census.' },
    { seq: 41, time: now, source: 'tool:Retain s:test', text: 'Licence lane (1.0.0-beta.35), 2026-10-14 09:1x: the owner flipped the review seat into the fix seat; src/panels/Licence.tsx must keep the signed badge; DONE at dc5853f07f.' },
  )
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const licence = getRelevantMemoryAttachments(null, [turn('tidy the licence panel', 'u6'), { type: 'assistant', uuid: 'a6', timestamp: now, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't6', name: 'Edit', input: { file_path: join(home, 'repo/src/panels/Licence.tsx'), old_string: 'a', new_string: 'b' } }] } } as never, { type: 'user', uuid: 'r6', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't6', content: 'ok' }] } } as never], context)
  const licenceIds = memoryRows(licence).flatMap(row => row.ids ?? [])
  assert.ok(licenceIds.includes('seq:40'), 'the rule about the edited file triggers')
  assert.ok(!licenceIds.includes('seq:38') && !licenceIds.includes('seq:39') && !licenceIds.includes('seq:41'), 'a dated state note, a session note or a lane note ("<name> lane (<version>), <date>:") naming the file is never bound as a constraint or carried as a companion')
  const verdicts = automaticMemoryCandidates('tidy the licence panel', { dir, files: [join(home, 'repo/src/panels/Licence.tsx')], limit: Infinity })
  assert.ok(!verdicts.some(row => (row.id === 'seq:38' || row.id === 'seq:39' || row.id === 'seq:41') && (row.admission === 'constraint' || row.admission === 'companion')), 'the verdicts agree: no constraint or companion admission for the three notes')
  assert.ok(verdicts.find(row => row.id === 'seq:38')?.historical?.names === 32 || !verdicts.some(row => row.id === 'seq:38'), 'a state note naming an older cycle is marked historical when it rides at all')
  const limits = getRelevantMemoryAttachments(null, [turn('raise the limits', 'u5'), ...toolRound('sed -n 1,20p config/limits.yaml', 'r5')], context)
  assert.ok(memoryRows(limits).flatMap(row => row.ids ?? []).includes('seq:36'), 'a rule citing config/… triggers when a command names that file')
  const caption = getRelevantMemoryAttachments('give the subtitles to a new seat with the plain writing rules', [], context)
  assert.ok(memoryRows(caption).some(row => row.ids?.includes('seq:30')), 'a captions task admits the writing constraint')
  assert.ok(!memoryRows(getRelevantMemoryAttachments('fix the caption wording on the harbour film', [], context)).some(row => row.ids?.includes('seq:30')), 'the constraint rode once this session; the paraphrase does not carry it a second time')
  freshSession()
  const paraphrase = getRelevantMemoryAttachments('fix the caption wording on the harbour film', [], context)
  assert.ok(memoryRows(paraphrase).some(row => row.ids?.includes('seq:30')), 'in a new session, a paraphrase of the captions task still admits it')
  assert.equal(getRelevantMemoryAttachments('run the dock census and tell me the count', [], context).length, 0, 'a distractor with no task word and no two rare stems admits nothing')
  const stale = automaticMemoryCandidates('the marble pier showcase film', { dir, limit: Infinity })
  const plan = stale.find(row => row.id === 'seq:31')
  assert.ok(plan?.historical?.names === 32 && plan.historical.latest === 36, 'a prior-cycle plan is marked historical against the library\'s latest cycle')
  assert.ok(stale.findIndex(row => row.id === 'seq:31') > stale.findIndex(row => row.id === 'seq:32'), 'the historical plan ranks after the current fact')
  const staleText = rendered(getRelevantMemoryAttachments('the marble pier showcase film', [], context))
  assert.match(staleText, /\[historical — names beta\.32; the library's latest cycle is beta\.36; not a current obligation\]/)
  doc.sections[0]!.entries.find(e => e.seq === 28)!.text += ' ' + 'Preserve the complete signed manifest wording. '.repeat(40)
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  freshSession()
  const long = getRelevantMemoryAttachments('quartz engine cobalt receipt', [], context)
  const longText = rendered(long)
  assert.ok(longText.length <= 1200 && /\(cropped: read the whole record with Recall read:"seq:28"/.test(longText), 'a large rule becomes a marked preview pointer, not a cropped fact presented as complete')
  console.log('PASS relevance gate; generic 0; no backfill; startup excluded; file constraint timely at the tool round with its companion and a reserved pointer, once a session; captions constraint on the task and, in a new session, its paraphrase; historical plan marked and last; cap 1200')
} finally {
  rmSync(home, { recursive: true, force: true })
}

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DESKTOP_DRIVER = 'none'
const home = mkdtempSync(join(tmpdir(), 'memory-once-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_PROJECT_INTEL
process.env.MERCURY_EMBED_ENGINE = 'off'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { emptyDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { MEMORY_EVIDENCE_CONTRACT } = await import('../../src/mneme/memoryEvidence.ts')
const { getRelevantMemoryAttachments } = await import('../../src/utils/attachments/memorySurfacing.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { materializeFixture } = await import('../project-intel/fixtures/materialize.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
const producer = await import('../../src/utils/attachments/contextCapsule.ts')
const surfacedModule = await import('../../src/utils/attachments/memorySurfaced.ts').catch(() => null)
const resetSession = (): void => {
  surfacedModule?._resetMemorySurfacedForTesting()
  producer._resetContextCapsuleForTesting()
}

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const now = '2026-10-18T20:00:00.000Z'
const doc = emptyDoc('harbour', 'harbour', now)
doc.sections.push({ heading: 'notes', entries: Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, time: now, source: 'tool:Retain s:proof', text: `The release update ${i + 1} used the ordinary blue tender.` })) })
doc.sections[0]!.entries.push(
  { seq: 61, time: now, source: 'tool:Retain s:proof', text: 'The harbour pricing rounds half up before the quayside invoice is printed.' },
  { seq: 62, time: now, source: 'tool:Retain s:proof', text: 'The lantern catalogue lists every mooring fee in cobalt ink.' },
)
writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
const FACT = 'seq:61'
const REF = 'mneme:61'

const workspace = materializeFixture('ts')
bootstrap.setOriginalCwd(workspace)
const context = () => ({ readFileState: new Map(), options: {}, getAppState: () => ({}) }) as never
const PROMPT = 'Fix the harbour pricing rounding of the quayside invoice in src/core/pricing.ts'
const turn = (text: string, uuid: string) => ({ type: 'user', uuid, timestamp: now, message: { role: 'user', content: text } }) as never
const reply = (uuid: string) => ({ type: 'assistant', uuid, timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) as never
const asMessages = (attachments: readonly unknown[]) => attachments.map((attachment, index) => ({ type: 'attachment', attachment, uuid: `att-${index}-${Math.random()}`, timestamp: now })) as never[]
const boundary = (uuid: string) => ({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: now, content: 'folded', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 90000 } }) as never
const summary = (uuid: string) => ({ type: 'user', uuid, timestamp: now, isCompactSummary: true, message: { role: 'user', content: 'Summary: the pricing work continues.' } }) as never
const ids = (attachments: readonly unknown[]): string[] => (attachments as Array<{ type: string; memories?: Array<{ ids?: string[] }> }>).flatMap(row => row.type === 'relevant_memories' ? (row.memories ?? []).flatMap(memory => memory.ids ?? []) : [])
const wire = (attachments: readonly unknown[]): string => (attachments as never[]).flatMap(row => normalizeAttachmentForAPI(row)).map(row => JSON.stringify(row.message.content)).join('\n')
type Capsule = { markdown: string; memoryIds?: string[]; memoryEmitted?: boolean }
const capsule = async (input: string | null, messages: never[], ctx = context()): Promise<Capsule | undefined> => (await producer.getContextCapsuleAttachment(input, messages, ctx))[0] as Capsule | undefined

try {
  section('§1 the per-turn surface: a fact rides once, then it is a Recall away')
  resetSession()
  const first = getRelevantMemoryAttachments(PROMPT, [], context())
  check('turn 1: the matching fact rides', ids(first).includes(FACT), JSON.stringify(first))
  check('the lantern fact, which the prompt does not match, does not ride', !ids(first).includes('seq:62'))
  const header = (first[0] as { memories?: Array<{ header?: string }> } | undefined)?.memories?.[0]?.header ?? ''
  check('the per-turn header is plain: no "read pointers before relying" clause', header === 'Memory (task-matched):' && !wire(first).includes('read pointers before relying'), header)
  check('that clause stands once, on the session-start memory page', MEMORY_EVIDENCE_CONTRACT.includes('read fact pointers before relying'))
  const window1 = [turn(PROMPT, 'u1'), ...asMessages(first), reply('a1'), turn(PROMPT, 'u2')]
  check('turn 2, the block in view: nothing rides again', getRelevantMemoryAttachments(PROMPT, window1, context()).length === 0)
  const folded = [boundary('fold-1'), summary('s1'), turn(PROMPT, 'u3')]
  const afterFold1 = getRelevantMemoryAttachments(PROMPT, folded, context())
  check('turn 3, after a compaction took the block out of the window: nothing rides again', afterFold1.length === 0, JSON.stringify(ids(afterFold1)))
  check('a continuation round with the block scrolled away: nothing rides again', getRelevantMemoryAttachments(null, [turn(PROMPT, 'u4')], context()).length === 0)
  doc.sections[0]!.entries.push({ seq: 63, time: now, source: 'tool:Retain s:proof', text: 'The quayside invoice names the harbour band beside each mooring.' })
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const later = getRelevantMemoryAttachments(PROMPT, folded, context())
  check('a record that matches for the first time still rides, once, without the old one beside it', ids(later).includes('seq:63') && !ids(later).includes(FACT), JSON.stringify(ids(later)))
  check('and not a second time', getRelevantMemoryAttachments(PROMPT, [...folded, ...asMessages(later), turn(PROMPT, 'u5')], context()).length === 0 && getRelevantMemoryAttachments(PROMPT, [turn(PROMPT, 'u6')], context()).length === 0)
  resetSession()
  check('a resumed session starts a fresh count: the fact rides once more', ids(getRelevantMemoryAttachments(PROMPT, [turn(PROMPT, 'u7')], context())).includes(FACT))
  resetSession()
  check('a resumed session whose window still shows the block does not repeat it', !ids(getRelevantMemoryAttachments(PROMPT, window1, context())).includes(FACT))

  section('§2 the working-set capsule: the same record rides on one surface only, once')
  resetSession()
  const onCapsule = await capsule(PROMPT, [])
  check('a fresh session: the capsule lists the matching record', onCapsule !== undefined && onCapsule.markdown.includes(REF) && onCapsule.markdown.includes('Memory (task-scoped refs'), onCapsule?.markdown)
  check('the capsule records which memory it surfaced', onCapsule?.memoryIds?.includes(FACT) === true && onCapsule?.memoryEmitted === true, JSON.stringify(onCapsule?.memoryIds))
  check('the per-turn surface then holds its peace on that record', !ids(getRelevantMemoryAttachments(PROMPT, [turn(PROMPT, 'c1'), ...asMessages([onCapsule])], context())).includes(FACT))
  const afterFold = await capsule(null, [boundary('fold-2'), summary('s2'), turn(PROMPT, 'c2')])
  check('after a compaction the capsule re-attaches its working set without the record', afterFold !== undefined && !afterFold.markdown.includes(REF) && !afterFold.markdown.includes('Memory (') && !afterFold.memoryIds?.length, afterFold?.markdown)
  check('the capsule never says a previous selection is no longer current', !(afterFold?.markdown ?? '').includes('no task-scoped refs remain'))
  const scrolled = await capsule(null, [turn(PROMPT, 'c3')])
  check('with the earlier capsule scrolled out of the window the record still does not come back', scrolled === undefined || !scrolled.markdown.includes(REF), scrolled?.markdown)
  doc.sections[0]!.entries.push({ seq: 64, time: now, source: 'tool:Retain s:proof', text: 'Fix every quayside invoice rounding in the harbour pricing before the wharf clerk checks it.' })
  writeFileSync(join(dir, 'topic-harbour.md'), serializeTopicDoc(doc))
  const newRecord = await capsule(null, [boundary('fold-3'), summary('s3'), turn(PROMPT, 'c4')])
  check('a record that ranks for the first time rides on the capsule once, alone', newRecord !== undefined && newRecord.markdown.includes('mneme:64') && !newRecord.markdown.includes(`${REF} `) && !newRecord.markdown.includes('mneme:63') && newRecord.memoryIds?.join() === 'seq:64', newRecord?.markdown)

  resetSession()
  const rode = ids(getRelevantMemoryAttachments(PROMPT, [], context()))
  check('a fresh session the other way round: the per-turn surface rides first', rode.includes(FACT), rode.join())
  const quiet = await capsule(PROMPT, [])
  check('the capsule then lists nothing the per-turn surface already surfaced', quiet !== undefined && rode.every(id => !quiet.markdown.includes(`mneme:${id.slice('seq:'.length)} `) && !quiet.memoryIds?.includes(id)), quiet?.markdown)
  const child = await capsule(PROMPT, [], { ...context(), agentId: 'child-1' } as never)
  check('a crewmate thread keeps its own count: its first capsule lists the record', child !== undefined && child.markdown.includes(REF), child?.markdown)
  check('the main lane is untouched by the crewmate\'s count', !ids(getRelevantMemoryAttachments(PROMPT, [turn(PROMPT, 'm1')], context())).includes(FACT))
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ a memory record is surfaced automatically once per session, on either surface' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

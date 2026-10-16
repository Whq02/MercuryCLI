#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-pointers-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const { retainItems, readMemoryRecord, correctMemory, recallQuery } = await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { publishFrontPage } = await import('../../src/mneme/mnemeFrontPage.js')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')
const dir = mnemeLibraryDir()

type Block = { content: string; is_error?: boolean }
const render = (output: unknown): string => (RecallTool.mapToolResultToToolResultBlockParam(output as never, 'tu') as unknown as Block).content
const recallTool = async (input: Record<string, unknown>): Promise<{ data: Record<string, unknown>; text: string }> => {
  const out = (await RecallTool.call(input as never, {} as never)) as { data: Record<string, unknown> }
  return { data: out.data, text: render(out.data) }
}

const SECRETS = ['quartzlantern', 'ambermoth', 'cobaltferry', 'velvetanvil']

section('§1 the search answers with pointers that carry no content')
retainItems(
  [
    { content: `the deploy gate waits for the smoke suite ${SECRETS[0]}`, topic: 'deploy' },
    { content: `the deploy gate token refreshes weekly ${SECRETS[1]}`, topic: 'deploy' },
    { content: `release tags are signed by the ops key ${SECRETS[2]}`, topic: 'release' },
  ],
  { session: 'alpha-session' },
)
check('consolidated', maybeConsolidate({ dir, force: true }).consolidated === true)
retainItems([{ content: `a pending note about the deploy gate ${SECRETS[3]}`, topic: 'deploy' }], { session: 'alpha-session' })
const search = await recallTool({ query: 'deploy gate' })
check('the answer is pointers', search.data.kind === 'pointers', String(search.data.kind))
const pointers = (search.data.pointers ?? []) as Array<Record<string, unknown>>
check('three pointers for three matching records (two facts and the pending row)', pointers.length === 3, JSON.stringify(pointers.map(p => p.id)))
check(
  'every pointer carries identity, title, footnotes, source and freshness',
  pointers.every(p => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['footnotes', 'freshness', 'id', 'kind', 'source', 'title'])),
  JSON.stringify(pointers.map(p => Object.keys(p))),
)
check('the pointer kinds are fact pointers', pointers.every(p => p.kind === 'fact'), JSON.stringify(pointers.map(p => p.kind)))
const leaked = SECRETS.filter(s => JSON.stringify(search.data).includes(s) || search.text.includes(s))
check('no content word of any record is in the answer (data or text)', leaked.length === 0, leaked.join(', '))
check('the answer states the fact and no law of negation', search.text.startsWith('3 pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n') && !search.text.includes('never from a pointer') && !search.text.includes('quoted from the record'), search.text.split('\n')[0])
check('a pointer title names the page, the section, the day and the source', pointers.some(p => /^deploy › notes · \d{4}-\d{2}-\d{2} · tool:Retain s:alpha-se · matches deploy, gate$/.test(String(p.title))), JSON.stringify(pointers.map(p => p.title)))
check('the pending row is a pointer too, named pending', pointers.some(p => String(p.id).startsWith('pending:') && String(p.title).startsWith('pending · deploy · ')), JSON.stringify(pointers.map(p => p.title)))
const noMatch = await recallTool({ query: 'zebrafrost quintuple' })
check('nothing matched is elidable, as before', noMatch.data.elidable === true && noMatch.text.startsWith('No memory matched.'))
check('limit above 20 is refused by the schema', RecallTool.inputSchema.safeParse({ query: 'x', limit: 21 }).success === false && RecallTool.inputSchema.safeParse({ query: 'x', limit: 20 }).success === true)

section('§2 the read verb returns the record itself')
const factPointer = pointers.find(p => String(p.id).startsWith('seq:'))!
const read = await recallTool({ read: String(factPointer.id) })
check('the record read carries its content', read.data.found === true && SECRETS.some(s => String(read.data.content).includes(s)), String(read.data.content).slice(0, 120))
check('the text shows the content and the unlock note', SECRETS.some(s => read.text.includes(s)) && read.text.includes('[full record read'), read.text.slice(0, 80))
const pendingPointer = pointers.find(p => String(p.id).startsWith('pending:'))!
const pendingRead = await recallTool({ read: String(pendingPointer.id) })
check('a pending pointer opens to its row', pendingRead.data.found === true && String(pendingRead.data.content).includes(SECRETS[3]!))
const { RECALL_PROMPT, RECALL_DESCRIPTION } = await import('../../src/tools/MemoryTools/prompt.js')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.js')
const querySchemaText = String((zodToJsonSchema(RecallTool.inputSchema as never) as { properties?: { query?: { description?: string } } }).properties?.query?.description ?? '')
const NEGATIONS = ['never from a pointer', 'quoted from the record', 'never the content', 'never carries the content']
const negated = [RECALL_PROMPT, RECALL_DESCRIPTION, querySchemaText].flatMap(text => NEGATIONS.filter(phrase => text.includes(phrase)))
check(
  'the tool teaches the ledger spelling and the pointer fact',
  RECALL_PROMPT.includes('ledger:<ordinal>') &&
    RECALL_PROMPT.includes('- A pointer carries no content: open the record with read before you rely on it or quote it.') &&
    RECALL_DESCRIPTION.includes('footnotes (which session, which ruling, superseded by what). Read one full record by id.') &&
    querySchemaText.includes('A pointer is an id, a title and footnotes: open one with read to see the record.'),
  querySchemaText.slice(-90),
)
check('no law of negation in the prompt, the description or the query schema', negated.length === 0, negated.join(' | '))

section('§3 the footnotes point both ways after a Correct')
const { searchPointers } = await import('../../src/mneme/mnemePointers.js')
const tokenHit = recallQuery('refreshes weekly').hits.find(h => h.label === 'consolidated')!
const superseded = correctMemory({ op: 'supersede', id: tokenHit.id, content: 'the deploy gate token now rotates itself', reason: 'automation landed', session: 'beta-session' })
check('supersede landed', superseded.ok === true, JSON.stringify(superseded))
const successorId = superseded.ok ? `seq:${superseded.newSeq}` : ''
const successorPointer = searchPointers('rotates itself', { dir }).pointers.find(p => p.id === successorId)
check('the successor pointer footnotes name what it supersedes', successorPointer?.footnotes.supersedes === tokenHit.id, JSON.stringify(successorPointer))
const oldRead = readMemoryRecord(tokenHit.id)
check('the superseded record, read by id, names its successor', oldRead.found === true && oldRead.footnotes?.supersededBy === successorId, JSON.stringify(oldRead.footnotes))
const oldText = render({ kind: 'record', ...oldRead })
check('the rendered read carries the footnote line', oldText.includes(`[footnotes: superseded by ${successorId}]`), oldText.split('\n').slice(-1)[0])
const smokeHit = recallQuery('smoke suite').hits.find(h => h.label === 'consolidated')!
const signedHit = recallQuery('signed by the ops key').hits.find(h => h.label === 'consolidated')!
const pointed = correctMemory({ op: 'supersede', id: smokeHit.id, replacementId: signedHit.id, reason: 'the release fact covers it', session: 'beta-session' })
check('supersede by replacementId landed', pointed.ok === true, JSON.stringify(pointed))
const movedRead = readMemoryRecord(smokeHit.id)
check('the target now points at the existing truth, not at a tombstone', movedRead.footnotes?.supersededBy === signedHit.id, JSON.stringify(movedRead.footnotes))
const truthRead = readMemoryRecord(signedHit.id)
check('the existing truth points back at what it replaced', truthRead.found === true && truthRead.footnotes?.supersedes === smokeHit.id, JSON.stringify(truthRead.footnotes))
const deployDoc = readMemoryRecord('doc:deploy')
check('the act is in history with its reason', (deployDoc.content ?? '').includes(`superseded by seq ${signedHit.id.slice(4)}: the release fact covers it`), (deployDoc.content ?? '').slice(-200))
check('the target is out of default recall', !recallQuery('smoke suite').hits.some(h => h.id === smokeHit.id))
const crossSlug = pointed.ok ? pointed.slug : ''
check('the result names the target page', crossSlug === 'deploy', crossSlug)

section('§4 the ruling footnote: the pinned rule recorded in the same session, at or before the fact')
const rulingOut = retainItems([{ content: 'always run the smoke suite before a release', pin: true }], { session: 'gamma-session', pinIntent: { messageId: 'owner-gamma', text: 'always run the smoke suite before a release' } })
check('the rule is staged', rulingOut[0]?.status === 'stored', JSON.stringify(rulingOut))
check('the shelf landed', maybeConsolidate({ dir, force: true }).consolidated === true)
await sleep(5)
retainItems([{ content: 'the soak suite runs nightly on the staging ring', topic: 'release' }], { session: 'gamma-session' })
retainItems([{ content: 'the staging ring has four nodes', topic: 'release' }], { session: 'delta-session' })
check('consolidated', maybeConsolidate({ dir, force: true }).consolidated === true)
const rulingPointer = searchPointers('smoke suite before a release', { dir }).pointers.find(p => p.kind === 'ruling')
check('the pinned rule is a ruling pointer', rulingPointer !== undefined && /^seq:\d+$/.test(rulingPointer.id), JSON.stringify(rulingPointer))
const underRuling = searchPointers('soak suite nightly', { dir }).pointers.find(p => p.kind === 'fact')
check('a fact of the same session, after the rule, falls under it', underRuling?.footnotes.ruling === rulingPointer?.id, JSON.stringify(underRuling))
const otherSession = searchPointers('four nodes', { dir }).pointers.find(p => p.kind === 'fact')
check('a fact of another session carries no ruling', otherSession !== undefined && otherSession.footnotes.ruling === undefined, JSON.stringify(otherSession))
const earlier = searchPointers('rotates itself', { dir }).pointers.find(p => p.id === successorId)
check('a fact recorded before any rule carries no ruling', earlier !== undefined && earlier.footnotes.ruling === undefined, JSON.stringify(earlier))

section('§5 the front page does not grow: footnotes are read on lookup only')
publishFrontPage(dir)
const frontPage = readFileSync(join(dir, 'front-page.md'), 'utf8')
const FOOTNOTE_WORDS = /ledger:|superseded by|ruling seq:|footnote|\{session/
check('no footnote on the front page', !FOOTNOTE_WORDS.test(frontPage), frontPage.split('\n').filter(l => FOOTNOTE_WORDS.test(l)).join(' | '))
check('the pinned rule still reads as before', frontPage.includes('always run the smoke suite before a release <seq='))

section('§6 the ledger: sessions and handoffs are searched and read through the same button')
const sessions = [
  {
    ordinal: 1,
    sessionId: 'alpha-session-0000-4000-8000-000000000001',
    startedAt: '2026-10-09T14:02:11.000+01:00',
    endedAt: '2026-10-09T15:40:02.000+01:00',
    engines: [{ model: 'engine-one', at: '2026-10-09T14:02:11.000+01:00' }],
    rulings: [],
    retained: [],
    corrected: [],
    files: ['src/deploy/gate.ts'],
    outcome: 'completed',
    handoff: { text: 'The deploy gate is the centre of this work; the smoke suite decides it. Still to do: the soak ring. I got the token cadence wrong once.', at: '2026-10-09T15:39:50.000+01:00' },
  },
  {
    ordinal: 2,
    sessionId: 'gamma-session-0000-4000-8000-000000000002',
    startedAt: '2026-10-10T09:00:00.000+01:00',
    endedAt: '2026-10-10T10:12:00.000+01:00',
    engines: [{ model: 'engine-two', at: '2026-10-10T09:00:00.000+01:00' }],
    rulings: [rulingPointer?.id ?? 'seq:0'],
    retained: [],
    corrected: [],
    files: ['src/release/soak.ts'],
    outcome: 'interrupted',
    handoff: null,
  },
  {
    ordinal: 3,
    sessionId: 'delta-session-0000-4000-8000-000000000003',
    startedAt: '2026-10-11T01:00:00.000+01:00',
    endedAt: null,
    engines: [{ model: 'engine-three', at: '2026-10-11T01:00:00.000+01:00' }],
    rulings: [],
    retained: [],
    corrected: [],
    files: [],
    outcome: null,
    handoff: null,
  },
]
const handoffSearch = searchPointers('soak ring', { dir, sessions })
const handoffPointer = handoffSearch.pointers.find(p => p.kind === 'handoff')
check('a word of a handoff finds the handoff pointer', handoffPointer?.id === 'ledger:1', JSON.stringify(handoffSearch.pointers))
check('the handoff title names the session, the day and the length, not the words', handoffPointer !== undefined && /^handoff of session 1 of 3 · 2026-10-09 · \d+ words · matches soak, ring$/.test(handoffPointer.title) && !handoffPointer.title.includes('centre'), handoffPointer?.title)
check('the matching fact comes before the handoff', handoffSearch.pointers[0]?.kind === 'fact', JSON.stringify(handoffSearch.pointers.map(p => p.kind)))
const sessionPointer = searchPointers('src/release/soak.ts', { dir, sessions }).pointers.find(p => p.kind === 'session')
check('a session without a handoff is absent from search', sessionPointer === undefined, JSON.stringify(sessionPointer))
check('a path touched by a session with a note finds its session pointer', searchPointers('src/deploy/gate.ts', { dir, sessions }).pointers.some(p => p.id === 'ledger:1' && p.kind === 'session'))
const ledgerRead = readMemoryRecord('ledger:1', dir, { sessions })
check('ledger:<ordinal> reads the entry and the handoff verbatim', ledgerRead.found === true && (ledgerRead.content ?? '').includes(sessions[0]!.handoff!.text) && (ledgerRead.content ?? '').includes('engines: engine-one from 2026-10-09T14:02:11.000+01:00'), (ledgerRead.content ?? '').slice(0, 200))
const noNote = readMemoryRecord('ledger:2', dir, { sessions })
check('a session that left no note says so', (noNote.content ?? '').includes('handoff: no note left') && (noNote.content ?? '').includes('rulings (1):'), noNote.content)
const open = readMemoryRecord('ledger:3', dir, { sessions })
check('an open session shows no engine line', open.found === true && (open.content ?? '').includes('still open') && !(open.content ?? '').includes('engine-three'), open.content)
const missing = readMemoryRecord('ledger:9', dir, { sessions })
check('a missing ordinal is a typed not-found', missing.found === false && (missing.note ?? '').includes('no session 9 in the ledger (3 so far)'), missing.note)
const sessionFact = searchPointers('four nodes', { dir, sessions }).pointers.find(p => p.kind === 'fact')
check('a fact footnotes the session that retained it', sessionFact?.footnotes.session === 3, JSON.stringify(sessionFact))
const rulingBySessionLedger = searchPointers('soak suite nightly', { dir, sessions }).pointers.find(p => p.kind === 'fact')
check('the ruling footnote stands with the ledger in view', rulingBySessionLedger?.footnotes.ruling === rulingPointer?.id && rulingBySessionLedger?.footnotes.session === 2, JSON.stringify(rulingBySessionLedger))

section('§7 the lineage ledger itself: what the ledger module wrote, the button finds and reads with nothing passed in')
const { openEntry, recordHandoff, closeEntry, readLedger } = await import('../../src/mneme/ledger.js')
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const key = mnemeProjectKey()
check('no session in the ledger yet', readLedger(key).length === 0)
const before = await recallTool({ read: 'ledger:1' })
check('ledger:1 before any session is a typed not-found', before.data.found === false && String(before.data.note).includes('no session yet'), String(before.data.note))
const first = 'alpha-session-real-0000-4000-8000-000000000001'
const second = 'delta-session-real-0000-4000-8000-000000000002'
openEntry(key, { sessionId: first, model: 'engine-one' })
recordHandoff(key, first, 'The lanternmoth cadence was wrong once; the deploy gate is the centre of this work. Still to do: the soak ring.')
closeEntry(key, first, { outcome: 'completed' })
openEntry(key, { sessionId: second, model: 'engine-two' })
const written = readLedger(key)
check('two entries, one closed with a note and one open', written.length === 2 && written[0]!.handoff !== null && written[1]!.endedAt === null, JSON.stringify(written.map(e => [e.ordinal, e.endedAt === null])))
const liveSearch = await recallTool({ query: 'lanternmoth cadence' })
const livePointers = (liveSearch.data.pointers ?? []) as Array<{ id: string; kind: string; title: string }>
check('the handoff is found through the tool with nothing passed in', livePointers.some(p => p.id === 'ledger:1' && p.kind === 'handoff' && p.title.startsWith('handoff of session 1 of 2 · ')), JSON.stringify(livePointers))
check('the handoff words are not in the answer', !liveSearch.text.includes('centre of this work') && !liveSearch.text.includes('soak ring'), liveSearch.text)
const liveRead = await recallTool({ read: 'ledger:1' })
check('the ledger read carries the handoff verbatim and the engine with its clock time', liveRead.text.includes(written[0]!.handoff!.text) && liveRead.text.includes(`engines: engine-one from ${written[0]!.engines[0]!.at}`) && liveRead.text.includes(`handoff (${written[0]!.handoff!.at}):`), liveRead.text)
const openRead = await recallTool({ read: 'ledger:2' })
check('the open session reads as still open without its engine', openRead.text.includes('still open') && !openRead.text.includes('engine-two') && openRead.text.includes('handoff: no note left'), openRead.text)
const sessionFootnote = ((await recallTool({ query: 'four nodes' })).data.pointers as Array<{ kind: string; footnotes: { session?: number } }>).find(p => p.kind === 'fact')
check('a fact retained by the open session footnotes it by the session id in its source', sessionFootnote?.footnotes.session === 2, JSON.stringify(sessionFootnote))
const factRead = readMemoryRecord(otherSession!.id)
check('the same footnote on the record read', factRead.footnotes?.session === 2, JSON.stringify(factRead.footnotes))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL MEMORY-POINTER PROOFS PASS' : `❌ ${failures} MEMORY-POINTER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// gate-watch: src/mneme/memoryVerbs.ts src/mneme/mnemePointers.ts src/tools/MemoryTools/MemoryTools.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-recall-limit-cut-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV']) delete process.env[key]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { recallQuery } = await import('../../src/mneme/memoryVerbs.ts')
const { searchPointers, limitCutLine, POINTER_DEFAULT_LIMIT } = await import('../../src/mneme/mnemePointers.ts')
const { emptyDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')
const { writeDoc } = await import('../../src/mneme/mnemeLibrary.ts')
const { RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')

const now = new Date('2026-10-14T02:00:00.000Z')
const fresh = '2026-10-10T00:00:00.000Z'
const old = '2026-06-01T00:00:00.000Z'
const dir = join(HOME, 'library')
const doc = emptyDoc('quartz', 'quartz notes', now.toISOString())
doc.sections = [{ heading: 'notes', entries: [
  ...Array.from({ length: 13 }, (_, i) => ({ seq: i + 1, text: `Quartz lot ${i + 1} passed the bench check and ships with the ledger.`, source: 'proof', time: fresh })),
  { seq: 14, text: 'Quartz lot 14 was recut after the bench check failed once.', source: 'proof', time: old },
  { seq: 15, text: 'Quartz lot 15 waits for the bench check in the yard.', source: 'proof', time: old },
] }]
writeDoc(doc, dir)
const render = (query: string, limit?: number): string => String(RecallTool.mapToolResultToToolResultBlockParam({ kind: 'pointers', ...searchPointers(query, { dir, now, sessions: [], ...(limit === undefined ? {} : { limit }) }) }, 'tid').content)

try {
  console.log('\n── the limit cut is said in one line, and a stale hit the cut left out is named in it')
  const recall = recallQuery('quartz', { dir, now, limit: POINTER_DEFAULT_LIMIT })
  check('fifteen records match beside two page lines (the id and the summary); the default limit of twelve keeps twelve RECORDS and leaves three out, two of them stale — the page lines ride along without taking a slot (RED before: ten records, five out)', recall.hits.filter(hit => !hit.id.startsWith('doc:')).length === 12 && recall.hits.filter(hit => hit.id.startsWith('doc:')).length === 2 && recall.cut.hits === 3 && recall.cut.stale === 2, JSON.stringify({ kept: recall.hits.map(hit => hit.id), cut: recall.cut }))
  check('stale hits sort last, so the cut falls on them first', recall.hits.every(hit => hit.status !== 'stale'))
  const pointers = searchPointers('quartz', { dir, now, sessions: [] })
  check('the pointer result carries the count found, the stale count cut and the limit it ran under (a page line yields no pointer)', pointers.pointers.length === 12 && pointers.found === 15 && pointers.cutStale === 2 && pointers.limit === POINTER_DEFAULT_LIMIT, JSON.stringify({ shown: pointers.pointers.length, found: pointers.found, cutStale: pointers.cutStale, limit: pointers.limit }))
  const line = limitCutLine(pointers)
  check('below the most, the line names the cut, the stale hits it left out and the two remedies', line === '12 of 15 hits shown, 2 of the 3 left out stale; narrow the words or raise the limit', String(line))
  const content = render('quartz')
  check('the tool result says it right after the header, before the pointers', content.startsWith('12 pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n12 of 15 hits shown, 2 of the 3 left out stale; narrow the words or raise the limit\n- [seq:'), content.slice(0, 260))
  const raised = searchPointers('quartz', { dir, now, sessions: [], limit: 20 })
  check('raising the limit shows every hit and the line is gone', raised.pointers.length === 15 && raised.found === 15 && limitCutLine(raised) === null && !render('quartz', 20).includes('hits shown'), JSON.stringify({ shown: raised.pointers.length, found: raised.found }))
  const narrowed = searchPointers('quartz lot 14', { dir, now, sessions: [] })
  check('narrowing the words finds the stale record without a cut', narrowed.pointers.some(p => p.id === 'seq:14') && limitCutLine(narrowed) === null, JSON.stringify(narrowed.pointers.map(p => p.id)))
  const current = searchPointers('ships with the ledger', { dir, now, sessions: [], limit: 5 })
  check('a cut with no stale hit in it says the count alone', limitCutLine(current) === '5 of 13 hits shown; narrow the words or raise the limit', String(limitCutLine(current)))
  check('an uncut answer keeps its shape: the header, then the pointer lines', render('quartz lot 15').startsWith('1 pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n- [seq:15]'), render('quartz lot 15').slice(0, 200))

  console.log('\n── F37A-1D-03: five records across two pages, a catch-all query, the limit already at its most (20)')
  const air = join(HOME, 'air-library')
  const git = emptyDoc('git-workflow', 'git workflow rules', now.toISOString())
  git.sections = [{ heading: 'notes', entries: [{ seq: 4, text: 'Never push to the cobalt branch on a Friday.', source: 'tool:Retain', time: fresh }] }]
  writeDoc(git, air)
  const infra = emptyDoc('project-infrastructure', 'servers, branches and caches', now.toISOString())
  infra.sections = [{ heading: 'notes', entries: [
    { seq: 2, text: 'The release branch is called cobalt.', source: 'tool:Retain', time: fresh },
    { seq: 3, text: 'The build cache lives at /var/cache/kestrel.', source: 'tool:Retain', time: fresh },
    { seq: 5, text: 'The staging server is called heron-09 (renamed from heron-07).', source: 'tool:Correct', time: fresh },
    { seq: 6, text: 'Deploys go out from the cobalt branch after the Friday freeze lifts.', source: 'tool:Retain', time: fresh },
  ] }]
  infra.history = [{ seq: 1, text: 'The staging server is called heron-07.', source: 'tool:Retain', time: fresh }]
  writeDoc(infra, air)
  const catchAll = recallQuery('.', { dir: air, now, limit: 20 })
  check('the catch-all pattern matches every line of both pages; the five live records are all kept and none is cut (RED before: two kept, three cut — eighteen of the twenty slots went to frontmatter and headings)', catchAll.hits.filter(hit => !hit.id.startsWith('doc:')).map(hit => hit.id).sort().join(' ') === 'seq:2 seq:3 seq:4 seq:5 seq:6' && catchAll.cut.hits === 0, JSON.stringify({ kept: catchAll.hits.map(hit => hit.id), cut: catchAll.cut }))
  check('the page lines that ride along are capped at the limit, so the raw recall stays bounded', catchAll.hits.filter(hit => hit.id.startsWith('doc:')).length <= 20, String(catchAll.hits.length))
  const airPointers = searchPointers('.', { dir: air, now, sessions: [], limit: 20 })
  check('the Recall tool shows all five pointers and prints no cut line at all (RED before: "2 of 5 hits shown; narrow the words or raise the limit")', airPointers.pointers.length === 5 && airPointers.found === 5 && limitCutLine(airPointers) === null, JSON.stringify({ shown: airPointers.pointers.map(p => p.id), found: airPointers.found, line: limitCutLine(airPointers) }))
  const airContent = String(RecallTool.mapToolResultToToolResultBlockParam({ kind: 'pointers', ...airPointers }, 'tid').content)
  check('the result reads "5 pointer(s)" and never the words "raise the limit"', airContent.startsWith('5 pointer(s) — ') && !airContent.includes('raise the limit') && !airContent.includes('hits shown'), airContent.slice(0, 200))

  console.log('\n── at the most (20), a real cut never says "raise the limit": the words name the cause and the two roads left')
  const atMost = searchPointers('quartz', { dir, now, sessions: [], limit: 20 })
  check('fifteen quartz records fit under twenty: no line', limitCutLine(atMost) === null)
  const crowded = emptyDoc('quartz-yard', 'quartz yard ledger', now.toISOString())
  crowded.sections = [{ heading: 'notes', entries: Array.from({ length: 25 }, (_, i) => ({ seq: 100 + i, text: `Quartz yard bay ${i + 1} holds a crate for the bench check.`, source: 'proof', time: i < 22 ? fresh : old })) }]
  writeDoc(crowded, dir)
  const yard = searchPointers('quartz yard bay', { dir, now, sessions: [], limit: 20 })
  const yardLine = limitCutLine(yard)
  check('twenty-six records (the yard\'s twenty-five and lot 15, which waits in the yard) under a limit of twenty: the line says the limit is at its most and offers the two roads (narrow the words, or open the page), never "raise the limit"', yard.pointers.length === 20 && yard.found === 26 && yardLine === '20 of 26 hits shown, 4 of the 6 left out stale; the limit is at its most (20): narrow the words, or open a whole page with read:"doc:<slug>"', String(yardLine))
  check('the same cut under the default limit keeps the raise-the-limit remedy (it is true there)', String(limitCutLine(searchPointers('quartz yard bay', { dir, now, sessions: [] }))).endsWith('; narrow the words or raise the limit'), String(limitCutLine(searchPointers('quartz yard bay', { dir, now, sessions: [] }))))
  check('a result persisted before the limit field reads as below the most', limitCutLine({ pointers: yard.pointers, found: 26, cutStale: 0 }) === '20 of 26 hits shown; narrow the words or raise the limit')
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ RECALL LIMIT CUT GREEN (${checks} checks)`)
else console.log(`❌ RECALL LIMIT CUT RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

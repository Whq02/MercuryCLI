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
  check('fifteen records match beside two page lines (the heading and the summary); the default limit of twelve keeps ten records and leaves five out, two of them stale', recall.hits.length === 12 && recall.hits.filter(hit => hit.id.startsWith('doc:')).length === 2 && recall.cut.hits === 5 && recall.cut.stale === 2, JSON.stringify({ kept: recall.hits.map(hit => hit.id), cut: recall.cut }))
  check('stale hits sort last, so the cut falls on them first', recall.hits.every(hit => hit.status !== 'stale'))
  const pointers = searchPointers('quartz', { dir, now, sessions: [] })
  check('the pointer result carries the count found and the stale count cut (a page line yields no pointer)', pointers.pointers.length === 10 && pointers.found === 15 && pointers.cutStale === 2, JSON.stringify({ shown: pointers.pointers.length, found: pointers.found, cutStale: pointers.cutStale }))
  const line = limitCutLine(pointers)
  check('the line names the cut and the stale hits it left out', line === '10 of 15 hits shown; narrow the words or raise the limit, 2 of them stale', String(line))
  const content = render('quartz')
  check('the tool result says it right after the header, before the pointers', content.startsWith('10 pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n10 of 15 hits shown; narrow the words or raise the limit, 2 of them stale\n- [seq:'), content.slice(0, 260))
  const raised = searchPointers('quartz', { dir, now, sessions: [], limit: 20 })
  check('raising the limit shows every hit and the line is gone', raised.pointers.length === 15 && raised.found === 15 && limitCutLine(raised) === null && !render('quartz', 20).includes('hits shown'), JSON.stringify({ shown: raised.pointers.length, found: raised.found }))
  const narrowed = searchPointers('quartz lot 14', { dir, now, sessions: [] })
  check('narrowing the words finds the stale record without a cut', narrowed.pointers.some(p => p.id === 'seq:14') && limitCutLine(narrowed) === null, JSON.stringify(narrowed.pointers.map(p => p.id)))
  const current = searchPointers('ships with the ledger', { dir, now, sessions: [], limit: 5 })
  check('a cut with no stale hit in it says the count alone', limitCutLine(current) === '5 of 13 hits shown; narrow the words or raise the limit', String(limitCutLine(current)))
  check('an uncut answer keeps its shape: the header, then the pointer lines', render('quartz lot 15').startsWith('1 pointer(s) — a pointer carries no content: open one with read:"<id>" before you rely on it\n- [seq:15]'), render('quartz lot 15').slice(0, 200))
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log(`✅ RECALL LIMIT CUT GREEN (${checks} checks)`)
else console.log(`❌ RECALL LIMIT CUT RED (${failures} of ${checks} checks failed)`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

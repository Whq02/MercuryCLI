#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-verbs-lifecycle.ts
//  PROOF (spec 06): the verb surface over the MNEME owners, end to end —
//  retain → recall (pending, labeled) → consolidation → recall (consolidated,
//  provenance cues intact) → correct(supersede) → recall shows the successor
//  while history retains the original. Plus the structural laws: the verbs
//  are ABSENT when the backend is off (catalogue + why-not), Retain never
//  touches the memdir index (MEMORY.md byte-unchanged), and two concurrent
//  Retain writers (the teammate-clobber class) interleave without loss.
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-memverbs-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_MNEME = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, recallQuery, readMemoryRecord, correctMemory, memoryVerbsEnabled, memoryVerbsWhyNot } =
  await import('../../src/memdir/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.js')
const { getAutoMemPath } = await import('../../src/memdir/paths.js')
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')
const { RetainTool, RecallTool, ReflectTool, CorrectTool } = await import(
  '../../src/tools/MemoryTools/MemoryTools.js'
)
const { getAllBaseTools } = await import('../../src/tools.js')

section('gate law: absent when the backend is off, present when on')
process.env.MERCURY_MNEME = '0'
check('verbs disabled with MNEME off', memoryVerbsEnabled() === false)
check('why-not names the gate', (memoryVerbsWhyNot() ?? '').includes('MERCURY_MNEME'), memoryVerbsWhyNot() ?? '')
check('all four tools out of the catalogue', !getAllBaseTools().some(t => ['Retain', 'Recall', 'Reflect', 'Correct'].includes(t.name)))
process.env.MERCURY_MNEME = '1'
check('verbs enabled with MNEME on + auto-memory on', memoryVerbsEnabled() === true)
check(
  'all four tools in the catalogue',
  ['Retain', 'Recall', 'Reflect', 'Correct'].every(name => getAllBaseTools().some(t => t.name === name)),
)
check('tools report enabled', RetainTool.isEnabled() && RecallTool.isEnabled() && ReflectTool.isEnabled() && CorrectTool.isEnabled())

section('MEMORY.md is untouched by the verbs (the index law)')
const memPath = getAutoMemPath()
mkdirSync(memPath, { recursive: true })
const indexPath = join(memPath, 'MEMORY.md')
writeFileSync(indexPath, '# Memory index\n\n- untouched sentinel\n', 'utf8')
const indexBefore = readFileSync(indexPath, 'utf8')

section('retain → recall: pending, labeled, seconds old')
const retained = retainItems(
  [
    { content: 'the deploy gate needs the staging token refreshed weekly', topic: 'deploy' },
    { content: 'ops prefers rollouts on tuesdays', context: 'operator said so', topic: 'deploy' },
  ],
  { session: 'lifecycle-session' },
)
check('both items stored with ids', retained.every(o => o.status === 'stored'), JSON.stringify(retained))
const pendingRecall = recallQuery('staging token')
check('pending fact recallable seconds later', pendingRecall.hits.length > 0, JSON.stringify(pendingRecall.hits))
check('labeled pending', pendingRecall.hits[0]?.label === 'pending')
check('pending signature carries time+source cues', (pendingRecall.hits[0]?.signature ?? '').includes('source=tool:Retain'), pendingRecall.hits[0]?.signature)
const dupe = retainItems([{ content: 'the deploy gate needs the staging token refreshed weekly', topic: 'deploy' }], { session: 'lifecycle-session' })
check('same-session duplicate updates, never duplicates', dupe[0]?.status === 'already-staged', JSON.stringify(dupe))

section('consolidation: same fact, now consolidated, cues intact')
const consolidated = maybeConsolidate({ dir: mnemeLibraryDir(), force: true })
check('consolidation ran', consolidated.consolidated === true, consolidated.reason)
const afterRecall = recallQuery('staging token')
check('the fact survives consolidation', afterRecall.hits.length > 0)
const conHit = afterRecall.hits.find(h => h.label === 'consolidated')
check('now labeled consolidated with a seq id', conHit !== undefined && /^seq:\d+$/.test(conHit.id), conHit?.id)
check('the source cue MOVED with the entry', (conHit?.signature ?? '').includes('source=tool:Retain'), conHit?.signature)

section('correct(supersede): successor live, history retained')
const targetSeq = Number(/^seq:(\d+)$/.exec(conHit!.id)?.[1])
const superseded = correctMemory({
  op: 'supersede',
  id: conHit!.id,
  content: 'the deploy gate token now auto-refreshes; no weekly manual step',
  reason: 'automation landed',
  session: 'lifecycle-session',
})
check('supersede landed', superseded.ok === true, JSON.stringify(superseded))
const successorRecall = recallQuery('auto-refreshes')
check('the successor is live in recall', successorRecall.hits.some(h => h.label === 'consolidated'), JSON.stringify(successorRecall.hits.map(h => h.id)))
const oldRecall = recallQuery('refreshed weekly')
check('the OLD fact is absent from default recall', !oldRecall.hits.some(h => h.id === conHit!.id), JSON.stringify(oldRecall.hits.map(h => h.id)))
const docRead = superseded.ok ? readMemoryRecord(`doc:${superseded.slug}`) : { found: false, content: '' }
check('history RETAINS the original with a superseded-by pointer', (docRead.content ?? '').includes(`[superseded-by`) && (docRead.content ?? '').includes('refreshed weekly'), (docRead.content ?? '').slice(-300))

section('concurrent Retain (the teammate-clobber class): no loss')
const parallelOutcomes = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    Promise.resolve().then(() => retainItems([{ content: `concurrent fact number ${i}` }], { session: `writer-${i}`, agent: `agent-${i}` })),
  ),
)
check('all eight writers stored', parallelOutcomes.every(o => o[0]?.status === 'stored'))
const countRecall = recallQuery('concurrent fact number', { limit: 50 })
check('all eight rows readable back', countRecall.hits.length === 8, String(countRecall.hits.length))

section('the index law held throughout')
check('MEMORY.md byte-unchanged', existsSync(indexPath) && readFileSync(indexPath, 'utf8') === indexBefore)

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL VERBS-LIFECYCLE PROOFS PASS' : `❌ ${failures} VERBS-LIFECYCLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

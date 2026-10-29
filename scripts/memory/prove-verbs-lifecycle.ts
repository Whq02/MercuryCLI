#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-memverbs-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, recallQuery, readMemoryRecord, correctMemory, memoryVerbsEnabled, memoryVerbsWhyNot } =
  await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
const { getMnemeHome } = await import('../../src/mneme/paths.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { RetainTool, RecallTool, ReflectTool, CorrectTool } = await import(
  '../../src/tools/MemoryTools/MemoryTools.js'
)
const { getAllBaseTools } = await import('../../src/tools.js')

section('the one switch: absent when memory is off, present by default')
process.env.MERCURY_BARE = '1'
check('verbs disabled with memory off', memoryVerbsEnabled() === false)
check('why-not names the switch', (memoryVerbsWhyNot() ?? '').includes('memory is off'), memoryVerbsWhyNot() ?? '')
check('all four tools out of the catalogue', !getAllBaseTools().some(t => ['Retain', 'Recall', 'Reflect', 'Correct'].includes(t.name)))
delete process.env.MERCURY_BARE
check('verbs enabled with nothing set', memoryVerbsEnabled() === true)
check(
  'all four tools in the catalogue',
  ['Retain', 'Recall', 'Reflect', 'Correct'].every(name => getAllBaseTools().some(t => t.name === name)),
)
check('tools report enabled', RetainTool.isEnabled() && RecallTool.isEnabled() && ReflectTool.isEnabled() && CorrectTool.isEnabled())

section('an ordinary file in the memory dir is untouched by the verbs')
const memPath = getMnemeHome()
mkdirSync(memPath, { recursive: true })
const indexPath = join(memPath, 'notes.md')
writeFileSync(indexPath, '# notes\n\n- untouched sentinel\n', 'utf8')
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

section('concurrent Retain (the crewmate-clobber class): no loss')
const parallelOutcomes = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    Promise.resolve().then(() => retainItems([{ content: `concurrent fact number ${i}` }], { session: `writer-${i}`, agent: `agent-${i}` })),
  ),
)
check('all eight writers stored', parallelOutcomes.every(o => o[0]?.status === 'stored'))
const countRecall = recallQuery('concurrent fact number', { limit: 50 })
check('all eight rows readable back', countRecall.hits.length === 8, String(countRecall.hits.length))

section('the other file is still as it was')
check('notes.md byte-unchanged', existsSync(indexPath) && readFileSync(indexPath, 'utf8') === indexBefore)

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL VERBS-LIFECYCLE PROOFS PASS' : `❌ ${failures} VERBS-LIFECYCLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-memverbs-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { retainItems, recallQuery, readMemoryRecord, correctMemory, memoryVerbsEnabled, memoryVerbsWhyNot } =
  await import('../../src/sessions/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.js')
const { getMnemeHome } = await import('../../src/sessions/mneme/paths.js')
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.js')
const { RetainTool, RecallTool, ReflectTool, CorrectTool } = await import(
  '../../src/tools/memory/MemoryTools.js'
)
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')

section('the one switch: absent when memory is off, present by default')
process.env.MERCURY_BARE = '1'
check('verbs disabled with memory off', memoryVerbsEnabled() === false, '', 'memoryVerbsEnabled in src/sessions/mneme/memoryVerbs.ts must be false when MERCURY_BARE is set')
check('why-not names the switch', (memoryVerbsWhyNot() ?? '').includes('memory is off'), memoryVerbsWhyNot() ?? '', 'memoryVerbsWhyNot in src/sessions/mneme/memoryVerbs.ts must say memory is off')
check('all four tools out of the catalogue', !getAllBaseTools().some(t => ['Retain', 'Recall', 'Reflect', 'Correct'].includes(t.name)), '', 'getAllBaseTools in src/tools/kit/toolList.ts must leave the memory tools out when memoryVerbsEnabled is false')
delete process.env.MERCURY_BARE
check('verbs enabled with nothing set', memoryVerbsEnabled() === true, '', 'memoryVerbsEnabled in src/sessions/mneme/memoryVerbs.ts must be true when no switch is set')
check(
  'all four tools in the catalogue',
  ['Retain', 'Recall', 'Reflect', 'Correct'].every(name => getAllBaseTools().some(t => t.name === name)),
  '',
  'getAllBaseTools in src/tools/kit/toolList.ts must include the four tools from src/tools/memory/MemoryTools.ts when memoryVerbsEnabled is true',
)
check('tools report enabled', RetainTool.isEnabled() && RecallTool.isEnabled() && ReflectTool.isEnabled() && CorrectTool.isEnabled(), '', 'isEnabled of each tool in src/tools/memory/MemoryTools.ts must follow memoryVerbsEnabled')

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
check('both items stored with ids', retained.every(o => o.status === 'stored'), JSON.stringify(retained), 'retainItems in src/sessions/mneme/memoryVerbs.ts must store each item and return status stored')
const pendingRecall = recallQuery('staging token')
check('pending fact recallable seconds later', pendingRecall.hits.length > 0, JSON.stringify(pendingRecall.hits), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must return pending retained rows')
check('labeled pending', pendingRecall.hits[0]?.label === 'pending', '', 'recallQuery in src/sessions/mneme/memoryVerbs.ts must label unconsolidated rows pending')
check('pending signature carries time+source cues', (pendingRecall.hits[0]?.signature ?? '').includes('source=tool:Retain'), pendingRecall.hits[0]?.signature, 'retainItems and recallQuery in src/sessions/mneme/memoryVerbs.ts must carry the source cue into the hit signature')
const dupe = retainItems([{ content: 'the deploy gate needs the staging token refreshed weekly', topic: 'deploy' }], { session: 'lifecycle-session' })
check('same-session duplicate updates, never duplicates', dupe[0]?.status === 'already-staged', JSON.stringify(dupe), 'retainItems in src/sessions/mneme/memoryVerbs.ts must answer already-staged for the same content in the same session')

section('consolidation: same fact, now consolidated, cues intact')
const consolidated = maybeConsolidate({ dir: mnemeLibraryDir(), force: true })
check('consolidation ran', consolidated.consolidated === true, consolidated.reason, 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts declined; see the reason above')
const afterRecall = recallQuery('staging token')
check('the fact survives consolidation', afterRecall.hits.length > 0, '', 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must keep the retained fact recallable')
const conHit = afterRecall.hits.find(h => h.label === 'consolidated')
check('now labeled consolidated with a seq id', conHit !== undefined && /^seq:\d+$/.test(conHit.id), conHit?.id, 'recallQuery in src/sessions/mneme/memoryVerbs.ts must label a consolidated row consolidated with a seq:<n> id')
check('the source cue MOVED with the entry', (conHit?.signature ?? '').includes('source=tool:Retain'), conHit?.signature, 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must carry the source cue into the consolidated entry')

section('correct(supersede): successor live, history retained')
const targetSeq = Number(/^seq:(\d+)$/.exec(conHit!.id)?.[1])
const superseded = correctMemory({
  op: 'supersede',
  id: conHit!.id,
  content: 'the deploy gate token now auto-refreshes; no weekly manual step',
  reason: 'automation landed',
  session: 'lifecycle-session',
})
check('supersede landed', superseded.ok === true, JSON.stringify(superseded), 'correctMemory (op supersede) in src/sessions/mneme/memoryVerbs.ts refused; see the result above')
const successorRecall = recallQuery('auto-refreshes')
check('the successor is live in recall', successorRecall.hits.some(h => h.label === 'consolidated'), JSON.stringify(successorRecall.hits.map(h => h.id)), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must write the successor as a live row')
const oldRecall = recallQuery('refreshed weekly')
check('the OLD fact is absent from default recall', !oldRecall.hits.some(h => h.id === conHit!.id), JSON.stringify(oldRecall.hits.map(h => h.id)), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must leave superseded rows out of default recall')
const docRead = superseded.ok ? readMemoryRecord(`doc:${superseded.slug}`) : { found: false, content: '' }
check('history RETAINS the original with a superseded-by pointer', (docRead.content ?? '').includes(`[superseded-by`) && (docRead.content ?? '').includes('refreshed weekly'), (docRead.content ?? '').slice(-300), 'correctMemory in src/sessions/mneme/memoryVerbs.ts must keep the original in history with a superseded-by pointer')

section('concurrent Retain (the crewmate-clobber class): no loss')
const parallelOutcomes = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    Promise.resolve().then(() => retainItems([{ content: `concurrent fact number ${i}` }], { session: `writer-${i}`, agent: `agent-${i}` })),
  ),
)
check('all eight writers stored', parallelOutcomes.every(o => o[0]?.status === 'stored'), '', 'retainItems in src/sessions/mneme/memoryVerbs.ts must store concurrent writers without refusing or losing one')
const countRecall = recallQuery('concurrent fact number', { limit: 50 })
check('all eight rows readable back', countRecall.hits.length === 8, String(countRecall.hits.length), 'concurrent retainItems calls in src/sessions/mneme/memoryVerbs.ts lost or duplicated a row')

section('the other file is still as it was')
check('notes.md byte-unchanged', existsSync(indexPath) && readFileSync(indexPath, 'utf8') === indexBefore, '', 'a memory verb in src/sessions/mneme/memoryVerbs.ts wrote to notes.md, an ordinary file in the memory dir; it must touch only its own library files')

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL VERBS-LIFECYCLE PROOFS PASS' : `❌ ${failures} VERBS-LIFECYCLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

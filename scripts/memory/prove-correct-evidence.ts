#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-correct-evidence.ts
//  PROOF (spec 06 C4): the seen-evidence law and the audit spine.
//    · amend WITHOUT a full-row read this session refuses with the re-read
//      hint; after the read (Recall read:"seq:n") the SAME amend lands;
//    · retract retains history (marked wrong-with-reason, never deleted);
//    · supersede-by-replacementId points at an EXISTING live row and
//      retires the target with the pointer; a dead replacement refuses;
//    · pending rows are not correctable (typed), unknown seqs are typed
//      not-found, double-correction gets already-superseded.
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-correct-evidence-'))
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

const { retainItems, recallQuery, readMemoryRecord, correctMemory, _resetMemoryVerbSessionStateForTesting } =
  await import('../../src/memdir/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.js')

// Seed three consolidated facts.
retainItems(
  [
    { content: 'the cache TTL is ninety seconds', topic: 'caching' },
    { content: 'the cache backend is redis', topic: 'caching' },
    { content: 'cache keys are prefixed by tenant', topic: 'caching' },
  ],
  { session: 'evidence' },
)
maybeConsolidate({ dir: mnemeLibraryDir(), force: true })
const seeded = recallQuery('cache', { limit: 20 }).hits.filter(h => h.label === 'consolidated' && h.id.startsWith('seq:'))
check('three consolidated facts seeded', seeded.length >= 3, JSON.stringify(seeded.map(h => h.id)))
const ttlHit = seeded.find(h => h.preview.includes('ninety'))!
const ttlSeq = Number(/^seq:(\d+)$/.exec(ttlHit.id)?.[1])

section('amend refuses without the full-row read, with the exact hint')
_resetMemoryVerbSessionStateForTesting()
const blind = correctMemory({ op: 'amend', id: ttlHit.id, content: 'the cache TTL is ninety seconds (measured)', reason: 'add provenance', session: 'evidence' })
check('refused with the unseen-evidence code', blind.ok === false && blind.code === 'unseen-evidence', JSON.stringify(blind))
check('the hint names the exact read to perform', blind.ok === false && blind.message.includes(`read:"seq:${ttlSeq}"`), blind.ok === false ? blind.message : '')

section('after the read, the SAME amend lands')
const read = readMemoryRecord(ttlHit.id)
check('the full record read succeeded', read.found === true && (read.content ?? '').includes('ninety'), read.note)
const amended = correctMemory({ op: 'amend', id: ttlHit.id, content: 'the cache TTL is ninety seconds (measured)', reason: 'add provenance', session: 'evidence' })
check('amend landed after the evidence read', amended.ok === true, JSON.stringify(amended))

section('retract retains history')
const backendHit = seeded.find(h => h.preview.includes('redis'))!
readMemoryRecord(backendHit.id)
const retracted = correctMemory({ op: 'retract', id: backendHit.id, reason: 'we moved off redis', session: 'evidence' })
check('retract landed', retracted.ok === true, JSON.stringify(retracted))
const doc = retracted.ok ? readMemoryRecord(`doc:${retracted.slug}`) : { content: '' }
check('the retired fact remains in history, marked with the reason', (doc.content ?? '').includes('retired: we moved off redis') && (doc.content ?? '').includes('cache backend is redis'), (doc.content ?? '').slice(-260))
check('the retired fact is out of default recall', !recallQuery('redis').hits.some(h => h.id === backendHit.id))

section('supersede by replacementId: pointer to an EXISTING truth')
const prefixHit = seeded.find(h => h.preview.includes('prefixed'))!
const amendedSuccessor = recallQuery('measured').hits.find(h => h.label === 'consolidated')!
const bridged = correctMemory({
  op: 'supersede',
  id: prefixHit.id,
  replacementId: amendedSuccessor.id,
  reason: 'the measured row covers this',
  session: 'evidence',
})
check('replacement supersede landed', bridged.ok === true, JSON.stringify(bridged))
const deadReplacement = correctMemory({ op: 'supersede', id: amendedSuccessor.id, replacementId: 'seq:99999', reason: 'x', session: 'evidence' })
check('a dead replacementId refuses typed', deadReplacement.ok === false && deadReplacement.code === 'unknown-target', JSON.stringify(deadReplacement))

section('typed edges: pending, unknown, already-superseded')
const pendingRefusal = correctMemory({ op: 'retract', id: 'pending:2026-01-01T00:00:00Z', reason: 'x', session: 'evidence' })
check('pending rows are not correctable (typed)', pendingRefusal.ok === false && pendingRefusal.code === 'not-editable', JSON.stringify(pendingRefusal))
const unknown = correctMemory({ op: 'retract', id: 'seq:424242', reason: 'x', session: 'evidence' })
check('unknown seq is typed not-found', unknown.ok === false && unknown.code === 'unknown-target', JSON.stringify(unknown))
const doubled = correctMemory({ op: 'retract', id: ttlHit.id, reason: 'again', session: 'evidence' })
check('double correction gets already-superseded', doubled.ok === false && doubled.code === 'already-superseded', JSON.stringify(doubled))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL CORRECT-EVIDENCE PROOFS PASS' : `❌ ${failures} CORRECT-EVIDENCE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

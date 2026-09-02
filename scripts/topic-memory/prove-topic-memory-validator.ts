#!/usr/bin/env bun
// prove-topic-memory-validator — the anti-gaming spine red-teamed: every way an LLM
// rewriter draft could lose or forge evidence is REFUSED deterministically,
// and a refusal leaves CURRENT untouched (nothing lost).
//
//   §1 DROPPED seq (the acceptance case): a rewriter that silently omits an
//      observation is refused with the seq named.
//   §2 INVENTED seq · §3 rewritten time/source cues · §4 double-supersede ·
//   §5 self/unknown supersede targets · §6 empty text · §7 bad slug ·
//   §8 duplicate live seq — all refused.
//   §9 a VALID supersede draft passes the same validator (no false refusals).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

const { appendObservation, readBuffer } = await import('../../src/memdir/mnemeBuffer.ts')
const { maybeConsolidate, validateDraft } = await import('../../src/memdir/mnemeConsolidate.ts')
import type { AssignedRow, MnemeDraft } from '../../src/memdir/mnemeConsolidate.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const dir = mkdtempSync(join(tmpdir(), 'mneme-val-'))
appendObservation({ text: 'fact one', source: 'proof', topicHint: 'topic' }, dir)
appendObservation({ text: 'fact two', source: 'proof', topicHint: 'topic' }, dir)
appendObservation({ text: 'fact three corrects fact two', source: 'proof', topicHint: 'topic' }, dir)

const entryFor = (r: AssignedRow, extra: Partial<{ text: string; time: string; source: string; supersedes: string }> = {}) => ({
  text: extra.text ?? r.text,
  seq: r.seq,
  time: extra.time ?? r.ts,
  source: extra.source ?? r.source,
  ...(extra.supersedes ? { supersedes: extra.supersedes } : {}),
})

function refusedBy(makeDraft: (rows: AssignedRow[]) => MnemeDraft): string {
  const before = readBuffer(dir).length
  const r = maybeConsolidate({ force: true, dir, rewriter: ({ rows }) => makeDraft([...rows]) })
  const after = readBuffer(dir).length
  if (r.consolidated) return 'NOT REFUSED'
  if (before !== after) return 'CURRENT MUTATED ON REFUSAL'
  return r.reason
}

section('§1 dropped seq refused, CURRENT untouched')
{
  const reason = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.slice(0, 2).map(r => entryFor(r)) }], // drops row 3
  }))
  check('refused naming the dropped seq', /dropped/.test(reason) && /conservation/.test(reason), reason)
}

section('§2 invented seq refused')
{
  const reason = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: [...rows.map(r => entryFor(r)), { text: 'forged', seq: 999, time: rows[0]!.ts, source: 'proof' }] }],
  }))
  check('refused as invention', /invention/.test(reason), reason)
}

section('§3 rewritten cues refused (time/source move with entries)')
{
  const t = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.map((r, i) => (i === 0 ? entryFor(r, { time: '2001-01-01T00:00:00Z' }) : entryFor(r))) }],
  }))
  check('time rewrite refused', /cues rewritten/.test(t), t)
  const s = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.map((r, i) => (i === 0 ? entryFor(r, { source: 'model-retelling' }) : entryFor(r))) }],
  }))
  check('source rewrite refused', /cues rewritten/.test(s), s)
}

section('§4 double-supersede refused')
{
  const reason = refusedBy(rows => ({
    blocks: [{
      topicSlug: 'topic',
      entries: [
        entryFor(rows[1]!, { supersedes: String(rows[0]!.seq) }),
        entryFor(rows[2]!, { supersedes: String(rows[0]!.seq) }),
      ],
    }],
  }))
  check('refused', /superseded twice/.test(reason), reason)
}

section('§5 self- and unknown-target supersedes refused')
{
  const self = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.map((r, i) => (i === 2 ? entryFor(r, { supersedes: String(r.seq) }) : entryFor(r))) }],
  }))
  check('self-supersede refused', /supersedes itself/.test(self), self)
  const unknown = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.map((r, i) => (i === 2 ? entryFor(r, { supersedes: '4242' }) : entryFor(r))) }],
  }))
  check('unknown target refused', /neither in this batch nor live/.test(unknown), unknown)
}

section('§6 empty text refused (evidence lost)')
{
  const reason = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: rows.map((r, i) => (i === 1 ? entryFor(r, { text: '   ' }) : entryFor(r))) }],
  }))
  check('refused', /empty text/.test(reason), reason)
}

section('§7 non-slug topic refused')
{
  const reason = refusedBy(rows => ({
    blocks: [{ topicSlug: '../escape', entries: rows.map(r => entryFor(r)) }],
  }))
  check('refused', /slug/.test(reason), reason)
}

section('§8 duplicate live seq refused')
{
  const reason = refusedBy(rows => ({
    blocks: [{ topicSlug: 'topic', entries: [...rows.map(r => entryFor(r)), entryFor(rows[0]!)] }],
  }))
  check('refused', /appears twice/.test(reason), reason)
}

section('§9 a valid supersede draft PASSES (no false refusals)')
{
  const rows: AssignedRow[] = readBuffer(dir).map((r, i) => ({ ...r, seq: i + 1 }))
  const draft: MnemeDraft = {
    blocks: [{
      topicSlug: 'topic',
      entries: [
        entryFor(rows[0]!),
        entryFor(rows[2]!, { supersedes: String(rows[1]!.seq) }), // the correction supersedes fact two
      ],
    }],
  }
  const v = validateDraft(draft, { rows, libraryLiveSeqs: new Set() })
  check('validator accepts', v.ok === true, v.ok ? '' : v.reason)
  const r = maybeConsolidate({ force: true, dir, rewriter: () => draft })
  check('consolidation lands', r.consolidated && r.entries === 2, r.reason)
  check('CURRENT cleared on success', readBuffer(dir).length === 0)
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MNEME VALIDATOR PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MNEME VALIDATOR PROOFS PASS')

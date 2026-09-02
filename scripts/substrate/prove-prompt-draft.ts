#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-prompt-draft.ts — the durable prompt-draft store
//  oracle (mercury-feel; DoD: "prompt text, cursor position, mode,
//  and pasted-reference metadata survive session switches, modal
//  round-trips, process interruption, and relaunch until submit or explicit
//  discard").
//
//    §1 save → sync read-back (the boot seed path) round-trips all fields
//    §2 saves COALESCE (one write for a typing burst)
//    §3 an EMPTIED draft deletes the entry (submit can never resurrect)
//    §4 a fast session switch flushes the OUTGOING session's pending save
//    §5 oversized pastes shed with honest labels; the text survives
//    §6 the per-project file stays bounded to the newest MAX drafts
//    §7 corrupt store degrades to empty (fail-soft), then recovers
//
//  Run: ~/.bun/bin/bun run scripts/substrate/prove-prompt-draft.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Hermetic config home BEFORE importing the module under test.
const home = mkdtempSync(join(tmpdir(), 'draft-proof-'))
process.env.MERCURY_CONFIG_DIR = home

const {
  saveDraftDebounced,
  flushDraftSaves,
  deleteDraft,
  readDraftSync,
  cancelPendingDraftSave,
} = await import('../../src/utils/promptDraft.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002'

console.log('prove-prompt-draft')

// §1 round-trip
saveDraftDebounced(S1, {
  text: 'fix the flaky test in',
  cursorOffset: 8,
  mode: 'prompt',
  pastedContents: { 1: { id: 1, type: 'text', content: 'pasted body' } as never },
})
await flushDraftSaves()
{
  const d = readDraftSync(S1)
  check('§1 sync read-back round-trips text', d?.text === 'fix the flaky test in')
  check('§1 cursor + mode survive', d?.cursorOffset === 8 && d?.mode === 'prompt')
  check('§1 pasted contents survive', Boolean(d?.pastedContents[1]))
}

// §2 coalescing: a typing burst = ONE final state (and no intermediate is
// observable after flush)
for (const t of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
  saveDraftDebounced(S1, { text: t, cursorOffset: t.length, mode: 'prompt', pastedContents: {} })
}
await flushDraftSaves()
check('§2 coalesced saves land the final keystroke state', readDraftSync(S1)?.text === 'abcde')

// §3 emptied draft deletes (submit clears the prompt → entry gone)
saveDraftDebounced(S1, { text: '', cursorOffset: 0, mode: 'prompt', pastedContents: {} })
await flushDraftSaves()
check('§3 an emptied draft deletes the entry', readDraftSync(S1) === null)

// §4 fast switch: pending save for S1 flushes when S2 starts saving
saveDraftDebounced(S1, { text: 'unsent thought', cursorOffset: 5, mode: 'prompt', pastedContents: {} })
saveDraftDebounced(S2, { text: 'second session draft', cursorOffset: 3, mode: 'bash', pastedContents: {} })
await flushDraftSaves()
await sleep(80)
{
  const d1 = readDraftSync(S1)
  const d2 = readDraftSync(S2)
  check('§4 outgoing session keeps its last keystrokes across a fast switch', d1?.text === 'unsent thought', d1?.text ?? 'null')
  check('§4 incoming session saved independently (mode too)', d2?.text === 'second session draft' && d2?.mode === 'bash')
}

// §5 oversize shed with labels
{
  const big = 'x'.repeat(300_000)
  saveDraftDebounced(S1, {
    text: 'text survives',
    cursorOffset: 2,
    mode: 'prompt',
    pastedContents: { 1: { id: 1, type: 'text', content: big } as never },
  })
  await flushDraftSaves()
  const d = readDraftSync(S1)
  check('§5 oversized draft keeps its text', d?.text === 'text survives')
  check('§5 oversized pastes shed', Object.keys(d?.pastedContents ?? { x: 1 }).length === 0)
  check('§5 shed pastes recorded as honest labels', (d?.missingPastes ?? []).some(m => m.includes('pasted text #1')), JSON.stringify(d?.missingPastes))
}

// §6 bound: 25 sessions → newest 20 kept
for (let i = 0; i < 25; i++) {
  const sid = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`
  saveDraftDebounced(sid, { text: `draft ${i}`, cursorOffset: 0, mode: 'prompt', pastedContents: {} })
  await flushDraftSaves()
}
{
  const draftsDir = join(home, 'drafts')
  const file = readdirSync(draftsDir).find(f => f.endsWith('.json'))
  const parsed = JSON.parse(readFileSync(join(draftsDir, file!), 'utf8')) as Record<string, unknown>
  // Count DRAFT entries only: the fileStore kernel stamps metadata keys
  // (schema `_v`, the revisioned-store `_rev`) beside them — the store's
  // decode skips anything that doesn't sanitize as a draft, so the proof
  // must too (de-stale: `_rev` landed after this prover and read
  // as a phantom 21st draft).
  const entries = Object.keys(parsed).filter(k => !k.startsWith('_'))
  check('§6 per-project file bounded to 20 newest', entries.length <= 20, `${entries.length}`)
  check('§6 the newest draft survived the bound', entries.some(k => k.endsWith('000000000024')))
}

// §7 corrupt file: fail-soft, then recover
{
  const draftsDir = join(home, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  const file = readdirSync(draftsDir).find(f => f.endsWith('.json'))!
  writeFileSync(join(draftsDir, file), '{ nope')
  check('§7 corrupt store reads as empty (boot never crashes)', readDraftSync(S1) === null)
  saveDraftDebounced(S1, { text: 'recovered', cursorOffset: 0, mode: 'prompt', pastedContents: {} })
  await flushDraftSaves()
  check('§7 the next save recovers the store', readDraftSync(S1)?.text === 'recovered')
}

// §8 submit semantics: cancel-then-delete — a pending keystroke save must
// NOT resurrect the submitted draft after the delete
saveDraftDebounced(S1, { text: 'about to submit', cursorOffset: 3, mode: 'prompt', pastedContents: {} })
cancelPendingDraftSave()
deleteDraft(S1)
await sleep(600) // past the debounce window — a leaked pending would flush here
check('§8 submit cancel-then-delete leaves NO draft (no late-flush resurrection)', readDraftSync(S1) === null)

// explicit discard
deleteDraft(S1)
await sleep(60)
check('explicit discard removes the draft', readDraftSync(S1) === null)

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n✓ prove-prompt-draft: all green' : `\n✗ prove-prompt-draft: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

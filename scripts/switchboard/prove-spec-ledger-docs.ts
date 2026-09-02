#!/usr/bin/env bun
// ============================================================================
//  prove-spec-ledger-docs — the docs' lifecycle page tells the L20 truth.
//
// The incident this closes (the find): the operator
//  re-cut the older-chats browse (ledger L20) — ↵ on the board's "N older
//  chats" line unfolds a drop-down IN PLACE, never a shunt into a chat
//  panel — and the code landed that shape at the concourse-design fold, but
//  docs/SESSIONS.md kept the superseded sentence ("↵ opens the project's own
//  session list … in the chat frame"): the page was trued before the re-cut
//  landed, and the fold carried no doc re-true. The page is part of the
//  landed product; a doc speaking a narrowed reading is the drift class the
//  spec ledger exists to catch.
//
//  WORD-KEYED BOTH WAYS (the DOCSCP pin class): the DOC must carry the
//  in-place words, and the CODE must still own the behaviour those words
//  describe — either side moving alone reads RED, so the pair can only move
//  together.
//
//  POISON: the retired shunt copy, composed at runtime (never quoted as one
//  live string) — a doc that says the ↵ opens the session list in the chat
//  frame fails here.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-spec-ledger-docs.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const root = join(import.meta.dir, '..', '..')
// The page is prose wrapped to its own measure (the line breaks fall
// where the measure puts them) — so every PROSE needle here matches the
// space-folded text, never the wrap. The first run of this pin
// went red on a wrap that split "…a parked / row rides" across a
// break while the words stood exactly as written. Poison needles fold the
// same way: a retired sentence hides behind a wrap no better than a kept
// one.
const doc = readFileSync(join(root, 'docs', 'SESSIONS.md'), 'utf8').replace(/\s+/g, ' ')
const screen = readFileSync(join(root, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf8')
const route = readFileSync(join(root, 'src', 'components', 'concourse', 'ConcourseRoute.tsx'), 'utf8')

console.log('============================================================')
console.log(' spec-ledger docs — the older-chats browse (L20) in the doc')
console.log('============================================================')

// ── the doc speaks the landed in-place drop-down ────────────────────────────
{
  check('the doc keeps the census line spelling', doc.includes('N older chats · ↵ to'))
  check('…and says ↵ unfolds the list in place on the board', doc.includes('unfolds that very list in place on the board'))
  check('…with esc folding it back to the line', doc.includes('folds it back to the line'))
  check('…through the same door a parked row rides', doc.includes('the same door a parked row rides'))
  check('…with the honest tail arithmetic', doc.includes('+N more — /resume'))
}

// ── the poison: the retired shunt reading, composed at runtime ──────────────
{
  // The superseded sentence's two teeth (never quoted whole here): the ↵
  // door described as opening the "…own session list" and doing so "in the
  // chat frame". The landed page speaks neither.
  const toothA = ['own', 'session list'].join(' ')
  const toothB = ['in the chat', 'frame'].join(' ')
  check('the doc never says the ↵ opens the session list in the chat frame', !(doc.includes(toothA) && doc.includes(toothB)))
}

// ── the code still owns the behaviour the words describe ────────────────────
{
  check('the screen owns the in-place unfold (the L20 comment stands)', screen.includes('the older-chats DROP-DOWN'))
  check('…reads the census the line counted', screen.includes('olderChatsCensus('))
  check('…and folds on esc', screen.includes('esc folds'))
  check('the route reactivates a pick through the one resume door', route.includes('resumeOlderChat'))
}

// ── the neighbouring L11 truth stays beside it ──────────────────────────────
{
  check('the retention sentence stands (nothing deletes a transcript)', doc.includes('Nothing deletes a transcript'))
}

console.log(failures === 0 ? '\n✅ prove-spec-ledger-docs — all checks pass' : '\n❌ prove-spec-ledger-docs — check(s) failed')
process.exit(failures)

#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-d.ts — Journey D reproducer.
//  Pins row (EXPECT-RED until Wave A lands).
//
//  The gap this repro pins: sideQuestion.ts (THE one side-branch seam — 1-turn,
//  no-tools, cache-hit fork; contracts KEPT) records no parentage and its
//  result cannot become a typed context item. extends the SAME file —
//  never a parallel engine — so this reproducer reads the owner's source for
//  the two pinned contract extensions.
//
//  Source-text pins (tight anchors, not comments): the result type gains an
//  `originRef` field; the module exports `toContextItem`.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const src = readFileSync('src/utils/sideQuestion.ts', 'utf8')

t.section('Journey D — side-branch parentage + attachable result at the ONE seam')
t.check(
  'SideQuestionResult records parentage (originRef field in the type body)',
  /^\s*originRef[?]?:/m.test(src),
  'the result type carries no origin/parentage today',
)
t.check(
  'the result is attachable as a typed context item (export toContextItem)',
  /^export (function|const) toContextItem/m.test(src),
)
t.check(
  'the 1-turn no-tools contract is STILL the engine law (must never regress)',
  src.includes('cap at 1 turn') && src.includes('tools are blocked'),
)

t.section('Journey D — the side-branch surface is bound (RV-09)')
{
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  // The board's side-question target retired with the WORK panel;
  // the console keeps the ONE
  // sideQuestion engine as its own surface.
  t.check(
    "the Action Graph no longer names 'board:side-question' (retired with the WORK panel)",
    !/['"]board:side-question['"]/.test(ag),
    'the retired side-question verb is still registered',
  )
}

t.finish('repro-journey-d')

#!/usr/bin/env bun
// ============================================================================
//  repro-input — reproducer (EXPECT-RED until M5/M9).
//
//  The baseline this repro pins: the input-intent matrix, the interaction
//  ratchets and the board grammar (NavigablePanes/InteractiveRow) gate the
//  existing estate (preserved). What it demands and finds absent: the crew-board
//  actions registered in the one key atlas (crew board dispatch dispositions,
//  conversation open, graph navigation, folio threads) and the footer-honesty
//  proof over the new focus states.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-27 — the Constellation actions live in the one key atlas')
let bindings = ''
try {
  bindings = readFileSync('src/keybindings/defaultBindings.ts', 'utf8')
} catch {
  bindings = ''
}
t.check(
  "the atlas carries a 'crew:' action family",
  /crew:/.test(bindings),
  'defaultBindings.ts registers no crew actions',
)

t.section('CS-27 — disposition visibility is prover-pinned')
let dispatch: Record<string, unknown> | null = null
try {
  dispatch = (await import('../../src/services/crew/dispatch.ts')) as Record<string, unknown>
} catch {
  dispatch = null
}
t.check(
  'the visible target+disposition label renderer exists (dispositionLabelOf)',
  typeof dispatch?.dispositionLabelOf === 'function',
  'no one owner renders `Steer X now` / `Hold for X next` / `Start a turn with X`',
)

t.finish('repro-input')

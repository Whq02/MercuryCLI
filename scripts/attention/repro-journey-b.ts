#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-b.ts — Journey B reproducer.
//  Pins row (EXPECT-RED until Wave A lands).
//
//  The gap this repro pins: no operator-action intent/receipt contract exists, and
//  the workflows resume queue "only drains after the board closes"
//  (WorkflowsBoard.tsx — the dispatch gap). lands the action contract
//  at the path pinned here; A3 gives the board an owner-receipt dispatch path.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/attention/actions.ts'

t.section('Journey B — operator-action intents + typed receipts exist')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/attention/actions.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no operator-action contract',
)
const kinds = mod?.RECEIPT_KINDS as unknown
const hasKind = (k: string): boolean => Array.isArray(kinds) && (kinds as string[]).includes(k)
t.check("RECEIPT_KINDS carries 'dispatch-accepted'", hasKind('dispatch-accepted'))
// steer-removal re-cut: 'target-moved' died with submitReplaceNext — no
// replaceable window exists under instant delivery. The closed vocabulary
// is exactly accepted/unavailable (poison: a third kind returning is a
// deliberate contract change, re-true prove-dispatch-actions with it).
t.check('RECEIPT_KINDS is exactly the delivery-law pair', Array.isArray(kinds) && (kinds as string[]).length === 2 && hasKind('dispatch-unavailable'))
t.check('the dispatch intent exists (submitDispatch)', typeof mod?.submitDispatch === 'function')

t.section('Journey B — the board dispatch surface is bound (RV-06)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  // The board dispatch composer retired with the WORK panel:
  // the registry must not carry the verb, and the
  // prompts panel's own rows stand in the Workbench context.
  t.check(
    "the Action Graph no longer names 'board:dispatch' (retired with the WORK panel)",
    !/['"]board:dispatch['"]/.test(ag) && /['"]prompts:send-saved['"]/.test(ag),
    'the retired dispatch verb is still registered',
  )
}

t.finish('repro-journey-b')

#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-e.ts — Journey E reproducer.
//  Pins row (EXPECT-RED until Wave A lands).
//
//  The gap this repro pins: attach enters a session but nothing captures the
//  origin (selection id, viewport anchor, scoped drafts, pane focus, route
//  back) — so detach cannot return the operator to the exact item, and a
//  session that settled meanwhile loses the trail entirely. lands the
//  return-state seam at the workbench owner pinned here.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/workbench/returnState.ts'

t.section('Journey E — the attach/detach return-state seam exists')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/workbench/returnState.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — detach has nowhere to return to',
)
t.check('captureReturnState exists', typeof mod?.captureReturnState === 'function')
t.check('restoreReturnState exists', typeof mod?.restoreReturnState === 'function')

t.section('Journey E — the attach/detach surface is bound (RV-10)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  // The board's attach deep-link retired with the WORK panel:
  // the prompts panel is a record
  // with no deep-links; the registry must not carry the verb.
  t.check(
    "the Action Graph no longer names 'board:attach' (retired with the WORK panel)",
    !/['"]board:attach['"]/.test(ag),
    'the retired attach verb is still registered',
  )
}

t.finish('repro-journey-e')

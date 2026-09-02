#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-g.ts — Journey G reproducer.
//  Pins rows (EXPECT-RED until Wave C lands).
//
//  The gap this repro pins: the folio is a pure read-only projection
//  (workbench/folio.ts exports assembleFolio/folioArtifactId and nothing
//  else) over a review data model that is DONE (reviewContracts: immutable
//  versions, additive anchored comments, relocate-or-OUTDATED) — comments,
//  decisions and feedback routing have no interaction surface. lands
//  ACTIONS at the sibling module pinned here, keeping folio.ts pure assembly.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/services/workbench/folioActions.ts'
const ACTIONS = ['accept', 'mark-reviewed', 'request-revision', 'send-feedback']

t.section('Journey G — folio ACTIONS exist beside the pure projection')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/workbench/folioActions.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — folios are observation-only',
)
const kinds = mod?.FOLIO_ACTION_KINDS as unknown
t.check(
  'FOLIO_ACTION_KINDS carries every decision verb',
  Array.isArray(kinds) && ACTIONS.every(k => (kinds as string[]).includes(k)),
  Array.isArray(kinds) ? (kinds as string[]).join(',') : 'absent',
)
t.check('applyFolioAction exists (idempotent, typed receipts)', typeof mod?.applyFolioAction === 'function')

t.finish('repro-journey-g')

#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/repro-journey-f.ts — Journey F reproducer.
//  Pins rows (EXPECT-RED until Wave B lands).
//
//  The gap this repro pins: the composer's paste/image references live as
//  view-local state at PromptInput/pendingInput; there is no scoped composer
//  document and no typed context shelf — no single body store referenced by
//  id, no reorder/undo, no restart durability. extracts
//  ComposerDocumentV2 AT the current owner into the input-core module pinned
//  here (input truth lives in input-core — the command-queue precedent).
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const OWNER = '../../src/input-core/composer-document.ts'
const KINDS = ['file', 'image', 'selection', 'large-paste', 'artifact', 'session-ref']

t.section('Journey F — ComposerDocumentV2 + the typed context shelf exist')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import(OWNER)) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/input-core/composer-document.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no scoped composer document',
)
t.check('createComposerDocument exists', typeof mod?.createComposerDocument === 'function')
const kinds = mod?.SHELF_ITEM_KINDS as unknown
t.check(
  'SHELF_ITEM_KINDS carries every required chip kind',
  Array.isArray(kinds) && KINDS.every(k => (kinds as string[]).includes(k)),
  Array.isArray(kinds) ? (kinds as string[]).join(',') : 'absent',
)

t.section('Journey F — the shelf surface is bound (RV-15/16)')
{
  const { readFileSync } = await import('node:fs')
  const ag = readFileSync('src/keybindings/actionGraph.ts', 'utf8')
  // The composer shelf never registered as a surface, and the WORK board
  // that would have hosted it retired in place:
  // the Action Graph names NO shelf surface, by design.
  t.check(
    "the Action Graph names no 'composer:shelf' surface (retired with the board)",
    !/['"]composer:shelf['"]/.test(ag),
    'a shelf surface is registered — the retirement regressed',
  )
}

t.finish('repro-journey-f')

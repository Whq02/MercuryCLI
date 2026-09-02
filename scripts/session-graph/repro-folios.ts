#!/usr/bin/env bun
// ============================================================================
//  repro-folios — reproducer (EXPECT-RED until M7).
//
//  The baseline this repro pins: the review journal already holds immutable
//  versions, additive anchored comments with relocate-or-OUTDATED honesty,
//  and idempotent folio decisions (preserved laws). What does NOT exist:
//  threaded replies (parentCommentId), resolve/reopen as first-class verbs,
//  per-SCOPE accept/request-revision with a documented global fold, typed
//  ActorRef authorship beside the legacy string authors, and revision
//  requests dispatched to the producing agent with a delivery receipt.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-21 — the journal vocabulary gains threads + scoped decisions')
const contracts = readFileSync('src/utils/artifacts/reviewContracts.ts', 'utf8')
t.check(
  'comments carry parentCommentId (threaded replies)',
  /parentCommentId/.test(contracts),
  'reviewContracts.ts has no reply lineage',
)
t.check(
  'a scoped decision event exists (scope-decision)',
  /scope-decision/.test(contracts),
  'no per-scope accept/request-revision vocabulary',
)
t.check(
  'typed actor refs exist beside legacy string authors (authorRef)',
  /authorRef/.test(contracts),
  'no ActorRef authorship',
)

t.section('CS-21 — folio actions gain the thread verbs')
let actions: Record<string, unknown> | null = null
try {
  actions = (await import('../../src/services/workbench/folioActions.ts')) as Record<string, unknown>
} catch {
  actions = null
}
const kinds = (actions?.FOLIO_ACTION_KINDS ?? []) as string[]
t.check('folioActions loads (the existing owner)', actions !== null)
for (const verb of ['reply', 'resolve-comment', 'reopen-comment']) {
  t.check(`FOLIO_ACTION_KINDS carries '${verb}'`, Array.isArray(kinds) && kinds.includes(verb), kinds.join(','))
}

t.section('CS-21 — folios reach the inbox + the editor wire (journey-final pins, M8)')
{
  // The conversation inbox holds a ready-to-review folio as a review-request
  // event on its conversation (the bucket law's input) — the wire from the
  // review journal into the conversation registry lands at M8.
  let inboxWire = false
  try {
    const reviewLayerFiles = ['src/services/workbench/folioActions.ts', 'src/utils/artifacts/reviewStore.ts']
    inboxWire = reviewLayerFiles.some(f =>
      /review-request|crew\/conversations/.test(readFileSync(f, 'utf8')),
    )
  } catch {
    inboxWire = false
  }
  t.check(
    'the review journal reaches the conversation inbox (review-request events, M8)',
    inboxWire,
    'no review→conversation wire yet',
  )
  // Editors read + act on the SAME artifact ids and fold over the ACP wire.
  let acpFolioWire = false
  try {
    acpFolioWire = /_mercury\/crew|foldScopeDecisions|artifact/.test(
      readFileSync('src/services/acp/acpServer.ts', 'utf8'),
    ) && /_mercury\/crew/.test(readFileSync('src/services/acp/acpServer.ts', 'utf8'))
  } catch {
    acpFolioWire = false
  }
  t.check(
    'the editor wire serves the same folio ids and fold (M8)',
    acpFolioWire,
    'acpServer.ts carries no crew/folio wire yet',
  )
}

t.finish('repro-folios')

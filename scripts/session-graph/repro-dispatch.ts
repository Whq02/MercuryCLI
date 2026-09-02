#!/usr/bin/env bun
// ============================================================================
//  repro-dispatch — reproducer (EXPECT-RED until
//  M3/M5).
//
//  The gap this repro pins: dispatch receipts exist per-surface (attention
//  actions' accepted/refused, folio feedback's retained), but there is no ONE
//  dispatch transaction with a typed AgentAddress, capability-confirmed
//  disposition, idempotency key, per-instruction AND per-attachment outcomes,
//  and the delivered / not-delivered / delivery-unknown truth split. Drafts
//  are cleared by surface convention, not by the positive-receipt law.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-09 — the one dispatch transaction exists at its pinned owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/dispatch.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'src/services/crew/dispatch.ts loads',
  mod !== null,
  mod ? 'loaded' : 'module absent — no canonical dispatch transaction',
)
t.check('the transaction entry exists (dispatchToAgent)', typeof mod?.dispatchToAgent === 'function')
t.check(
  'receipt states are exactly delivered|not-delivered|delivery-unknown',
  Array.isArray(mod?.DELIVERY_STATES) &&
    JSON.stringify([...(mod!.DELIVERY_STATES as string[])].sort()) ===
      JSON.stringify(['delivered', 'delivery-unknown', 'not-delivered']),
)
t.check(
  'dispositions are exactly steer-current|hold-next|start-turn',
  Array.isArray(mod?.DISPATCH_DISPOSITIONS) &&
    JSON.stringify([...(mod!.DISPATCH_DISPOSITIONS as string[])].sort()) ===
      JSON.stringify(['hold-next', 'start-turn', 'steer-current']),
)

t.section('CS-09 — the transaction laws (live once the owner exists)')
if (mod) {
  const laws = mod.__dispatchLawsForProof as
    | undefined
    | (() => Promise<{
        draftPreservedOnUnknown: boolean
        noAutoRetryWithoutDeclaredIdempotency: boolean
        perAttachmentOutcomes: boolean
        clearOnlyAfterPositiveReceipt: boolean
      }>)
  const r = typeof laws === 'function' ? await laws() : null
  t.check('the law probe exists (__dispatchLawsForProof)', r !== null)
  t.check('an ambiguous outcome preserves the draft as delivery-unknown', r?.draftPreservedOnUnknown === true)
  t.check('no automatic retry without declared dedupe/reconciliation', r?.noAutoRetryWithoutDeclaredIdempotency === true)
  t.check('instruction and every attachment carry independent outcomes', r?.perAttachmentOutcomes === true)
  t.check('the draft clears only after the positive receipt', r?.clearOnlyAfterPositiveReceipt === true)
} else {
  t.check('dispatch laws hold', false, 'owner absent')
}

t.section('CS-17 — the board composer rides the ONE transaction (journey-final pins)')
{
  const { readFileSync } = await import('node:fs')
  // The board's dispatch composer, its disposition label and the M6
  // conversation-row verbs retired in place with the WORK panel.
  // The ONE dispatch transaction
  // stays an owner (crew/dispatch); the prompts panel never dispatches —
  // its only hand-off is a saved prompt into the operator's own composer.
  const dispatch = readFileSync('src/services/crew/dispatch.ts', 'utf8')
  t.check(
    'the ONE dispatch transaction owner stands (crew/dispatch)',
    /export (async )?function dispatchToAgent/.test(dispatch),
    'the dispatch owner is gone',
  )
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check(
    'the prompts panel dispatches nothing (no crew/dispatch, no disposition, no branch/redirect verbs)',
    !/dispatchToAgent|dispositionLabelOf|linkConversation|crew:redirect|branch-conversation/.test(panel),
    'a retired dispatch verb re-grew on the panel',
  )
}

t.finish('repro-dispatch')

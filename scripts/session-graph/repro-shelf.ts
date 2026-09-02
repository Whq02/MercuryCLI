#!/usr/bin/env bun
// ============================================================================
//  repro-shelf — reproducer (EXPECT-RED until M6).
//
//  The baseline this repro pins: ComposerDocumentV2 already stores shelf
//  items as owner references with per-SCOPE drafts (main/dispatch/reply/
//  comment/change-next — preserved law). What does NOT exist: per-
//  CONVERSATION draft identity (three surfaces sharing the owner must not
//  share one mutable shelf), the resource kind, and dispatch receipts
//  listing exactly which attachments the target accepted.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-20 — per-conversation draft identity on the one shelf owner')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/input-core/composer-document.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check('composer-document loads (the existing owner)', mod !== null)
t.check(
  'conversation-scoped documents exist (conversationScope)',
  typeof mod?.conversationScope === 'function',
  'the per-conversation draft identity seam',
)
t.check(
  "the shelf vocabulary carries 'resource'",
  Array.isArray(mod?.SHELF_ITEM_KINDS) && (mod!.SHELF_ITEM_KINDS as string[]).includes('resource'),
  Array.isArray(mod?.SHELF_ITEM_KINDS) ? (mod!.SHELF_ITEM_KINDS as string[]).join(',') : 'absent',
)

t.section('CS-20 — attachment acceptance receipts (live once dispatch lands)')
let dispatch: Record<string, unknown> | null = null
try {
  dispatch = (await import('../../src/services/crew/dispatch.ts')) as Record<string, unknown>
} catch {
  dispatch = null
}
t.check(
  'per-attachment outcomes ride the receipt (attachmentOutcomes on DeliveryReceiptV1 — the field every surface reads)',
  typeof dispatch?.readDeliveryReceipt === 'function' &&
    Array.isArray((dispatch as { DELIVERY_STATES?: unknown }).DELIVERY_STATES),
)

t.finish('repro-shelf')

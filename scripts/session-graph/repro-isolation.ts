#!/usr/bin/env bun
// ============================================================================
//  repro-isolation — reproducer
//  (EXPECT-RED until M6).
//
//  The baseline this repro pins: the sideQuestion engine already keeps the
//  main agent uninterrupted (product law, preserved), and Minerva stages
//  plans without touching the main queue. What does NOT exist: conversation
//  identity for the three streams (main / Console side question / Minerva
//  refinement), staged-draft handoffs with explicit dispositions and
//  receipts, and the concurrency proof that each stream can settle or be
//  dismissed without mutating the other two. Those land at M6 over the
//  conversation registry + dispatch transaction pinned by the sibling
//  reproducers.
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-04 — the three-stream isolation seam exists')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/services/crew/conversations.ts')) as Record<string, unknown>
} catch {
  mod = null
}
t.check(
  'the conversation registry loads (the isolation substrate)',
  mod !== null,
  mod ? 'loaded' : 'module absent',
)
t.check(
  'stream kinds distinguish main | console-side | minerva-refinement',
  Array.isArray(mod?.CONVERSATION_KINDS) &&
    ['main', 'console-side', 'minerva-refinement'].every(k =>
      (mod!.CONVERSATION_KINDS as string[]).includes(k),
    ),
)

t.section('CS-18 — Minerva staging: refinement never dispatches by itself')
let minerva: Record<string, unknown> | null = null
try {
  minerva = (await import('../../src/services/crew/minervaHandoff.ts')) as Record<string, unknown>
} catch {
  minerva = null
}
t.check(
  'the staged-handoff owner loads (src/services/crew/minervaHandoff.ts)',
  minerva !== null,
  minerva ? 'loaded' : 'module absent — no staged Minerva handoff',
)
t.check('staging exists (stageRefinedDraft)', typeof minerva?.stageRefinedDraft === 'function')
t.check(
  'staged drafts carry original AND refined text (the side-by-side law)',
  typeof minerva?.stagedDraftOf === 'function',
)

t.section('CS-19 — Console handoff: explicit lineage, never transcript merge')
let handoff: Record<string, unknown> | null = null
try {
  handoff = (await import('../../src/services/crew/consoleHandoff.ts')) as Record<string, unknown>
} catch {
  handoff = null
}
t.check(
  'the console handoff owner loads (src/services/crew/consoleHandoff.ts)',
  handoff !== null,
  handoff ? 'loaded' : 'module absent — no explicit console handoff',
)
t.check('handoff preserves both conversation ids (handOffSideConversation)', typeof handoff?.handOffSideConversation === 'function')

t.finish('repro-isolation')

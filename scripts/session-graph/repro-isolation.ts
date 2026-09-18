#!/usr/bin/env bun
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
  'stream kinds distinguish main | console-side',
  Array.isArray(mod?.CONVERSATION_KINDS) &&
    ['main', 'console-side'].every(k =>
      (mod!.CONVERSATION_KINDS as string[]).includes(k),
    ),
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

#!/usr/bin/env bun
// ============================================================================
//  repro-seat-bridge — reproducer
//  (EXPECT-RED until M3).
//
//  The gap this repro pins: Mercury's ACP surface (src/services/acp/acpServer.ts)
//  is OUTWARD — it exposes Mercury to editors. No inward seat bridge attaches
//  an external Claude-family / Codex / OpenCode session INSIDE Mercury, no
//  tri-state observed-capability vocabulary exists, and no protocol
//  conformance fixtures cover the named adapters. M3 lands the transport-
//  neutral core at the path pinned HERE, distinct from the outward server.
// ============================================================================
import { existsSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('CS-07 — the inward seat bridge exists at its pinned owner')
let bridge: Record<string, unknown> | null = null
try {
  bridge = (await import('../../src/services/crew/seatBridge.ts')) as Record<string, unknown>
} catch {
  bridge = null
}
t.check(
  'src/services/crew/seatBridge.ts loads',
  bridge !== null,
  bridge ? 'loaded' : 'module absent — no inward external seat bridge',
)
t.check('attach exists (attachExternalSeat)', typeof bridge?.attachExternalSeat === 'function')
t.check('detach exists (detachExternalSeat)', typeof bridge?.detachExternalSeat === 'function')

t.section('CS-08 — capabilities are tri-state observed facts')
let caps: Record<string, unknown> | null = null
try {
  caps = (await import('../../src/services/crew/capabilities.ts')) as Record<string, unknown>
} catch {
  caps = null
}
t.check('src/services/crew/capabilities.ts loads', caps !== null)
t.check(
  'CAPABILITY_STATES is exactly supported|unsupported|unknown',
  Array.isArray(caps?.CAPABILITY_STATES) &&
    JSON.stringify([...(caps!.CAPABILITY_STATES as string[])].sort()) ===
      JSON.stringify(['supported', 'unknown', 'unsupported']),
)
t.check(
  'the vocabulary covers the required operations',
  Array.isArray(caps?.CAPABILITY_KINDS) &&
    [
      'steer-current',
      'hold-next',
      'start-turn',
      'cancel-turn',
      'attach-file',
      'attach-image',
      'attach-selection',
      'resume-session',
      'set-title',
      'structured-activity',
      'usage-totals',
      'artifact-replies',
    ].every(k => (caps!.CAPABILITY_KINDS as string[]).includes(k)),
)
t.check(
  'observations expire (invalidateCapabilities on reconnect/revision)',
  typeof caps?.invalidateCapabilities === 'function',
)

t.section('CS-10 — adapter conformance fixtures exist per named adapter')
for (const adapter of ['codex', 'opencode', 'goose']) {
  t.check(
    `fixtures/${adapter} conformance fixture exists`,
    existsSync(`scripts/session-graph/fixtures/${adapter}.fixture.json`),
    `scripts/session-graph/fixtures/${adapter}.fixture.json`,
  )
}

t.finish('repro-seat-bridge')

#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-r04b-mock-seam-dead.ts — R04
//  expect-red driver: the
//  /mock-limits fixture seam is DEAD-GATED — the R5 brief named
//  rateLimitMocking "the deterministic fixture seam", but its gate opens
//  with a hardcoded `{ return false }` (fork residue of an internal-only
//  build macro), so the seam can never arm in Mercury.
//
//    §A DEFECT: the seam is dead at EVERY layer — the setter is a no-op
//       (`{ return }` residue), so the store never arms and getMockHeaders
//       stays null
//    §B DEFECT: shouldProcessMockLimits() is false regardless
//    §C DEFECT: the live extractor no-ops for a non-subscriber even with
//       a rejected header — the sanctioned journey route is structurally
//       unreachable (subscriber-only AND mock-dead)
//
//  The R04 fix gives the seam a Mercury-native opening (registered
//  flag / boot-menu arm, double-consent preserved). Until then the cap
//  journeys ride the pure parser (prove-transition-cap-journey-fixtures).
//
//  Exit 0 = defect REPRODUCED. Not part of the green gate.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-r04b-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { setMockRateLimitScenario, shouldProcessMockLimits, getMockHeaders } = await import(
  '../../src/services/mockRateLimits.ts'
)
const limits = await import('../../src/services/claudeAiLimits.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — DEFECT: the setter is a no-op; the store never arms.
setMockRateLimitScenario('weekly-limit-reached')
const headers = getMockHeaders()
check(
  '§A REPRODUCED: setMockRateLimitScenario is a no-op (store never arms)',
  headers === null,
  JSON.stringify(headers),
)

// §B — DEFECT: the gate never opens.
check('§B REPRODUCED: shouldProcessMockLimits() is false (gate dead)', shouldProcessMockLimits() === false)

// §C — DEFECT: the live extractor no-ops for a non-subscriber (no listener
// emission of a rejected state even with the mock armed).
const seen: unknown[] = []
limits.statusListeners.add(l => seen.push(l))
limits.extractQuotaStatusFromHeaders(
  new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }),
)
const sawRejected = seen.some(l => (l as { status?: string }).status === 'rejected')
check('§C REPRODUCED: the live extractor emits no rejected state (route unreachable)', !sawRejected, JSON.stringify(seen))

console.log(
  failed === 0
    ? '\n REPRODUCED — R04b red recorded (the mock fixture seam is dead-gated; the live route is subscriber-only)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)

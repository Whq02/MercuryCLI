#!/usr/bin/env bun
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

setMockRateLimitScenario('weekly-limit-reached')
const headers = getMockHeaders()
check(
  '§A REPRODUCED: setMockRateLimitScenario is a no-op (store never arms)',
  headers === null,
  JSON.stringify(headers),
)

check('§B REPRODUCED: shouldProcessMockLimits() is false (gate dead)', shouldProcessMockLimits() === false)

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

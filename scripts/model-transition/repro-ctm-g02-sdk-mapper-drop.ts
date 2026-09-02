#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g02-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g02-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { createModelTransitionMessage, createCompactBoundaryMessage } = await import(
  '../../src/utils/messages/systemMessages.ts'
)
const { toSDKMessages } = await import('../../src/utils/messages/mappers.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const boundary = createCompactBoundaryMessage('auto', 1000)
const sdkBoundary = toSDKMessages([boundary as never])
check(
  '§A control: compact_boundary crosses the SDK mapper',
  sdkBoundary.length >= 1,
  `mapped=${sdkBoundary.length}`,
)

const transition = createModelTransitionMessage({
  previous: 'claude-opus-5',
  requested: 'gpt-5.2',
  applied: 'gpt-5.2',
  resolution: 'applied',
  boundary: 'turn-boundary',
  crossProvider: true,
  cacheDisposition: 'keyed-sections-recompute-once',
})
const sdkTransition = toSDKMessages([transition as never])
check(
  '§B REPRODUCED: model_transition maps to ZERO SDK messages',
  sdkTransition.length === 0,
  `mapped=${sdkTransition.length}`,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — G02 red recorded (the transition receipt never crosses the SDK mapper)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)

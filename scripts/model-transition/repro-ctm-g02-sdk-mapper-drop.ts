#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g02-sdk-mapper-drop.ts —
//  expect-red driver (bind defect D2: the transition receipt never crosses
//  the SDK boundary).
//
//  Mechanism under test: the transcript projects a settled model transition
//  as a system row (subtype 'model_transition', types/message.ts) minted by
//  createModelTransitionMessage from the settlement owner's receipt. The
//  SDK mappers (utils/messages/mappers.ts toSDKMessages) map system rows
//  through an explicit subtype switch that today carries ONLY
//  'compact_boundary' and 'local_command' — every other system row falls
//  through to []. UN-09's cross-surface claim was proven structurally;
//  through the mapper the receipt vanishes: resume sees the row, SDK/
//  headless consumers never do.
//
//    §A control: a compact_boundary system row crosses the mapper (the
//       harness itself works)
//    §B DEFECT: the model_transition row maps to ZERO SDK messages
//
//  Exit 0 = defect REPRODUCED.
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
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

// §A — control: the compact boundary row crosses the mapper.
const boundary = createCompactBoundaryMessage('auto', 1000)
const sdkBoundary = toSDKMessages([boundary as never])
check(
  '§A control: compact_boundary crosses the SDK mapper',
  sdkBoundary.length >= 1,
  `mapped=${sdkBoundary.length}`,
)

// §B — the settled transition receipt row: the durable projection of the
// settlement owner's receipt, exactly the row the
// transcript and resume path carry.
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

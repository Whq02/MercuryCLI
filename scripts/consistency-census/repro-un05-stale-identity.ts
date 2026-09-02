#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/repro-un05-stale-identity.ts — UN-05 expect-red
//  driver (D1: stale model-visible identity after a live switch).
//
//  Field symptom: a live model switch succeeds, but the model-visible
//  environment line still names the previous model. Mechanism under test:
//  systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(model, …))
//  closes over the composition-time `model`; the section cache is NAME-ONLY
//  until /clear//compact (bootstrap cache latches), and the REPL
//  pendingModelSwitch apply sets mainLoopModel without touching the section
//  cache — so the next turn's composition returns the previous model's bytes.
//  The `frc` section closes over the same mutable `model` (structurally the
//  same class; its compute returns null in this build).
//
//  This driver composes the REAL prompt twice through getSystemPrompt —
//  model A then model B, same process, no clear (the exact post-switch
//  composition shape) — and records whether the "You are powered by" line
//  follows the applied model:
//
//    §A compose with A — the env line names A
//    §B compose with B (post-switch shape) — DEFECT when the line still
//       names A (the name-only cache returned A's bytes)
//    §C clearSystemPromptSections() + recompose with B — names B, proving
//       the mechanism is the cache lifetime, not the compute
//
//  Exit 0 = defect REPRODUCED (the recorded red for UN-05's before-state).
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unison-un05-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'unison-un05-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'unison-un05-proj-'))
bootstrap.setOriginalCwd(projDir)
process.chdir(projDir)

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import(
  '../../src/constants/systemPromptSections.ts'
)

const MODEL_A = 'claude-opus-5'
const MODEL_B = 'claude-sonnet-5'

const lineOf = (blocks: string[]): string =>
  blocks.join('\n\n').match(/You are powered by[^\n]*/)?.[0] ?? '(no identity line)'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — first composition binds A
const lineA = lineOf(await getSystemPrompt([], MODEL_A))
check('§A env line names the composed model', lineA.includes(MODEL_A), lineA)

// §B — the post-switch composition shape: same process, cache intact, model B.
// The defect is REPRODUCED when the cached line still names A.
const lineB = lineOf(await getSystemPrompt([], MODEL_B))
const stale = lineB.includes(MODEL_A) && !lineB.includes(MODEL_B)
check('§B REPRODUCED: post-switch line still names the previous model', stale, lineB)

// §C — the cache lifetime is the mechanism: a cleared recompose follows B.
clearSystemPromptSections()
const lineC = lineOf(await getSystemPrompt([], MODEL_B))
check('§C cleared recompose follows the applied model', lineC.includes(MODEL_B), lineC)

console.log(
  failed === 0
    ? '\n REPRODUCED — UN-05 red recorded (stale cached identity after live switch)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)

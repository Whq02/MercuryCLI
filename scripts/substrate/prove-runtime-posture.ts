#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-runtime-posture.ts
//  PROOF: init-path self-knowledge (task #62 — MERCURY_RUNTIME_POSTURE).
//
//  The contract under proof: every process/spawn path composes a POSTURE at
//  model-wake — interactive vs headless deny semantics, kills armed at boot,
//  MCP risk cap, swarms, the never-Haiku floor — and it obeys the house gate
//  rules: default-ON, =0 ⇒ byte-identical absence; memoized per process
//  (prompt-cache byte-stability); honest "at boot" labeling with the live
//  surface (/substrate) named.
//
//  Seams proven here (all pure/in-process, no child spawns):
//   1. the builder (getRuntimePostureSection) — content per interactivity mode
//   2. the subagent-doctrine line (getRuntimePostureDoctrineLine) + its
//      composition into buildSubagentMercurySections (both chokepoints share it)
//   3. the prompts.ts wiring (structural: the dynamic section is registered)
//   4. the print-entry marker wiring (structural: runHeadless stamps
//      non-interactive with the resolved boot mode)
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-runtime-posture.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const saved = {
  posture: process.env.MERCURY_RUNTIME_POSTURE,
  kill: process.env.MERCURY_KILL,
  risk: process.env.MERCURY_MCP_MAX_RISK,
}
delete process.env.MERCURY_RUNTIME_POSTURE
delete process.env.MERCURY_KILL
delete process.env.MERCURY_MCP_MAX_RISK

const {
  getRuntimePostureSection,
  getRuntimePostureDoctrineLine,
  markSessionNonInteractive,
  resetRuntimePostureForTest,
  runtimePostureEnabled,
} = await import('../../src/utils/cockpit/runtimePosture.js')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('============================================================')
console.log(' runtime posture (init-path self-knowledge) — proof')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('gate — default-ON, =0 byte-identical absence')
{
  check('fork ⇒ enabled', runtimePostureEnabled() === true)
  process.env.MERCURY_RUNTIME_POSTURE = '0'
  resetRuntimePostureForTest()
  check('=0 ⇒ disabled', runtimePostureEnabled() === false)
  check('=0 ⇒ section null (absent from the prompt)', getRuntimePostureSection() === null)
  check('=0 ⇒ doctrine line null', getRuntimePostureDoctrineLine() === null)
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'general-purpose' } })
  check(
    '=0 ⇒ no posture text in the subagent doctrine',
    sections.every(s => !s.includes('Runtime posture:')),
  )
  delete process.env.MERCURY_RUNTIME_POSTURE
  resetRuntimePostureForTest()
}

// ───────────────────────────────────────────────────────────────────────────
section('interactive posture (the default)')
{
  const s = getRuntimePostureSection()
  check('section present when on', s !== null)
  const text = s ?? ''
  check('titled as a posture block', text.startsWith('# Runtime posture'))
  check('interactive semantics stated', /Session: interactive/.test(text))
  check('never claims headless deny in interactive', !/NON-INTERACTIVE/.test(text))
  check('kills labeled "at boot" + live surface named', /at boot/.test(text) && /\/substrate/.test(text))
  check('no kills armed ⇒ says none', /kills armed at boot: none/.test(text))
  check('MCP posture stated (permissive without a cap)', /MCP tool-risk policy: permissive/.test(text))
  check('model floor stated with the fallback tier', /claude-sonnet-5/.test(text))
  check('MEMOIZED — second call returns the identical string', getRuntimePostureSection() === s)
}

// ───────────────────────────────────────────────────────────────────────────
section('headless posture (the daemon-child / -p truth)')
{
  resetRuntimePostureForTest()
  markSessionNonInteractive('implement')
  const text = getRuntimePostureSection() ?? ''
  check('headless semantics stated', /NON-INTERACTIVE/.test(text))
  check('deny-is-policy instruction present', /DENIED automatically/.test(text) && /Do not retry/.test(text))
  check('boot permission mode surfaced', /Permission mode for this run: implement/.test(text))
  const line = getRuntimePostureDoctrineLine() ?? ''
  check('doctrine line carries HEADLESS deny semantics', /HEADLESS/.test(line))
  check('doctrine line carries lease semantics', /file-lease denial/.test(line))
}

// ───────────────────────────────────────────────────────────────────────────
section('boot-state capture — kills + MCP cap render when armed at boot')
{
  // MERCURY_KILL seeds the kill store at MODULE IMPORT (seedFromEnv — the one
  // sanctioned import-time side effect), so a post-import env set is invisible
  // by design. Arm via the runtime mutator (/kill's own path) instead — the
  // same store the posture reads at compose time.
  const { killCapability, restoreCapability } = await import(
    '../../src/utils/permissions/capabilityGate.js'
  )
  resetRuntimePostureForTest()
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  killCapability('*', 'WebFetch')
  const text = getRuntimePostureSection() ?? ''
  check('armed kill named', /kills armed at boot: .*WebFetch/.test(text))
  check('kill absoluteness stated (bypass cannot override)', /bypass, overrides a kill/.test(text) || /no mode, including bypass/.test(text))
  check('MCP cap reflected', /MCP tool-risk policy: (?!permissive)/.test(text))
  restoreCapability('*', 'WebFetch')
  delete process.env.MERCURY_MCP_MAX_RISK
  resetRuntimePostureForTest()
}

// ───────────────────────────────────────────────────────────────────────────
section('composition into the subagent doctrine (both chokepoints share the seam)')
{
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'general-purpose' } })
  check(
    'doctrine sections include the posture line',
    sections.some(s => s.startsWith('Runtime posture:')),
  )
  const exempt = buildSubagentMercurySections({ agentDefinition: { agentType: 'Explore' } })
  check(
    'fable-exempt agents still get the posture (it is scope-neutral)',
    exempt.some(s => s.startsWith('Runtime posture:')),
  )
}

// ───────────────────────────────────────────────────────────────────────────
section('wiring (structural) — prompts.ts section + print-entry marker')
{
  const prompts = src('src/constants/prompts.ts')
  check(
    "prompts.ts registers the 'runtime_posture' dynamic section",
    /systemPromptSection\('runtime_posture', \(\) => getRuntimePostureSection\(\)\)/.test(prompts),
  )
  const print = src('src/cli/print.ts')
  check(
    'runHeadless stamps non-interactive with the resolved boot mode',
    /markSessionNonInteractive\(getAppState\(\)\.toolPermissionContext\?\.mode\)/.test(print),
  )
}

// Restore operator env.
for (const [k, v] of [
  ['MERCURY_RUNTIME_POSTURE', saved.posture],
  ['MERCURY_KILL', saved.kill],
  ['MERCURY_MCP_MAX_RISK', saved.risk],
] as const) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — every init path states its runtime posture')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}

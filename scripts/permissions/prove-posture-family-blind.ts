#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-posture-family-blind.ts
// PROOF (trust-combo review): the two permission-POSTURE boot
//  rows — Skip-permissions-at-boot (MERCURY_SKIP_PERMISSIONS) and the
//  Autopilot tier (MERCURY_AUTOPILOT) — are FAMILY-BLIND. The posture a
//  session boots with, and the guarded mode entries it may take, answer
//  identically whatever provider family the session rides. (The permission-
//  mode semantics hold on every family — the QF/K rows' law.)
//
//  The law under proof:
//   §1 GATE MODULE CENSUS — autopilotGates.ts imports exactly {envUtils,
//      flagRegistry} and references no model seam: availability is an env
//      fact, never a family fact. (The tier-KEY vocabulary opus/sonnet/fable
//      is the separately RATIFIED Anthropic-tier rail — the boot row's own
//      copy says so; vocabulary is not posture and is not swept here.)
//   §2 BOOT ARMING IS ENV+ARGV ONLY — the main.tsx bypass decision couples
//      MERCURY_SKIP_PERMISSIONS to the print-mode check alone; no family
//      identifier appears in the arming expression.
//   §3 GUARDED ENTRIES ARE FAMILY-BLIND — setPermissionModeWithGuards
//      answers byte-identically across planted family envs (unset · gpt ·
//      glm · kimi) for every audited posture case: autopilot refused
//      without the opt-in; autopilot refused without bypass eligibility
//      (never a consent backdoor); autopilot granted with both; sovereign
//      refused without eligibility; sovereign granted with it.
//   §4 THE ONE MODEL READ IS THE FLOW GATE'S — permissionSetup.ts reads
//      getMainLoopModel exactly once, inside verifyAutoModeGateAccess (the
//      auto-mode/flow capability gate, a DESIGNED model-capability check).
//      The sovereign/autopilot arms provably never read model identity.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-posture-family-blind.ts
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE any src import (the ambient-state law): the
// settings/policy reads must see a virgin home, never the operator's.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'posture-blind-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')

const FAMILY_PLANTS: ReadonlyArray<[label: string, model: string | undefined]> = [
  ['no model env', undefined],
  ['openai (gpt-5.6-luna)', 'gpt-5.6-luna'],
  ['zai (glm-5.3)', 'glm-5.3'],
  ['moonshot (kimi-k3)', 'kimi-k3'],
]

function withModelEnv<T>(model: string | undefined, fn: () => T): T {
  const saved = process.env.ANTHROPIC_MODEL
  if (model === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = model
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = saved
  }
}

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' posture rows are family-blind — skip-permissions + autopilot')
  console.log('============================================================')

  section('§1 gate module census — autopilot availability is an env fact')
  {
    const gatesSrc = readFileSync(join(ROOT, 'src', 'utils', 'autopilot', 'autopilotGates.ts'), 'utf-8')
    const imports: string[] = []
    const re = /^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms
    let m: RegExpExecArray | null
    while ((m = re.exec(gatesSrc)) !== null) imports.push(m[1]!)
    const ADJUDICATED = new Set(['../envUtils.js', '../../substrate/flagRegistry.js'])
    const strays = imports.filter(spec => !ADJUDICATED.has(spec))
    check('autopilotGates.ts imports exactly {envUtils, flagRegistry}', strays.length === 0, strays.join(', '))
    const FORBIDDEN = [
      'getMainLoopModel',
      'getSmallFastModel',
      'resolveCallModelRoute',
  'classifyModelRoute',
  'declaredRouteOf',
      'providerFrontier',
      'callModelRouter',
      'queryModel',
      'sideQuery',
      'getAnthropicClient',
      'ANTHROPIC_MODEL',
    ]
    const hits = FORBIDDEN.filter(f => gatesSrc.includes(f))
    check('autopilotGates.ts references no model seam', hits.length === 0, hits.join(', '))
  }

  section('§2 boot arming is env+argv only — the main.tsx bypass expression')
  {
    const mainSrc = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf-8')
    const armIdx = mainSrc.indexOf("flagEnv('MERCURY_SKIP_PERMISSIONS')")
    check('the arming read exists', armIdx !== -1)
    const armLine = mainSrc.slice(mainSrc.lastIndexOf('\n', armIdx) + 1, mainSrc.indexOf('\n', armIdx))
    check(
      'the arming expression couples ONLY to the print-mode check',
      /isEnvTruthy\(flagEnv\('MERCURY_SKIP_PERMISSIONS'\)\)\s*&&\s*!isPrintModeArgv\(\)/.test(armLine),
      armLine.trim(),
    )
    check(
      'no family identifier in the arming expression',
      !/getMainLoopModel|resolveCallModelRoute|classifyModelRoute|declaredRouteOf|ANTHROPIC_MODEL|claude|gpt-|glm-/i.test(armLine),
    )
  }

  const { setPermissionModeWithGuards } = await import('../../src/utils/permissions/permissionSetup.js')

  type AnyContext = Record<string, unknown>
  const runEntry = (mode: string, context: AnyContext): string => {
    // A fresh minimal context per call; the updater is applied like the
    // carousel's — the verdict (ok/error) is the audited surface.
    const updateAppState = (updater: (c: never) => never) => {
      updater(context as never)
    }
    const result = setPermissionModeWithGuards(mode as never, context as never, updateAppState as never)
    return JSON.stringify(result)
  }

  section('§3 guarded entries — byte-identical verdicts across family plants')
  {
    delete process.env.MERCURY_AUTOPILOT
    const CASES: ReadonlyArray<[label: string, run: () => string, expectOk: boolean]> = [
      [
        'autopilot WITHOUT the opt-in ⇒ refused',
        () => runEntry('autopilot', { mode: 'implement', isBypassPermissionsModeAvailable: true }),
        false,
      ],
      [
        'autopilot WITH opt-in but NO bypass eligibility ⇒ refused (no consent backdoor)',
        () => {
          process.env.MERCURY_AUTOPILOT = '1'
          try {
            return runEntry('autopilot', { mode: 'implement', isBypassPermissionsModeAvailable: false })
          } finally {
            delete process.env.MERCURY_AUTOPILOT
          }
        },
        false,
      ],
      [
        'autopilot WITH opt-in AND eligibility ⇒ granted',
        () => {
          process.env.MERCURY_AUTOPILOT = '1'
          try {
            return runEntry('autopilot', { mode: 'implement', isBypassPermissionsModeAvailable: true })
          } finally {
            delete process.env.MERCURY_AUTOPILOT
          }
        },
        true,
      ],
      [
        'sovereign WITHOUT eligibility ⇒ refused',
        () => runEntry('sovereign', { mode: 'implement', isBypassPermissionsModeAvailable: false }),
        false,
      ],
      [
        'sovereign WITH eligibility ⇒ granted',
        () => runEntry('sovereign', { mode: 'implement', isBypassPermissionsModeAvailable: true }),
        true,
      ],
    ]
    for (const [label, run, expectOk] of CASES) {
      const verdicts: string[] = []
      for (const [, model] of FAMILY_PLANTS) {
        verdicts.push(withModelEnv(model, run))
      }
      const allIdentical = verdicts.every(v => v === verdicts[0])
      const okMatches = (JSON.parse(verdicts[0]!) as { ok: boolean }).ok === expectOk
      check(`${label} — one verdict across all four plants`, allIdentical, verdicts.join(' vs '))
      check(`${label} — the verdict is ${expectOk ? 'ok' : 'a refusal'}`, okMatches, verdicts[0])
    }
  }

  section('§4 the one model read is the flow gate’s — sovereign/autopilot arms never read identity')
  {
    const setupSrc = readFileSync(
      join(ROOT, 'src', 'utils', 'permissions', 'permissionSetup.ts'),
      'utf-8',
    )
    const calls = setupSrc.match(/getMainLoopModel\(\)/g) ?? []
    check('permissionSetup.ts calls getMainLoopModel exactly once', calls.length === 1, `${calls.length} call(s)`)
    const flowGateStart = setupSrc.indexOf('export async function verifyAutoModeGateAccess')
    const nextExport = setupSrc.indexOf('\nexport ', flowGateStart + 1)
    const flowGateBody = setupSrc.slice(flowGateStart, nextExport === -1 ? undefined : nextExport)
    check('that one call sits inside verifyAutoModeGateAccess (the flow/auto gate)', flowGateStart !== -1 && flowGateBody.includes('getMainLoopModel()'))
    const validateStart = setupSrc.indexOf('function validateModeEntry')
    const validateEnd = setupSrc.indexOf('\nexport ', validateStart + 1)
    const validateBody = setupSrc.slice(validateStart, validateEnd === -1 ? undefined : validateEnd)
    check(
      'validateModeEntry (sovereign/autopilot/flow arms) reads no model identity',
      validateStart !== -1 &&
        !/getMainLoopModel|getSmallFastModel|resolveCallModelRoute|classifyModelRoute|declaredRouteOf|ANTHROPIC_MODEL/.test(validateBody),
    )
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ POSTURE ROWS ARE FAMILY-BLIND')
}

void main()

#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const saved = process.env.MERCURY_MODEL
  if (model === undefined) delete process.env.MERCURY_MODEL
  else process.env.MERCURY_MODEL = model
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.MERCURY_MODEL
    else process.env.MERCURY_MODEL = saved
  }
}

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' the posture row is family-blind — skip-permissions')
  console.log('============================================================')

  section('§2 boot arming is env+argv only — the main.tsx bypass expression')
  {
    const mainSrc = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf-8')
    const armIdx = mainSrc.indexOf("flagEnv('MERCURY_SKIP_PERMISSIONS')")
    check('the arming read exists', armIdx !== -1)
    const armLine = mainSrc.slice(mainSrc.lastIndexOf('\n', armIdx) + 1, mainSrc.indexOf('\n', armIdx))
    check(
      'the arming expression couples ONLY to the print-mode check',
      /isEnvTruthy\(flagEnv\('MERCURY_SKIP_PERMISSIONS'\)\)\s*&&\s*!isRunArgv\(\)/.test(armLine),
      armLine.trim(),
    )
    check(
      'no family identifier in the arming expression',
      !/getMainLoopModel|resolveCallModelRoute|classifyModelRoute|declaredRouteOf|MERCURY_MODEL|claude|gpt-|glm-/i.test(armLine),
    )
  }

  const { setPermissionModeWithGuards } = await import('../../src/utils/permissions/permissionSetup.js')

  type AnyContext = Record<string, unknown>
  const runEntry = (mode: string, context: AnyContext): string => {
    const updateAppState = (updater: (c: never) => never) => {
      updater(context as never)
    }
    const result = setPermissionModeWithGuards(mode as never, context as never, updateAppState as never)
    return JSON.stringify(result)
  }

  section('§3 guarded entries — byte-identical verdicts across family plants')
  {
    const CASES: ReadonlyArray<[label: string, run: () => string, expectOk: boolean]> = [
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

  section('§4 the one model read is the flow gate’s — the sovereign arm never reads identity')
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
      'validateModeEntry (sovereign/flow arms) reads no model identity',
      validateStart !== -1 &&
        !/getMainLoopModel|getSmallFastModel|resolveCallModelRoute|classifyModelRoute|declaredRouteOf|MERCURY_MODEL/.test(validateBody),
    )
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ THE POSTURE ROW IS FAMILY-BLIND')
}

void main()

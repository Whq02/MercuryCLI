#!/usr/bin/env bun
// prove-permission-posture — the permission-posture record. When
// standing consent arms bypass (env row + settings-suppressed dialog), the
// boot decision writes ONE composition record into the project config — a
// fresh config read alone names the real posture (the field audit had to
// cross-reference the env emission, the settings suppression, and the
// never-shown trust dialog across three files).
//
//   §1 the record shapes: env-standing-consent · cli-flag · session-choice ·
//      suppressed vs shown · standard.
//   §2 the no-op law: identical posture re-records write nothing; a posture
//      CHANGE re-stamps.
//   §3 wiring: the boot decision records it; /doctor names the composition.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'permission-posture-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test' // config gate + the in-memory project store
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { recordPermissionPosture } = await import('../../src/utils/config/trust.ts')
const { getCurrentProjectConfig } = await import('../../src/utils/config/projectConfig.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const posture = () => getCurrentProjectConfig().permissionPosture

section('§1 RECORD SHAPES')
{
  recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: true, dialogSuppressed: true })
  const p1 = posture()
  check(
    'env standing consent + suppressed dialog ⇒ the audit composition, recorded',
    p1?.mode === 'bypass' &&
      p1.armedBy === 'env-standing-consent' &&
      p1.consentDialog === 'suppressed-by-standing-consent' &&
      typeof p1.trustDialogAccepted === 'boolean' &&
      p1.recordedAtMs > 0,
    JSON.stringify(p1),
  )

  recordPermissionPosture({ bypassArmed: true, envArmed: false, flagArmed: true, dialogSuppressed: false })
  const p2 = posture()
  check(
    'CLI flag + shown dialog classified distinctly',
    p2?.mode === 'bypass' && p2.armedBy === 'cli-flag' && p2.consentDialog === 'shown-accepted',
  )

  recordPermissionPosture({ bypassArmed: true, envArmed: false, flagArmed: false, dialogSuppressed: true })
  check('session permission mode classified distinctly', posture()?.armedBy === 'session-choice')

  recordPermissionPosture({ bypassArmed: false, envArmed: false, flagArmed: false, dialogSuppressed: false })
  const p4 = posture()
  check(
    'a standard boot RE-STAMPS a stale bypass record to standard (fresh reads = real posture)',
    p4?.mode === 'standard' && p4.consentDialog === 'not-required' && p4.armedBy === undefined,
  )
}

section('§2 THE NO-OP LAW')
{
  recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: true, dialogSuppressed: true })
  const stamped = posture()?.recordedAtMs
  await new Promise(resolve => setTimeout(resolve, 5))
  recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: true, dialogSuppressed: true })
  check(
    'identical posture re-record writes NOTHING (timestamp unchanged)',
    posture()?.recordedAtMs === stamped,
    `at=${posture()?.recordedAtMs} vs ${stamped}`,
  )
  recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: true, dialogSuppressed: false })
  check('a composition CHANGE re-stamps', posture()?.recordedAtMs !== stamped && posture()?.consentDialog === 'shown-accepted')
}

section('§3 WIRING')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')
  const helpers = src('src/interactiveHelpers.tsx')
  check(
    'the boot dialog decision records the posture (both branches — shown AND suppressed)',
    // The record runs unconditionally after the consent branch and carries
    // dialogSuppressed as a shorthand property.
    /recordPermissionPosture\(\{[\s\S]*?dialogSuppressed,[\s\S]*?\}\)/.test(helpers),
  )
  check(
    'the env arming is read from the REGISTERED row at the decision',
    helpers.includes("flagEnv('MERCURY_SKIP_PERMISSIONS')"),
  )
  const doctor = src('src/utils/healthReport.ts')
  check(
    '/doctor carries the permission-posture row naming the composition',
    doctor.includes("id: 'permission-posture'") &&
      doctor.includes('standing consent') &&
      doctor.includes('consent dialog suppressed by settings'),
  )
  check(
    'the missing-record-while-env-armed case self-detects (warn + remedy)',
    doctor.includes('NO posture record exists yet'),
  )
  check(
    'the record is declared in the project-config schema',
    src('src/utils/config/schema.ts').includes('permissionPosture?:'),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-permission-posture: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-permission-posture: all green')

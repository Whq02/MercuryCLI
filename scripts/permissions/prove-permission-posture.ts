#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'permission-posture-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { recordPermissionPosture } = await import('../../src/platform/config/trust.ts')
const { getCurrentProjectConfig } = await import('../../src/platform/config/projectConfig.ts')

let failures = 0
let whereToLook = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && whereToLook ? ` | to fix: ${whereToLook}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const posture = () => getCurrentProjectConfig().permissionPosture

section('§1 RECORD SHAPES')
{
  whereToLook = 'recordPermissionPosture in src/platform/config/trust.ts composes the record (mode, armedBy, consentDialog); the printed value is the stored posture'
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
  whereToLook = 'recordPermissionPosture in src/platform/config/trust.ts must skip the write when the composition is unchanged and re-stamp recordedAtMs when it changes'
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
  whereToLook = 'the permission-posture row of crewChecks in src/platform/health/sections/crew.ts builds the evidence and fix text; the printed value is what it returned'
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const { saveCurrentProjectConfig } = await import('../../src/platform/config/projectConfig.ts')
  const postureRow = crewChecks().find(row => row.id === 'permission-posture')
  recordPermissionPosture({ bypassArmed: true, envArmed: true, flagArmed: true, dialogSuppressed: true })
  const composed = await postureRow?.run()
  check(
    '/health carries the permission-posture row naming the composition',
    composed?.status === 'ok' && composed.evidence.includes('standing consent') && composed.evidence.includes('consent dialog suppressed by settings'),
    composed?.evidence,
  )
  saveCurrentProjectConfig(current => ({ ...current, permissionPosture: undefined }))
  const armedBefore = process.env.MERCURY_SKIP_PERMISSIONS
  process.env.MERCURY_SKIP_PERMISSIONS = '1'
  const unrecorded = await postureRow?.run()
  if (armedBefore === undefined) delete process.env.MERCURY_SKIP_PERMISSIONS
  else process.env.MERCURY_SKIP_PERMISSIONS = armedBefore
  check(
    'the missing-record-while-env-armed case self-detects (warn + remedy)',
    unrecorded?.status === 'warn' && unrecorded.evidence.includes('NO posture record exists yet') && unrecorded.fix?.startsWith('Open Mercury interactively once in this project') === true,
    JSON.stringify(unrecorded),
  )
}

section("§4 THE ROW'S SCOPE (RELEASE-29-WINDOWS R29W-02): the record is per project, and the row says so")
{
  whereToLook = 'the permission-posture row in src/platform/health/sections/crew.ts, run through node dist/mercury.mjs health --json (rebuild dist with bun run build.ts if the row is stale)'
  const { existsSync, mkdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const ROOT = join(import.meta.dir, '../..')
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const node = [process.env.MERCURY_NODE_BIN, join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')].find(p => p !== undefined && p !== '' && existsSync(p)) ?? 'node'
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist absent — run `bun run build.ts` for the health row')
  } else {
    const home = join(HOME, 'row-home')
    const project = join(HOME, 'a-project-never-opened-interactively')
    mkdirSync(home, { recursive: true })
    mkdirSync(project, { recursive: true })
    const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SKIP_PERMISSIONS: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
    delete env.NODE_ENV
    const r = spawnSync(node, [dist, 'health', '--json'], { cwd: project, encoding: 'utf8', env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    let row: { status?: string; evidence?: string; fix?: string } | undefined
    try {
      const report = JSON.parse(r.stdout) as { sections: Array<{ checks: Array<{ id: string; status: string; evidence: string; fix?: string }> }> }
      row = report.sections.flatMap(s => s.checks).find(c => c.id === 'permission-posture')
    } catch {
      row = undefined
    }
    check('health --json from a folder never opened interactively, with the env arming sovereign, carries the posture row', row !== undefined, `status=${String(r.status)} ${(r.stderr ?? '').slice(0, 300)}`)
    check('the row warns that no record exists FOR THIS PROJECT, naming where the record comes from', row?.status === 'warn' && (row.evidence ?? '').includes('NO posture record exists yet for this project') && (row.evidence ?? '').includes("interactive boot in the project's own folder"), row?.evidence)
    const { normalizePathForConfigKey } = await import('../../src/platform/files/path.ts')
    check("the remedy names this project's folder and says an interactive Mercury open elsewhere records that folder's (the box had one open)", (row?.fix ?? '').includes(`in this project (${normalizePathForConfigKey(project)}`) && (row?.fix ?? '').includes("another folder records that folder's"), row?.fix)
  }
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-permission-posture: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-permission-posture: all green')

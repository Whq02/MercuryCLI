#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'permission-posture-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
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
    /recordPermissionPosture\(\{[\s\S]*?dialogSuppressed,[\s\S]*?\}\)/.test(helpers),
  )
  check(
    'the env arming is read from the REGISTERED row at the decision',
    helpers.includes("flagEnv('MERCURY_SKIP_PERMISSIONS')"),
  )
  const health = src('src/utils/healthReport.ts')
  check(
    '/health carries the permission-posture row naming the composition',
    health.includes("id: 'permission-posture'") &&
      health.includes('standing consent') &&
      health.includes('consent dialog suppressed by settings'),
  )
  check(
    'the missing-record-while-env-armed case self-detects (warn + remedy)',
    health.includes('NO posture record exists yet'),
  )
  check(
    'the record is declared in the project-config schema',
    src('src/utils/config/schema.ts').includes('permissionPosture?:'),
  )
}

section("§4 THE ROW'S SCOPE (RELEASE-29-WINDOWS R29W-02): the record is per project, and the row says so")
{
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
    check("the remedy names this project's folder and says an interactive Mercury open elsewhere records that folder's (the box had one open)", (row?.fix ?? '').includes(`in this project (${project}`) && (row?.fix ?? '').includes("another folder records that folder's"), row?.fix)
  }
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-permission-posture: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-permission-posture: all green')

#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' mercury-only boot — zero Claude material, real dist')
console.log('============================================================')

if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'sov-boot-'))
try {
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(join(project, '.mercury', 'skills', 'proof-skill'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(project, 'MERCURY.md'), '# proof project guide\n\nProof-token: sovereign-NATIVE-GUIDE.\n')
  writeFileSync(
    join(project, '.mercury', 'skills', 'proof-skill', 'SKILL.md'),
    '---\nname: proof-skill\ndescription: sovereign boot proof skill\n---\n\nproof body\n',
  )
  const { MERCURY_CONFIG_DIR: _mc, MERCURY_HOME: _mh, ...cleanEnv } = process.env
  const env = {
    ...cleanEnv,
    HOME: home,
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    CI: '1',
    TERM: 'dumb',
  }

  const version = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [DIST, '--version'], { env, encoding: 'utf8', timeout: 120_000 }).trim()
  check('no-Claude boot: --version prints the Mercury banner', /^Mercury /.test(version), version)

  const doctorRun = spawnSync((process.execPath.includes('bun') ? 'node' : process.execPath), [DIST, 'doctor', '--json'], {
    env,
    cwd: project,
    encoding: 'utf8',
    timeout: 180_000,
  })
  const doctor = doctorRun.stdout ?? ''
  check('no-Claude boot: doctor --json runs to completion (exit 0|3 — 3 is the signed-out verdict fault)', (doctorRun.status === 0 || doctorRun.status === 3) && doctor.length > 0, `status ${doctorRun.status} signal ${doctorRun.signal}`)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(doctor)
  } catch {
  }
  check('doctor emits valid JSON on the Claude-free estate', parsed !== null)

  check(
    'the run created NO .claude anywhere in the scratch estate',
    !existsSync(join(project, '.claude')) && !existsSync(join(home, '.claude')),
  )
  const harnessSpelling = (name: string): boolean =>
    /^\.?(claude|hermes)([._-].*)?$/i.test(name) ||
    (/^\.?mercury([._-].*)?$/i.test(name) && name !== '.mercury' && name !== 'mercury-nodejs')
  const offenders = readdirSync(home).filter(harnessSpelling)
  for (const xdg of ['.config', '.cache', join('.local', 'share'), join('.local', 'state')]) {
    const dir = join(home, xdg)
    if (existsSync(dir)) offenders.push(...readdirSync(dir).filter(harnessSpelling).map(n => join(xdg, n)))
  }
  check('user-scope harness state landed in the native home only', offenders.length === 0, offenders.join(','))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} mercury-only-boot check(s) failed`)
  process.exit(1)
}
console.log('✅ MERCURY-ONLY BOOT — ZERO CLAUDE MATERIAL REQUIRED')

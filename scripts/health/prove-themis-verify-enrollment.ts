#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-themis-verify-enrollment.ts — `themis verify` never
//  certifies CLEAN over an empty check (FC-156). With the trust state
//  absent the sweep verifies nothing — and a tampered-then-WIPED state is
//  indistinguishable from a never-enrolled one by data — yet the verb said
//  CLEAN and exited 0 for both. Driven on the built artifact.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-themis-verify-enrollment.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'themis-verify-home-')))
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'themis-verify-proj-')))
  const run = (): { status: number | null; out: string } => {
    const r = spawnSync('node', [DIST, 'themis', 'verify'], {
      cwd: proj,
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_THEMIS: 'warn', NODE_ENV: undefined } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60000,
    })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  const unenrolled = run()
  check(
    'an un-enrolled sweep says NOTHING ENROLLED and names the wipe ambiguity — never CLEAN',
    unenrolled.out.includes('NOTHING ENROLLED') &&
      unenrolled.out.includes('never-enrolled project read identically') &&
      !unenrolled.out.includes('verify: CLEAN'),
    `rc=${unenrolled.status} ${unenrolled.out.slice(0, 140).replace(/\s+/g, ' ')}`,
  )
  rmSync(home, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-themis-verify-enrollment: all green' : `\nprove-themis-verify-enrollment: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

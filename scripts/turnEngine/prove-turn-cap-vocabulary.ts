#!/usr/bin/env bun
// ============================================================================
//  scripts/turnEngine/prove-turn-cap-vocabulary.ts — the --max-turns cap is a
//  POSITIVE INTEGER or absent (FC-078). The guard's truthiness test let 0
//  and NaN REMOVE the cap entirely and made a negative fire on the first
//  turn; the flag door admitted all three via a bare Number parse.
//
//  §1 the guard matrix (module).
//  §2 the door refuses junk loudly, live on the built artifact — a
//     preflight refusal, so no credential is needed.
//
//  Run: ~/.bun/bin/bun run scripts/turnEngine/prove-turn-cap-vocabulary.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('§1 the guard matrix')
{
  const { BudgetGuard } = await import('../../src/run-core/budget-guard.js')
  const guard = new BudgetGuard(undefined as never)
  check('a positive cap fires past the cap', guard.maxTurnsExceeded(3, 2) === true)
  check('… and not at or under it', guard.maxTurnsExceeded(2, 2) === false && guard.maxTurnsExceeded(1, 2) === false)
  check('absent ⇒ uncapped (unchanged)', guard.maxTurnsExceeded(999, undefined) === false)
  check('0 never fires AND never removes an assertion elsewhere (junk caps nothing)', guard.maxTurnsExceeded(999, 0) === false)
  check('NaN caps nothing', guard.maxTurnsExceeded(999, Number.NaN) === false)
  check('a NEGATIVE cap no longer fires on the first turn', guard.maxTurnsExceeded(1, -3) === false)
  check('a fractional cap caps nothing (integer vocabulary)', guard.maxTurnsExceeded(999, 2.5) === false)
}

console.log('§2 the door, live (preflight — credential-free)')
{
  const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'maxturns-home-')))
    const run = (value: string): { status: number | null; err: string } => {
      const result = spawnSync('node', [DIST, '-p', '--max-turns', value, 'hi'], {
        env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: undefined } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 60000,
      })
      return { status: result.status, err: `${result.stderr ?? ''}${result.stdout ?? ''}` }
    }
    for (const bad of ['0', 'abc', '-3', '2.5']) {
      const outcome = run(bad)
      check(
        `--max-turns ${bad} refuses loudly at the door`,
        outcome.status !== 0 && outcome.err.includes('positive integer'),
        `rc=${outcome.status} ${outcome.err.slice(0, 90).replace(/\s+/g, ' ')}`,
      )
    }
    const good = run('2')
    check(
      '--max-turns 2 passes the door (fails later on auth, never on the flag)',
      !good.err.includes('positive integer'),
      good.err.slice(0, 90).replace(/\s+/g, ' '),
    )
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nprove-turn-cap-vocabulary: all green' : `\nprove-turn-cap-vocabulary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

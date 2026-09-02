#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-error-stop-reason.ts — an endpoint-failure run
//  never claims a model stop reason (FC-129). Every -p run that ended in
//  an endpoint failure reported "stop_reason":"stop_sequence" in its
//  machine envelope — a real wire value meaning the model matched one of
//  the caller's stop sequences — because the synthetic error message
//  hardcodes a wire-shaped stop internally (settledness consumers need
//  non-null) and the result frame copied whatever the terminal message
//  carried. Error synthetics no longer feed the envelope: an
//  error-terminal run reports stop_reason null.
//
//  Driven on the BUILT artifact against a closed port, in both machine
//  formats, per the card's own repro.
//
//  Run: ~/.bun/bin/bun run scripts/headless/prove-error-stop-reason.ts
//  (build dist/mercury.mjs first)
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
  console.log('\nprove-error-stop-reason: 1 FAILURE(S)')
  process.exit(1)
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'stopreason-home-')))
const run = (args: string[]): { status: number | null; out: string } => {
  const result = spawnSync('node', [DIST, ...args], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      NODE_ENV: undefined,
      // The card's ground: a compat endpoint at a CLOSED port — the call
      // fails before any model stop reason can exist.
      MERCURY_COMPAT_BASE_URL: 'http://127.0.0.1:9',
      MERCURY_COMPAT_MODELS: 'w17-mock',
    } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 90000,
  })
  return { status: result.status, out: result.stdout ?? '' }
}

console.log('§1 --output-format json')
{
  const r = run(['-p', 'hi', '--model', 'compat/w17-mock', '--output-format', 'json'])
  let frame: Record<string, unknown> | null = null
  try {
    frame = JSON.parse(r.out) as Record<string, unknown>
  } catch {
    frame = null
  }
  check('the run fails with a parseable result envelope', r.status !== 0 && frame !== null, `status=${r.status}`)
  check(
    'the error envelope carries stop_reason null — never a fabricated stop_sequence',
    frame !== null && 'stop_reason' in frame && frame.stop_reason === null,
    JSON.stringify({ subtype: frame?.subtype, stop_reason: frame?.stop_reason }),
  )
}

console.log('\n§2 --output-format stream-json')
{
  const r = run(['-p', 'hi', '--model', 'compat/w17-mock', '--output-format', 'stream-json', '--verbose'])
  const frames = r.out
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((f): f is Record<string, unknown> => f !== null)
  const result = frames.find(f => f.type === 'result')
  check('a result frame arrives', result !== undefined, `${frames.length} frames`)
  check(
    'the stream result frame carries stop_reason null too',
    result !== undefined && 'stop_reason' in result && result.stop_reason === null,
    JSON.stringify({ subtype: result?.subtype, stop_reason: result?.stop_reason }),
  )
}

console.log(failures === 0 ? '\nprove-error-stop-reason: all green' : `\nprove-error-stop-reason: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

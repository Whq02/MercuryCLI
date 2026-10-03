#!/usr/bin/env bun
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
      MERCURY_COMPAT_BASE_URL: 'http://127.0.0.1:9',
      MERCURY_COMPAT_MODELS: 'w17-mock',
    } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 90000,
  })
  return { status: result.status, out: result.stdout ?? '' }
}

console.log('§1 --format json')
{
  const r = run(['run', 'hi', '--model', 'compat/w17-mock', '--format', 'json'])
  let frame: Record<string, unknown> | null = null
  try {
    frame = JSON.parse(r.out) as Record<string, unknown>
  } catch {
    frame = null
  }
  check('the run fails with a parseable result envelope', r.status !== 0 && frame !== null, `status=${r.status}`)
  check(
    'the failed outcome carries no stop word — never a fabricated stop_sequence',
    frame !== null && frame.type === 'outcome' && frame.status === 'failed' && !('stop' in frame),
    JSON.stringify({ status: frame?.status, stop: frame?.stop }),
  )
}

console.log('\n§2 --format rows')
{
  const r = run(['run', 'hi', '--model', 'compat/w17-mock', '--format', 'rows'])
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
  const result = frames.find(f => f.type === 'outcome')
  check('an outcome row arrives', result !== undefined, `${frames.length} frames`)
  check(
    'the stream outcome carries no stop word either',
    result !== undefined && result.status === 'failed' && !('stop' in result),
    JSON.stringify({ status: result?.status, stop: result?.stop }),
  )
}

console.log(failures === 0 ? '\nprove-error-stop-reason: all green' : `\nprove-error-stop-reason: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

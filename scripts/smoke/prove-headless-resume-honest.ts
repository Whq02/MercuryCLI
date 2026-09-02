#!/usr/bin/env bun
// prove-headless-resume-honest — three headless load/store defects on the
// built artifact (field cards FC-037 · FC-038 · FC-039).
//
// FC-037: an unwritable transcript store aborted the run with a RAW errno —
//   cause unnamed, the transcript never mentioned, the escape hatch never
//   offered. The store seam now names the failure and offers
//   --no-session-persistence.
// FC-038: --resume "" was falsy-skipped — a brand-new session started with
//   no error. Presence now refuses like any unparseable target.
// FC-039: a .jsonl/URL target that could not load was refused with a
//   freshly minted random UUID (different every run), never the path. The
//   refusal now names what the operator supplied, stably.
//
//   §1 FC-038: --resume "" refuses with the usage sentence.
//   §2 FC-039: a missing .jsonl refusal names the path, identically twice.
//   §3 FC-037: projects-as-a-file names the store and the escape hatch.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}

type Run = { rc: number; out: string; err: string }
const runMercury = (home: string, args: string[]): Promise<Run> =>
  new Promise(resolve => {
    const child = spawn('node', [DIST, ...args], {
      env: { ...process.env, MERCURY_CONFIG_DIR: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    child.on('close', rc => resolve({ rc: rc ?? -1, out, err }))
  })

section('§1 FC-038 — the empty resume target')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'resume-honest-a-')))
  const run = await runMercury(home, ['-p', '--resume', '', 'probe'])
  check('--resume "" REFUSES (nonzero exit)', run.rc !== 0, `rc=${run.rc}`)
  check(
    'with the usage sentence, not a fresh session',
    /--resume requires a valid session ID/.test(run.err + run.out),
    JSON.stringify((run.err + run.out).slice(0, 160)),
  )
  rmSync(home, { recursive: true, force: true })
}

section('§2 FC-039 — the missing .jsonl target')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'resume-honest-b-')))
  const target = '/no/such/place/missing-transcript.jsonl'
  const first = await runMercury(home, ['-p', '--resume', target, 'probe'])
  const second = await runMercury(home, ['-p', '--resume', target, 'probe'])
  const line = (r: Run): string => (r.err + r.out).split('\n').find(l => /No conversation/.test(l)) ?? ''
  check('the refusal NAMES the supplied path', line(first).includes(target), JSON.stringify(line(first)))
  check('and is IDENTICAL across runs (no minted UUID)', line(first) === line(second) && line(first) !== '', JSON.stringify(line(second)))
  rmSync(home, { recursive: true, force: true })
}

section('§3 FC-037 — the unwritable store')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'resume-honest-c-')))
  writeFileSync(join(home, 'projects'), 'a file wearing the store directory name')
  const run = await runMercury(home, ['-p', 'probe'])
  const all = run.err + run.out
  check('the failure NAMES the transcript store', /transcript store is unwritable/.test(all), JSON.stringify(all.slice(0, 220)))
  check('and offers the escape hatch', /--no-session-persistence/.test(all))
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-headless-resume-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-headless-resume-honest: all green')

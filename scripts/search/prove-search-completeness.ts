#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-search-completeness-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const rg = (await import('../../src/platform/shell/ripgrep.ts')) as Record<string, unknown>
const ripGrepAnswer = rg.ripGrepAnswer as
  | ((args: string[], target: string, signal: AbortSignal, opts?: { timeoutMs?: number }) => Promise<{ lines: string[]; complete: boolean; reason?: string }>)
  | undefined
const ripGrep = rg.ripGrep as (args: string[], target: string, signal: AbortSignal) => Promise<string[]>

console.log('============================================================')
console.log(' the search answer carries its own completeness')
console.log('============================================================')

async function driveShim(
  label: string,
  script: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ answer?: { lines: string[]; complete: boolean; reason?: string }; threw?: { name: string; message: string }; missing?: boolean; raw: string }> {
  const shim = mkdtempSync(join(tmpdir(), `prove-search-${label}-`))
  const fake = join(shim, 'rg')
  writeFileSync(fake, script)
  chmodSync(fake, 0o755)
  const driver = join(shim, 'drive.ts')
  writeFileSync(
    driver,
    `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const rg = await import(${JSON.stringify(join(ROOT, 'src/platform/shell/ripgrep.ts'))})
const door = (rg as Record<string, unknown>).ripGrepAnswer as undefined | ((a: string[], t: string, s: AbortSignal, o?: { timeoutMs?: number }) => Promise<{ lines: string[]; complete: boolean; reason?: string }>)
if (typeof door !== 'function') {
  console.log(JSON.stringify({ missing: true }))
  process.exit(0)
}
try {
  const answer = await door(['--files'], ${JSON.stringify(shim)}, new AbortController().signal, ${JSON.stringify(opts)})
  console.log(JSON.stringify({ answer }))
} catch (e) {
  console.log(JSON.stringify({ threw: { name: (e as Error).name, message: (e as Error).message } }))
}
`,
  )
  const { spawnSync } = await import('node:child_process')
  const run = spawnSync(process.execPath, ['run', driver], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${shim}:${process.env.PATH ?? ''}`,
      MERCURY_BUILTIN_RIPGREP: '0',
      MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR ?? '',
    },
  })
  const raw = (run.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
  rmSync(shim, { recursive: true, force: true })
  try {
    return { ...(JSON.parse(raw) as Record<string, never>), raw }
  } catch {
    return { raw: `${raw} | stderr ${(run.stderr ?? '').slice(0, 200)}` }
  }
}

section('§1 LIVE — a walk cut off mid-flight says so, and keeps what it found')
{
  check('the completeness-bearing door exists', typeof ripGrepAnswer === 'function', 'export ripGrepAnswer from src/platform/shell/ripgrep.ts')
  if (process.platform === 'win32') {
    console.log('  [SKIP] not read on Windows: ripgrep stand-in shim requires a POSIX executable script (§1–§2)')
  } else {
    const out = await driveShim('slow', '#!/bin/sh\necho "a.ts"\necho "b.ts"\necho "c.ts"\nsleep 30\n', { timeoutMs: 900 })
    const answer = out.answer
    check('the cut walk produced an answer rather than a throw (lines were salvaged)', answer !== undefined, `${out.raw.slice(0, 200)} | ripGrepAnswer in src/platform/shell/ripgrep.ts must salvage the lines read so far on a timeout instead of throwing`)
    check('a walk that could not finish is reported INCOMPLETE (never a clean short answer)', answer?.complete === false, `${JSON.stringify(answer)} | ripGrepAnswer in src/platform/shell/ripgrep.ts must set complete false when the walk times out`)
    check('the partial lines are KEPT', (answer?.lines.length ?? 0) >= 2, `${JSON.stringify(answer?.lines)} | ripGrepAnswer in src/platform/shell/ripgrep.ts must keep the lines read before the timeout`)
    check("the reason names the timeout in the operator's words", /timed out/i.test(answer?.reason ?? ''), `${answer?.reason ?? '(none)'} | the timeout reason built in ripGrepAnswer (src/platform/shell/ripgrep.ts) must say the search timed out`)
    check('…and says the walk did not finish, so the answer is partial', /partial|did not finish/i.test(answer?.reason ?? ''), `${answer?.reason ?? ''} | the timeout reason built in ripGrepAnswer (src/platform/shell/ripgrep.ts) must say the answer is partial`)
    check('…and counts what it kept', /line\(s\) kept/.test(answer?.reason ?? ''), `${answer?.reason ?? ''} | the timeout reason built in ripGrepAnswer (src/platform/shell/ripgrep.ts) must count the kept lines as N line(s) kept`)
  }
}

section('§2 LIVE — a binary that exits 101 with stderr is a NAMED refusal')
if (process.platform !== 'win32') {
  const out = await driveShim('panic', '#!/bin/sh\necho "rg: thread panicked at src/boot/main.rs:42" >&2\nexit 101\n')
  check('the exit-101 run produced a verdict', out.answer !== undefined || out.threw !== undefined, `${out.raw.slice(0, 200)} | the fake rg stand-in did not give a verdict; run ripGrepAnswer in src/platform/shell/ripgrep.ts against it by hand`)
  const reason = out.answer?.reason ?? out.threw?.message ?? ''
  check('a panicking search is NOT reported complete', out.answer === undefined || out.answer.complete === false, `${JSON.stringify(out.answer)} | ripGrepAnswer in src/platform/shell/ripgrep.ts must not report complete when the engine exits 101`)
  check('the reason carries the exit code', /101/.test(reason), `${reason || '(none)'} | the engine-failed reason in ripGrepAnswer (src/platform/shell/ripgrep.ts) must include the exit code`)
  check('…and the stderr tail that explains it', /panicked/.test(reason), `${reason || '(none)'} | the engine-failed reason in ripGrepAnswer (src/platform/shell/ripgrep.ts) must include the first stderr lines`)
  check('…and says plainly that the answer is incomplete', /INCOMPLETE/i.test(reason), `${reason || '(none)'} | the engine-failed reason in ripGrepAnswer (src/platform/shell/ripgrep.ts) must say the answer is INCOMPLETE`)
}


section('§5 the complete case is byte-identical')
{
  const fixture = mkdtempSync(join(tmpdir(), 'prove-search-complete-'))
  mkdirSync(join(fixture, 'sub'))
  writeFileSync(join(fixture, 'a.ts'), 'const needle = 1\n')
  writeFileSync(join(fixture, 'sub', 'b.ts'), 'const other = 2\n')
  const lines = await ripGrep(['--files'], fixture, new AbortController().signal)
  check('a finished walk still returns its lines through the plain door', lines.length === 2, `${JSON.stringify(lines)} | ripGrep in src/platform/shell/ripgrep.ts must return every line of a finished walk`)
  if (ripGrepAnswer) {
    const answer = await ripGrepAnswer(['--files'], fixture, new AbortController().signal)
    check('…and the detailed door calls it complete with no reason', answer.complete && answer.reason === undefined && answer.lines.length === 2, `${JSON.stringify(answer)} | ripGrepAnswer in src/platform/shell/ripgrep.ts must return complete true with no reason for a finished walk`)
  }
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-search-completeness${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/search/prove-search-completeness.ts — a search that did not
//  finish never reads as one that found nothing (FN-015 rank 10).
//
//  Two entrances reached the same silent `return salvaged`. A walk that
//  exceeded its budget AFTER emitting at least one line fell past the
//  timeout throw (raised only when nothing was salvaged) — routine on a
//  7200rpm disk with a cold cache and on-access scanning. And any
//  spawn/exit failure outside the named errno set — a ripgrep panic exiting
//  101, a vendored rg.exe present but not a runnable image, descriptor
//  exhaustion — reached the same line with an EMPTY array. Grep rendered
//  those as "Found N files" or "No matches found" with no marker, Glob
//  computed `truncated` purely from the caller's limit, and the model
//  edited on a systematically short answer: a symbol is unused, a file does
//  not exist, a refactor is complete.
//
//   §1 LIVE: a real walk cut off by a real deadline mid-flight — the answer
//      carries its partial lines AND says it is incomplete
//   §2 LIVE: an unclassified failure (a binary that exits 101 with stderr)
//      is a NAMED refusal carrying the code and the stderr tail
//   §3 the back-compat door can never hand back a silent short answer
//   §4 the tools propagate incompleteness to the model (Grep · Glob ·
//      the coordinator's grep · the config-estate discovery)
//   §5 a complete search is untouched
//
//  Run:  ~/.bun/bin/bun run scripts/search/prove-search-completeness.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const rg = (await import('../../src/utils/ripgrep.ts')) as Record<string, unknown>
const ripGrepAnswer = rg.ripGrepAnswer as
  | ((args: string[], target: string, signal: AbortSignal, opts?: { timeoutMs?: number }) => Promise<{ lines: string[]; complete: boolean; reason?: string }>)
  | undefined
const ripGrep = rg.ripGrep as (args: string[], target: string, signal: AbortSignal) => Promise<string[]>

console.log('============================================================')
console.log(' the search answer carries its own completeness')
console.log('============================================================')

// A search driven in a CHILD process against a shim binary: the engine
// resolution is memoised per process, so each shape gets its own run. The
// child prints one JSON line — the answer, or the error it threw.
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
const rg = await import(${JSON.stringify(join(ROOT, 'src/utils/ripgrep.ts'))})
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
      USE_BUILTIN_RIPGREP: '0',
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

// ── §1 a deadline cuts a walk that has already emitted lines ────────────────
section('§1 LIVE — a walk cut off mid-flight says so, and keeps what it found')
{
  check('the completeness-bearing door exists', typeof ripGrepAnswer === 'function')
  // The engine emits three paths, flushes, and then never finishes — the
  // exact shape that fell through the old silent `return salvaged`: lines
  // already out, the walk unfinished.
  const out = await driveShim('slow', '#!/bin/sh\necho "a.ts"\necho "b.ts"\necho "c.ts"\nsleep 30\n', { timeoutMs: 900 })
  const answer = out.answer
  check('the cut walk produced an answer rather than a throw (lines were salvaged)', answer !== undefined, out.raw.slice(0, 200))
  check('a walk that could not finish is reported INCOMPLETE (never a clean short answer)', answer?.complete === false, JSON.stringify(answer))
  check('the partial lines are KEPT', (answer?.lines.length ?? 0) >= 2, JSON.stringify(answer?.lines))
  check("the reason names the timeout in the operator's words", /timed out/i.test(answer?.reason ?? ''), answer?.reason ?? '(none)')
  check('…and says the walk did not finish, so the answer is partial', /partial|did not finish/i.test(answer?.reason ?? ''), answer?.reason ?? '')
  check('…and counts what it kept', /line\(s\) kept/.test(answer?.reason ?? ''), answer?.reason ?? '')
}

// ── §2 an unclassified failure is a named refusal ───────────────────────────
section('§2 LIVE — a binary that exits 101 with stderr is a NAMED refusal')
{
  const out = await driveShim('panic', '#!/bin/sh\necho "rg: thread panicked at src/main.rs:42" >&2\nexit 101\n')
  check('the exit-101 run produced a verdict', out.answer !== undefined || out.threw !== undefined, out.raw.slice(0, 200))
  const reason = out.answer?.reason ?? out.threw?.message ?? ''
  check('a panicking search is NOT reported complete', out.answer === undefined || out.answer.complete === false, JSON.stringify(out.answer))
  check('the reason carries the exit code', /101/.test(reason), reason || '(none)')
  check('…and the stderr tail that explains it', /panicked/.test(reason), reason || '(none)')
  check('…and says plainly that the answer is incomplete', /INCOMPLETE/i.test(reason), reason || '(none)')
}

// ── §3 the back-compat door refuses to hand back a short answer ─────────────
section('§3 the plain door never returns a silently short answer')
{
  const src = readFileSync(join(ROOT, 'src/utils/ripgrep.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function ripGrep('), src.indexOf('// ---', src.indexOf('export async function ripGrep(')))
  check('ripGrep throws when the answer is incomplete rather than returning it', /if \(!answer\.complete\)/.test(fn) && /throw/.test(fn), fn.slice(0, 200))
  // The needle is CODE-shaped: the module's own history comment names the
  // retired line, and a prose mention must not red the pin.
  check('no bare `return salvaged` statement remains (the silent short answer)', !/^\s*return salvaged$/m.test(src))
  check('every incomplete road ends in an answer that says so', /return \{ lines: salvaged, complete: false, reason \}/.test(src))
}

// ── §4 the tools carry it to the model ──────────────────────────────────────
section('§4 every caller propagates incompleteness')
{
  const grep = readFileSync(join(ROOT, 'src/tools/GrepTool/GrepTool.ts'), 'utf8')
  check('Grep asks for the completeness-bearing answer', /ripGrepAnswer\(/.test(grep))
  check('Grep carries the reason on its output', /incomplete/.test(grep))
  check("Grep's rendered result shows the marker beside the count", /data\.incomplete/.test(grep))
  const globUtil = readFileSync(join(ROOT, 'src/utils/glob.ts'), 'utf8')
  check('glob() asks for the completeness-bearing answer', /ripGrepAnswer\(/.test(globUtil))
  check('glob() returns the reason to its caller', /incomplete/.test(globUtil))
  const globTool = readFileSync(join(ROOT, 'src/tools/GlobTool/GlobTool.ts'), 'utf8')
  check('Glob renders the marker (never a bare file list)', /incomplete/.test(globTool))
  const coordinator = readFileSync(join(ROOT, 'src/services/concourse/coordinatorTools.ts'), 'utf8')
  check("the coordinator's grep carries it too", /ripGrepAnswer\(|incomplete/.test(coordinator))
  const loader = readFileSync(join(ROOT, 'src/utils/markdownConfigLoader.ts'), 'utf8')
  check('the config-estate discovery treats an incomplete walk as no answer at all (it walks natively instead)', /complete === false|!\w+\.complete/.test(loader), 'a partial agent/skill/command estate would read as the whole estate')
}

// ── §5 a complete search is untouched ───────────────────────────────────────
section('§5 the complete case is byte-identical')
{
  const fixture = mkdtempSync(join(tmpdir(), 'prove-search-complete-'))
  mkdirSync(join(fixture, 'sub'))
  writeFileSync(join(fixture, 'a.ts'), 'const needle = 1\n')
  writeFileSync(join(fixture, 'sub', 'b.ts'), 'const other = 2\n')
  const lines = await ripGrep(['--files'], fixture, new AbortController().signal)
  check('a finished walk still returns its lines through the plain door', lines.length === 2, JSON.stringify(lines))
  if (ripGrepAnswer) {
    const answer = await ripGrepAnswer(['--files'], fixture, new AbortController().signal)
    check('…and the detailed door calls it complete with no reason', answer.complete && answer.reason === undefined && answer.lines.length === 2, JSON.stringify(answer))
  }
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-search-completeness${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)

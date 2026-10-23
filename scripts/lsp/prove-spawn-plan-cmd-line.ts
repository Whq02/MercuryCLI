#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const source = (relative: string): string => {
  try {
    return readFileSync(join(ROOT, relative), 'utf8')
  } catch {
    return ''
  }
}

console.log('============================================================')
console.log(" spawn plan — a .cmd/.bat remedy rides the batch composer's cmd.exe line")
console.log('============================================================')

type Planner = typeof import('../../src/utils/spawnPlan.ts')
type Composer = typeof import('../../src/utils/shell/windowsBatchLine.ts')
const planner = (await import('../../src/utils/spawnPlan.ts').catch(() => null)) as Planner | null
const composer = (await import('../../src/utils/shell/windowsBatchLine.ts').catch(() => null)) as Composer | null

const SWITCHES = ['/d', '/s', '/v:off', '/c']

section("§1 one composer, two roads: the planner and the Bash tool's batch road share the quoting rules and the cmd.exe switches")
{
  const line = source('src/utils/shell/windowsBatchLine.ts')
  const plan = source('src/utils/spawnPlan.ts')
  const batch = source('src/utils/shell/windowsBatchInvocation.ts')
  check('src/utils/shell/windowsBatchLine.ts exports the composer', composer !== null && typeof composer.windowsBatchTail === 'function' && /export function windowsBatchTail\(/.test(line), composer === null ? 'module absent' : 'no export in the source')
  check('spawnPlan.ts imports the composer from the shared module and keeps no quoting rules of its own', /import \{ windowsBatchTail \} from '\.\/shell\/windowsBatchLine\.js'/.test(plan) && !/quoteForCmd|CMD_NEEDS_QUOTES/.test(plan))
  check('windowsBatchInvocation.ts takes the composer from the same module and defines none of its own', /import \{ windowsBatchTail \} from '\.\/windowsBatchLine\.js'/.test(batch) && !/function windowsBatchTail|TRAILING_BACKSLASHES|PERCENT_RUN/.test(batch))
  check('…and still exports it under its own name (the batch proof imports it there)', /export \{ windowsBatchTail \}/.test(batch))
  const switchesText = SWITCHES.map(s => `'${s}'`).join(', ')
  check('the planner spawns cmd.exe with the batch road\'s switches: /d /s /v:off /c', plan.includes(`[${switchesText}, `), 'no such argv in spawnPlan.ts')
  check('the batch road spawns cmd.exe with the same switches', batch.includes(`[${switchesText}, invocation.commandLine]`), 'no such argv in windowsBatchInvocation.ts')
  if (composer !== null) {
    const tail = composer.windowsBatchTail
    check('the shared composer: a trailing backslash run is doubled inside the quotes', tail(['p', 'C:\\dir\\']) === '""p" "C:\\dir\\\\""', JSON.stringify(tail(['p', 'C:\\dir\\'])))
    check('the shared composer: a bang and a caret are literal inside quotes', tail(['p', 'x!y', 'a^b']) === '""p" "x!y" "a^b""', JSON.stringify(tail(['p', 'x!y', 'a^b'])))
    check('the shared composer: a percent run rides bare as %^NAME%', tail(['p', '%FOO%']) === '""p" %^FOO%"', JSON.stringify(tail(['p', '%FOO%'])))
    check('the shared composer: a double quote is refused', tail(['p', 'he said "hi"']) === null)
  }
}

const CRLF = '\r\n'
const writeBatch = (path: string, lines: string[]): void => writeFileSync(path, lines.join(CRLF))
const WINBIN = mkdtempSync(join(tmpdir(), 'spawn-plan-bin-'))
const WINBIN_SPACED = mkdtempSync(join(tmpdir(), 'spawn plan spaced-'))
writeBatch(join(WINBIN, 'tool.cmd'), ['@echo off', 'exit /b 0'])
writeBatch(join(WINBIN, 'legacy.bat'), ['@echo off', 'exit /b 0'])
writeFileSync(join(WINBIN, 'native.exe'), Buffer.alloc(0))
writeBatch(join(WINBIN_SPACED, 'spaced.cmd'), ['@echo off', 'exit /b 0'])
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
const win32 = { platform: 'win32', path: WINBIN, comSpec: COMSPEC }
const TOOL = join(WINBIN, 'tool.cmd')
const planOf = (argv: string[], world: { platform: string; path: string; comSpec?: string } = win32) => (planner === null ? null : planner.spawnPlanOf(argv, world))

section("§2 the planner's cmd.exe line, word by word (the composition the Windows box proved on the batch road)")
{
  const rides = (label: string, argv: string[], inner: string, world = win32): void => {
    const got = planOf(argv, world)
    const want = [...SWITCHES, `"${inner}"`]
    const ok = got !== null && 'file' in got && got.file === world.comSpec && JSON.stringify(got.args) === JSON.stringify(want) && got.windowsVerbatimArguments === true
    check(label, ok, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`)
  }
  rides('a plain word is quoted, the whole line wrapped once, the switches carry /v:off', ['tool', '--version'], `"${TOOL}" "--version"`)
  rides('a trailing backslash run is doubled inside the quotes: C:\\dir\\ arrives whole and the closing quote survives', ['tool', 'C:\\dir\\'], `"${TOOL}" "C:\\dir\\\\"`)
  rides('a path with a space and a trailing backslash', ['tool', 'C:\\my dir\\'], `"${TOOL}" "C:\\my dir\\\\"`)
  rides('a longer trailing run is doubled whole', ['tool', 'C:\\dir\\\\'], `"${TOOL}" "C:\\dir\\\\\\\\"`)
  rides('a mid-word backslash is untouched', ['tool', 'a\\b\\c'], `"${TOOL}" "a\\b\\c"`)
  rides('a bang is literal inside quotes (delayed expansion is off)', ['tool', 'x!y!z'], `"${TOOL}" "x!y!z"`)
  rides('a caret is literal inside quotes (never doubled)', ['tool', 'a^b'], `"${TOOL}" "a^b"`)
  rides('a percent run rides bare with a caret after the opening percent', ['tool', '%FOO%'], `"${TOOL}" %^FOO%`)
  rides('a prefixed percent run keeps its quoted head', ['tool', '--flag=%FOO%'], `"${TOOL}" "--flag="%^FOO%`)
  rides('a lone percent stays quoted', ['tool', '50%off'], `"${TOOL}" "50%off"`)
  rides('an empty word stays a quoted empty argument', ['tool', ''], `"${TOOL}" ""`)
  rides("cmd.exe's own operators are literal inside quotes", ['tool', 'a&b|c<d>e(f)'], `"${TOOL}" "a&b|c<d>e(f)"`)
  rides('spaces and non-ASCII stay byte-honest', ['tool', 'pl ain', 'ünï ✓'], `"${TOOL}" "pl ain" "ünï ✓"`)
  rides('the npm remedy shape: every word in its own quotes', ['tool', 'i', '-g', '@vue/language-server'], `"${TOOL}" "i" "-g" "@vue/language-server"`)
  rides('a .bat rides the same line', ['legacy', 'x'], `"${join(WINBIN, 'legacy.bat')}" "x"`)
  rides('a batch under a directory with spaces is quoted like any word', ['spaced', 'x'], `"${join(WINBIN_SPACED, 'spaced.cmd')}" "x"`, { ...win32, path: WINBIN_SPACED })

  const refused = (word: string, why: string): void => {
    const got = planOf(['tool', word])
    const ok = got !== null && 'refused' in got && got.missing === undefined && got.refused.includes(JSON.stringify(word)) && got.refused.includes('cmd.exe would rewrite')
    check(`${why} (${JSON.stringify(word)}) refuses the batch road, nothing spawned`, ok, JSON.stringify(got))
  }
  refused('say "hi"', 'a double quote')
  refused('two\nlines', 'a line feed')
  refused('cr\rline', 'a carriage return')
  refused('nul\0byte', 'a NUL')
  refused('a%FOO%b%CD%c', 'two percent runs in one word')
  refused('%%', 'a word that is only percents')
  refused('a%FOO%b%', 'a percent run plus a stray percent')
  const noTool = planOf(['', 'x'])
  check('an empty program word is refused', noTool !== null && 'refused' in noTool, JSON.stringify(noTool))
  const absent = planOf(['absent', 'x'])
  check('a tool with no spawnable spelling is reported missing', absent !== null && 'refused' in absent && absent.missing === 'absent', JSON.stringify(absent))
}

section('§3 every other road is untouched: a native .exe and every non-Windows host spawn the argv as it stands')
{
  const native = planOf(['native', 'C:\\dir\\', 'x!y', 'say "hi"'])
  check('a .exe on win32 is spawned by its resolved path with its own argv, nothing quoted, nothing refused', native !== null && 'file' in native && native.file === join(WINBIN, 'native.exe') && JSON.stringify(native.args) === JSON.stringify(['C:\\dir\\', 'x!y', 'say "hi"']) && native.windowsVerbatimArguments === false, JSON.stringify(native))
  const POSIXBIN = mkdtempSync(join(tmpdir(), 'spawn-plan-posix-'))
  writeFileSync(join(POSIXBIN, 'tool'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(POSIXBIN, 'tool'), 0o755)
  for (const platform of ['darwin', 'linux']) {
    const posix = planOf(['tool', 'C:\\dir\\', 'x!y', 'say "hi"', '%FOO%'], { platform, path: POSIXBIN })
    check(`on ${platform} the argv passes verbatim: no cmd.exe, no quoting, no refusal`, posix !== null && 'file' in posix && posix.file === join(POSIXBIN, 'tool') && JSON.stringify(posix.args) === JSON.stringify(['C:\\dir\\', 'x!y', 'say "hi"', '%FOO%']) && posix.windowsVerbatimArguments === false, JSON.stringify(posix))
  }
  const notASpelling = planOf(['tool', 'x'], { platform: 'linux', path: WINBIN })
  check('off win32 a .cmd is not a spelling: the same directory answers not-on-PATH', notASpelling !== null && 'refused' in notASpelling && notASpelling.missing === 'tool', JSON.stringify(notASpelling))
}

section('§4 the live seam: cmd.exe hands the batch every byte (the Windows box reads this leg)')
if (process.platform !== 'win32') {
  console.log('  [SKIP] the live leg runs .cmd files through cmd.exe; this host has no cmd.exe (the Windows box runs it live)')
} else {
  const LIVE_BIN = mkdtempSync(join(tmpdir(), 'spawn plan live-'))
  const dumpPath = join(LIVE_BIN, 'argv.json')
  writeFileSync(join(LIVE_BIN, 'dump.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.argv))\n`)
  writeBatch(join(LIVE_BIN, 'echoargs.cmd'), ['@echo off', 'node "%~dp0dump.mjs" %*', 'exit /b %errorlevel%'])
  writeBatch(join(LIVE_BIN, 'code42.cmd'), ['@echo off', 'exit /b 42'])
  const live = { platform: 'win32', path: LIVE_BIN, comSpec: process.env.ComSpec ?? 'cmd.exe' }
  const env = { ...process.env, SPAWNPLANVAR: 'SHOULD-NOT-EXPAND' }
  const readDump = (): string[] => {
    try {
      return JSON.parse(readFileSync(dumpPath, 'utf8')).slice(2)
    } catch {
      return ['(no dump)']
    }
  }
  const run = (argv: string[]) => {
    const plan = planOf(argv, live)
    if (plan === null || !('file' in plan)) return { plan, status: null as number | null, stderr: '' }
    const r = spawnSync(plan.file, plan.args, { env, windowsVerbatimArguments: plan.windowsVerbatimArguments, windowsHide: true, encoding: 'utf8', timeout: 20_000 })
    return { plan, status: r.status, stderr: String(r.stderr ?? '') }
  }
  const expectArgv = (label: string, args: string[]): void => {
    writeFileSync(dumpPath, 'stale')
    const r = run(['echoargs', ...args])
    const got = readDump()
    check(label, r.status === 0 && JSON.stringify(got) === JSON.stringify(args), `plan ${JSON.stringify(r.plan)} status ${r.status} argv ${JSON.stringify(got).slice(0, 200)}${r.stderr ? ` err ${JSON.stringify(r.stderr.slice(0, 120))}` : ''}`)
  }
  expectArgv('a trailing backslash arrives whole and the closing quote is not eaten', ['C:\\dir\\', 'next'])
  expectArgv('a path with a space and a trailing backslash', ['C:\\my dir\\', 'next'])
  expectArgv('a bang survives (delayed expansion off)', ['x!y!', 'next'])
  expectArgv('a caret survives inside quotes', ['a^b'])
  expectArgv('a percent run is not expanded', ['%SPAWNPLANVAR%', '--flag=%SPAWNPLANVAR%'])
  expectArgv('a lone percent survives', ['50%off'])
  expectArgv("cmd.exe's operators survive inside quotes", ['a&b|c<d>e(f)'])
  expectArgv('spaces, an empty word and non-ASCII are byte-honest', ['pl ain', '', 'ünï'])
  const code = run(['code42'])
  check('the batch exit code reaches the caller', code.status === 42, `status ${code.status}`)
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL SPAWN PLAN CMD LINE PROOFS PASS')
else console.log(` ❌ ${failures} SPAWN PLAN CMD LINE CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

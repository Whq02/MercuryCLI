#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { shimContent, powershellEntryContent } = await import('../../src/services/privateChannel/installLayout.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const WIN = process.platform === 'win32'

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'shim-contain-')))
const home = join(BASE, 'home')
const versions = join(home, 'versions')
const outside = join(home, 'outside', 'evil')
mkdirSync(versions, { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(join(versions, '1.2.3'), { recursive: true })
if (WIN) {
  writeFileSync(join(outside, 'mercury.cmd'), '@echo ESCAPED-THE-ROOT\r\n@exit /b 0\r\n')
  writeFileSync(join(versions, '1.2.3', 'mercury.cmd'), '@echo LEGIT-LAUNCH\r\n@exit /b 0\r\n')
} else {
  writeFileSync(join(outside, 'mercury'), '#!/bin/sh\necho ESCAPED-THE-ROOT\nexit 0\n')
  chmodSync(join(outside, 'mercury'), 0o755)
  writeFileSync(join(versions, '1.2.3', 'mercury'), '#!/bin/sh\necho LEGIT-LAUNCH\nexit 0\n')
  chmodSync(join(versions, '1.2.3', 'mercury'), 0o755)
}

type Launch = { rc: number; out: string; err: string }
const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_VERSIONS_DIR: '' }
const launched = (result: ReturnType<typeof spawnSync>): Launch => ({ rc: result.status ?? -1, out: String(result.stdout ?? ''), err: String(result.stderr ?? '') })
const roads: Array<{ name: string; run: () => Launch }> = []
if (WIN) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const cmdShim = join(BASE, 'mercury.cmd')
  writeFileSync(cmdShim, shimContent(true))
  roads.push({ name: 'the cmd shim', run: () => launched(spawnSync(join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"${cmdShim}"`], { env, encoding: 'utf8', timeout: 15_000, windowsHide: true, windowsVerbatimArguments: true })) })
  const ps1 = join(BASE, 'mercury.ps1')
  writeFileSync(ps1, powershellEntryContent())
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  roads.push({ name: 'the PowerShell entry', run: () => launched(spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })) })
} else {
  const shimPath = join(BASE, 'mercury-shim.sh')
  writeFileSync(shimPath, shimContent(false))
  chmodSync(shimPath, 0o755)
  roads.push({ name: 'the POSIX shim', run: () => launched(spawnSync('/bin/sh', [shimPath], { env, encoding: 'utf8', timeout: 15_000 })) })
}

for (const road of roads) {
  const runShim = (pointer: string): Launch => {
    writeFileSync(join(versions, 'current.txt'), `${pointer}\n`)
    return road.run()
  }
  section(`§1 ${road.name.toUpperCase()} LIVE`)
  const escape = runShim('../outside/evil')
  check(`${road.name}: an escape pointer REFUSES (exit 1)`, escape.rc === 1, `rc=${escape.rc} err=${escape.err.slice(0, 120)}`)
  check(`${road.name}: and nothing outside the root executed`, !escape.out.includes('ESCAPED-THE-ROOT'), JSON.stringify(escape.out))
  check(`${road.name}: the refusal names the pointer problem`, /version directory name|separator|not a path/i.test(escape.err), JSON.stringify(escape.err).slice(0, 140))

  const nested = runShim('1.2.3/../../outside/evil')
  check(`${road.name}: a nested traversal pointer refuses too`, nested.rc === 1 && !nested.out.includes('ESCAPED-THE-ROOT'), `rc=${nested.rc}`)

  const legit = runShim('1.2.3')
  check(`${road.name}: control: a legitimate pointer still launches`, legit.rc === 0 && legit.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: legit.rc, out: legit.out.slice(0, 40), err: legit.err.slice(0, 120) }))

  const padded = runShim('1.2.3   ')
  check(`${road.name}: a trailing-space pointer still launches (FC-055)`, padded.rc === 0 && padded.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: padded.rc, err: padded.err.slice(0, 120) }))

  const bom = runShim('\uFEFF1.2.3')
  check(`${road.name}: a pointer saved with a UTF-8 byte-order mark launches (f06: the status reader reads it as the version)`, bom.rc === 0 && bom.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: bom.rc, err: bom.err.slice(0, 120) }))
  const blankFirst = runShim('\n1.2.3')
  check(`${road.name}: a pointer with a leading blank line launches, as the status reader reads it (f07)`, blankFirst.rc === 0 && blankFirst.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: blankFirst.rc, err: blankFirst.err.slice(0, 120) }))
  const bomBlank = runShim('\uFEFF\n1.2.3')
  check(`${road.name}: a byte-order mark on a blank first line launches too (f06 + f07)`, bomBlank.rc === 0 && bomBlank.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: bomBlank.rc, err: bomBlank.err.slice(0, 120) }))
  const escapeAfterBom = runShim('\uFEFF../outside/evil')
  check(`${road.name}: the byte-order mark buys no escape: a traversal pointer behind it still refuses`, escapeAfterBom.rc === 1 && !escapeAfterBom.out.includes('ESCAPED-THE-ROOT'), `rc=${escapeAfterBom.rc}`)
}

section('§2 THE CMD TEMPLATE (structural)')
{
  const cmd = shimContent(true)
  check('quotes are STRIPPED from the pointer before use (the parse-abort class)', /%MVER:"=%/.test(cmd))
  check('a backslash in the pointer refuses', cmd.includes('%MVER:\\=%'))
  check('a forward slash in the pointer refuses', cmd.includes('%MVER:/=%'))
  check('a dot-dot in the pointer refuses', cmd.includes('%MVER:..=%'))
  check(
    'the guards sit BEFORE the call',
    cmd.indexOf('%MVER:..=%') !== -1 && cmd.indexOf('%MVER:..=%') < cmd.indexOf('call "%MROOT%\\%MVER%\\mercury.cmd"'),
  )
  check('the cmd twin trims trailing whitespace before the guards (FC-055)', cmd.includes(':trimver') && cmd.indexOf(':trimver') < cmd.indexOf('%MVER:..=%'))
  check('the byte-order mark is held as its own bytes, so it decodes as the pointer file does under any code page', cmd.includes('set "MBOM=\uFEFF"'))
  check('every pointer line passes through :pick before it can become the version', cmd.includes('do if not defined MVER (set "MLINE=%%v" & call :pick)'))
  check(':pick strips the mark in its one-, two- and three-character readings', ['3', '2', '1'].every(n => cmd.includes(`if defined MLINE if "%MLINE:~0,${n}%"=="%MBOM%" set "MLINE=%MLINE:~${n}%"`)))
  check(':pick skips a line that is blank once the mark and spaces are gone, so the next line is read', cmd.includes('if defined MLINE set "MVER=%MLINE%"') && cmd.includes(':pickblank'))
  check(':pick sits after the final exit, reachable only by call', cmd.indexOf('\r\n:pick\r\n') > cmd.indexOf('exit /b %ERRORLEVEL%'))
  check('the refusal never echoes pointer content', !cmd.split('\r\n').some(l => l.includes('echo') && (l.includes('%MVER%') || l.includes('%MLINE%'))))
}

removeScratch(BASE)
if (failures > 0) {
  console.error(`\nprove-shim-pointer-containment: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shim-pointer-containment: all green')

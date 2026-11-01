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
  const bomSpaces = runShim('\uFEFF   \n1.2.3')
  check(`${road.name}: a byte-order mark on a spaces-only first line launches the version on the next line`, bomSpaces.rc === 0 && bomSpaces.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: bomSpaces.rc, err: bomSpaces.err.slice(0, 120) }))
  const refusedPlainly = (launch: Launch): boolean => launch.rc === 1 && !launch.out.includes('LEGIT-LAUNCH') && /is empty|does not name an installed version/.test(launch.err)
  const bomOnly = runShim('\uFEFF')
  check(`${road.name}: a byte-order mark alone refuses with the shim's own sentence, never a parse abort`, refusedPlainly(bomOnly), JSON.stringify({ rc: bomOnly.rc, err: bomOnly.err.slice(0, 160) }))
  const bomSpacesOnly = runShim('\uFEFF   ')
  check(`${road.name}: a byte-order mark then spaces alone refuses the same way`, refusedPlainly(bomSpacesOnly), JSON.stringify({ rc: bomSpacesOnly.rc, err: bomSpacesOnly.err.slice(0, 160) }))
  const escapeAfterBom = runShim('\uFEFF../outside/evil')
  check(`${road.name}: the byte-order mark buys no escape: a traversal pointer behind it still refuses`, escapeAfterBom.rc === 1 && !escapeAfterBom.out.includes('ESCAPED-THE-ROOT'), `rc=${escapeAfterBom.rc}`)
}

section('§2 THE CMD TEMPLATE (structural)')
{
  const cmd = shimContent(true)
  check('the versioned launcher replaces the batch context, without a CALL return offset into a shim the child can refresh', cmd.includes('\r\n"%MROOT%\\%MVER%\\mercury.cmd" %*\r\n') && !cmd.includes('call "%MROOT%\\%MVER%\\mercury.cmd"'))
  check('quotes are STRIPPED from the pointer before use (the parse-abort class)', /%MVER:"=%/.test(cmd))
  check('a backslash in the pointer refuses', cmd.includes('%MVER:\\=%'))
  check('a forward slash in the pointer refuses', cmd.includes('%MVER:/=%'))
  check('a dot-dot in the pointer refuses', cmd.includes('%MVER:..=%'))
  check(
    'the guards sit BEFORE the tail chain',
    cmd.indexOf('%MVER:..=%') !== -1 && cmd.indexOf('%MVER:..=%') < cmd.indexOf('\r\n"%MROOT%\\%MVER%\\mercury.cmd"'),
  )
  check('the cmd twin trims trailing whitespace before the guards (FC-055)', cmd.includes(':trimver') && cmd.indexOf(':trimver') < cmd.indexOf('%MVER:..=%'))
  check('the byte-order mark is held as its own bytes, so it decodes as the pointer file does under any code page', cmd.includes('set "MBOM=\uFEFF"'))
  check('every pointer line passes through :pick before it can become the version', cmd.includes('do if not defined MVER (set "MLINE=%%v" & call :pick)'))
  check(':pick strips the mark in its one-, two- and three-character readings', ['3', '2', '1'].every(n => cmd.includes(`if "%MLINE:~0,${n}%"=="%MBOM%" set "MLINE=%MLINE:~${n}%"`)))
  check(':pick skips a line that is blank once the mark and spaces are gone, so the next line is read', cmd.includes('set "MVER=%MLINE%"') && cmd.includes(':pickblank'))
  check(':pick sits after the final exit, reachable only by call', cmd.indexOf('\r\n:pick\r\n') !== -1 && cmd.indexOf('exit /b %ERRORLEVEL%') !== -1 && cmd.indexOf('\r\n:pick\r\n') > cmd.indexOf('exit /b %ERRORLEVEL%'))
  check('the refusal never echoes pointer content', !cmd.split('\r\n').some(l => l.includes('echo') && (l.includes('%MVER%') || l.includes('%MLINE%'))))
  const pick = cmd.slice(cmd.indexOf('\r\n:pick\r\n') + 2).split('\r\n').filter(Boolean)
  const guarded = pick.every((line, at) => {
    if (!line.includes('%MLINE:') || at === 1) return true
    const before = pick[at - 1]!
    return before === 'if not defined MLINE exit /b 0' || before.endsWith('& goto pickblank')
  })
  check('every substring of MLINE in :pick expands right after a line that leaves when MLINE is undefined (cmd expands %MLINE:~…% before any if defined on the same line)', guarded && !pick.some(line => line.startsWith('if defined MLINE if')), pick.join(' | '))
}

section('§3 THE :pick SUBROUTINE UNDER CMD\'S PERCENT RULE (static, calibrated against a Windows trace)')
{
  type Vars = Map<string, string>
  const substring = (value: string, spec: string): string => {
    const [a, b] = spec.split(',').map(Number)
    const start = (a ?? 0) < 0 ? Math.max(0, value.length + (a ?? 0)) : Math.min(a ?? 0, value.length)
    const end = b === undefined ? value.length : b < 0 ? Math.max(start, value.length + b) : Math.min(value.length, start + b)
    return value.slice(start, end)
  }
  const replaceSpec = (value: string, spec: string): string => {
    const eq = spec.indexOf('=')
    const search = spec.slice(0, eq)
    const by = spec.slice(eq + 1)
    return search === '' ? value : value.split(search).join(by)
  }
  const percentExpand = (line: string, vars: Vars): string => {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (line[i] !== '%') {
        out += line[i]
        i++
        continue
      }
      if (line[i + 1] === '%') {
        out += '%'
        i += 2
        continue
      }
      let j = i + 1
      while (j < line.length && line[j] !== '%' && line[j] !== ':') j++
      if (j >= line.length) {
        out += line.slice(i + 1)
        break
      }
      const value = vars.get(line.slice(i + 1, j).toUpperCase())
      if (line[j] === '%') {
        if (value !== undefined) out += value
        i = j + 1
        continue
      }
      if (value === undefined) {
        i = j + 1
        continue
      }
      const end = line.indexOf('%', j + 1)
      if (end === -1) {
        out += line.slice(i + 1)
        break
      }
      const spec = line.slice(j + 1, end)
      out += spec.startsWith('~') ? substring(value, spec.slice(1)) : replaceSpec(value, spec)
      i = end + 1
    }
    return out
  }
  const SET = /^set "([A-Z]+)=(.*)"$/
  const GUARD = /^if not defined ([A-Z]+) exit \/b 0$/
  const COMPARE = /^(?:if defined ([A-Z]+) )?if "([^"]*)"=="([^"]*)" set "([A-Z]+)=([^"]*)"(?: & goto ([a-z]+))?$/
  const runPick = (lines: string[], mline: string, mbom: string): { mver: string | undefined; fault: string | null } => {
    const vars: Vars = new Map([['MBOM', mbom], ['MLINE', mline]])
    const assign = (name: string, value: string): void => {
      if (value === '') vars.delete(name)
      else vars.set(name, value)
    }
    let pc = lines.indexOf(':pick') + 1
    for (let steps = 0; steps < 2000 && pc < lines.length; steps++, pc++) {
      const raw = lines[pc]!
      if (raw.startsWith(':')) continue
      const line = percentExpand(raw, vars)
      if (line === 'exit /b 0') break
      const guard = GUARD.exec(line)
      if (guard) {
        if (!vars.has(guard[1]!)) break
        continue
      }
      const set = SET.exec(line)
      if (set) {
        assign(set[1]!, set[2]!)
        continue
      }
      const compare = COMPARE.exec(line)
      if (!compare) return { mver: vars.get('MVER'), fault: line }
      if (compare[1] !== undefined && !vars.has(compare[1])) continue
      if (compare[2] !== compare[3]) continue
      assign(compare[4]!, compare[5]!)
      if (compare[6] !== undefined) pc = lines.indexOf(`:${compare[6]}`)
    }
    return { mver: vars.get('MVER'), fault: null }
  }
  const FOLD_ELEVEN_PICK = [
    ':pick',
    'set "MLINE=%MLINE:"=%"',
    'if defined MLINE if "%MLINE:~0,3%"=="%MBOM%" set "MLINE=%MLINE:~3%"',
    'if defined MLINE if "%MLINE:~0,2%"=="%MBOM%" set "MLINE=%MLINE:~2%"',
    'if defined MLINE if "%MLINE:~0,1%"=="%MBOM%" set "MLINE=%MLINE:~1%"',
    ':pickblank',
    'if defined MLINE if "%MLINE:~0,1%"==" " set "MLINE=%MLINE:~1%" & goto pickblank',
    'if defined MLINE if "%MLINE:~0,1%"=="\t" set "MLINE=%MLINE:~1%" & goto pickblank',
    'if defined MLINE set "MVER=%MLINE%"',
    'exit /b 0',
  ]
  const traced = runPick(FOLD_ELEVEN_PICK, 'ABC', 'ABC')
  check('calibration: the model reproduces the box\'s trace of the earlier :pick on a mark-only line, word for word', traced.fault === 'if defined MLINE if "~0,2MBOMMLINE:~2"', JSON.stringify(traced))
  const spacesOnly = runPick(FOLD_ELEVEN_PICK, ' ', 'ABC')
  check('calibration: the earlier :pick on a spaces-only line corrupts at the blank strip, as the box saw (& was unexpected)', spacesOnly.fault !== null && spacesOnly.fault.startsWith('if defined MLINE if "~0,1MLINE:~1"'), JSON.stringify(spacesOnly))

  const shipped = shimContent(true).split('\r\n')
  const pickLines = shipped.slice(shipped.indexOf(':pick'))
  const ideal = (line: string, bom: string): string | undefined => {
    let s = line.replaceAll('"', '')
    if (s.startsWith(bom)) s = s.slice(bom.length)
    s = s.replace(/^[ \t]+/, '')
    return s === '' ? undefined : s
  }
  const readings: Array<[string, string]> = [['three characters (a single-byte console page)', '\u00b4\u2557\u2510'], ['two characters (a double-byte page)', '\u30c6\u30b5'], ['one character (code page 65001)', '\uFEFF']]
  let simulated = 0
  for (const [reading, bom] of readings) {
    const shapes = ['1.2.3', `${bom}1.2.3`, bom, '   ', `${bom}   `, '\t1.2.3', `${bom}  1.2.3  `, '"1.2.3"', '""', '"', `${bom}"1.2.3"`, `"${bom}"`, '..\\outside\\evil', '%MBOM%', 'a&b', 'a|b<c>d', '(1.2.3)', '1.2.3 & del x', '=1.2.3', '^1.2.3', '!1.2.3!', `${bom}${bom}1.2.3`]
    let faults = 0
    let wrong = 0
    for (const shape of shapes) {
      const run = runPick(pickLines, shape, bom)
      simulated++
      if (run.fault !== null) {
        faults++
        console.log(`    fault on ${JSON.stringify(shape)} under ${reading}: ${run.fault}`)
      } else if (run.mver !== ideal(shape, bom)) {
        wrong++
        console.log(`    ${JSON.stringify(shape)} under ${reading}: MVER ${JSON.stringify(run.mver)}, expected ${JSON.stringify(ideal(shape, bom))}`)
      }
    }
    check(`the shipped :pick, the mark read as ${reading}: ${shapes.length} first-line shapes expand to well-formed lines and pick the version the ideal picks`, faults === 0 && wrong === 0, `${faults} faults, ${wrong} wrong`)
  }
  check('the simulation covered every shape under every reading', simulated === 66, String(simulated))
}

if (WIN) {
  const cmdShim = join(BASE, 'refreshing.cmd')
  const replacement = join(BASE, 'replacement.cmd')
  const source = shimContent(true)
  writeFileSync(cmdShim, source)
  writeFileSync(replacement, ' '.repeat(Buffer.byteLength(source)) + '\r\n@echo RESUMED_AFTER_REFRESH\r\n@exit /b 17\r\n')
  writeFileSync(join(versions, 'current.txt'), '1.2.3\r\n')
  writeFileSync(join(versions, '1.2.3', 'mercury.cmd'), [
    '@echo off',
    'copy /y "%SHIM_REPLACEMENT%" "%STABLE_SHIM%" >nul',
    'echo rollback refused: no previous installed version is recorded 1>&2',
    'exit /b 1',
    '',
  ].join('\r\n'))
  const result = launched(spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${cmdShim}" update --rollback"`], {
    env: { ...env, SHIM_REPLACEMENT: replacement, STABLE_SHIM: cmdShim }, encoding: 'utf8', timeout: 15_000, windowsHide: true, windowsVerbatimArguments: true,
  }))
  check('a child that refreshes its calling shim keeps its refusal and exit code, never reading the replacement at the old return offset', result.rc === 1 && result.out.trim() === '' && result.err.trim() === 'rollback refused: no previous installed version is recorded', JSON.stringify(result))
} else console.log('  [SKIP] live CMD refresh handoff needs Windows; the tail-chain pin ran here')

removeScratch(BASE)
if (failures > 0) {
  console.error(`\nprove-shim-pointer-containment: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shim-pointer-containment: all green')

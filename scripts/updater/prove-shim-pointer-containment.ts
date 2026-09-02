#!/usr/bin/env bun
// prove-shim-pointer-containment — the managed shim never follows a pointer
// out of the versions root (field card FC-021, folding E008 122/124,
// re-rated S1). current.txt is a plain text file ordinary install/update
// flows write, and the shim called whatever it named with only a lexical
// existence check — a pointer of ..\outside\evil (or
// 9.9.9-beta.1\..\..\outside\evil) executed a launcher OUTSIDE the
// versions root on both shim members, and a pointer carrying a double quote
// aborted the cmd shim with a raw batch parse error. The pointer is a
// version directory NAME, never a path: both templates now strip quotes and
// refuse any separator or dot-dot before the call.
//
//   §1 the POSIX shim LIVE: an escape pointer refuses (exit 1, nothing
//      executed outside the root); a legitimate pointer still execs.
//   §2 the cmd template carries the same guards (structural — the cmd twin
//      cannot run on this box; the live leg is Windows-field-owed).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { shimContent } = await import('../../src/services/privateChannel/installLayout.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'shim-contain-')))
const home = join(BASE, 'home')
const versions = join(home, 'versions')
// The card's layout: the escape target sits ONE level above the
// versions root (inside the config home) — <root>/../outside/evil.
const outside = join(home, 'outside', 'evil')
mkdirSync(versions, { recursive: true })
mkdirSync(outside, { recursive: true })
// The escape target: proof of execution is its marker on stdout.
writeFileSync(join(outside, 'mercury'), '#!/bin/sh\necho ESCAPED-THE-ROOT\nexit 0\n')
chmodSync(join(outside, 'mercury'), 0o755)
// A legitimate installed version.
mkdirSync(join(versions, '1.2.3'), { recursive: true })
writeFileSync(join(versions, '1.2.3', 'mercury'), '#!/bin/sh\necho LEGIT-LAUNCH\nexit 0\n')
chmodSync(join(versions, '1.2.3', 'mercury'), 0o755)

const shimPath = join(BASE, 'mercury-shim.sh')
writeFileSync(shimPath, shimContent(false))
chmodSync(shimPath, 0o755)

const runShim = (pointer: string): { rc: number; out: string; err: string } => {
  writeFileSync(join(versions, 'current.txt'), `${pointer}\n`)
  const result = spawnSync('/bin/sh', [shimPath], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_VERSIONS_DIR: '' },
    encoding: 'utf8',
    timeout: 15_000,
  })
  return { rc: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

section('§1 THE POSIX SHIM LIVE')
{
  const escape = runShim('../outside/evil')
  check('an escape pointer REFUSES (exit 1)', escape.rc === 1, `rc=${escape.rc}`)
  check('and nothing outside the root executed', !escape.out.includes('ESCAPED-THE-ROOT'), JSON.stringify(escape.out))
  check('the refusal names the pointer problem', /version directory name|separator|not a path/i.test(escape.err), JSON.stringify(escape.err).slice(0, 140))

  const nested = runShim('1.2.3/../../outside/evil')
  check('a nested traversal pointer refuses too', nested.rc === 1 && !nested.out.includes('ESCAPED-THE-ROOT'), `rc=${nested.rc}`)

  const legit = runShim('1.2.3')
  check('control: a legitimate pointer still launches', legit.rc === 0 && legit.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: legit.rc, out: legit.out.slice(0, 40) }))

  // FC-055: a pointer with trailing spaces launches (update --status called
  // it healthy while the shim refused it — the two now agree).
  const padded = runShim('1.2.3   ')
  check('a trailing-space pointer still launches (FC-055)', padded.rc === 0 && padded.out.includes('LEGIT-LAUNCH'), JSON.stringify({ rc: padded.rc }))
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
}

rmSync(BASE, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-shim-pointer-containment: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shim-pointer-containment: all green')

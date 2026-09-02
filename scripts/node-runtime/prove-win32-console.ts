#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-win32-console.ts — the boot-time Windows console
//  UTF-8 seam.
//
//  No real Windows console required (F6-hermetic): the decision core is pure,
//  the performer runs against an injected chcp seam, and the cli.tsx wiring +
//  built-bundle presence are proven structurally.
//    (1) decide matrix — win32-gated · TTY-gated · =0 opt-out · engage
//    (2) chcp output parsing — localized variants, garbage, null
//    (3) performer + restore honesty against the injected seam:
//        prev≠65001 ⇒ set + exactly-once exit restore to prev;
//        prev=65001 ⇒ query-only no-op; unparseable prev ⇒ set WITHOUT
//        restore (the recorded deliberate decision); query failure ⇒ still
//        sets, never restores blind; non-engage ⇒ ZERO syscalls; idempotent
//    (4) cli.tsx placement — the seam sits AFTER the zero-import --version
//        fast-path and BEFORE any route dispatch/frame paint
//    (5) the built bundle carries the seam (dist grep, skip when absent)
//    (6) the fd delivery law is UNTOUCHED — delivery.ts still owns
//        writeAllSync on the TTY fd path (the codepage is the fix, never a
//        write-path swap)
//    (7) the chcp SPAWN SHAPE — windowsHide must stay false: CREATE_NO_WINDOW
//        hands chcp.com its own hidden console and the set lands there while
//        stdout still claims success (TASK-014 W1's inert-seam class; FN-012
//        kernel32 A/B). Real-console effect proves only on hardware
//        (NEEDS-REAL-BOX); this section pins the shape that decides it.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  chcpSpawnShape,
  decideWin32ConsoleUtf8,
  ensureWin32ConsoleUtf8,
  parseChcpCodepage,
  restoreWin32ConsoleNow,
  UTF8_CODEPAGE,
  _resetWin32ConsoleForTest,
  type Win32ConsoleSyscalls,
} from '../../src/utils/runtime/win32Console.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

//
section('(1) decide matrix — win32-gated · TTY-gated · opt-out')
{
  const d1 = decideWin32ConsoleUtf8('darwin', true, {})
  check('darwin ⇒ no engage (not-win32)', !d1.engage && d1.reason === 'not-win32')
  const d2 = decideWin32ConsoleUtf8('linux', true, {})
  check('linux ⇒ no engage', !d2.engage)
  const d3 = decideWin32ConsoleUtf8('win32', false, {})
  check('win32 non-TTY ⇒ no engage (no-tty)', !d3.engage && d3.reason === 'no-tty')
  const d4 = decideWin32ConsoleUtf8('win32', true, { MERCURY_WIN32_UTF8: '0' })
  check('win32 TTY =0 ⇒ no engage (opted-out)', !d4.engage && d4.reason === 'opted-out')
  const d5 = decideWin32ConsoleUtf8('win32', true, {})
  check('win32 TTY ⇒ engage', d5.engage)
  const d6 = decideWin32ConsoleUtf8('win32', true, { MERCURY_WIN32_UTF8: '1' })
  check('win32 TTY =1 ⇒ engage (only =0 opts out)', d6.engage)
  // The launcher already set 65001 and says so — skip even the
  // query spawn; the opt-out still wins over the marker (both are no-ops,
  // but the reason must stay honest).
  const d7 = decideWin32ConsoleUtf8('win32', true, { MERCURY_WIN32_UTF8_PRESET: '1' })
  check('win32 TTY launcher-preset ⇒ no engage (launcher-preset)', !d7.engage && d7.reason === 'launcher-preset')
  const d8 = decideWin32ConsoleUtf8('win32', true, { MERCURY_WIN32_UTF8_PRESET: '1', MERCURY_WIN32_UTF8: '0' })
  check('opt-out outranks the preset marker in the stated reason', !d8.engage && d8.reason === 'opted-out')
  const d9 = decideWin32ConsoleUtf8('win32', true, { MERCURY_WIN32_UTF8_PRESET: '' })
  check('an empty preset marker does not skip (only =1)', d9.engage)
}

//
section('(2) chcp output parsing — localized, garbage, null')
check('en-US: "Active code page: 437"', parseChcpCodepage('Active code page: 437\r\n') === 437)
check('de-DE trailing dot: "Aktive Codepage: 850."', parseChcpCodepage('Aktive Codepage: 850.\r\n') === 850)
check('es-ES: "Página de códigos activa: 65001"', parseChcpCodepage('Página de códigos activa: 65001') === 65001)
check('no number ⇒ null', parseChcpCodepage('no digits here') === null)
check('null ⇒ null', parseChcpCodepage(null) === null)
check('empty ⇒ null', parseChcpCodepage('') === null)

//
section('(3) performer + restore honesty (injected chcp seam)')

interface Call {
  arg: string | undefined
}
function seam(prevOutput: string | null, setOutput: string | null): { calls: Call[]; sys: Win32ConsoleSyscalls } {
  const calls: Call[] = []
  return {
    calls,
    sys: {
      chcp: arg => {
        calls.push({ arg })
        return arg === undefined ? prevOutput : setOutput
      },
    },
  }
}
const WIN_TTY = { platform: 'win32', stdoutIsTTY: true, env: {} as Record<string, string | undefined> }

{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 437', 'Active code page: 65001')
  const exits: Array<() => void> = []
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: fn => exits.push(fn) })
  check('prev 437 ⇒ engaged + changed + restore armed', o.engaged && o.previous === 437 && o.changed && o.restoreArmed)
  check('exactly query + set calls (no more)', calls.length === 2 && calls[0]!.arg === undefined && calls[1]!.arg === String(UTF8_CODEPAGE))
  check('an exit restore was registered', exits.length === 1)
  exits[0]!()
  check('exit restore ran chcp back to 437', calls.length === 3 && calls[2]!.arg === '437')
  exits[0]!()
  restoreWin32ConsoleNow(sys)
  check('restore is exactly-once (second call is a no-op)', calls.length === 3)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 65001', null)
  const exits: Array<() => void> = []
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: fn => exits.push(fn) })
  check('prev already 65001 ⇒ query-only no-op (no set, no restore)', o.engaged && o.previous === UTF8_CODEPAGE && !o.changed && !o.restoreArmed)
  check('only the query syscall ran', calls.length === 1 && calls[0]!.arg === undefined)
  check('no exit hook registered', exits.length === 0)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('kein parsebarer text', 'Active code page: 65001')
  const exits: Array<() => void> = []
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: fn => exits.push(fn) })
  check('unparseable prev ⇒ set WITHOUT restore (deliberate)', o.engaged && o.previous === null && o.changed && !o.restoreArmed)
  check('no exit hook when previous is unknown', exits.length === 0)
  restoreWin32ConsoleNow(sys)
  check('restore refuses to run blind', calls.length === 2)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam(null, null)
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: () => {} })
  check('query failure ⇒ still attempts the set, reports unchanged', o.engaged && o.previous === null && !o.changed && !o.restoreArmed)
  check('both syscalls attempted, none repeated', calls.length === 2)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 437', 'Active code page: 65001')
  const o = ensureWin32ConsoleUtf8(sys, { platform: 'darwin', stdoutIsTTY: true, env: {} })
  check('non-win32 ⇒ ZERO syscalls', !o.engaged && calls.length === 0)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 437', 'Active code page: 65001')
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, env: { MERCURY_WIN32_UTF8: '0' } })
  check('=0 opt-out ⇒ ZERO syscalls', !o.engaged && calls.length === 0)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 65001', 'Active code page: 65001')
  const exits: Array<() => void> = []
  const o = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, env: { MERCURY_WIN32_UTF8_PRESET: '1' }, registerExit: fn => exits.push(fn) })
  check('launcher-preset ⇒ ZERO syscalls (even the query is skipped)', !o.engaged && calls.length === 0)
  check('launcher-preset ⇒ no restore armed, no exit hook', !o.restoreArmed && exits.length === 0)
}
{
  _resetWin32ConsoleForTest()
  const { calls, sys } = seam('Active code page: 437', 'Active code page: 65001')
  const exits: Array<() => void> = []
  const first = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: fn => exits.push(fn) })
  const second = ensureWin32ConsoleUtf8(sys, { ...WIN_TTY, registerExit: fn => exits.push(fn) })
  check('idempotent — the second call returns the latched outcome, no extra syscalls', first === second && calls.length === 2 && exits.length === 1)
}

//
section('(4) cli.tsx placement — after --version, before route dispatch')
{
  const cli = readFileSync(join(ROOT, 'src', 'entrypoints', 'cli.tsx'), 'utf8')
  // The guard spans lines: platform + TTY + the registry spelling (legacy
  // rung beside it) + the preset escape; its last clause anchors it.
  const guard = cli.indexOf("process.env.MERCURY_WIN32_UTF8_PRESET !== '1'")
  const importLine = cli.indexOf("await import('../utils/runtime/win32Console.js')")
  const versionFastPath = cli.indexOf("console.log(`Mercury ${MACRO.VERSION}`)")
  const firstRoute = cli.indexOf("profileCheckpoint('cli_entry')")
  check('the win32 guard exists in cli.tsx', guard !== -1)
  check('the module is dynamically imported (zero posix load)', importLine !== -1)
  check('seam sits AFTER the zero-import --version fast-path', versionFastPath !== -1 && guard > versionFastPath)
  check('seam sits BEFORE the first route checkpoint (pre-paint)', firstRoute !== -1 && guard < firstRoute)
  check('ensureWin32ConsoleUtf8 is invoked at the seam', /ensureWin32ConsoleUtf8\(\)\n/.test(cli))
}

//
section('(5) the built bundle carries the seam')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (existsSync(dist)) {
    const bundle = readFileSync(dist, 'utf8')
    check('dist carries the MERCURY_WIN32_UTF8 gate', bundle.includes('MERCURY_WIN32_UTF8'))
    check('dist carries the chcp.com performer', bundle.includes('chcp.com'))
  } else {
    console.log('  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it')
  }
}

//
section('(6) the fd delivery law is UNTOUCHED')
{
  const delivery = readFileSync(join(ROOT, 'src', 'ink', 'session', 'delivery.ts'), 'utf8')
  check('delivery.ts still owns the loss-proof fd path', delivery.includes('writeAllSync(out.fd!, Buffer.from(buffer, \'utf8\')'))
  check('the TTY fd gate is unchanged', delivery.includes('out.isTTY === true && typeof out.fd === \'number\''))
  const win32Src = readFileSync(join(ROOT, 'src', 'utils', 'runtime', 'win32Console.ts'), 'utf8')
  check('win32Console never touches the write path', !win32Src.includes("from '../../ink/session/delivery") && !win32Src.includes('writeSync('))
}

//
section('(7) the chcp spawn shape — the console must be OURS')
{
  const shape = chcpSpawnShape({ SystemRoot: 'C:\\WINDOWS' })
  check(
    'windowsHide is FALSE (CREATE_NO_WINDOW re-aims chcp at a throwaway console — the inert-seam class)',
    shape.options.windowsHide === false,
  )
  // join() keeps the first segment's separators verbatim, so these hold on
  // every host the pool runs on.
  check('the exe is System32 chcp.com under the env SystemRoot', shape.exe.startsWith('C:\\WINDOWS') && shape.exe.endsWith('chcp.com') && shape.exe.includes('System32'))
  check('the spawn is bounded (timeout armed, ≤ 5s)', shape.options.timeout > 0 && shape.options.timeout <= 5_000)
  check('SystemRoot absent falls back to C:\\Windows', chcpSpawnShape({}).exe.startsWith('C:\\Windows'))
  const win32Src = readFileSync(join(ROOT, 'src', 'utils', 'runtime', 'win32Console.ts'), 'utf8')
  check('defaultSyscalls rides chcpSpawnShape (one shape owner)', /const\s*\{\s*exe,\s*options\s*\}\s*=\s*chcpSpawnShape\(\)/.test(win32Src))
  // Comment-blind needle: the seam's own docblock lawfully NAMES the
  // disease ("`windowsHide: true` is CREATE_NO_WINDOW…") — only CODE may
  // never spell it. Block comments blank whole; comment-led lines drop.
  const win32Code = win32Src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .filter(l => !/^\s*(?:\/\/|\*)/.test(l))
    .join('\n')
  check('no windowsHide: true survives anywhere in the seam (code, not comments)', !win32Code.includes('windowsHide: true'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ WIN32 CONSOLE SEAM PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)

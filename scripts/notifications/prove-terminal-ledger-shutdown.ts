#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ledger = await import('../../src/ink/root/terminalModeLedger.js')

t.section('§1 — the derivation answers exactly the open obligations')
{
  ledger._resetTerminalModeLedgerForTesting()
  t.check(
    'a process that acquired nothing has NOTHING to release at shutdown',
    ledger.shutdownReleaseObligations().length === 0,
    JSON.stringify(ledger.shutdownReleaseObligations()),
  )
  ledger.noteModeAcquired('repro-tm01', 'mouse-tracking')
  t.check(
    'an acquired mode appears as an open shutdown obligation',
    ledger.shutdownReleaseObligations().includes('mouse-tracking'),
    JSON.stringify(ledger.shutdownReleaseObligations()),
  )
  ledger.noteModeReleased('repro-tm01', 'mouse-tracking')
  t.check(
    'a released mode leaves the shutdown obligation set',
    !ledger.shutdownReleaseObligations().includes('mouse-tracking'),
    JSON.stringify(ledger.shutdownReleaseObligations()),
  )
}

t.section('§2 — dedup across owners')
{
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('owner-a', 'bracketed-paste')
  ledger.noteModeAcquired('owner-b', 'bracketed-paste')
  const open = ledger.shutdownReleaseObligations()
  t.check('two owners holding one mode yield ONE release', open.length === 1 && open[0] === 'bracketed-paste', JSON.stringify(open))
  ledger.noteModeReleased('owner-a', 'bracketed-paste')
  t.check(
    "one owner's release does not settle the other's obligation",
    ledger.shutdownReleaseObligations().includes('bracketed-paste'),
    JSON.stringify(ledger.shutdownReleaseObligations()),
  )
}

t.section('§3 — the App-armed trio is representable (focus-events joined)')
{
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('app-raw-mode', 'bracketed-paste')
  ledger.noteModeAcquired('app-raw-mode', 'focus-events')
  ledger.noteModeAcquired('app-raw-mode', 'kitty-kbd')
  const open = new Set(ledger.shutdownReleaseObligations())
  t.check(
    'the raw-mode arm trio is exactly derivable',
    open.has('bracketed-paste') && open.has('focus-events') && open.has('kitty-kbd') && open.size === 3,
    JSON.stringify([...open]),
  )
  ledger._resetTerminalModeLedgerForTesting()
}

t.section('§4 — settle-everywhere: the shutdown writer is exactly-once')
{
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('owner-a', 'mouse-tracking')
  ledger.noteModesImported('owner-b', ['mouse-tracking'])
  ledger.noteModeSettledEverywhere('mouse-tracking')
  t.check(
    "settle-everywhere closes EVERY owner's open record of the mode",
    !ledger.shutdownReleaseObligations().includes('mouse-tracking'),
    JSON.stringify(ledger.terminalModeLedgerSnapshot()),
  )
  t.check(
    'a failsafe re-run then has nothing left to write for it',
    ledger.shutdownReleaseObligations().length === 0,
    JSON.stringify(ledger.shutdownReleaseObligations()),
  )
  ledger.noteModeSettledEverywhere('alt-screen')
  t.check(
    'settling a never-armed mode records nothing open (no phantom rows)',
    ledger.shutdownReleaseObligations().length === 0,
    JSON.stringify(ledger.terminalModeLedgerSnapshot()),
  )
  ledger._resetTerminalModeLedgerForTesting()
}

t.section('§5 — the partition: the full standing set notes and settles')
{
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('app-raw-mode', 'bracketed-paste')
  ledger.noteModeAcquired('app-raw-mode', 'focus-events')
  ledger.noteModeAcquired('app-raw-mode', 'kitty-kbd')
  ledger.noteModeAcquired('app-cursor', 'cursor-hidden')
  ledger.noteModeAcquired('alt-screen-session', 'alt-screen')
  ledger.noteModeAcquired('alt-screen-session', 'alternate-scroll')
  ledger.noteModeAcquired('alt-screen-session', 'mouse-tracking')
  const open = new Set(ledger.shutdownReleaseObligations())
  t.check(
    'the full standing set derives (7 modes, every arm site noted)',
    open.size === 7 &&
      open.has('bracketed-paste') &&
      open.has('focus-events') &&
      open.has('kitty-kbd') &&
      open.has('cursor-hidden') &&
      open.has('alt-screen') &&
      open.has('alternate-scroll') &&
      open.has('mouse-tracking'),
    JSON.stringify([...open]),
  )
  ledger.noteModeReleased('alt-screen-session', 'alt-screen')
  ledger.noteModeReleased('alt-screen-session', 'alternate-scroll')
  ledger.noteModeReleased('alt-screen-session', 'mouse-tracking')
  ledger.noteModeReleased('app-cursor', 'cursor-hidden')
  const rest = new Set(ledger.shutdownReleaseObligations())
  t.check(
    'owner-settled modes leave the shutdown set; the remainder is exact',
    rest.size === 3 && rest.has('bracketed-paste') && rest.has('focus-events') && rest.has('kitty-kbd'),
    JSON.stringify([...rest]),
  )
  ledger._resetTerminalModeLedgerForTesting()

  const src = await Bun.file('src/utils/shutdownRestoration.ts').text()
  const cleanup = src.slice(src.indexOf('function cleanupTerminalModes'), src.indexOf('let resumeHintPrinted'))
  for (const [name, needle] of [
    ['mouse', 'DISABLE_MOUSE_TRACKING'],
    ['cursor', 'SHOW_CURSOR'],
    ['paste', 'DBP'],
    ['focus', 'DFE'],
    ['kitty', 'DISABLE_KITTY_KEYBOARD'],
  ] as const) {
    const writes = [...cleanup.matchAll(new RegExp(`writeSync\\(1, ${needle}\\)`, 'g'))]
    const gated = writes.length > 0
    const allGated = writes.every(m => {
      const before = cleanup.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0)
      return /open\.has\(|shutdownReleaseObligations\(\)/.test(before)
    })
    t.check(`${name} close writes are ledger-gated (no unconditional reset)`, gated && allGated, `${writes.length} write(s)`)
  }
}

t.section('§6 — a boot with mouse capture off owes no mouse-tracking release')
{
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('alt-screen-session', 'alt-screen')
  ledger.noteModeAcquired('alt-screen-session', 'alternate-scroll')
  const open = new Set(ledger.shutdownReleaseObligations())
  t.check(
    'the capture-off session owes alt-screen + alternate-scroll and never mouse-tracking',
    open.size === 2 && open.has('alt-screen') && open.has('alternate-scroll') && !open.has('mouse-tracking'),
    JSON.stringify([...open]),
  )
  ledger.noteModeReleased('alt-screen-session', 'mouse-tracking')
  ledger.noteModeReleased('alt-screen-session', 'alt-screen')
  ledger.noteModeReleased('alt-screen-session', 'alternate-scroll')
  t.check(
    'releasing the never-acquired mode adds no obligation; the settled pair leaves nothing',
    ledger.shutdownReleaseObligations().length === 0 && ledger.openModeObligations('alt-screen-session').length === 0,
    JSON.stringify(ledger.terminalModeLedgerSnapshot()),
  )
  ledger._resetTerminalModeLedgerForTesting()
}

t.finish('prove-terminal-ledger-shutdown')

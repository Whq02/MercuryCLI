#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-terminal-profile.ts — the versioned full-profile
//  contract resolves honestly.
//
//  Table-drives resolveTerminalProfile() through the probe seam: the two
//  first-class Windows hosts, the bare-conhost case ruling 3 exists for, the
//  POSIX floor, and the rules that keep the profile from ever locking out a
//  working host (NO_COLOR is a supported family; recommended rows can only
//  downgrade full→capable, never to unsupported).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'
import { resolveTerminalProfile, TERMINAL_PROFILE_VERSION } from '../../src/ink/session/terminalProfile.ts'

const t = checker()

const ALL_RECS = { syncOutput: true, extendedKeys: true, hyperlinks: true, progress: true }

t.section('POSIX floor')
{
  const full = resolveTerminalProfile({
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    platform: 'darwin', isTTY: true, ...ALL_RECS,
  })
  t.check('a complete host resolves full', full.verdict === 'full', full.verdict)
  t.check('the profile is versioned', full.version === TERMINAL_PROFILE_VERSION, `v${full.version}`)

  const dumb = resolveTerminalProfile({
    env: { TERM: 'dumb' }, platform: 'linux', isTTY: true, ...ALL_RECS,
  })
  t.check('TERM=dumb is unsupported', dumb.verdict === 'unsupported', dumb.verdict)

  const noTty = resolveTerminalProfile({
    env: { TERM: 'xterm-256color' }, platform: 'darwin', isTTY: false, ...ALL_RECS,
  })
  t.check('a tty-less stdout is unsupported (print mode is the path for pipes)', noTty.verdict === 'unsupported', noTty.verdict)
}

t.section('the Windows host rule (operator ruling 3)')
{
  const wt = resolveTerminalProfile({
    env: { WT_SESSION: 'x', COLORTERM: undefined }, platform: 'win32', isTTY: true,
    modernWindowsHost: true, ...ALL_RECS,
  })
  t.check('Windows Terminal stable is a full-profile host', wt.verdict === 'full', wt.verdict)

  const vscode = resolveTerminalProfile({
    env: { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.102.0' }, platform: 'win32',
    isTTY: true, modernWindowsHost: true, ...ALL_RECS,
  })
  t.check('VS Code integrated is a full-profile host', vscode.verdict === 'full', vscode.verdict)

  // Model the host honestly: a bare conhost answers no DEC 2026 (the probe
  // is the first-class witness, not a recommended-row
  // detail, so the model matters).
  const bare = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.22631', ...ALL_RECS, syncOutput: false,
  })
  t.check('bare conhost is unsupported', bare.verdict === 'unsupported', bare.verdict)
  const bareRows = bare.checks.filter(c => !c.ok && c.requirement === 'required')
  t.check(
    'the failing rows name the supported hosts',
    bareRows.length > 0 && bareRows.every(c => c.remediation.includes('Windows Terminal')),
    bareRows.map(c => c.id).join(', '),
  )

  // Modern mintty DOES answer DEC 2026 — its own fingerprint (MSYSTEM /
  // TERM_PROGRAM=mintty) must keep it out of the first-class row anyway
  // (ruling 3 names two hosts; the latch witness is only for the
  // fingerprint-LESS default-terminal case).
  const mintty = resolveTerminalProfile({
    env: { MSYSTEM: 'MINGW64', TERM: 'xterm-256color' }, platform: 'win32', isTTY: true,
    modernWindowsHost: true, osRelease: '10.0.22631', ...ALL_RECS,
  })
  t.check(
    'mintty is VT-capable but NOT first-class (explain before entering, ruling 3)',
    mintty.verdict === 'unsupported' &&
      mintty.checks.find(c => c.id === 'win32-conpty-host')!.ok &&
      !mintty.checks.find(c => c.id === 'win32-first-class-host')!.ok,
    mintty.verdict,
  )
}

t.section('the default-terminal handoff (the friend-path class)')
{
  // Windows Terminal as the OS DEFAULT terminal hosts a double-clicked
  // launcher WITHOUT injecting WT_SESSION/TERM_PROGRAM — the live DEC 2026
  // latch is the env-free witness (conhost never answers it). The profile
  // must not tell an operator looking at Windows Terminal to go run
  // Windows Terminal.
  const defterm = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.22631', ...ALL_RECS, // syncOutput: true — the witness
  })
  t.check(
    'WT-as-default-terminal (fingerprint-less, DEC 2026 live) is not locked out',
    defterm.verdict !== 'unsupported',
    defterm.verdict,
  )
  t.check(
    'the first-class row names the live witness in its evidence',
    defterm.checks.find(c => c.id === 'win32-first-class-host')!.evidence.includes('DEC 2026'),
    defterm.checks.find(c => c.id === 'win32-first-class-host')!.evidence,
  )

  // A ConPTY-era console IS ConPTY-era even with zero env fingerprints: the
  // era is an OS-build fact (10.0.17763+), not a host-app fingerprint. The
  // quiet true-conhost still gets the ruling-3 requirement surface — from
  // the first-class row alone, honestly.
  const conhost = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.22631', ...ALL_RECS, syncOutput: false,
  })
  t.check(
    'quiet conhost: the ConPTY-era row passes on the OS build',
    conhost.checks.find(c => c.id === 'win32-conpty-host')!.ok,
    conhost.checks.find(c => c.id === 'win32-conpty-host')!.evidence,
  )
  t.check(
    'quiet conhost keeps the ruling-3 gate (first-class fails, verdict unsupported)',
    conhost.verdict === 'unsupported' &&
      !conhost.checks.find(c => c.id === 'win32-first-class-host')!.ok,
    conhost.verdict,
  )

  const preConpty = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '6.3.9600', ...ALL_RECS, syncOutput: false,
  })
  t.check(
    'a pre-ConPTY console fails the era row itself',
    preConpty.verdict === 'unsupported' &&
      !preConpty.checks.find(c => c.id === 'win32-conpty-host')!.ok,
    preConpty.checks.find(c => c.id === 'win32-conpty-host')!.evidence,
  )
}

t.section('nothing here locks out a working host')
{
  const noColor = resolveTerminalProfile({
    env: { TERM: 'xterm-256color', NO_COLOR: '1' }, platform: 'linux', isTTY: true, ...ALL_RECS,
  })
  t.check(
    'NO_COLOR is a supported family, never unsupported',
    noColor.verdict !== 'unsupported',
    noColor.verdict,
  )

  const noRecs = resolveTerminalProfile({
    env: { TERM: 'xterm' }, platform: 'linux', isTTY: true,
    syncOutput: false, extendedKeys: false, hyperlinks: false, progress: false,
  })
  t.check(
    'missing recommended capabilities downgrade to capable, never unsupported',
    noRecs.verdict === 'capable',
    noRecs.verdict,
  )
  const failedRecs = noRecs.checks.filter(c => !c.ok)
  t.check(
    'every failed row still explains itself',
    failedRecs.every(c => c.remediation.length > 0 && c.evidence.length > 0),
    `${failedRecs.length} rows`,
  )
}

t.section('the dependency inventory (windowsHostSetup — friend-path QoL)')
{
  const { detectWindowsHostInventory, hostSetupActions, inventoryLines } = await import(
    '../../src/ink/session/windowsHostSetup.ts'
  )
  const offPlatform = await detectWindowsHostInventory({ platform: 'darwin' })
  t.check(
    'non-win32 detection reports unknown everywhere (never a fabricated missing)',
    Object.values(offPlatform).every(v => v === 'unknown'),
    JSON.stringify(offPlatform),
  )

  const which = (table: Record<string, 'present' | 'missing' | 'unknown'>) =>
    (exe: string) => Promise.resolve(table[exe] ?? 'unknown')

  const friend = await detectWindowsHostInventory({
    platform: 'win32',
    which: which({ 'wt.exe': 'missing', 'pwsh.exe': 'missing', 'winget.exe': 'present' }),
  })
  const friendActions = hostSetupActions(friend)
  t.check(
    'missing WT + PS7 with winget yields two runnable install actions',
    friendActions.length === 2 && friendActions.every(a => a.command !== null) &&
      friendActions.some(a => a.id === 'install-windows-terminal') &&
      friendActions.some(a => a.id === 'install-pwsh7'),
    friendActions.map(a => a.id).join(','),
  )
  t.check(
    'winget commands are exact and agreement-accepting',
    friendActions.every(
      a => a.command![0] === 'winget' && a.command!.includes('--accept-package-agreements'),
    ),
    friendActions[0]!.command!.join(' '),
  )

  const noWinget = hostSetupActions({
    windowsTerminal: 'missing',
    pwsh7: 'present',
    winget: 'missing',
  })
  t.check(
    'without winget the action degrades to the install page (no command)',
    noWinget.length === 1 && noWinget[0]!.command === null &&
      noWinget[0]!.url.includes('aka.ms'),
    JSON.stringify(noWinget.map(a => ({ id: a.id, url: a.url }))),
  )

  const unknownInv = hostSetupActions({
    windowsTerminal: 'unknown',
    pwsh7: 'unknown',
    winget: 'present',
  })
  t.check(
    'an inconclusive probe offers NO install (proven absence only)',
    unknownInv.length === 0,
    `${unknownInv.length} actions`,
  )

  const lines = inventoryLines({ windowsTerminal: 'present', pwsh7: 'missing', winget: 'present' })
  t.check(
    'the inventory names PowerShell 7 as preferred shell, never the gate',
    lines.some(l => l.label === 'PowerShell 7' && l.note.includes('not the gate')) &&
      lines.some(l => l.label === 'Windows Terminal' && l.note.includes('gate')),
    lines.map(l => `${l.label}:${l.note}`).join(' | '),
  )
}

t.section('structure')
{
  const r = resolveTerminalProfile({
    env: { TERM: 'xterm-256color' }, platform: 'darwin', isTTY: true, ...ALL_RECS,
  })
  const required = r.checks.filter(c => c.requirement === 'required')
  t.check('required rows exist', required.length >= 2, `${required.length}`)
  t.check(
    'every required row carries a remediation',
    required.every(c => c.remediation.trim().length > 0),
    'ok',
  )
  const ids = r.checks.map(c => c.id)
  t.check('check ids are unique', new Set(ids).size === ids.length, ids.join(','))
}

t.finish('prove-terminal-profile')

#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { checker } from '../engine-durability/harness.ts'
import { resolveTerminalProfile, TERMINAL_PROFILE_VERSION } from '../../src/screen/renderer/terminal-session/terminalProfile.ts'

if (process.argv[2] === '--leave') {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const os = require('node:os') as { release: () => string }
  const release = os.release
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { showSetupScreens } = await import('../../src/boot/setupScreens.tsx')
  const leave = (node: React.ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(leave)
    if (!React.isValidElement(node)) return false
    const props = node.props as { children?: React.ReactNode; onDone?: (choice: string) => void }
    if (typeof node.type === 'function' && node.type.name === 'TerminalProfileCard') {
      props.onDone?.('exit')
      return true
    }
    return leave(props.children)
  }
  if (process.argv[3] === 'win32') {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    os.release = () => '10.0.22631'
  }
  await showSetupScreens(
    {
      render: (node: React.ReactNode) => {
        if (!leave(node)) throw new Error('a setup screen other than the terminal check was shown')
      },
      unmount: () => {
        Object.defineProperty(process, 'platform', platform)
        os.release = release
      },
    } as never,
    'default',
    false,
  )
  process.exit(0)
}

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
  t.check('a tty-less stdout is unsupported (a run is the path for pipes)', noTty.verdict === 'unsupported', noTty.verdict)
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
  const defterm = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.22631', ...ALL_RECS,
  })
  t.check(
    'WT-as-default-terminal (fingerprint-less, DEC 2026 live) is not locked out',
    defterm.verdict !== 'unsupported',
    defterm.verdict,
  )
  t.check(
    'the first-class row names the live witness in plain words (the window draws frames atomically, as Windows Terminal does as the default terminal) and never the DEC number',
    defterm.checks.find(c => c.id === 'win32-first-class-host')!.evidence.includes('draws frames atomically, as Windows Terminal does when it is the default terminal') &&
      !defterm.checks.find(c => c.id === 'win32-first-class-host')!.evidence.includes('DEC 2026'),
    defterm.checks.find(c => c.id === 'win32-first-class-host')!.evidence,
  )

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

t.section('the 24-bit colour row on Windows (every console since build 14931 renders 24-bit colour; chalk paints it on the OS build, whatever the host names itself)')
{
  const defterm = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.19045', ...ALL_RECS,
  })
  const defRow = defterm.checks.find(c => c.id === 'truecolor')!
  t.check('WT-as-default (no WT_SESSION, no COLORTERM): the row is met on the OS build', defRow.ok, defRow.evidence)
  t.check('…and its evidence names the build and the 14931 fact', defRow.evidence.includes('10.0.19045') && defRow.evidence.includes('14931') && defRow.evidence.includes('COLORTERM=(unset)'), defRow.evidence)
  t.check('…so WT-as-default resolves full, not capable, when every other recommended row holds', defterm.verdict === 'full', defterm.verdict)
  const conhost = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '10.0.19045', ...ALL_RECS, syncOutput: false,
  })
  const conhostRow = conhost.checks.find(c => c.id === 'truecolor')!
  t.check('bare conhost: the colour row is met too (the console paints 24-bit colour) while the first-class gate still fails', conhostRow.ok && conhost.verdict === 'unsupported', `${conhostRow.ok} ${conhost.verdict}`)
  const wt = resolveTerminalProfile({
    env: { WT_SESSION: 'x' }, platform: 'win32', isTTY: true, modernWindowsHost: true,
    osRelease: '10.0.22631', ...ALL_RECS,
  })
  t.check('Windows Terminal with its fingerprint keeps the fingerprint as the evidence', wt.checks.find(c => c.id === 'truecolor')!.evidence === 'WT_SESSION (Windows Terminal)', wt.checks.find(c => c.id === 'truecolor')!.evidence)
  const preConpty = resolveTerminalProfile({
    env: {}, platform: 'win32', isTTY: true, modernWindowsHost: false,
    osRelease: '6.3.9600', ...ALL_RECS, syncOutput: false,
  })
  const oldRow = preConpty.checks.find(c => c.id === 'truecolor')!
  t.check('a pre-ConPTY console (Windows 8.1) is not credited with 24-bit colour', !oldRow.ok && oldRow.evidence.includes('no known truecolor terminal'), oldRow.evidence)
  const apple = resolveTerminalProfile({
    env: { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }, platform: 'darwin', isTTY: true, ...ALL_RECS,
  })
  const appleRow = apple.checks.find(c => c.id === 'truecolor')!
  t.check('the Mac road is unchanged: Apple Terminal without COLORTERM is still not met, with the same words', !appleRow.ok && appleRow.evidence === 'COLORTERM=(unset) · no known truecolor terminal named', appleRow.evidence)
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
    '../../src/screen/renderer/terminal-session/windowsHostSetup.ts'
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
    'the inventory names PowerShell 7 as the preferred shell and not a requirement, and Windows Terminal as where Mercury looks right — no "gate" word anywhere',
    lines.some(l => l.label === 'PowerShell 7' && l.note.includes('not a requirement')) &&
      lines.some(l => l.label === 'Windows Terminal' && l.note.includes('looks right')) &&
      lines.every(l => !/\bgate\b/.test(l.note)),
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

t.section('the parting words after Exit on the terminal check')
{
  const scratch = mkdtempSync(join(tmpdir(), 'terminal-parting-'))
  const leave = (platform: 'win32' | 'own', term?: string): { status: number | null; lines: string[] } => {
    const home = mkdtempSync(join(scratch, 'home-'))
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true }))
    const child = spawnSync(process.execPath, [import.meta.path, '--leave', platform], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        MERCURY_CONFIG_DIR: home,
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        TERM: term,
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { status: child.status, lines: child.stdout.split('\n').filter(line => line !== '') }
  }
  const fix = 'the exit branch of showSetupScreens in src/boot/setupScreens.tsx must open its parting lines with what the failing required rows found (their evidence), and leave the two lines after it as they are'
  const conhost = leave('win32')
  t.check('the old Windows console: Exit ends the process with status 1', conhost.status === 1, `status ${conhost.status} · ${fix}`)
  t.check(
    'its first line says what the window is and what it does not do, in the words of the check',
    conhost.lines[0] === 'This window cannot show Mercury the way it is designed: the old Windows console — it names itself to nothing and does not draw frames atomically (WT_SESSION=unset TERM_PROGRAM=(unset)).',
    `${conhost.lines[0]} · ${fix}`,
  )
  t.check(
    'no line names the window where a capability should stand',
    conhost.lines.length > 0 && !conhost.lines.some(line => line.includes('capabilities: this window')),
    `${conhost.lines.join(' | ')} · ${fix}`,
  )
  t.check(
    'the supported terminals and the mercury run line follow it',
    conhost.lines[1] === 'Use a supported terminal (the stable Windows Terminal or your editor’s integrated terminal; PowerShell 7 preferred).' &&
      conhost.lines[2] === 'Non-interactive use works anywhere via mercury run.',
    `${conhost.lines.slice(1).join(' | ')} · ${fix}`,
  )
  if (process.platform !== 'win32') {
    const dumb = leave('own', 'dumb')
    t.check(
      'TERM=dumb: the first line names the TERM the check read',
      dumb.status === 1 && dumb.lines[0] === `This window cannot show Mercury the way it is designed: TERM=dumb platform=${process.platform}.`,
      `status ${dumb.status} · ${dumb.lines[0]} · ${fix}`,
    )
  }
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('prove-terminal-profile')

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

if (process.argv[2] === '--start') {
  const answer = process.argv[3]
  if (process.argv[4] === 'tty') Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  const cwd = process.cwd()
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const state = await import('../../src/boot/process-state/processState.ts')
  state.setCwdState(cwd)
  state.setOriginalCwd(cwd)
  state.setProjectRoot(cwd)
  const { showSetupScreens } = await import('../../src/boot/setupScreens.tsx')
  const { TerminalProfileCard } = await import('../../src/boot/first-run/TerminalProfileCard.tsx')
  const { Onboarding } = await import('../../src/boot/first-run/Onboarding.tsx')
  const { TrustDialog } = await import('../../src/screen/trust-dialog/TrustDialog.tsx')
  const answerScreen = (node: React.ReactNode): boolean => {
    if (Array.isArray(node)) return node.some(answerScreen)
    if (!React.isValidElement(node)) return false
    const props = node.props as { children?: React.ReactNode; onDone?: (value?: unknown) => void }
    if (node.type === TerminalProfileCard) {
      console.log('asked')
      if (answer === 'supported') Object.assign(process.env, { TERM: 'xterm-256color', WT_SESSION: 'a-first-class-host' })
      props.onDone?.(answer === 'exit' ? 'exit' : 'continue')
      return true
    }
    if (node.type === Onboarding) {
      props.onDone?.([])
      return true
    }
    if (node.type === TrustDialog) {
      props.onDone?.()
      return true
    }
    return answerScreen(props.children)
  }
  await showSetupScreens(
    {
      render: (node: React.ReactNode) => {
        if (!answerScreen(node)) throw new Error('a setup screen other than the terminal check, the first run and the trust card was shown')
      },
      unmount: () => {},
    } as never,
    'default',
    false,
  )
  console.log('entered')
  process.exit(0)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = '', fix = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && fix ? ` — fix: ${fix}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const KIND = 'resolveTerminalProfile in src/screen/renderer/terminal-session/terminalProfile.ts must return a kind made of the profile version, how the window names itself (TERM, WT_SESSION, TERM_PROGRAM, MSYSTEM) and the ids of the required rows it misses, and of nothing a later reading of the same window can change'
const FLOW = 'showSetupScreens in src/boot/setupScreens.tsx must skip the terminal check when terminalChecksContinued in the global config holds the kind of the profile, and add the kind there after Continue anyway while the window still reads unsupported'

const { resolveTerminalProfile, TERMINAL_PROFILE_VERSION } = await import('../../src/screen/renderer/terminal-session/terminalProfile.ts')
const kindOf = (probe: Parameters<typeof resolveTerminalProfile>[0]): string => String((resolveTerminalProfile(probe) as { kind?: unknown }).kind)
const THIS_VERSION = `v${TERMINAL_PROFILE_VERSION}, `

section('A · the kind of a window, read from the Windows shapes the profile knows')
{
  const lacking = { syncOutput: false, extendedKeys: false, hyperlinks: false, progress: false }
  const conhost = { env: {}, platform: 'win32' as const, isTTY: true, modernWindowsHost: false, osRelease: '10.0.22631', ...lacking }
  const mintty = { ...conhost, env: { MSYSTEM: 'MINGW64', TERM: 'xterm-256color', TERM_PROGRAM: 'mintty' }, modernWindowsHost: true }
  const kinds = {
    conhost: kindOf(conhost),
    conhostAgain: kindOf({ ...conhost }),
    conhostAfterAnUpdateOfWindows: kindOf({ ...conhost, osRelease: '10.0.26100' }),
    conhostWithMore: kindOf({ ...conhost, extendedKeys: true, hyperlinks: true, progress: true }),
    conhostBeforeConpty: kindOf({ ...conhost, osRelease: '6.3.9600' }),
    mintty: kindOf(mintty),
    minttyAtomic: kindOf({ ...mintty, syncOutput: true }),
  }
  const read = JSON.stringify(kinds)
  const named = Object.values(kinds).every(kind => kind.startsWith(THIS_VERSION))
  check('every window the profile reads has a kind, and the kind carries the profile version first', named, read, KIND)
  check('the old Windows console reads unsupported and the same kind at every start', named && resolveTerminalProfile(conhost).verdict === 'unsupported' && kinds.conhost === kinds.conhostAgain, read, KIND)
  check('…after an update of Windows too', named && kinds.conhostAfterAnUpdateOfWindows === kinds.conhost, read, KIND)
  check('…whichever recommended rows it lacks', named && kinds.conhostWithMore === kinds.conhost, read, KIND)
  check('a console that misses another required row is another kind', named && kinds.conhostBeforeConpty !== kinds.conhost, read, KIND)
  check('a mintty window is another kind: another host', named && kinds.mintty !== kinds.conhost, read, KIND)
  check('…and one kind whether or not its frames read atomic at that start', named && resolveTerminalProfile({ ...mintty, syncOutput: true }).verdict === 'unsupported' && kinds.minttyAtomic === kinds.mintty, read, KIND)
}

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-check-kept-')))
const folderOf = (name: string): string => {
  const folder = join(ROOT, name)
  mkdirSync(folder)
  return folder
}
const project = folderOf('project')
const user = folderOf('user')
const homeOf = (name: string, config: Record<string, unknown> = {}): string => {
  const home = folderOf(name)
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, ...config }))
  return home
}
const configOf = (home: string): Record<string, unknown> => (existsSync(join(home, '.mercury.json')) ? (JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as Record<string, unknown>) : {})
const keptIn = (home: string): string[] => {
  const kept = configOf(home).terminalChecksContinued
  return kept !== null && typeof kept === 'object' && !Array.isArray(kept) ? Object.keys(kept) : []
}

type Window = { TERM: string; TERM_PROGRAM?: string; piped?: true }
const DUMB: Window = { TERM: 'dumb' }
const OTHER_HOST: Window = { TERM: 'dumb', TERM_PROGRAM: 'Apple_Terminal' }
const PIPED: Window = { TERM: 'dumb', piped: true }
const NOT_OF_THE_WINDOW = ['WT_SESSION', 'MSYSTEM', 'ConEmuANSI', 'COLORTERM', 'TERM_PROGRAM_VERSION', 'TMUX', 'KITTY_WINDOW_ID', 'ZED_TERM', 'VTE_VERSION', 'MERCURY_FORCE_SYNC_OUTPUT', 'MERCURY_HOME', 'MERCURY_DEMO', 'NODE_ENV', 'ANTHROPIC_API_KEY']
type Start = { asked: boolean; entered: boolean; status: number | null; said: string }
const start = (home: string, window: Window, answer: 'continue' | 'exit' | 'supported' = 'continue', folder = project): Start => {
  const child = spawnSync(process.execPath, [import.meta.path, '--start', answer, window.piped ? 'pipe' : 'tty'], {
    cwd: folder,
    env: {
      ...process.env,
      ...Object.fromEntries(NOT_OF_THE_WINDOW.map(name => [name, undefined])),
      HOME: user,
      USERPROFILE: user,
      MERCURY_CONFIG_DIR: home,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      TERM: window.TERM,
      TERM_PROGRAM: window.TERM_PROGRAM,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const lines = child.stdout.split('\n')
  return { asked: lines.includes('asked'), entered: lines.includes('entered'), status: child.status, said: `status ${child.status} · ${lines.filter(Boolean).join(' | ')} · ${child.stderr.trim().split('\n').slice(-2).join(' | ')}` }
}

try {
  section('B · Continue anyway is kept for that kind of window')
  const home = homeOf('home')
  const first = start(home, DUMB)
  check('a first start in a window whose profile reads unsupported asks, and Continue anyway enters', first.asked && first.entered, first.said, FLOW)
  const dumbKind = keptIn(home)[0] ?? ''
  check('the answer is kept in the global config of the home, under the kind of that window', keptIn(home).length === 1 && dumbKind.startsWith(THIS_VERSION), JSON.stringify(configOf(home).terminalChecksContinued), FLOW)
  const second = start(home, DUMB)
  check('the next start in the same kind of window goes straight in', !second.asked && second.entered, second.said, FLOW)
  const elsewhere = start(home, DUMB, 'continue', folderOf('another-project'))
  check('…from another folder too: the answer belongs to the window, not to a project', !elsewhere.asked && elsewhere.entered, elsewhere.said, FLOW)

  section('C · a window whose profile differs asks again')
  const otherHost = start(home, OTHER_HOST)
  check('another host asks', otherHost.asked && otherHost.entered, otherHost.said, FLOW)
  check('…and is kept in its turn', !start(home, OTHER_HOST).asked, JSON.stringify(keptIn(home)), FLOW)
  const piped = start(home, PIPED)
  check('other missing required rows ask', piped.asked && piped.entered, piped.said, FLOW)
  const back = start(home, DUMB)
  check('the first kind of window is still kept beside the two others', !back.asked && back.entered && keptIn(home).length === 3, `${back.said} · ${JSON.stringify(keptIn(home))}`, FLOW)
  const older = Object.fromEntries(keptIn(home).map(kind => [kind.replace(THIS_VERSION, `v${TERMINAL_PROFILE_VERSION - 1}, `), true]))
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ ...configOf(home), terminalChecksContinued: older }))
  const newer = start(home, DUMB)
  check('an answer kept under another profile version asks again', keptIn(home).length === 4 && newer.asked && newer.entered, `${newer.said} · ${JSON.stringify(keptIn(home))}`, FLOW)

  section('D · a fresh home asks, whatever a project carries')
  mkdirSync(join(project, '.mercury'))
  for (const file of ['.mercury/settings.json', '.mercury/settings.local.json', '.mercury.json', '.config.json']) writeFileSync(join(project, file), JSON.stringify({ terminalChecksContinued: { [dumbKind]: true } }))
  const fresh = folderOf('fresh')
  const stranger = start(fresh, DUMB)
  check('an empty home asks, with the kind of this window written in four files of the project', dumbKind !== '' && stranger.asked && stranger.entered, stranger.said, FLOW)
  check('…and its new global config holds that one answer beside the finished first run', dumbKind !== '' && keptIn(fresh).join() === dumbKind && configOf(fresh).hasCompletedOnboarding === true, JSON.stringify(configOf(fresh)), FLOW)
  check('…so its next start goes straight in', !start(fresh, DUMB).asked, '', FLOW)

  section('E · what is not an answer is not kept')
  const left = homeOf('left')
  const exit = start(left, DUMB, 'exit')
  check('Exit ends the start with status 1 and keeps nothing', exit.asked && !exit.entered && exit.status === 1 && keptIn(left).length === 0, `${exit.said} · ${JSON.stringify(configOf(left))}`, FLOW)
  check('…so the next start asks again', start(left, DUMB).asked, '', FLOW)
  const late = homeOf('late')
  const supported = start(late, DUMB, 'supported')
  check('a window that reads supported by the time the check closes keeps nothing', supported.asked && supported.entered && keptIn(late).length === 0, `${supported.said} · ${JSON.stringify(configOf(late))}`, FLOW)
  const damaged = homeOf('damaged', { terminalChecksContinued: true })
  const mended = start(damaged, DUMB)
  check('a kept value that is no record of kinds is read as no answer, and Continue anyway writes one over it', mended.asked && mended.entered && dumbKind !== '' && keptIn(damaged).join() === dumbKind, `${mended.said} · ${JSON.stringify(configOf(damaged).terminalChecksContinued)}`, FLOW)
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(`\nprove-terminal-check-kept-answer: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

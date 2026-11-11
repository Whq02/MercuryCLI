#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('landing-lines-in-order')
for (const name of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'MERCURY_MODEL']) delete process.env[name]
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', MERCURY_JEV_BASE: 'http://127.0.0.1:1',
  MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_OPERATOR: 'sam', BROWSER: '/usr/bin/true',
  MERCURY_HOME: join(HOME, 'proof-home'), MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
})
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME!, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const COLS = 120
const ROWS = 40
const PLACEHOLDER = 'Type a prompt'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const React = await import('react')
const { setIsInteractive } = await import('../../src/bootstrap/state.js')
setIsInteractive(true)
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const history = await import('../../src/history.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { createUserMessage } = await import('../../src/utils/messages/factories.js')
const { getCommands, commandSeat } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)
const sessionCommand = commands.find(command => command.name === 'review' && commandSeat(command) === 'session') ?? commands.find(command => command.type === 'prompt' && commandSeat(command) === 'session')

type Paste = { id: number; type: 'text' | 'image'; content: string }
type Handed = { text: string; mode: string; pastes: Record<number, Paste> }
const handed: Handed[] = []
const recording = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'proof-session',
  sendWords: async (text: string, opts?: { mode?: string; pastedContents?: Record<number, Paste> }) => {
    const send = { text, mode: opts?.mode ?? 'prompt', pastes: { ...(opts?.pastedContents ?? {}) } }
    await settle(text.includes('slow to be taken') ? 400 : 20)
    handed.push(send)
    return { state: 'accepted' as const }
  },
})
const said = (sends: Handed[]): string => JSON.stringify(sends.map(send => `${send.mode === 'bash' ? '!' : ''}${send.text}`))
const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯')) ?? '(no composer row)'
const h = React.createElement
async function mountChat(first?: string): Promise<Mounted> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})
  const initialState = first === undefined ? getDefaultAppState() : { ...getDefaultAppState(), initialMessage: { message: createUserMessage({ content: first }) } }
  const m = await mountOffscreen(h(App, { initialState, getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))), COLS, ROWS)
  await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
  await settle(300)
  return m
}
async function emptyComposer(m: Mounted): Promise<void> {
  await settle(260)
  pending.edit('')
  pending.setPastedContents({})
  pending.setMode('prompt')
  await waitFor(() => pending.text() === '' && composerRow(m).includes(PLACEHOLDER), 3000)
}
function landing(): { ends: (withSession: boolean) => Promise<void> } {
  let land = (): void => {}
  const inFlight = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  return {
    ends: async withSession => {
      if (withSession) slot.setFocusedSessionConnector(recording)
      land()
      await inFlight
    },
  }
}
async function type(m: Mounted, line: string): Promise<boolean> {
  const shell = line.startsWith('!')
  if (shell) {
    m.push('!')
    await waitFor(() => pending.mode() === 'bash', 2000)
  }
  const words = shell ? line.slice(1) : line
  m.push(words)
  const typed = await waitFor(() => pending.text() === words, 3000)
  await settle(350)
  return typed
}
async function send(m: Mounted, line: string): Promise<boolean> {
  const typed = await type(m, line)
  m.push(KEY.enter)
  return (await waitFor(() => pending.text() === '', 3000)) && typed
}
async function recalled(): Promise<string[]> {
  await history.flushHistoryNow()
  const lines: string[] = []
  for await (const entry of history.getHistory()) lines.push(entry.display)
  return lines
}

slot.setFocusedSessionConnector(recording)
let m = await mountChat()

section(`§1 two lines sent while one session lands, at ${COLS}x${ROWS}`)
{
  const before = handed.length
  const session = landing()
  await settle(200)
  const first = await send(m, 'alpha first line of two')
  const second = await send(m, 'alpha second line of two')
  check('each Enter took its line from the composer and nothing was sent yet', first && second && handed.length === before, `first ${first} second ${second} handed ${handed.length - before}`)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 2, 4000)
  await settle(300)
  check('both lines reach the session, in the order they were sent', said(handed.slice(before)) === JSON.stringify(['alpha first line of two', 'alpha second line of two']), said(handed.slice(before)))
  await emptyComposer(m)
}

section('§2 three lines, a slash command and a shell line among them, the first slow to be taken')
{
  const before = handed.length
  const command = `/${sessionCommand?.name ?? 'no-session-command'} the change`
  check('a slash command the session runs is on this screen', sessionCommand !== undefined, commands.filter(candidate => commandSeat(candidate) === 'session').map(candidate => candidate.name).slice(0, 12).join(','))
  const session = landing()
  await settle(200)
  const sentAll = (await send(m, 'beta prompt, slow to be taken')) && (await send(m, command)) && (await send(m, '!zzqq-beta-shell-line'))
  check('the three lines were taken and nothing was sent yet', sentAll && handed.length === before, `taken ${sentAll} handed ${handed.length - before}`)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 3, 5000)
  await settle(300)
  check('the three reach the session in order, each in the mode it was sent in', said(handed.slice(before)) === JSON.stringify(['beta prompt, slow to be taken', command, '!zzqq-beta-shell-line']), said(handed.slice(before)))
  check('the composer is a prompt again, empty', pending.mode() === 'prompt' && pending.text() === '', `mode ${pending.mode()} text ${JSON.stringify(pending.text())}`)
  const lines = await recalled()
  check('the prompt history holds each of the three once', ['beta prompt, slow to be taken', command, '!zzqq-beta-shell-line'].every(line => lines.filter(entry => entry === line).length === 1), JSON.stringify(lines.slice(0, 8)))
  await emptyComposer(m)
}

section('§3 a line still being typed when the session lands is left a draft, in the mode it was typed in')
{
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentBoth = (await send(m, 'gamma prompt line')) && (await send(m, '!zzqq-gamma-shell-line'))
  const typed = await type(m, 'gamma draft, still being typed')
  check('two lines wait and a third stands unsent in the composer as a prompt', sentBoth && typed && pending.mode() === 'prompt', `taken ${sentBoth} typed ${typed} mode ${pending.mode()}`)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 2, 4000)
  await settle(400)
  check('the two waiting lines are sent in order, the shell line as a shell line', said(handed.slice(before)) === JSON.stringify(['gamma prompt line', '!zzqq-gamma-shell-line']), said(handed.slice(before)))
  check('the draft is untouched and still a prompt', pending.text() === 'gamma draft, still being typed' && pending.mode() === 'prompt' && composerRow(m).includes('gamma draft, still being typed'), `mode ${pending.mode()} text ${JSON.stringify(pending.text())}`)
  await emptyComposer(m)
}
{
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentOne = await send(m, 'delta prompt line')
  const typed = await type(m, '!zzqq-delta-shell-draft')
  check('a prompt waits and a shell line stands unsent in the composer', sentOne && typed && pending.mode() === 'bash', `taken ${sentOne} typed ${typed} mode ${pending.mode()}`)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 1, 4000)
  await settle(400)
  check('the waiting prompt is sent as a prompt, not as a shell line', said(handed.slice(before)) === JSON.stringify(['delta prompt line']), said(handed.slice(before)))
  check('the shell draft is untouched and still a shell line', pending.text() === 'zzqq-delta-shell-draft' && pending.mode() === 'bash', `mode ${pending.mode()} text ${JSON.stringify(pending.text())}`)
  await emptyComposer(m)
}
{
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentOne = await send(m, 'epsilon prompt line')
  m.push('!')
  const toggled = await waitFor(() => pending.mode() === 'bash' && pending.text() === '', 2000)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 1, 4000)
  await settle(400)
  check('an empty composer switched to shell mode meanwhile: the waiting prompt is still sent as a prompt', sentOne && toggled && said(handed.slice(before)) === JSON.stringify(['epsilon prompt line']), `${said(handed.slice(before))}; taken ${sentOne} toggled ${toggled}`)
  await emptyComposer(m)
}
m.unmount()

section('§4 the prompt given on the command line, and a line typed while its session lands')
{
  const before = handed.length
  const session = landing()
  m = await mountChat('zeta prompt from the command line')
  const typed = await send(m, 'zeta line typed during the landing')
  check('the typed line is taken while the first prompt still waits', typed && handed.length === before, `taken ${typed} handed ${handed.length - before}`)
  await session.ends(true)
  await waitFor(() => handed.length >= before + 2, 5000)
  await settle(300)
  check('both reach the session, the command line\'s prompt first', said(handed.slice(before)) === JSON.stringify(['zeta prompt from the command line', 'zeta line typed during the landing']), said(handed.slice(before)))
  m.unmount()
}

section('§5 a landing that ends with no session: every waiting line comes back to the composer, in the order sent')
{
  slot.setFocusedSessionConnector(recording)
  m = await mountChat()
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentOne = await send(m, 'eta only line')
  await session.ends(false)
  const back = await waitFor(() => pending.text() === 'eta only line', 4000)
  check('one waiting line comes back as it was sent, and nothing reached a session', sentOne && back && handed.length === before && pending.mode() === 'prompt', `the composer holds ${JSON.stringify(pending.text())} in mode ${pending.mode()}`)
  m.unmount()
}
{
  slot.setFocusedSessionConnector(recording)
  m = await mountChat()
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentAll = (await send(m, 'theta first line')) && (await send(m, 'theta second line')) && (await send(m, 'theta third line'))
  await session.ends(false)
  const back = await waitFor(() => pending.text() === 'theta first line\ntheta second line\ntheta third line', 5000)
  check('three waiting lines come back together, one under the other in the order sent', sentAll && back && handed.length === before, `the composer holds ${JSON.stringify(pending.text())}`)
  m.unmount()
}
{
  slot.setFocusedSessionConnector(recording)
  m = await mountChat()
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentBoth = (await send(m, 'iota first line')) && (await send(m, 'iota second line'))
  const typed = await type(m, 'iota draft typed meanwhile')
  await session.ends(false)
  await settle(1200)
  check('with a draft in the composer the refused lines are not written over it', sentBoth && typed && pending.text() === 'iota draft typed meanwhile' && handed.length === before, `the composer holds ${JSON.stringify(pending.text())}`)
  const lines = await recalled()
  check('…and the prompt history holds both, so each can be recalled', lines.includes('iota first line') && lines.includes('iota second line'), JSON.stringify(lines.slice(0, 6)))
  m.unmount()
}
{
  slot.setFocusedSessionConnector(recording)
  m = await mountChat()
  const before = handed.length
  const session = landing()
  await settle(200)
  const sentOne = await send(m, 'kappa prompt line')
  m.push('!')
  const toggled = await waitFor(() => pending.mode() === 'bash' && pending.text() === '', 2000)
  await session.ends(false)
  const back = await waitFor(() => pending.text() === 'kappa prompt line', 4000)
  check('a refused prompt never comes back into a shell-mode composer', sentOne && toggled && back && pending.mode() === 'prompt' && handed.length === before, `the composer holds ${JSON.stringify(pending.text())} in mode ${pending.mode()}`)
  m.unmount()
}

if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? `prove-landing-lines-sent-in-order: ${checks} checks, 0 failed` : `prove-landing-lines-sent-in-order: ${checks} checks, ${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)

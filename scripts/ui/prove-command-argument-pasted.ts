#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('command-argument-pasted')
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
const LANDING_NOTICE = 'the session is landing — /mission sends when it lands'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
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
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands, commandSeat } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
markDaemonHaltStanddown()

type LocalModule = { call: (args: string, context: unknown) => Promise<unknown> }
const channelArgs: string[] = []
const commands = (await getCommands(PROJECT)).map(command => {
  if (command.name !== 'general' || command.type !== 'local') return command
  const real = command as unknown as { load: () => Promise<LocalModule> }
  return {
    ...command,
    load: async () => {
      const module = await real.load()
      return { ...module, call: (args: string, context: unknown) => { channelArgs.push(args); return module.call(args, context) } }
    },
  }
}) as Awaited<ReturnType<typeof getCommands>>
const mission = commands.find(command => command.name === 'mission')
const general = commands.find(command => command.name === 'general')

type Handed = { text: string; pastes: number; metaFrom: string | undefined }
const handed: Handed[] = []
type Roster = { rows: never[]; mission: never[]; missionCard: { goal: string; state: string; nextStep: null; iterations: number; setAt: string; updatedAt: string } | null }
let roster: Roster = { rows: [], mission: [], missionCard: null }
const recording = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'proof-session',
  sendWords: async (text: string, opts?: { pastedContents?: Record<number, unknown>; metaFrom?: { command: string } }) => {
    await settle(text.includes('slow to be taken') ? 1200 : 20)
    handed.push({ text, pastes: Object.keys(opts?.pastedContents ?? {}).length, metaFrom: opts?.metaFrom?.command })
    const at = new Date().toISOString()
    if (text.startsWith('/mission ')) roster = { rows: [], mission: [], missionCard: { goal: text.slice('/mission '.length), state: 'armed', nextStep: null, iterations: 0, setAt: at, updatedAt: at } }
    return { state: 'accepted' as const }
  },
  workRoster: () => roster,
})
function body(mark: string, lines = 1): string {
  let text = `${mark} begins. `
  for (let i = 1; text.length < 800; i++) text += `Sentence ${i} of the ${mark} text says nothing new.${lines > 1 && i % 4 === 0 ? '\n' : ' '}`
  return `${text}The ${mark} text ends here.`
}
const bracketed = (text: string): string => `\x1b[200~${text}\x1b[201~`
const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯')) ?? '(no composer row)'
async function emptyComposer(m: Mounted): Promise<void> {
  await settle(260)
  pending.edit('')
  pending.setPastedContents({})
  pending.setMode('prompt')
  await waitFor(() => pending.text() === '' && composerRow(m).includes(PLACEHOLDER), 3000)
}
async function typeThenPaste(m: Mounted, typed: string, pasted: string, after = ''): Promise<string> {
  m.push(typed)
  await waitFor(() => pending.text() === typed, 3000)
  await settle(200)
  m.push(bracketed(pasted))
  await waitFor(() => pending.text().includes('[Pasted text #'), 3000)
  await settle(300)
  if (after !== '') {
    const before = pending.text()
    m.push(after)
    await waitFor(() => pending.text() === `${before}${after}`, 3000)
    await settle(200)
  }
  return pending.text()
}
const whole = (send: Handed | undefined, command: string, text: string): boolean => send !== undefined && send.text === `${command} ${text}`.trim()
const says = (send: Handed | undefined): string => (send === undefined ? 'nothing was handed' : `handed ${send.text.length} characters: ${JSON.stringify(send.text.slice(0, 70))}`)

initializeSurfaceRoute(ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})
slot.setFocusedSessionConnector(recording)
const h = React.createElement
const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))), COLS, ROWS)
await waitFor(() => composerRow(m).includes(PLACEHOLDER), 8000)
await settle(300)

section(`§0 the commands on this screen at ${COLS}x${ROWS}`)
check('/mission is the interactive command, a dialog the screen runs', mission?.type === 'local-jsx' && commandSeat(mission) === 'screen', `type ${mission?.type}`)
check('/general is a command the screen runs with its argument', general?.type === 'local' && commandSeat(general) === 'screen', `type ${general?.type}`)

section('§1 a landed session: /mission with a typed goal, then with a pasted one')
{
  const before = handed.length
  m.push('/mission a typed goal, no paste in it')
  await waitFor(() => pending.text() === '/mission a typed goal, no paste in it', 3000)
  await settle(300)
  m.push(KEY.enter)
  await waitFor(() => handed.length > before, 4000)
  check('a typed goal reaches the session as typed, sent by the mission command', whole(handed[before], '/mission', 'a typed goal, no paste in it') && handed[before]!.metaFrom === 'mission', says(handed[before]))
  await emptyComposer(m)
}
for (const [label, text] of [['one line of 800 characters', body('Alder')], ['five lines', body('Birch', 5)]] as const) {
  const before = handed.length
  const line = await typeThenPaste(m, '/mission ', text)
  m.push(KEY.enter)
  await waitFor(() => handed.length > before, 4000)
  check(`a pasted goal, ${label}: the composer showed its placeholder and the session is handed the whole goal`, /^\/mission \[Pasted text #\d+( \+\d+ lines)?\]$/.test(line) && whole(handed[before], '/mission', text), `composer ${JSON.stringify(line)}; ${says(handed[before])}`)
  const set = await waitFor(() => m.screen().includes(`Mission set: ${text.slice(0, 30)}`), 3000)
  check(`${label}: the command's own receipt names the goal it set, not a placeholder`, set && !m.screen().includes('Mission set: [Pasted text'), m.lines().filter(row => row.includes('Mission')).join(' | '))
  await emptyComposer(m)
}
{
  const before = handed.length
  const text = body('Cedar')
  const line = await typeThenPaste(m, '/mission first ', text, ' and last')
  m.push(KEY.enter)
  await waitFor(() => handed.length > before, 4000)
  check('typed words around the paste keep their places', line.startsWith('/mission first [Pasted text #') && whole(handed[before], '/mission', `first ${text} and last`), `composer ${JSON.stringify(line)}; ${says(handed[before])}`)
  await emptyComposer(m)
}

section('§2 the same line sent while the session lands')
{
  let land = (): void => {}
  const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
  slot.releaseFocusedSessionConnector()
  await settle(200)
  const before = handed.length
  const text = body('Dogwood')
  await typeThenPaste(m, '/mission ', text)
  m.push(KEY.enter)
  const armed = await waitFor(() => m.screen().includes(LANDING_NOTICE) && pending.text() === '', 3000)
  check('the line is taken and waits for the landing', armed && handed.length === before, `armed ${armed}; handed ${handed.length - before}`)
  await settle(300)
  slot.setFocusedSessionConnector(recording)
  land()
  await landing
  await waitFor(() => handed.length > before, 5000)
  check('when the session lands it is handed the whole goal', whole(handed[before], '/mission', text), says(handed[before]))
  await emptyComposer(m)
}

section('§3 a command queued behind another that has not settled')
{
  const before = handed.length
  m.push('/mission a first goal, slow to be taken')
  await waitFor(() => pending.text() === '/mission a first goal, slow to be taken', 3000)
  await settle(300)
  m.push(KEY.enter)
  await waitFor(() => pending.text() === '', 3000)
  const text = body('Elm')
  await typeThenPaste(m, '/mission ', text)
  m.push(KEY.enter)
  const queued = await waitFor(() => m.screen().includes('/mission queued'), 3000)
  check('the second command is queued behind the first', queued && handed.length === before, `queued ${queued}; handed ${handed.length - before}`)
  await waitFor(() => handed.length > before + 1, 8000)
  check('the first is handed as typed, and the queued one with its whole goal', whole(handed[before], '/mission', 'a first goal, slow to be taken') && whole(handed[before + 1], '/mission', text), `${says(handed[before])}; ${says(handed[before + 1])}`)
  await emptyComposer(m)
}

section('§4 a command the screen runs itself: /general with a pasted text')
{
  const before = channelArgs.length
  const text = body('Fir')
  const line = await typeThenPaste(m, '/general ', text)
  m.push(KEY.enter)
  await waitFor(() => channelArgs.length > before, 4000)
  check('the command is called with the whole text', line.startsWith('/general [Pasted text #') && channelArgs[before] === text, `composer ${JSON.stringify(line)}; called with ${channelArgs[before]?.length ?? 0} characters: ${JSON.stringify((channelArgs[before] ?? '').slice(0, 70))}`)
  await emptyComposer(m)
}
{
  const before = channelArgs.length
  m.push('/general a typed note')
  await waitFor(() => pending.text() === '/general a typed note', 3000)
  await settle(300)
  m.push(KEY.enter)
  await waitFor(() => channelArgs.length > before, 4000)
  check('a typed text reaches it as typed', channelArgs[before] === 'a typed note', JSON.stringify(channelArgs[before]))
  await emptyComposer(m)
}

m.unmount()
if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? `prove-command-argument-pasted: ${checks} checks, 0 failed` : `prove-command-argument-pasted: ${checks} checks, ${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)

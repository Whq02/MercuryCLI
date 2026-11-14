#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('swarm-switch-landing')
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

type Asked = { op?: string; action?: string; sessionId?: string; title?: string }
const asked: Asked[] = []
const controlSocket = await import('../../src/daemon/controlSocket.js')
const realRpc = controlSocket.daemonControlRpc
mock.module('../../src/daemon/controlSocket.js', () => ({
  ...controlSocket,
  daemonControlRpc: async (...args: Parameters<typeof realRpc>) => {
    const frame = args[0] as Asked
    if (frame.op !== 'sessionControl' || frame.action !== 'set-title') return realRpc(...args)
    asked.push(frame)
    return { ok: true, outcome: 'applied' }
  },
}))

const COLS = 120
const ROWS = 40
const PLACEHOLDER = 'Type a prompt'
const SESSION = 'proof-session'
const NO_CHAT = 'no chat is open — ↵ New Session on the boot menu starts one'
const landingLine = (name: string): string => `the session is landing — /${name} sends when it lands`
const LINE_HELD = 'the session is landing — your line sends when it lands'
const PROMPT = 'the first prompt of the chat'
const TYPED: Array<{ line: string; name: string }> = [
  { line: '/swarm on', name: 'swarm' },
  { line: '/swarmchat main', name: 'swarmchat' },
  { line: '/general hello crew', name: 'general' },
  { line: '/team parser hello team', name: 'team' },
  { line: '/whisper alpha hello alpha', name: 'whisper' },
  { line: '/rename Landing name', name: 'rename' },
  { line: '/title Landing title', name: 'title' },
  { line: '/contract the work agreed', name: 'contract' },
  { line: '/crewmates on', name: 'crewmates' },
]
const NAMES = TYPED.map(typed => typed.name)

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
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...filesUnder(path, keep))
    else if (keep(entry)) out.push(path)
  }
  return out
}
const boardFiles = (): string[] => filesUnder(HOME, name => name === 'board.sqlite')
const transcriptFiles = (): string[] => filesUnder(HOME, name => /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(name))
const strays = (): string => `${boardFiles().length} board file(s), ${transcriptFiles().length} transcript file(s): ${[...boardFiles(), ...transcriptFiles()].map(path => path.replace(HOME, '<home>')).join(' · ')}`
const j = (value: unknown): string => JSON.stringify(value)

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

type BoardViewSnapshot = import('../../src/services/crewBoard/contracts.js').BoardViewSnapshot
type Answer = { name: string; args: string; said: string | undefined; landed: boolean }
const answers: Answer[] = []
type DialogModule = { call: (onDone: (result?: string, options?: unknown) => void, context: unknown, args: string, name?: string) => Promise<unknown> }
type LocalModule = { call: (args: string, context: unknown) => Promise<{ type: string; value?: string }> }
const commands = (await getCommands(PROJECT)).map(command => {
  if (!NAMES.includes(command.name)) return command
  if (command.type === 'local-jsx') {
    const real = command as unknown as { load: () => Promise<DialogModule> }
    return {
      ...command,
      load: async () => {
        const module = await real.load()
        return {
          ...module,
          call: (onDone: (result?: string, options?: unknown) => void, context: unknown, args: string, name?: string) => {
            const landed = slot.hasFocusedSession()
            return module.call((result, options) => { answers.push({ name: command.name, args, said: result, landed }); onDone(result, options) }, context, args, name)
          },
        }
      },
    }
  }
  if (command.type !== 'local') return command
  const real = command as unknown as { load: () => Promise<LocalModule> }
  return {
    ...command,
    load: async () => {
      const module = await real.load()
      return {
        ...module,
        call: async (args: string, context: unknown) => {
          const landed = slot.hasFocusedSession()
          const result = await module.call(args, context)
          answers.push({ name: command.name, args, said: result.type === 'text' ? result.value : undefined, landed })
          return result
        },
      }
    },
  }
}) as Awaited<ReturnType<typeof getCommands>>

const handed: string[] = []
const posted: Array<{ channel: string; target?: string; text: string }> = []
const switched: Array<{ kind: string; on: boolean }> = []
let board: BoardViewSnapshot | null = null
const recording = Object.assign(new NoSessionConnector(), {
  sessionId: () => SESSION,
  sendWords: async (text: string) => {
    await settle(20)
    handed.push(text)
    return { state: 'accepted' as const }
  },
  postBoard: async (post: { channel: string; target?: string; text: string }) => {
    posted.push({ channel: post.channel, ...(post.target === undefined ? {} : { target: post.target }), text: post.text })
    return { ok: true as const, eventId: `event-${posted.length}`, seq: posted.length, replay: false, address: post.target ?? 'all', recipients: [] }
  },
  setSpawnSwitch: async (kind: string, on: boolean) => {
    switched.push({ kind, on })
    return { outcome: 'applied' as const }
  },
  swarmBoard: () => board,
})
const composerRow = (m: Mounted): string => m.lines().find(line => line.startsWith('│❯')) ?? '(no composer row)'
async function send(m: Mounted, line: string): Promise<void> {
  m.push(line)
  await waitFor(() => pending.text() === line, 3000)
  await settle(250)
  m.push(KEY.enter)
}

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

section(`§0 the nine verbs are commands this screen runs, at ${COLS}x${ROWS}`)
for (const { name } of TYPED) {
  const command = commands.find(candidate => candidate.name === name)
  check(`/${name} is a command the screen runs, not the session`, command !== undefined && commandSeat(command) === 'screen', `type ${command?.type}`)
}
check('nothing of the window\'s own stands under the home before a line is typed', boardFiles().length === 0 && transcriptFiles().length === 0, strays())

section('§1 typed while a session lands: each verb is taken and waits, and the window answers nothing for itself')
let land = (): void => {}
const landing = slot.withLanding(new Promise<void>(resolve => { land = resolve }))
slot.releaseFocusedSessionConnector()
await settle(200)
for (const { line, name } of TYPED) {
  await send(m, line)
  const held = await waitFor(() => m.screen().includes(landingLine(name)) && pending.text() === '', 3000)
  check(`${line}: the footer says "${landingLine(name)}" and the composer is taken`, held, `composer ${j(pending.text())}; footer ${j(m.lines().filter(row => row.includes('landing') || row.includes('chat is open') || row.includes('warm') || row.includes('enamed')).map(row => row.trim()))}`)
  pending.edit('')
  await settle(120)
}
await send(m, PROMPT)
check('a plain line typed after them is held as it always was', await waitFor(() => m.screen().includes(LINE_HELD) && pending.text() === '', 3000), j(m.lines().filter(row => row.includes('landing')).map(row => row.trim())))
await settle(300)
check('no verb was run while the session landed: the window answered none of them for itself', answers.length === 0, j(answers))
check('the session that is landing was handed nothing yet, no line, no post, no switch, no title', handed.length === 0 && posted.length === 0 && switched.length === 0 && asked.length === 0, j({ handed, posted, switched, asked }))
check('the window made no board file and no transcript file of its own', boardFiles().length === 0 && transcriptFiles().length === 0, strays())

section('§2 the session lands: every line reaches it, in the order typed')
slot.setFocusedSessionConnector(recording)
land()
await landing
await waitFor(() => handed.includes(PROMPT), 8000)
await waitFor(() => posted.length >= 3 && answers.length >= TYPED.length, 3000)
const said = (name: string): Answer | undefined => answers.find(answer => answer.name === name)
check('the switch typed first is handed first, and the prompt typed last arrives last', handed[0] === '/swarm on' && handed[handed.length - 1] === PROMPT, j(handed))
check('/swarm on and /swarmchat main are sent to the landed session as words', j(handed) === j(['/swarm on', '/swarmchat main', PROMPT]), j(handed))
check('the owner\'s /general line is posted to the landed session\'s board', posted.some(post => post.channel === 'general' && post.text === 'hello crew'), j(posted))
check('…and /team and /whisper with their targets', posted.some(post => post.channel === 'team' && post.target === 'parser' && post.text === 'hello team') && posted.some(post => post.channel === 'whisper' && post.target === 'alpha' && post.text === 'hello alpha'), j(posted))
check('/rename titles the landed session by its id', asked.some(frame => frame.action === 'set-title' && frame.sessionId === SESSION && frame.title === 'Landing name') && said('rename')?.said === 'Renamed this session to Landing name', `${j(asked)} · ${j(said('rename'))}`)
check('/title answers for the landed session, not "No chat is open"', asked.some(frame => frame.action === 'set-title' && frame.sessionId === SESSION && frame.title === 'Landing title') && said('title')?.said === 'Titled this session "Landing title"', `${j(asked)} · ${j(said('title'))}`)
check('/contract answers for the landed session, not "No chat is open"', said('contract')?.said?.startsWith('This chat is not a daemon-hosted session') === true, j(said('contract')))
check('/crewmates on flips the landed session\'s switch, not "no chat is open"', j(switched) === j([{ kind: 'subagents', on: true }]) && said('crewmates')?.said?.includes('no chat is open') === false, `${j(switched)} · ${j(said('crewmates'))}`)
check('every verb ran once, after the landing, on the landed session', answers.length === TYPED.length && answers.every(answer => answer.landed) && NAMES.every(name => answers.filter(answer => answer.name === name).length === 1), j(answers.map(answer => `${answer.name}:${answer.landed}`)))
check('the dialog verbs ran in the order typed', j(answers.filter(answer => !['general', 'team', 'whisper'].includes(answer.name)).map(answer => answer.name)) === j(NAMES.filter(name => !['general', 'team', 'whisper'].includes(name))), j(answers.map(answer => answer.name)))
check('still no board file and no transcript file of the window\'s own', boardFiles().length === 0 && transcriptFiles().length === 0, strays())
pending.edit('')
await settle(200)
m.unmount()

section('§3 the board\'s two switches, called as the window calls them: never run on the window itself')
{
  const swarm = (await import('../../src/commands/swarm/swarm.js')) as unknown as DialogModule
  const swarmchat = (await import('../../src/commands/swarmchat/swarmchat.js')) as unknown as DialogModule
  const windowContext = { options: { isNonInteractiveSession: false } }
  const run = async (module: DialogModule, args: string, context: unknown = windowContext): Promise<{ said: string | undefined; element: unknown }> => {
    let said: string | undefined
    const element = await module.call(result => { said = result }, context, args)
    return { said, element }
  }
  slot.setFocusedSessionConnector(recording)
  board = null
  let before = handed.length
  const bare = await run(swarm, '')
  check('bare /swarm in a chat whose swarm is not on is sent to the session, which answers for itself', j(handed.slice(before)) === j(['/swarm']) && bare.said === undefined && bare.element === null, `${j(handed.slice(before))} · said ${j(bare.said)}`)
  board = { on: true, events: [], snapshot: 0, omitted: 0, peerTurns: 0 }
  before = handed.length
  const panel = await run(swarm, '')
  check('bare /swarm in a chat whose swarm is on opens Crew chat, as it did', panel.element !== null && handed.length === before, `element ${panel.element === null ? 'none' : 'present'} · handed ${j(handed.slice(before))}`)
  before = handed.length
  const usage = await run(swarm, 'bogus')
  check('an unknown verb answers the usage line and is sent nowhere', usage.said === 'usage: /swarm on|off|status — /swarm opens Crew chat' && handed.length === before, j(usage.said))
  slot.releaseFocusedSessionConnector()
  board = null
  const closedOn = await run(swarm, 'on')
  const closedStatus = await run(swarm, 'status')
  const closedBare = await run(swarm, '')
  const closedChat = await run(swarmchat, 'on')
  check('with no chat open /swarm on, /swarm status and bare /swarm answer the connector\'s own refusal', [closedOn, closedStatus, closedBare].every(answer => answer.said === NO_CHAT && answer.element === null), j([closedOn.said, closedStatus.said, closedBare.said]))
  check('…and so does /swarmchat on', closedChat.said === NO_CHAT, j(closedChat.said))
  check('…and no board file was made under the home for a window that is no conversation', boardFiles().length === 0, strays())
  const runner = await run(swarm, 'on', { options: { isNonInteractiveSession: true } })
  check('the runner, which is the session, still switches itself: its own answer and its own board', runner.said === 'Swarm on for new crewmates.' && boardFiles().length === 1, `${j(runner.said)} · ${strays()}`)
}

if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(`\n${failures === 0 ? `prove-swarm-switch-waits-for-the-landing: ${checks} checks, 0 failed` : `prove-swarm-switch-waits-for-the-landing: ${checks} checks, ${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)

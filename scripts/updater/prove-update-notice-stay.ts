#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('update-notice-stay')
const RUNNING = '1.0.0-beta.17'
const NEWER = '1.0.0-beta.18'
const FIVE_MINUTES_MS = 5 * 60 * 1000
const LONG_TIMER_MS = 15_000
;(globalThis as Record<string, unknown>).MACRO = { VERSION: RUNNING }
for (const key of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'MERCURY_UPDATE_NOTICE', 'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_JEV_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_UPDATE_API_BASE_URL']) process.env[base] = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_GH_CMD = JSON.stringify(['/usr/bin/false'])
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_HOME = join(HOME, 'proof-home')
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(process.env.MERCURY_HOME, { recursive: true })
process.chdir(PROJECT)

mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

class HeldTimer {
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  hasRef(): boolean {
    return false
  }
  refresh(): this {
    return this
  }
  close(): this {
    return this
  }
  [Symbol.toPrimitive](): number {
    return -1
  }
}
type Held = { fire: () => void; at: number; delayMs: number }
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const held = new Map<HeldTimer, Held>()
const armed: number[] = []
let clockMs = 0
globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
  if (typeof delay === 'number' && delay >= LONG_TIMER_MS) {
    const handle = new HeldTimer()
    held.set(handle, { fire: () => fn(...args), at: clockMs + delay, delayMs: delay })
    armed.push(delay)
    return handle
  }
  return realSetTimeout(fn, delay, ...args)
}) as unknown as typeof setTimeout
globalThis.clearTimeout = ((handle: unknown) => {
  if (handle instanceof HeldTimer) {
    held.delete(handle)
    return
  }
  realClearTimeout(handle as never)
}) as unknown as typeof clearTimeout
const clockLabel = (ms: number): string => {
  const whole = Math.floor(ms / 1000)
  const rest = ms % 1000
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s${rest === 0 ? '' : ` + ${rest} ms`}`
}
async function advance(ms: number): Promise<void> {
  const target = clockMs + ms
  for (;;) {
    const due = [...held.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
    if (due === undefined) break
    clockMs = due[1].at
    held.delete(due[0])
    due[1].fire()
    await settle(80)
  }
  clockMs = target
  await settle(200)
}
const armedWords = (): string => (armed.length === 0 ? 'none' : armed.map(ms => `${ms} ms`).join(', '))
function resetClock(): void {
  held.clear()
  armed.length = 0
  clockMs = 0
}
const hardLimit = realSetTimeout(() => {
  console.error('prove-update-notice-stay exceeded its deadline')
  process.exit(1)
}, 240_000)
hardLimit.unref()

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => {
  faults.push(args.map(String).join(' '))
  originalError(...args)
}

const React = await import('react')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { useAppState, useSetAppState } = await import('../../src/state/AppState.tsx')
const { enqueueNotification } = await import('../../src/context/notifications.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { BootSplashScreen } = await import('../../src/components/BootSplashScreen.tsx')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.tsx')
const { Chat } = await import('../../src/screens/Chat.tsx')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const pending = await import('../../src/input-core/pending-input.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.ts')
const notice = await import('../../src/services/privateChannel/quietUpdateNotice.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
markDaemonHaltStanddown()
const h = React.createElement
const stayMs = (notice as Record<string, unknown>).UPDATE_NOTICE_STAY_MS
const cachePath = notice.updateNoticeCachePath()
const seedNewer = (): void => notice.writeUpdateNoticeCache({ schema: 1, checkedAtMs: Date.now(), runningVersion: RUNNING, available: { version: NEWER, tag: `v${NEWER}` } }, cachePath)
const rowsWith = (m: Mounted, word: string): string => m.lines().filter(line => line.includes(word)).join(' | ')
const WARNING_FG = '38;2;219;161;61'
const FAINT_FG = '38;2;113;128;123'
const fgAcross = (m: Mounted, x0: number, y: number, width: number): string[] => [...new Set(Array.from({ length: width }, (_, i) => m.styleAt(x0 + i, y)?.fg ?? 'none'))]

console.log('============================================================')
console.log(' the quiet update notice is painted in the warning tone on both surfaces; the chat line stays for the whole session')
console.log('============================================================')

section("§0 the splash's constant")
check('quietUpdateNotice.ts exports UPDATE_NOTICE_STAY_MS = 5 minutes (300 000 ms) — the splash line\'s own stay', stayMs === FIVE_MINUTES_MS, `UPDATE_NOTICE_STAY_MS reads ${String(stayMs)}`)

section(`§1 the boot-splash line (120x40): "${notice.faceUpdateNoticeText(NEWER)}" is painted in the warning tone and stays five minutes while the splash is up`)
{
  const faceLine = notice.faceUpdateNoticeText(NEWER)
  seedNewer()
  const face = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(KeybindingSetup, null, h(BootSplashScreen))), 120, 40)
  const painted = await waitFor(() => face.screen().includes('↑↓ choose'), 15_000)
  await settle(400)
  const bottom = (): string => face.lines()[39] ?? ''
  check('the face painted its hint row', painted, face.lines().slice(0, 6).join(' | '))
  check(`the bottom row carries the line at its appearance`, bottom().includes(faceLine), JSON.stringify(bottom()))
  const lineAt = bottom().indexOf(faceLine)
  const lineTones = lineAt === -1 ? [] : fgAcross(face, lineAt, 39, faceLine.length)
  check(`every cell of the line is painted in the warning tone rgb(219, 161, 61) (the base tree paints it faint)`, lineTones.length === 1 && lineTones[0] === WARNING_FG, `tones across the line: ${lineTones.join(' ')}`)
  const hintTones = fgAcross(face, 2, 39, 2)
  check('the key-map hint beside it keeps the faint tone', hintTones.length === 1 && hintTones[0] === FAINT_FG, `tones across the hint: ${hintTones.join(' ')}`)
  check('the cache records the version announced on the face (the unchanged once-only law)', notice.readUpdateNoticeCache(cachePath)?.faceAnnounced === NEWER, JSON.stringify(notice.readUpdateNoticeCache(cachePath)))
  console.log(`  long timers armed since the face mounted: ${armedWords()}`)
  await advance(FIVE_MINUTES_MS - 1_000)
  check(`at ${clockLabel(clockMs)} the line still stands in the bottom row`, bottom().includes(faceLine), JSON.stringify(bottom()))
  await advance(2_000)
  check(`at ${clockLabel(clockMs)} the line has left the bottom row`, !bottom().includes(faceLine) && !face.screen().includes('available'), `the splash line outlives five minutes — the base holds it for the splash's whole life: ${JSON.stringify(bottom())}`)
  check('the card beneath is intact after the line leaves (one caret on New Session)', face.lines().filter(line => line.includes('❯')).length === 1 && face.lines().some(line => line.includes('❯') && line.includes('New Session')), rowsWith(face, '❯'))
  face.unmount()
  await settle(200)
  resetClock()
  seedNewer()
  const second = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(KeybindingSetup, null, h(BootSplashScreen))), 120, 40)
  await waitFor(() => second.screen().includes('↑↓ choose'), 15_000)
  await settle(400)
  check('a fresh face with the line seeded again paints it (the control for the early end)', (second.lines()[39] ?? '').includes(faceLine), JSON.stringify(second.lines()[39] ?? ''))
  const pendingBefore = [...held.values()].some(timer => timer.delayMs === FIVE_MINUTES_MS)
  second.unmount()
  await settle(200)
  const pendingAfter = [...held.values()].some(timer => timer.delayMs === FIVE_MINUTES_MS)
  check(`when the splash ends first the line's five-minute timer leaves with it (armed while up: ${pendingBefore})`, !pendingAfter, 'a five-minute timer still stands after the splash unmounted')
  resetClock()
}

type SetApp = Parameters<typeof enqueueNotification>[0]
type Seen = { key: string; priority: string; color: string | undefined; timeoutMs: number | undefined }
const probe = { setApp: null as SetApp | null, armedEntry: null as Seen | null, live: null as { key: string } | null }
function Probe(): null {
  const current = useAppState(state => state.notifications.current)
  probe.setApp = useSetAppState() as SetApp
  React.useEffect(() => {
    probe.live = current === null ? null : { key: current.key }
    if (current !== null && current.key === notice.UPDATE_NOTICE_KEY && probe.armedEntry === null) {
      probe.armedEntry = { key: current.key, priority: current.priority, color: 'text' in current ? current.color : undefined, timeoutMs: current.timeoutMs }
    }
  }, [current])
  return null
}
type SeatLive = typeof IDLE_LIVE
function seatFixture(): { setLive: (next: SeatLive) => void } {
  const listeners = new Set<() => void>()
  let live: SeatLive = IDLE_LIVE
  const tailStore = createStreamingTailStore()
  const seat = Object.assign(new NoSessionConnector(), {
    sessionId: () => 'proof-session',
    turnActive: () => live.inFlight,
    live: () => live,
    subscribeLive: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    status: () => ({ title: 'a chat', projectLabel: 'proof', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }),
    tail: () => tailStore,
    setLive: (next: SeatLive): void => {
      live = next
      for (const listener of listeners) listener()
    },
  })
  slot.setFocusedSessionConnector(seat)
  return seat
}
const TURN_LIVE: SeatLive = { ...IDLE_LIVE, inFlight: true, phase: 'thinking', inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: Date.now() }
async function mountChat(): Promise<Mounted & { setLive: (next: SeatLive) => void }> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const seat = seatFixture()
  probe.armedEntry = null
  probe.live = null
  const app = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(SurfaceRouter, null, h(Chat, { commands: [], initialTools: [] })), h(Probe))
  return { ...(await mountOffscreen(app, 178, 51)), setLive: seat.setLive }
}
const noticeRow = (m: Mounted, text: string): { x: number; y: number } | null => {
  const y = m.lines().findIndex(line => line.includes(text))
  return y === -1 ? null : { x: (m.lines()[y] ?? '').indexOf(text), y }
}

section(`§2 the notice-area line in the chat (178x51): "${notice.updateNoticeText(NEWER)}" is painted in the warning tone, never expires, and yields the row to a later receipt`)
{
  const noticeText = notice.updateNoticeText(NEWER)
  seedNewer()
  const chat = await mountChat()
  const composerRow = (): string => chat.lines().find(line => line.startsWith('│❯')) ?? ''
  const painted = await waitFor(() => composerRow().includes('Type a prompt'), 10_000)
  await settle(300)
  check('the chat painted its composer', painted, chat.lines().slice(-8).join(' | '))
  const arrived = await waitFor(() => probe.armedEntry !== null, notice.UPDATE_NOTICE_FIRST_DELAY_MS + 12_000)
  await settle(400)
  const onScreen = (): boolean => chat.screen().includes(noticeText)
  const seen = (): Seen | null => probe.armedEntry
  const liveKey = (): string | null => probe.live?.key ?? null
  check(`after the first-check delay the cached ${NEWER} is offered on the notice surface`, arrived && onScreen(), `arrived=${arrived} · rows: ${rowsWith(chat, 'available')}`)
  check("the entry rides the warning road: priority 'high', color 'warning' (the base tree posts it low and uncoloured)", seen()?.priority === 'high' && seen()?.color === 'warning', JSON.stringify(seen()))
  check('the entry carries no expiry (timeoutMs: Infinity — the base tree arms five minutes)', seen()?.timeoutMs === Infinity, `timeoutMs ${String(seen()?.timeoutMs)}`)
  console.log(`  long timers armed since the chat mounted: ${armedWords()}`)
  check('no five-minute or unbounded timer was armed for it', !armed.some(ms => ms === FIVE_MINUTES_MS || !Number.isFinite(ms)), armedWords())
  const at = noticeRow(chat, noticeText)
  const tones = at === null ? [] : fgAcross(chat, at.x, at.y, noticeText.length)
  check('every cell of the line is painted in the warning colour rgb(219, 161, 61)', tones.length === 1 && tones[0] === WARNING_FG, `tones across the line: ${tones.join(' ')} (row ${at?.y ?? '?'})`)
  await advance(20_001)
  check(`at ${clockLabel(clockMs)} the notice still stands`, liveKey() === notice.UPDATE_NOTICE_KEY && onScreen(), `gone at ${clockLabel(clockMs)} (current ${liveKey()})`)
  await advance(FIVE_MINUTES_MS + 1_000 - clockMs)
  check(`at ${clockLabel(clockMs)} the notice still stands (the base tree has dropped it)`, liveKey() === notice.UPDATE_NOTICE_KEY && onScreen(), `current ${liveKey()} · rows: ${rowsWith(chat, 'available')}`)
  await advance(60 * 60 * 1000 - clockMs)
  check(`at ${clockLabel(clockMs)} the notice still stands`, liveKey() === notice.UPDATE_NOTICE_KEY && onScreen(), `current ${liveKey()} · rows: ${rowsWith(chat, 'available')}`)
  const interruptHint = (): boolean => chat.lines().some(line => /\binterrupt\b/.test(line))
  check('at idle the hint row carries no turn hint beside the notice', !interruptHint(), rowsWith(chat, 'interrupt'))
  chat.setLive(TURN_LIVE)
  const turnPainted = await waitFor(() => interruptHint(), 5_000)
  await settle(300)
  check("while a turn runs the hint row shows the turn's own hint (esc interrupt) and not the notice — the entry itself still stands", turnPainted && !onScreen() && liveKey() === notice.UPDATE_NOTICE_KEY, `interrupt=${turnPainted} · current ${liveKey()} · rows: ${rowsWith(chat, 'available')}`)
  chat.setLive(IDLE_LIVE)
  const idleAgain = await waitFor(() => onScreen() && !interruptHint(), 5_000)
  await settle(300)
  check('when the turn ends the notice is back on the row and the turn hint is gone', idleAgain && liveKey() === notice.UPDATE_NOTICE_KEY, `current ${liveKey()} · rows: ${rowsWith(chat, 'available')} · ${rowsWith(chat, 'interrupt')}`)
  const tonesAgain = (() => {
    const row = noticeRow(chat, noticeText)
    return row === null ? [] : fgAcross(chat, row.x, row.y, noticeText.length)
  })()
  check('…in the warning colour as before', tonesAgain.length === 1 && tonesAgain[0] === WARNING_FG, `tones across the line: ${tonesAgain.join(' ')}`)
  check('the app setter reached the probe', probe.setApp !== null)
  enqueueNotification(probe.setApp as SetApp, { key: 'proof-receipt', text: 'a receipt for the proof', priority: 'low', timeoutMs: 20_000 })
  await settle(400)
  check('a later low-priority receipt takes the row and the update line waits behind it', liveKey() === 'proof-receipt' && chat.screen().includes('a receipt for the proof') && !onScreen(), `current ${liveKey()} · rows: ${rowsWith(chat, 'receipt')}`)
  await advance(20_001)
  check('when the receipt expires the update line returns on its own', liveKey() === notice.UPDATE_NOTICE_KEY && onScreen() && !chat.screen().includes('a receipt for the proof'), `current ${liveKey()} · rows: ${rowsWith(chat, 'available')}`)
  check('the composer is still there beneath', composerRow().includes('Type a prompt') || composerRow() !== '', composerRow())
  chat.unmount()
  await settle(200)
  resetClock()
}

section(`§3 after the update: the cache that offered ${NEWER} under ${RUNNING} shows nothing once ${NEWER} is the running version`)
{
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: NEWER }
  seedNewer()
  const face = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(BootSplashScreen))), 120, 40)
  const painted = await waitFor(() => face.screen().includes('↑↓ choose'), 15_000)
  await settle(400)
  check('the splash painted', painted, face.lines().slice(0, 6).join(' | '))
  check('the splash paints no update line for the version now running', !face.screen().includes('available'), rowsWith(face, 'available'))
  check('the cache records no face announcement', notice.readUpdateNoticeCache(cachePath)?.faceAnnounced === undefined, JSON.stringify(notice.readUpdateNoticeCache(cachePath)))
  face.unmount()
  await settle(200)
  resetClock()
  const chat = await mountChat()
  const chatPainted = await waitFor(() => (chat.lines().find(line => line.startsWith('│❯')) ?? '').includes('Type a prompt'), 10_000)
  check('the chat painted its composer', chatPainted, chat.lines().slice(-8).join(' | '))
  const offered = await waitFor(() => probe.armedEntry !== null, notice.UPDATE_NOTICE_FIRST_DELAY_MS + 4_000)
  check('the chat posts no update line for the version now running (the stale cache is never read as an offer)', !offered && !chat.screen().includes('available'), `offered=${offered} · ${JSON.stringify(probe.armedEntry)} · rows: ${rowsWith(chat, 'available')}`)
  chat.unmount()
  await settle(200)
  resetClock()
}

console.error = originalError
realClearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
if (failures === 0) await releaseScratchHome(HOME)
else console.log(`scratch home kept: ${HOME}`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

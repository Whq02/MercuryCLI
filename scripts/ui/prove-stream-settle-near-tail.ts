import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('stream-settle-near-tail')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_HOME = join(HOME, 'proof-home')
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.MERCURY_REDUCED_MOTION
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'proof-project')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
mkdirSync(process.env.MERCURY_HOME, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { InkInstanceContext } = await import('../../src/ink/components/InkInstanceContext.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.tsx')
const { Chat } = await import('../../src/screens/Chat.tsx')
const route = await import('../../src/context/surfaceRoute.ts')
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/hooks/useLayoutTier.ts')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { setCwdState, setIsInteractive } = await import('../../src/bootstrap/state.ts')
const { getKeybindingsPath } = await import('../../src/keybindings/loadUserBindings.ts')
setCwdState(PROJECT)
setIsInteractive(true)
writeFileSync(
  getKeybindingsPath(),
  JSON.stringify(
    {
      $schema: 'https://www.schemastore.org/mercury-keybindings.json',
      bindings: [{ context: 'Scroll', bindings: { 'ctrl+y': 'scroll:lineUp' } }],
    },
    null,
    2,
  ),
)
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')
const { getCommands } = await import('../../src/commands.ts')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
type Message = import('../../src/types/message.ts').Message
type SessionLiveV1 = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1
type SeatStatusV1 = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1
type InkInstance = NonNullable<React.ContextType<typeof InkInstanceContext>>
type InkInternal = {
  scheduler?: { state: () => string }
  frameListeners?: ReadonlySet<unknown>
}

markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)

const LINE_UP = '\x19'
const ALT_DOWN = '\x1b[1;3B'
const hasPill = (s: string): boolean => /\[ (?:back to the bottom|\d+ new messages?) · alt\+↓ \]/.test(s)
const SETTLE_CEILING_MS = 15_000
const QUIET_STEP_MS = 45

const topMarkFrom = (screen: string): string | undefined => screen.match(/(?:STREAM|PRIOR|FOLLOW)-\d+/)?.[0]
const topMark = (m: Mounted): string | undefined => topMarkFrom(m.screen())

function zeroHeightHookAttachment(uuid: string): Message {
  return {
    type: 'attachment',
    uuid,
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'hook',
      name: 'post-turn-check',
      event: 'turn.answer',
      outcome: 'text',
      words: 'verified',
    },
  } as unknown as Message
}

function buildReplyText(prefix: string, lineCount: number, endMarker: string): string {
  return Array.from(
    { length: lineCount },
    (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')} streaming line in the active reply${i === lineCount - 1 ? ` ${endMarker}` : ''}`,
  ).join('\n')
}

for (const [cols, rows] of [[120, 40], [178, 51]] as const) {
  const tag = `${cols}x${rows}`
  const tailStore = createStreamingTailStore({ intervalMs: 1 })
  let records: Message[] = []
  let liveState: SessionLiveV1 = IDLE_LIVE
  const recordListeners = new Set<() => void>()
  const liveListeners = new Set<() => void>()
  const baseStatus: SeatStatusV1 = {
    title: `stream-${tag}`,
    projectLabel: 'proof-project',
    interrupting: false,
    hardStopping: false,
    wait: null,
    quietMs: null,
    watchdogMs: null,
    phaseMs: null,
    toolBudgetMs: null,
    stuck: false,
    runner: null,
  }

  const notifyRecords = (): void => {
    for (const listener of recordListeners) listener()
  }
  const notifyLive = (): void => {
    for (const listener of liveListeners) listener()
  }

  const sessionId = `stream-settle-${tag}`
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => sessionId,
      records: () => records,
      subscribeRecords: (listener: () => void) => {
        recordListeners.add(listener)
        return () => recordListeners.delete(listener)
      },
      live: () => liveState,
      subscribeLive: (listener: () => void) => {
        liveListeners.add(listener)
        return () => liveListeners.delete(listener)
      },
      status: () => baseStatus,
      tail: () => tailStore,
    }),
  )

  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  layoutChromeLive(cols, rows)
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})

  let inkTap: InkInstance | undefined
  let frameSeq = 0
  let baseListeners = 0
  function InkTap(): null {
    const ink = React.useContext(InkInstanceContext)
    inkTap = ink
    React.useLayoutEffect(() => {
      if (!ink) return
      const unsub = ink.subscribeFrame(() => {
        frameSeq++
      })
      const internal = ink as unknown as InkInternal
      baseListeners = internal.frameListeners ? internal.frameListeners.size : 0
      return unsub
    }, [ink])
    return null
  }

  const m = await mountOffscreen(
    h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(InkTap, null), h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))),
    cols,
    rows,
    { mouseTracking: true },
  )

  const schedulerQuiet = (): boolean => {
    const internal = inkTap as unknown as InkInternal | undefined
    if (!internal) return false
    const state = internal.scheduler?.state()
    if (state !== undefined && state !== 'idle' && state !== 'window-open') return false
    if (internal.frameListeners !== undefined && internal.frameListeners.size > baseListeners) return false
    return true
  }

  const paneText = (frame: string): string => frame.replace(/│ [◐◓◑◒●][^\n]*/g, '')

  const waitScreenSettled = async (label: string, ready: (frame: string) => boolean, ceilingMs = SETTLE_CEILING_MS): Promise<string> => {
    const deadline = Date.now() + ceilingMs
    let stableCount = 0
    let prevPane = ''
    let lastFrame = ''
    while (Date.now() < deadline) {
      await settle(QUIET_STEP_MS)
      const frame = m.screen()
      const pane = paneText(frame)
      lastFrame = frame
      if (ready(frame) && schedulerQuiet()) {
        if (pane === prevPane) {
          stableCount++
          if (stableCount >= 2) return frame
        } else {
          prevPane = pane
          stableCount = 1
        }
      } else {
        prevPane = ''
        stableCount = 0
      }
    }
    throw new Error(`screen never settled for ${label} within ${ceilingMs}ms (top=${topMarkFrom(lastFrame) ?? 'none'})\n${lastFrame}`)
  }

  const replyLinesNear = rows === 40 ? 35 : 46

  try {
    await waitScreenSettled(`${tag} initial mount`, frame => frame.includes('Type a prompt'))
    const seenBeforeMarks = new Set<string>()

    for (let n = 1; n <= 8; n++) {
      const endMarker = `NEAR-END-${n}`
      const replyText = buildReplyText('STREAM', replyLinesNear, endMarker)
      const anchorMsg = createAssistantMessage({ content: 'ANCHOR-01\nANCHOR-02\nANCHOR-03\nANCHOR-04' })
      const promptMsg = createUserMessage({ content: `prompt near ${n}` })
      tailStore.reset(null)
      tailStore.dropSettled()
      records = [anchorMsg, promptMsg]
      liveState = { ...IDLE_LIVE, inFlight: true, phase: 'responding', turnStartedAtMs: null }
      notifyRecords()
      notifyLive()
      await waitScreenSettled(`${tag} N=${n} prompt`, frame => frame.includes(`prompt near ${n}`))
      if (hasPill(m.screen())) {
        m.push(ALT_DOWN)
        await waitScreenSettled(`${tag} N=${n} repin`, frame => !hasPill(frame))
      }

      tailStore.setMessageId(`msg-near-${tag}-${n}`)
      tailStore.update(() => replyText)
      await waitScreenSettled(`${tag} N=${n} streaming at tail`, frame => frame.includes(endMarker) && !hasPill(frame))

      for (let step = 0; step < n; step++) {
        m.push(LINE_UP)
        await settle(15)
      }
      await waitScreenSettled(`${tag} N=${n} scrolled up`, frame => hasPill(frame) && !frame.includes(endMarker))
      const beforeSettle = topMark(m)
      if (beforeSettle) seenBeforeMarks.add(beforeSettle)

      const att1 = zeroHeightHookAttachment(`00000000-0000-4000-8000-000000010${cols}${n}`)
      const att2 = zeroHeightHookAttachment(`00000000-0000-4000-8000-000000020${cols}${n}`)
      const att3 = zeroHeightHookAttachment(`00000000-0000-4000-8000-000000030${cols}${n}`)
      const settledReply = createAssistantMessage({ content: replyText })
      records = [anchorMsg, promptMsg, att1, att2, att3, settledReply]
      tailStore.reset(null)
      tailStore.dropSettled()
      liveState = IDLE_LIVE
      notifyRecords()
      notifyLive()

      await waitScreenSettled(`${tag} N=${n} settled`, frame => !frame.includes('esc interrupt'))
      const afterSettle = topMark(m)
      check(
        `${tag}, N=${n} above tail: top row stays on ${beforeSettle} across stream settle`,
        beforeSettle !== undefined && afterSettle === beforeSettle && hasPill(m.screen()),
        `before=${beforeSettle} after=${afterSettle} pill=${hasPill(m.screen())}`,
      )
    }
    check(`${tag}: N=1..8 stepped across eight distinct pre-settle top rows`, seenBeforeMarks.size === 8, `${seenBeforeMarks.size}: ${[...seenBeforeMarks].join(',')}`)

    {
      const followEnd = `FOLLOW-END-${tag}`
      const followText = buildReplyText('FOLLOW', 60, followEnd)
      const promptMsg = createUserMessage({ content: `follow prompt ${tag}` })
      records = [promptMsg]
      liveState = { ...IDLE_LIVE, inFlight: true, phase: 'responding', turnStartedAtMs: null }
      notifyRecords()
      notifyLive()
      await waitScreenSettled(`${tag} follow prompt`, frame => frame.includes(`follow prompt ${tag}`))
      m.push(ALT_DOWN)
      await waitScreenSettled(`${tag} follow repin`, frame => !hasPill(frame))

      tailStore.setMessageId(`msg-follow-${tag}`)
      tailStore.update(() => followText)
      await waitScreenSettled(`${tag} follow streaming`, frame => frame.includes(followEnd) && !hasPill(frame))

      records = [
        promptMsg,
        zeroHeightHookAttachment(`00000000-0000-4000-8000-000000040${cols}`),
        zeroHeightHookAttachment(`00000000-0000-4000-8000-000000050${cols}`),
        createAssistantMessage({ content: followText }),
      ]
      tailStore.reset(null)
      tailStore.dropSettled()
      liveState = IDLE_LIVE
      notifyRecords()
      notifyLive()
      await waitScreenSettled(`${tag} follow settled`, frame => frame.includes(followEnd))
      check(
        `${tag}: sticky view following the tail keeps the tail through settle with no jump pill`,
        m.screen().includes(followEnd) && !hasPill(m.screen()),
        `end=${m.screen().includes(followEnd)} pill=${hasPill(m.screen())}`,
      )
    }

    {
      const prior: Message[] = Array.from({ length: 8 }, (_, p) =>
        createAssistantMessage({
          content: Array.from({ length: 10 }, (_, l) => `PRIOR-${String(p * 10 + l + 1).padStart(2, '0')} earlier turn line`).join('\n'),
        }),
      )
      const deepEnd = `DEEP-END-${tag}`
      const deepText = buildReplyText('STREAM', 60, deepEnd)
      const promptMsg = createUserMessage({ content: `deep prompt ${tag}` })
      records = [...prior, promptMsg]
      liveState = { ...IDLE_LIVE, inFlight: true, phase: 'responding', turnStartedAtMs: null }
      notifyRecords()
      notifyLive()
      await waitScreenSettled(`${tag} deep prompt`, frame => frame.includes(`deep prompt ${tag}`))
      m.push(ALT_DOWN)
      await waitScreenSettled(`${tag} deep repin`, frame => !hasPill(frame))

      tailStore.setMessageId(`msg-deep-${tag}`)
      tailStore.update(() => deepText)
      await waitScreenSettled(`${tag} deep streaming`, frame => frame.includes(deepEnd) && !hasPill(frame))

      for (let step = 0; step < 50; step++) {
        m.push(LINE_UP)
        if (step % 4 === 3) await settle(10)
      }
      await waitScreenSettled(`${tag} deep 50 up`, frame => hasPill(frame) && !frame.includes(deepEnd))
      const beforeDeep = topMark(m)

      records = [
        ...prior,
        promptMsg,
        zeroHeightHookAttachment(`00000000-0000-4000-8000-000000060${cols}`),
        zeroHeightHookAttachment(`00000000-0000-4000-8000-000000070${cols}`),
        createAssistantMessage({ content: deepText }),
      ]
      tailStore.reset(null)
      tailStore.dropSettled()
      liveState = IDLE_LIVE
      notifyRecords()
      notifyLive()
      await waitScreenSettled(`${tag} deep settled`, frame => hasPill(frame))
      const afterDeep = topMark(m)
      check(
        `${tag}, N=50 above tail: reader fifty rows up stays on ${beforeDeep} across stream settle`,
        beforeDeep !== undefined && afterDeep === beforeDeep && hasPill(m.screen()),
        `before=${beforeDeep} after=${afterDeep}`,
      )
    }
  } finally {
    tailStore.dispose()
    m.unmount()
  }
}

console.log(`stream-settle-near-tail: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)

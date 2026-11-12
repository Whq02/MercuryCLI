import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('flip-restore-yields')
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
process.env.MERCURY_REDUCED_MOTION = '1'
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
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/input-core/pending-input.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { getCommands } = await import('../../src/commands.ts')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
type Message = import('../../src/types/message.ts').Message
type InkInstance = NonNullable<React.ContextType<typeof InkInstanceContext>>
type InkInternal = {
  scheduler?: { state: () => string }
  frameListeners?: ReadonlySet<unknown>
}

markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)

const CTRL_O = '\x0f'
const PAGE_UP = '\x1b[5~'
const ALT_DOWN = '\x1b[1;3B'
const WHEEL_UP = '\x1b[<64;70;10M'
const PILL = 'back to the bottom'
const SETTLE_CEILING_MS = 15_000
const QUIET_STEP_MS = 45

function makeHistory(): Message[] {
  return Array.from({ length: 40 }, (_, n) =>
    createAssistantMessage({
      content: Array.from(
        { length: 10 },
        (_, line) => `MARK-${String(n).padStart(2, '0')}-${String(line).padStart(2, '0')} a recorded line holding the reader's place${n === 39 && line === 9 ? ' TAIL-END' : ''}`,
      ).join('\n'),
    }),
  )
}

const topMarkFrom = (screen: string): string | undefined => screen.match(/MARK-\d+-\d+/)?.[0]
const topMark = (m: Mounted): string | undefined => topMarkFrom(m.screen())
const markRank = (mark: string | undefined): number => {
  if (!mark) return -1
  const parts = /^MARK-(\d+)-(\d+)$/.exec(mark)
  return parts ? Number(parts[1]) * 10 + Number(parts[2]) : -1
}

for (const [cols, rows] of [[120, 40], [178, 51]] as const) {
  const tag = `${cols}x${rows}`
  let records: Message[] = makeHistory()
  const recordListeners = new Set<() => void>()
  const appendRow = (row: Message): void => {
    records = [...records, row]
    for (const listener of recordListeners) listener()
  }
  const sessionId = `flip-restore-${tag}`
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => sessionId,
      records: () => records,
      subscribeRecords: (listener: () => void) => {
        recordListeners.add(listener)
        return () => recordListeners.delete(listener)
      },
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

  const waitScreenSettled = async (label: string, ready: (frame: string) => boolean, ceilingMs = SETTLE_CEILING_MS): Promise<string> => {
    const deadline = Date.now() + ceilingMs
    let stableCount = 0
    let prevFrame = ''
    let prevSeq = -1
    let lastFrame = ''
    while (Date.now() < deadline) {
      await settle(QUIET_STEP_MS)
      const frame = m.screen()
      const seq = frameSeq
      lastFrame = frame
      if (ready(frame) && schedulerQuiet()) {
        if (frame === prevFrame && seq === prevSeq) {
          stableCount++
          if (stableCount >= 2) return frame
        } else {
          prevFrame = frame
          prevSeq = seq
          stableCount = 1
        }
      } else {
        prevFrame = ''
        prevSeq = -1
        stableCount = 0
      }
    }
    const internal = inkTap as unknown as InkInternal | undefined
    throw new Error(
      `screen never settled for ${label} within ${ceilingMs}ms (top=${topMarkFrom(lastFrame) ?? 'none'}, seq=${frameSeq}, scheduler=${internal?.scheduler?.state() ?? 'unknown'}, listeners=${internal?.frameListeners?.size ?? -1}/${baseListeners})\n${lastFrame}`,
    )
  }

  const runOnFirstRestoreFrame = async (
    label: string,
    trigger: () => void,
    followUp: () => void,
    ready: (frame: string) => boolean,
  ): Promise<void> => {
    if (!inkTap) throw new Error('missing InkInstanceContext')
    let followedUp = false
    const stop = inkTap.subscribeFrame(() => {
      stop()
      queueMicrotask(() => {
        followUp()
        followedUp = true
      })
    })
    trigger()
    await waitScreenSettled(label, frame => followedUp && ready(frame))
  }

  try {
    await waitScreenSettled(`${tag} initial mount`, frame => frame.includes('TAIL-END') && frame.includes('Type a prompt'))
    check(`${tag}: chat mounted at the tail`, m.screen().includes('TAIL-END') && m.screen().includes('Type a prompt'), topMark(m) ?? 'none')

    const leaveTail = async (): Promise<string | undefined> => {
      if (m.screen().includes('detailed transcript')) {
        m.push(CTRL_O)
        await waitScreenSettled(`${tag} leaveTail exit detail`, frame => frame.includes('Type a prompt'))
      }
      if (!m.screen().includes('TAIL-END') || m.screen().includes(PILL)) {
        m.push(ALT_DOWN)
        await waitScreenSettled(`${tag} leaveTail repin`, frame => frame.includes('TAIL-END') && !frame.includes(PILL))
      }
      m.push(WHEEL_UP)
      const afterFirstWheel = await waitScreenSettled(`${tag} wheel 1`, frame => frame.includes(PILL) && !frame.includes('TAIL-END'))
      const firstWheelMark = topMarkFrom(afterFirstWheel)
      m.push(WHEEL_UP)
      const afterSecondWheel = await waitScreenSettled(
        `${tag} wheel 2`,
        frame => frame.includes(PILL) && topMarkFrom(frame) !== undefined && topMarkFrom(frame) !== firstWheelMark,
      )
      return topMarkFrom(afterSecondWheel)
    }

    const offMark = await leaveTail()
    check(`${tag}: wheel leaves the tail with the jump pill shown`, offMark !== undefined && m.screen().includes(PILL) && !m.screen().includes('TAIL-END'), `${offMark}`)

    m.push(CTRL_O)
    await waitScreenSettled(`${tag} roundtrip enter detail`, frame => frame.includes('detailed transcript'))
    m.push(CTRL_O)
    await waitScreenSettled(`${tag} roundtrip exit detail`, frame => frame.includes('Type a prompt'))
    check(`${tag}: an uninterrupted flip round-trip still preserves the row`, topMark(m) === offMark && m.screen().includes(PILL), `${offMark} -> ${topMark(m)}`)

    m.push(CTRL_O)
    const refDetail = await waitScreenSettled(`${tag} reference enter detail`, frame => frame.includes('detailed transcript'))
    const refDetailMark = topMarkFrom(refDetail)
    m.push(PAGE_UP)
    const afterRefPageUp = await waitScreenSettled(
      `${tag} reference PageUp`,
      frame => topMarkFrom(frame) !== undefined && markRank(topMarkFrom(frame)) < markRank(refDetailMark) - 10,
    )
    const settledPageUpMark = topMarkFrom(afterRefPageUp)
    m.push('g')
    const afterRefTop = await waitScreenSettled(
      `${tag} reference top g`,
      frame => topMarkFrom(frame) !== undefined && markRank(topMarkFrom(frame)) < markRank(settledPageUpMark),
    )
    const settledTopMark = topMarkFrom(afterRefTop)
    m.push(CTRL_O)
    await waitScreenSettled(`${tag} reference exit detail`, frame => frame.includes('Type a prompt'))

    const beforeChunk = await leaveTail()
    m.push(CTRL_O + PAGE_UP)
    await waitScreenSettled(`${tag} buffered ctrl+o + PageUp`, frame => frame.includes('detailed transcript'))
    const afterChunkPageUp = topMark(m)
    check(
      `${tag}: a buffered ctrl+o + PageUp chunk is not overwritten back to the pre-flip gap`,
      markRank(afterChunkPageUp) < markRank(beforeChunk) - 10,
      `expected < ${beforeChunk}, got ${afterChunkPageUp}`,
    )

    const beforeBurst = await leaveTail()
    await runOnFirstRestoreFrame(
      `${tag} mid-restore PageUp`,
      () => m.push(CTRL_O),
      () => m.push(PAGE_UP),
      frame => frame.includes('detailed transcript'),
    )
    const afterFramePageUp = topMark(m)
    check(
      `${tag}: PageUp inside the restore frames is not overwritten back to the pre-flip gap`,
      afterFramePageUp === settledPageUpMark && markRank(afterFramePageUp) < markRank(beforeBurst) - 10,
      `expected ${settledPageUpMark} (< ${beforeBurst}), got ${afterFramePageUp}`,
    )

    await runOnFirstRestoreFrame(
      `${tag} mid-restore Alt+Down`,
      () => m.push(CTRL_O),
      () => m.push(ALT_DOWN),
      frame => frame.includes('Type a prompt'),
    )
    check(
      `${tag}: Alt+Down inside the restore frames pins to the tail instead of being pulled back off it`,
      m.screen().includes('TAIL-END') && !m.screen().includes(PILL),
      `top=${topMark(m)} pill=${m.screen().includes(PILL)}`,
    )

    await leaveTail()
    await runOnFirstRestoreFrame(
      `${tag} mid-restore g`,
      () => m.push(CTRL_O),
      () => m.push('g'),
      frame => frame.includes('detailed transcript'),
    )
    check(
      `${tag}: detailed transcript g inside the restore frames stays at the top of the slice`,
      settledTopMark !== undefined && topMark(m) === settledTopMark && markRank(topMark(m)) < markRank(settledPageUpMark),
      `expected ${settledTopMark}, got ${topMark(m)}`,
    )

    m.push(CTRL_O)
    await waitScreenSettled(`${tag} pre-repin exit detail`, frame => frame.includes('Type a prompt'))
    await leaveTail()
    m.push(CTRL_O)
    await waitScreenSettled(`${tag} pre-repin enter detail`, frame => frame.includes('detailed transcript'))
    const humanTail = `HUMAN-TAIL-${tag}`
    await runOnFirstRestoreFrame(
      `${tag} mid-restore repinToBottom`,
      () => m.push(CTRL_O),
      () => appendRow(createUserMessage({ content: humanTail })),
      frame => frame.includes('Type a prompt'),
    )
    check(
      `${tag}: repinToBottom inside the restore frames keeps the view pinned on the new tail`,
      m.screen().includes(humanTail) && !m.screen().includes(PILL),
      `top=${topMark(m)} humanTail=${m.screen().includes(humanTail)} pill=${m.screen().includes(PILL)}`,
    )
  } finally {
    m.unmount()
  }
}

console.log(`flip-restore-yields: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)

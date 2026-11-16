import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const HOME = pinScratchHome('flip-into-a-short-view')
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
const WHEEL_UP = '\x1b[<64;70;10M'
const PILL = 'back to the bottom'
const SETTLE_CEILING_MS = 15_000
const QUIET_STEP_MS = 45
const THOUGHT_LINES = 90
const NOTCHES = 7

function makeHistory(): Message[] {
  const thought = Array.from({ length: THOUGHT_LINES }, (_, line) => `THOUGHT-${String(line).padStart(2, '0')} a line of reasoning the prompt view folds away`).join('\n')
  return [
    createUserMessage({ content: 'FIRST-ROW a short question' }),
    createAssistantMessage({ content: [{ type: 'thinking', thinking: thought, signature: 'sig' } as never, { type: 'text', text: 'a short answer TAIL-END' } as never] }),
  ]
}

const thoughtRows = (screen: string): number => (screen.match(/THOUGHT-\d+/g) ?? []).length
const topThought = (screen: string): string | undefined => screen.match(/THOUGHT-\d+/)?.[0]
const renderError = (screen: string): boolean => /render error/i.test(screen)

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
      `screen never settled for ${label} within ${ceilingMs}ms (top=${topThought(lastFrame) ?? 'none'}, seq=${frameSeq}, scheduler=${internal?.scheduler?.state() ?? 'unknown'}, listeners=${internal?.frameListeners?.size ?? -1}/${baseListeners})\n${lastFrame}`,
    )
  }

  try {
    const mounted = await waitScreenSettled(`${tag} initial mount`, frame => frame.includes('TAIL-END') && frame.includes('Type a prompt'))
    check(
      `${tag}: the prompt view holds the whole short session, its first row and its tail, with no jump pill (the thinking is folded away)`,
      mounted.includes('FIRST-ROW') && mounted.includes('TAIL-END') && !mounted.includes(PILL) && thoughtRows(mounted) === 0,
      `first=${mounted.includes('FIRST-ROW')} tail=${mounted.includes('TAIL-END')} pill=${mounted.includes(PILL)} thought rows=${thoughtRows(mounted)}`,
    )

    const errors: string[] = []
    const onError = (error: unknown): void => {
      errors.push(String((error as Error)?.message ?? error).slice(0, 300))
    }
    process.on('uncaughtException', onError)
    process.on('unhandledRejection', onError)

    m.push(CTRL_O)
    const detail = await waitScreenSettled(`${tag} enter detail at the tail`, frame => frame.includes('detailed transcript') && frame.includes('TAIL-END'))
    check(`${tag}: the detailed transcript is longer than its viewport: at its tail it shows the thinking but not its first line`, thoughtRows(detail) > 10 && !detail.includes('THOUGHT-00'), `thought rows=${thoughtRows(detail)} first line shown=${detail.includes('THOUGHT-00')}`)
    const tailTop = topThought(detail)
    for (let notch = 0; notch < NOTCHES; notch++) {
      m.push(WHEEL_UP)
      await settle(60)
    }
    const scrolled = await waitScreenSettled(`${tag} scrolled up in detail`, frame => frame.includes('detailed transcript') && frame.includes(PILL) && !frame.includes('TAIL-END'))
    check(`${tag}: ${NOTCHES} wheel notches up in the detailed transcript leave its tail and show the jump pill`, scrolled.includes(PILL) && !scrolled.includes('TAIL-END') && topThought(scrolled) !== tailTop, `pill=${scrolled.includes(PILL)} top ${tailTop} -> ${topThought(scrolled)}`)

    m.push(CTRL_O)
    let settleFault = ''
    let back = ''
    try {
      back = await waitScreenSettled(`${tag} leave detail scrolled up`, frame => frame.includes('Type a prompt') || renderError(frame))
    } catch (error) {
      settleFault = String((error as Error).message).split('\n')[0]!.slice(0, 200)
      back = m.screen()
    }
    check(
      `${tag}: leaving the scrolled detailed transcript paints the prompt view: no render error, nothing thrown`,
      errors.length === 0 && settleFault === '' && !renderError(back) && back.includes('Type a prompt'),
      `thrown=${JSON.stringify(errors).slice(0, 300)} render error on the screen=${renderError(back)} prompt view=${back.includes('Type a prompt')} ${settleFault}`,
    )
    check(
      `${tag}: the short prompt view is whole again and shows no jump pill (there is nothing below to go back to)`,
      back.includes('FIRST-ROW') && back.includes('TAIL-END') && !back.includes(PILL),
      `first=${back.includes('FIRST-ROW')} tail=${back.includes('TAIL-END')} pill=${back.includes(PILL)}`,
    )

    const arriving = rows + 6
    for (let n = 0; n < arriving; n++) appendRow(createAssistantMessage({ content: `ARRIVED-${String(n).padStart(2, '0')} a row that lands after the reader came back` }))
    const last = `ARRIVED-${String(arriving - 1).padStart(2, '0')}`
    let followed = ''
    try {
      followed = await waitScreenSettled(`${tag} rows arriving after the flip`, frame => frame.includes(last) || renderError(frame), 6000)
    } catch {
      followed = m.screen()
    }
    check(
      `${tag}: rows that arrive afterwards are followed to the newest one, with no jump pill (the view stayed pinned to its tail)`,
      followed.includes(last) && !followed.includes('TAIL-END') && !followed.includes(PILL) && !renderError(followed),
      `newest=${followed.includes(last)} the old tail still shown=${followed.includes('TAIL-END')} pill=${followed.includes(PILL)} render error=${renderError(followed)}`,
    )
    process.off('uncaughtException', onError)
    process.off('unhandledRejection', onError)
  } finally {
    m.unmount()
  }
}

console.log(`flip-into-a-short-view: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)

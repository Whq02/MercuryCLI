import { mock, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, type Mounted } from '../lib/settingsPopupHarness.ts'

type Step = { label: string; title: string | null; cursor: string; calls: string[]; modes: string[]; lines: string[] }
type Recording = { scenario: string; size: string; warmups: string; steps: Step[] }

type Message = import('../../src/engine/message-shapes/message.ts').Message
type SessionLiveV1 = import('../../src/engine/connector/seatLive.ts').SessionLiveV1
type SeatStatusV1 = import('../../src/engine/connector/seatLive.ts').SeatStatusV1
type SessionAskV1 = import('../../src/engine/connector/types.ts').SessionAskV1
type PermissionMode = import('../../src/permissions/rules/permissions.ts').PermissionMode
type AppStateStore = ReturnType<typeof import('../../src/screen/app-state/AppState.tsx').useAppStateStore>

type ScriptedSession = {
  connector: object
  calls: string[]
  hooks: { onInterrupt?: () => void }
  records: () => Message[]
  setRecords: (next: Message[]) => void
  addRecords: (...rows: Message[]) => void
  setLive: (next: Partial<SessionLiveV1>) => void
  setStatus: (next: Partial<SeatStatusV1>) => void
  setAsks: (next: SessionAskV1[]) => void
  setRunnerMode: (mode: PermissionMode | null) => void
  setModelFacts: (next: Record<string, unknown>) => void
  refuseSends: (detail: string | null) => void
  holdSends: () => () => void
  failSends: (fault: string | null) => void
  refuseModes: (detail: string | null) => void
  setCompletedAt: (at: number | null) => void
  setLostLine: (line: { text: string; atMs: number } | null) => void
  setStoreFailing: (sentence: string | null) => void
  setAdmissionRefusal: (reason: string | null) => void
  setUsage: (costUSD: number, consoleBilling: boolean) => void
  stream: (text: string | null) => void
}

type Stage = {
  view: Mounted
  home: string
  project: string
  session: ScriptedSession
  store: () => AppStateStore
  src: SrcDoor
  mark: (label: string, ready?: (frame: string) => boolean) => Promise<void>
  key: (data: string, label: string, ready?: (frame: string) => boolean) => Promise<void>
  type: (text: string) => Promise<void>
  whileTyped: (run: () => Promise<void>) => Promise<void>
  emit: (event: 'suspend' | 'resume') => void
  resize: (columns: number, rows: number, label: string) => Promise<void>
  focus: (session: ScriptedSession | null) => void
  newSession: (id: string, records?: Message[]) => ScriptedSession
  user: (text: string) => Message
  assistant: (text: string) => Message
  askFor: (id: string, command: string) => SessionAskV1
  screen: () => string
  paintedAfter: (words: string) => Promise<number>
  dialogs: Array<{ name: string; args: string; done: (result?: string, options?: Record<string, unknown>) => void }>
  dispatch: (command: string) => void
  plainWorld: () => void
  handshake: (line: string | null) => void
  warmups: () => string
  steps: Step[]
}

type SrcDoor = {
  pending: typeof import('../../src/screen/composer/input-core/pending-input.ts')
  slot: typeof import('../../src/engine/connector/focusedConnector.ts')
  route: typeof import('../../src/screen/routes/surfaceRoute.ts')
  seatLive: typeof import('../../src/engine/connector/seatLive.ts')
}

type StageOptions = { columns?: number; rows?: number; reducedMotion?: boolean; session?: 'none' | 'empty' | 'history'; env?: Record<string, string>; plant?: 'crash' | 'crash-resumable' | 'worktree' | 'preflight' | 'fold-notice' | 'housekeeping' | 'update-notice' | 'handshake' | 'tmux' | 'commands' }

type Scenario = { name: string; covers: string[]; options?: StageOptions; run: (stage: Stage) => Promise<void> }

const FIXED_STAMP = '2026-01-02T03:04:05.000Z'
const QUIET_STEP_MS = 40
const QUIET_POLLS = 8
const SETTLE_CEILING_MS = 20_000

const CTRL_O = '\x0f'
const SHIFT_TAB = '\x1b[Z'
const ALT_DOWN = '\x1b[1;3B'
const PAGE_UP = '\x1b[5~'
const SHIFT_UP = '\x1b[1;2A'
const CTRL_R = '\x12'
export { KEY }

function maskerFor(home: string): (line: string) => string {
  const homes = [home, home.startsWith('/private') ? home.slice('/private'.length) : `/private${home}`].sort((a, b) => b.length - a.length)
  return line => {
    let out = line
    for (const spelled of homes) out = out.split(spelled).join('<home>')
    return out
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/g, '<clock>')
      .replace(/\b\d+(?:\.\d+)?(ms|s|m|h)\b/g, '<n>$1')
      .replace(/mercury-transcript-\d+\.md/g, 'mercury-transcript-<n>.md')
      .replace(SPINNER_ROW, (_row, lead: string, stats: string, rest: string) => `${lead}<spin> <verb>… (${stats.replace(/<n>[smh] · /g, '')})${rest.replace(/ {2,}/g, ' ')}`)
      .replace(/\s+$/, '')
  }
}

const SPINNER_ROW = /^(.*│ )\S [^│…]{1,60}… \(([^)│]*)\)(.*)$/
const maskTitle = (title: string | null): string | null => (title === null ? null : title.replace(/^[⠂⠐] /, '<frame> '))

const teardownSink: string[] = []
let teardownSunk = false

async function mountSunk(element: unknown, columns: number, rows: number, opts?: { mouseTracking?: boolean }): Promise<Mounted> {
  if (!teardownSunk) {
    teardownSunk = true
    const real = { ...(await import('../../src/screen/renderer/terminal-session/frameDelivery.ts')) }
    mock.module('../../src/screen/renderer/terminal-session/frameDelivery.ts', () => ({
      ...real,
      writeAllSync: (fd: number, data: Buffer, syscalls?: Parameters<typeof real.writeAllSync>[2]): boolean => {
        if (fd !== 1) return real.writeAllSync(fd, data, syscalls)
        teardownSink.push(data.toString('utf8'))
        return true
      },
    }))
  }
  return mountOffscreen(element, columns, rows, opts)
}

export async function openStage(tag: string, options: StageOptions = {}): Promise<Stage> {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const home = pinScratchHome(`chat-${tag}`)
  for (const name of Object.keys(process.env)) {
    if (/_API_KEY$|_AUTH_TOKEN$|^TERM_|^TMUX|^SSH_|^ITERM_|^KITTY_|^WT_|^VTE_|^WEZTERM_|^ZELLIJ|^CI$|^NO_COLOR$/.test(name)) delete process.env[name]
  }
  for (const name of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'EDITOR', 'VISUAL', 'MERCURY_RENDER_FAULT']) delete process.env[name]
  process.env.TERM = 'xterm-256color'
  process.env.COLORTERM = 'truecolor'
  process.env.MERCURY_TMPDIR = join(home, 'tmp')
  process.env.MERCURY_HOME = join(home, 'proof-home')
  process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
  process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:9'
  process.env.MERCURY_FULLSCREEN = '1'
  process.env.MERCURY_HELM_HOME = '1'
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (options.reducedMotion === false) delete process.env.MERCURY_REDUCED_MOTION
  else process.env.MERCURY_REDUCED_MOTION = '1'
  process.env.MERCURY_OPERATOR = 'sam'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.MERCURY_BOOT_PREFLIGHT = '0'
  process.env.BROWSER = '/usr/bin/true'
  for (const [name, value] of Object.entries(options.env ?? {})) process.env[name] = value
  const project = join(home, 'proof-project')
  mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
  mkdirSync(process.env.MERCURY_HOME, { recursive: true })
  mkdirSync(project, { recursive: true })
  process.chdir(project)

  if (options.plant === 'preflight') {
    const real = await import('../../src/platform/health/healthPreflight.ts')
    mock.module('../../src/platform/health/healthPreflight.ts', () => ({
      ...real,
      mercuryBootPreflightEnabled: () => true,
      runAndRecordPreflight: async () => ({ verdict: 'fail', ranAt: FIXED_STAMP, failing: [{ id: 'ripgrep', evidence: 'ripgrep MISSING @ rg' }], degraded: [], durationMs: 1, via: 'preflight' }),
    }))
  }
  if (options.plant === 'fold-notice') {
    const real = await import('../../src/engine/run/runCoordinator.ts')
    let notice: unknown = { interruptedTools: 2, blocker: { description: 'the build waits for a sign-in', resumeCondition: 'sign in with /logins and say continue' } }
    mock.module('../../src/engine/run/runCoordinator.ts', () => ({
      ...real,
      takeResumeFoldNotice: () => {
        const taken = notice
        notice = null
        return taken
      },
    }))
  }
  if (options.plant === 'housekeeping') {
    const real = await import('../../src/platform/housekeeping/backgroundHousekeeping.ts')
    mock.module('../../src/platform/housekeeping/backgroundHousekeeping.ts', () => ({
      ...real,
      startBackgroundHousekeeping: () => {
        throw new Error('a planted fault of the housekeeping')
      },
    }))
  }
  const warmed = { daemon: 0, runners: [] as string[], contextWindows: 0 }
  const realEnsure = { ...(await import('../../src/daemon/switchboard/ensureDaemon.ts')) }
  mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({
    ...realEnsure,
    ensureOwnedDaemon: async () => {
      warmed.daemon++
      return true
    },
    warmSessionRunner: async (cwd: string) => {
      warmed.runners.push(cwd)
      return true
    },
  }))
  const realWindows = { ...(await import('../../src/engine/context-window/contextWindowWarmup.ts')) }
  mock.module('../../src/engine/context-window/contextWindowWarmup.ts', () => ({
    ...realWindows,
    warmContextWindowSources: async () => {
      warmed.contextWindows++
    },
  }))
  if (options.plant === 'update-notice') {
    const real = { ...(await import('../../src/platform/update-channel/quietUpdateNotice.ts')) }
    mock.module('../../src/platform/update-channel/quietUpdateNotice.ts', () => ({
      ...real,
      scheduleQuietUpdateNotice: (notify: (text: string) => void) => {
        const timer = setTimeout(() => notify(real.updateNoticeText('9.9.9')), 0)
        return () => clearTimeout(timer)
      },
    }))
  }
  const handshake = { line: null as string | null, heard: new Set<() => void>() }
  if (options.plant === 'handshake') {
    const real = { ...(await import('../../src/daemon/control/handshake.ts')) }
    mock.module('../../src/daemon/control/handshake.ts', () => ({
      ...real,
      lastDaemonHandshake: () => (handshake.line === null ? null : { line: handshake.line }),
      subscribeDaemonHandshake: (listener: () => void) => {
        handshake.heard.add(listener)
        return () => void handshake.heard.delete(listener)
      },
    }))
  }
  if (options.plant === 'tmux') {
    const real = { ...(await import('../../src/screen/fullscreen-layout/fullscreen.ts')) }
    mock.module('../../src/screen/fullscreen-layout/fullscreen.ts', () => ({
      ...real,
      maybeGetTmuxMouseHint: async () => 'tmux detected: PageUp/PageDown scroll the transcript. Add `set -g mouse on` to ~/.tmux.conf to restore wheel scrolling.',
    }))
  }

  const React = await import('react')
  const h = React.createElement
  const { App } = await import('../../src/boot/App.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { useAppStateStore } = await import('../../src/screen/app-state/AppState.tsx')
  const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.tsx')
  const { Chat } = await import('../../src/screen/chat/Chat.tsx')
  const route = await import('../../src/screen/routes/surfaceRoute.ts')
  const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
  const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
  const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
  const { setCwdState, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
  const { TerminalWriteContext } = await import('../../src/screen/renderer/terminalWrite.ts')
  const { Text, useStdin } = await import('../../src/screen/themedRenderer.ts')
  const helm = await import('../../src/screen/cockpit/helmFocus.ts')
  setCwdState(project)
  setIsInteractive(true)
  enableConfigs()
  saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
  saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
  const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const seatLive = await import('../../src/engine/connector/seatLive.ts')
  const { createStreamingTailStore } = await import('../../src/engine/message-shapes/streamingTailStore.ts')
  const { getCommands } = await import('../../src/commands/catalogue/commands.ts')
  const { markDaemonHaltStanddown } = await import('../../src/daemon/control/daemonStanddown.ts')
  const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const buildAsk = await askBuilder()
  const modeRecord = await import('../../src/permissions/rules/modeTransitions.ts')
  modeRecord.clearModeTransitions()
  markDaemonHaltStanddown()
  const dialogs: Stage['dialogs'] = []
  const scriptedLocal = (name: string, call: (args: string) => Promise<unknown>, more: Record<string, unknown> = {}): unknown => ({ type: 'local', name, description: `the scripted /${name}`, supportsNonInteractive: false, seat: 'screen', load: async () => ({ call }), ...more })
  const scriptedDialog = (name: string, call: (done: (result?: string, options?: Record<string, unknown>) => void, args: string) => unknown): unknown => ({
    type: 'local-jsx',
    name,
    description: `the scripted /${name}`,
    load: async () => ({ call: async (done: (result?: string, options?: Record<string, unknown>) => void, _context: unknown, args: string) => call(done, args) }),
  })
  const scripted =
    options.plant !== 'commands'
      ? []
      : [
          scriptedLocal('proof-says', async args => ({ type: 'text', value: `the scripted command said ${args === '' ? 'nothing' : args}` })),
          scriptedLocal('proof-throws', async () => {
            throw new Error('a planted fault of the command')
          }),
          scriptedLocal('proof-throws-words', async () => {
            throw 'a planted fault that is no Error'
          }),
          scriptedLocal('proof-stops', async () => ({ type: 'text', value: 'the scripted command stopped the turn first' }), { interruptFirst: true }),
          scriptedLocal('proof-route', async () => ({ type: 'skip' }), { uiRouteAlias: 'concourse' }),
          scriptedLocal('proof-concourse-only', async () => ({ type: 'text', value: 'a command of the concourse ran' }), { needsConcourse: true }),
          scriptedLocal('whisper', async args => ({ type: 'text', value: `the scripted whisper said ${args}` })),
          scriptedDialog('proof-dialog', (done, args) => {
            dialogs.push({ name: 'proof-dialog', args, done })
            return h(Text, null, `a scripted dialog (${args})`)
          }),
          scriptedDialog('proof-nothing', () => null),
          scriptedDialog('proof-slow', async (_done, args) => {
            await new Promise<void>(resolve => dialogs.push({ name: 'proof-slow', args, done: () => resolve() }))
            return null
          }),
          scriptedDialog('proof-dialog-throws', () => {
            throw new Error('a planted fault of the dialog')
          }),
          scriptedDialog('proof-dialog-throws-words', () => {
            throw 'a planted fault of the dialog that is no Error'
          }),
          scriptedDialog('mission', (done, args) => {
            done(`the scripted mission took ${args}`)
            return null
          }),
          scriptedDialog('logins', (done, args) => {
            dialogs.push({ name: 'logins', args, done })
            return h(Text, null, 'a scripted sign-in door')
          }),
          scriptedDialog('model', (done, args) => {
            dialogs.push({ name: 'model', args, done })
            return h(Text, null, 'a scripted model door')
          }),
        ]
  const commands = [...scripted, ...(await getCommands(project))] as Awaited<ReturnType<typeof getCommands>>

  let rowNumber = 0
  const stamped = (row: Message): Message => {
    rowNumber++
    return { ...row, uuid: `00000000-0000-4000-8000-${String(rowNumber).padStart(12, '0')}`, timestamp: FIXED_STAMP } as Message
  }
  const user = (text: string): Message => stamped(createUserMessage({ content: text }) as Message)
  const assistant = (text: string): Message => stamped(createAssistantMessage({ content: text }) as Message)

  const newSession = (id: string, initial: Message[] = []): ScriptedSession => {
    const tailStore = createStreamingTailStore({ intervalMs: 1 })
    const calls: string[] = []
    let records = initial
    let live: SessionLiveV1 = seatLive.IDLE_LIVE
    let status: SeatStatusV1 = { title: id, projectLabel: 'proof-project', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false, runner: null }
    let asks: SessionAskV1[] = []
    let runnerMode: PermissionMode | null = null
    let modelFacts: Record<string, unknown> = { effective: 'claude-sonnet-4-5', main: 'claude-sonnet-4-5', setting: null, sessionPin: null, pendingSwitch: null }
    let sendRefusal: string | null = null
    let sendGate: Promise<void> | null = null
    let sendFault: string | null = null
    let modeRefusal: string | null = null
    let completedAt: number | null = null
    let lostLine: { text: string; atMs: number } | null = null
    let storeFailing: string | null = null
    let admissionRefusal: string | null = null
    let usage = { totalCostUSD: 0, consoleBilling: false }
    const listeners = { records: new Set<() => void>(), live: new Set<() => void>(), asks: new Set<() => void>(), mode: new Set<() => void>(), model: new Set<() => void>() }
    const tell = (set: Set<() => void>): void => {
      for (const listener of [...set]) listener()
    }
    const hear = (set: Set<() => void>) => (listener: () => void): (() => void) => {
      set.add(listener)
      return () => void set.delete(listener)
    }
    const hooks: { onInterrupt?: () => void } = {}
    const base = new NoSessionConnector()
    const zeroUsage = base.usage()
    const noIdentity = base.identity()
    const connector = Object.assign(base, {
      sessionId: () => id,
      records: () => records,
      subscribeRecords: hear(listeners.records),
      live: () => live,
      subscribeLive: hear(listeners.live),
      status: () => status,
      tail: () => tailStore,
      turnActive: () => live.inFlight,
      asks: () => asks,
      subscribeAsks: hear(listeners.asks),
      settleAsk: (askId: string) => {
        calls.push(`settleAsk ${askId}`)
        asks = asks.filter(ask => ask.id !== askId)
        tell(listeners.asks)
      },
      interrupt: () => {
        calls.push('interrupt')
        hooks.onInterrupt?.()
        return live.inFlight
      },
      sendWords: async (text: string, opts?: Record<string, unknown>) => {
        const said = Object.entries(opts ?? {})
          .filter(([name, value]) => name !== 'pastedContents' || Object.keys(value as object).length > 0)
          .map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
          .join(' ')
        calls.push(`sendWords ${JSON.stringify(text)}${said === '' ? '' : ` ${said}`}${sendFault !== null ? ' -> threw' : sendRefusal === null ? '' : ' -> refused'}`)
        if (sendFault !== null) throw new Error(sendFault)
        if (sendGate !== null) await sendGate
        return sendRefusal === null ? { state: 'accepted' as const } : { state: 'refused' as const, detail: sendRefusal }
      },
      modelFacts: () => modelFacts,
      subscribeModel: hear(listeners.model),
      permissionMode: () => runnerMode,
      subscribePermissionMode: hear(listeners.mode),
      setPermissionMode: async (mode: PermissionMode) => {
        calls.push(`setPermissionMode ${mode}${modeRefusal === null ? '' : ' -> refused'}`)
        if (modeRefusal !== null) return { outcome: 'refused' as const, detail: modeRefusal }
        runnerMode = mode
        return { outcome: 'applied' as const }
      },
      rewind: async (req: { userMessageId: string; mode: string }) => {
        calls.push(`rewind ${req.mode} ${req.userMessageId}`)
        return { outcome: 'applied' as const, mode: req.mode, conversation: { removed: 2 }, code: { filesChanged: ['a.ts'], insertions: 3, deletions: 1 } }
      },
      usage: () => ({ ...zeroUsage, totalCostUSD: usage.totalCostUSD }),
      identity: () => ({ ...noIdentity, consoleBilling: usage.consoleBilling }),
      addDisplayRow: (row: Message) => {
        records = [...records, stamped(row)]
        tell(listeners.records)
      },
      lastTurnCompletedAtMs: () => completedAt,
      lostLine: () => lostLine,
      transcriptStoreFailing: () => storeFailing,
      admissionRefusal: () => admissionRefusal,
    })
    return {
      connector,
      calls,
      hooks,
      records: () => records,
      setRecords: next => {
        records = next
        tell(listeners.records)
      },
      addRecords: (...more) => {
        records = [...records, ...more]
        tell(listeners.records)
      },
      setLive: next => {
        live = { ...live, ...next }
        tell(listeners.live)
      },
      setStatus: next => {
        status = { ...status, ...next }
        tell(listeners.live)
      },
      setAsks: next => {
        asks = next
        tell(listeners.asks)
      },
      setRunnerMode: mode => {
        runnerMode = mode
        tell(listeners.mode)
      },
      setModelFacts: next => {
        modelFacts = { ...modelFacts, ...next }
        tell(listeners.model)
      },
      refuseSends: detail => {
        sendRefusal = detail
      },
      holdSends: () => {
        let open: () => void = () => {}
        sendGate = new Promise<void>(resolve => (open = resolve))
        return () => {
          sendGate = null
          open()
        }
      },
      failSends: fault => {
        sendFault = fault
      },
      refuseModes: detail => {
        modeRefusal = detail
      },
      setCompletedAt: at => {
        completedAt = at
        tell(listeners.live)
      },
      setLostLine: line => {
        lostLine = line
        tell(listeners.live)
      },
      setStoreFailing: sentence => {
        storeFailing = sentence
        tell(listeners.model)
      },
      setAdmissionRefusal: reason => {
        admissionRefusal = reason
        tell(listeners.live)
      },
      setUsage: (costUSD, consoleBilling) => {
        usage = { totalCostUSD: costUSD, consoleBilling }
      },
      stream: text => {
        if (text === null) {
          tailStore.reset(null)
          tailStore.dropSettled()
          return
        }
        tailStore.setMessageId(`msg-${id}`)
        tailStore.update(() => text)
      },
    }
  }

  const history = (): Message[] => [user('what does the build print'), assistant('It prints BUILD OK and the path of the bundle.'), user('and the manifest'), assistant('The manifest lists every vendored pack beside the bundle.')]
  const sessionKind = options.session ?? 'history'
  let focused: ScriptedSession | null = sessionKind === 'none' ? null : newSession('rec-session', sessionKind === 'history' ? history() : [])
  slot._resetFocusedSessionConnectorForTesting()
  if (focused !== null) slot.setFocusedSessionConnector(focused.connector as never)

  if (options.plant === 'crash') {
    const { persistCrashReport } = await import('../../src/platform/logs/crashReport.ts')
    persistCrashReport(new Error('a planted crash of an earlier session'), undefined, 'app-root')
  }
  if (options.plant === 'crash-resumable') {
    const { persistCrashReport } = await import('../../src/platform/logs/crashReport.ts')
    const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
    const crashed = newSession('rec-crashed', [])
    mkdirSync(getProjectDir(project), { recursive: true })
    writeFileSync(join(getProjectDir(project), 'rec-crashed.jsonl'), `${JSON.stringify(user('what the crashed session was asked'))}\n`)
    slot.setFocusedSessionConnector(crashed.connector as never)
    persistCrashReport(new Error('a planted crash of a session that can be opened again'), undefined, 'app-root')
    if (focused === null) slot.releaseFocusedSessionConnector()
    else slot.setFocusedSessionConnector(focused.connector as never)
  }
  if (options.plant === 'worktree') {
    const { restoreWorktreeSession } = await import('../../src/platform/git/worktree/worktree.ts')
    restoreWorktreeSession({ originalCwd: project, worktreePath: project, worktreeName: 'proof-tree', sessionId: 'rec-session', creationDurationMs: 21_000 })
  }
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  layoutChromeLive(columns, rows)
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})

  let store: AppStateStore | undefined
  let stdinEvents: { emit: (event: string) => boolean } | undefined
  let title: string | null = null
  function StoreTap(): null {
    store = useAppStateStore()
    stdinEvents = useStdin().internal_eventEmitter
    return null
  }
  function TitleTap(props: { children?: import('react').ReactNode }): import('react').ReactElement {
    const write = React.useContext(TerminalWriteContext)
    const tapped = React.useMemo(
      () =>
        write === null || write === undefined
          ? write
          : (data: string): void => {
              const at = data.lastIndexOf('\x1b]0;')
              if (at >= 0) {
                const rest = data.slice(at + 4)
                const end = rest.search(/\x07|\x1b\\/)
                title = end < 0 ? rest : rest.slice(0, end)
              }
              write(data)
            },
      [write],
    )
    return h(TerminalWriteContext.Provider, { value: tapped as never }, props.children)
  }
  const element = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(StoreTap, null), h(TitleTap, null, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))))
  const mountedAt = performance.now()
  const view = await mountSunk(element, columns, rows, { mouseTracking: true })
  const mask = maskerFor(home)
  const steps: Step[] = []
  let seen = 0
  let modesSeen = 0
  const frameOf = (): string[] => view.lines().map(mask)

  const settled = async (label: string, ready?: (frame: string) => boolean): Promise<string[]> => {
    const deadline = Date.now() + SETTLE_CEILING_MS
    let stable = 0
    let before = ''
    let last: string[] = []
    while (Date.now() < deadline) {
      await settle(QUIET_STEP_MS)
      last = frameOf()
      const text = last.join('\n')
      if (ready !== undefined && !ready(text)) {
        stable = 0
        before = ''
        continue
      }
      if (text === before) {
        stable++
        if (stable >= QUIET_POLLS) return last
      } else {
        before = text
        stable = 0
      }
    }
    throw new Error(`the screen never settled for "${label}" within ${SETTLE_CEILING_MS}ms\n${last.join('\n')}`)
  }

  const mark = async (label: string, ready?: (frame: string) => boolean): Promise<void> => {
    const lines = await settled(label, ready)
    const at = view.cursor()
    const calls = focusedCalls().slice(seen)
    seen = focusedCalls().length
    const modes = modeRecord.modeTransitions().slice(modesSeen).map(entry => `${entry.from} → ${entry.to} via ${entry.road}`)
    modesSeen = modeRecord.modeTransitions().length
    steps.push({ label, title: maskTitle(title), cursor: `${at.x},${at.y} ${at.visible ? 'shown' : 'hidden'}`, calls, modes, lines })
  }
  const allCalls: string[] = []
  const sessions: ScriptedSession[] = focused === null ? [] : [focused]
  const focusedCalls = (): string[] => {
    for (const session of sessions) {
      while (session.calls.length > 0) allCalls.push(`${(session.connector as { sessionId: () => string }).sessionId()}: ${session.calls.shift()!}`)
    }
    return allCalls
  }

  const stage: Stage = {
    view,
    home,
    project,
    get session(): ScriptedSession {
      if (focused === null) throw new Error('no scripted session is focused')
      return focused
    },
    store: () => {
      if (store === undefined) throw new Error('the app state store was not tapped')
      return store
    },
    src: { pending, slot, route, seatLive },
    mark,
    key: async (data, label, ready) => {
      view.push(data)
      await mark(label, ready)
    },
    type: async text => {
      for (const ch of text) {
        view.push(ch)
        await settle(12)
      }
    },
    whileTyped: async run => {
      const hold = setInterval(() => pending.edit(pending.text()), 250)
      try {
        await run()
      } finally {
        clearInterval(hold)
      }
    },
    emit: event => {
      if (stdinEvents === undefined) throw new Error('the stdin events were not tapped')
      stdinEvents.emit(event)
    },
    resize: async (nextColumns, nextRows, label) => {
      layoutChromeLive(nextColumns, nextRows)
      view.resize(element, nextColumns, nextRows)
      await mark(label)
    },
    focus: next => {
      focused = next
      if (next === null) slot.releaseFocusedSessionConnector()
      else {
        if (!sessions.includes(next)) sessions.push(next)
        slot.setFocusedSessionConnector(next.connector as never)
      }
    },
    newSession,
    user,
    assistant,
    askFor: (id, command) =>
      buildAsk(id, command, project, word => {
        if (focused === null) throw new Error('an ask needs a focused session')
        focused.calls.push(word)
      }),
    screen: () => frameOf().join('\n'),
    paintedAfter: async words => {
      const deadline = performance.now() + SETTLE_CEILING_MS
      while (performance.now() < deadline) {
        if (view.screen().includes(words)) return performance.now() - mountedAt
        await settle(2)
      }
      throw new Error(`the screen never painted "${words}" within ${SETTLE_CEILING_MS}ms`)
    },
    dialogs,
    dispatch: command => helm.requestCommandDispatch(command),
    plainWorld: () => saveGlobalConfig(config => ({ ...config, concourseEnabled: false })),
    handshake: line => {
      handshake.line = line
      for (const listener of [...handshake.heard]) listener()
    },
    warmups: () => `the daemon asked for ${warmed.daemon} · a runner warmed ${warmed.runners.length}${warmed.runners.every(cwd => cwd === project) ? '' : ' (not in the project)'} · the context windows warmed ${warmed.contextWindows}`,
    steps,
  }
  return stage
}

export async function askBuilder(): Promise<(id: string, command: string, cwd: string, tell: (word: string) => void) => SessionAskV1> {
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  return (id, command, cwd, tell) => {
    const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
    const context = {
      options: { tools: [BashTool], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
      abortController: new AbortController(),
      messages: [],
      readFileState: new Map(),
      toolUseId: id,
      getAppState: () => state,
      setAppState: () => undefined,
      setResponseLength: () => undefined,
      updateFileHistoryState: () => undefined,
      updateAttributionState: () => undefined,
    }
    const confirm = {
      tool: BashTool,
      input: { command, description: 'Run the scripted command' },
      toolUseID: id,
      description: 'Run the scripted command',
      toolUseContext: context,
      permissionResult: { behavior: 'ask', message: 'Mercury wants to use Bash' },
      assistantMessage: { type: 'assistant', uuid: `assistant-${id}`, message: { id: `msg_${id}`, role: 'assistant', content: [] } },
      permissionPromptStartTimeMs: 0,
      cwd,
      onAllow: () => tell(`ask ${id} allowed`),
      onReject: () => tell(`ask ${id} rejected`),
      onAbort: () => tell(`ask ${id} aborted`),
      onUserInteraction: () => {},
      recheckPermission: async () => tell(`ask ${id} rechecked`),
    }
    return { id, confirm: confirm as never, toolName: 'Bash', askedAt: 0 }
  }
}

type PartMount<T> = {
  value: () => T
  renders: () => number
  set: (use: (store: AppStateStore) => T) => Promise<void>
  store: () => AppStateStore
  view: Mounted
  writes: string[]
  sunk: string[]
  unmount: () => void
}

export async function mountPart<T>(use: (store: AppStateStore) => T, options: { columns?: number; rows?: number; draw?: (value: T) => import('react').ReactNode } = {}): Promise<PartMount<T>> {
  const globals = globalThis as Record<string, unknown>
  globals.MACRO ??= { VERSION: '1.0.0' }
  const React = await import('react')
  const h = React.createElement
  const { App } = await import('../../src/boot/App.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { useAppStateStore } = await import('../../src/screen/app-state/AppState.tsx')
  const { TerminalWriteContext } = await import('../../src/screen/renderer/terminalWrite.ts')
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  let call = use
  let held: T | undefined
  let count = 0
  let store: AppStateStore | undefined
  let poke: (() => void) | undefined
  const writes: string[] = []
  function Probe(): import('react').ReactNode {
    const [, setTick] = React.useState(0)
    poke = () => setTick(tick => tick + 1)
    store = useAppStateStore()
    held = call(store)
    count++
    return options.draw === undefined ? null : options.draw(held)
  }
  function WriteTap(props: { children?: import('react').ReactNode }): import('react').ReactElement {
    const write = React.useContext(TerminalWriteContext)
    const tapped = React.useMemo(
      () =>
        write === null || write === undefined
          ? write
          : (data: string): void => {
              writes.push(data)
              write(data)
            },
      [write],
    )
    return h(TerminalWriteContext.Provider, { value: tapped as never }, props.children)
  }
  const view = await mountSunk(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(WriteTap, null, h(Probe))), options.columns ?? 100, options.rows ?? 30)
  await settle(80)
  return {
    value: () => held as T,
    renders: () => count,
    set: async next => {
      call = next
      poke?.()
      await settle(80)
    },
    store: () => {
      if (store === undefined) throw new Error('the app state store was not tapped')
      return store
    },
    view,
    writes,
    sunk: teardownSink,
    unmount: () => view.unmount(),
  }
}

type TranscriptHook = typeof import('../../src/screen/chat/useChatSearch.tsx').useChatSearch
type TranscriptArgs = Parameters<TranscriptHook>[0]
type TranscriptValue = ReturnType<TranscriptHook>

type TranscriptPart = {
  part: PartMount<TranscriptValue>
  module: typeof import('../../src/screen/chat/useChatSearch.tsx')
  plant: (over: Partial<TranscriptArgs>) => Promise<void>
  setRows: (rows: Message[]) => Promise<void>
  rowsOf: (count: number) => Message[]
  press: (data: string, wait?: number) => Promise<void>
  act: (run: () => void) => Promise<void>
  frame: () => string
  highlights: string[]
  jumps: string[]
  scroll: { calls: string[]; captures: number; flips: number; restore: { current: unknown } }
  editor: { answer: boolean; platform: string; asked: string[] }
  touched: string[]
  close: () => Promise<void>
}

export async function openTranscriptPart(tag: string, size: { columns?: number; rows?: number; keepHome?: boolean } = {}): Promise<TranscriptPart> {
  const home = size.keepHome === true ? null : pinScratchHome(tag)
  delete process.env.EDITOR
  delete process.env.VISUAL
  const highlights: string[] = []
  const highlightApi = { setQuery: (query: string) => void highlights.push(query), scanElement: () => [], setPositions: () => {} }
  mock.module('../../src/screen/renderer/bindings/use-search-highlight.ts', () => ({ useSearchHighlight: () => highlightApi }))
  const realEditor = await import('../../src/platform/editor/externalEditor.ts')
  const realPlatform = process.platform
  const editor = { answer: true, platform: realPlatform as string, asked: [] as string[] }
  mock.module('../../src/platform/editor/externalEditor.ts', () => ({
    ...realEditor,
    openFileInExternalEditor: (path: string) => {
      editor.asked.push(path)
      Object.defineProperty(process, 'platform', { value: editor.platform, configurable: true })
      return editor.answer
    },
  }))
  const React = await import('react')
  const h = React.createElement
  const module = await import('../../src/screen/chat/useChatSearch.tsx')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const route = await import('../../src/screen/routes/surfaceRoute.ts')
  const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const { default: useInput } = await import('../../src/screen/renderer/bindings/use-input.ts')
  const rowsOf = (count: number): Message[] => Array.from({ length: count }, (_, i) => (i % 2 === 0 ? createUserMessage({ content: `question ${i} about the gate` }) : createAssistantMessage({ content: `answer ${i} about the gate` })) as Message)
  let rows: Message[] = []
  let over: Partial<TranscriptArgs> = {}
  const touched: string[] = []
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => tag,
      records: () => rows,
      sendWords: async () => {
        touched.push('sendWords')
        return { state: 'accepted' as const }
      },
      interrupt: () => {
        touched.push('interrupt')
        return false
      },
      rewind: async () => {
        touched.push('rewind')
        return { outcome: 'noop' as const, mode: 'both' as const }
      },
    }) as never,
  )
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  const scroll = { calls: [] as string[], captures: 0, flips: 0, restore: { current: null as unknown } }
  const scrollRef = {
    current: { scrollTo: (y: number) => void scroll.calls.push(`scrollTo ${y}`), scrollToBottom: () => void scroll.calls.push('scrollToBottom'), getScrollHeight: () => 90, getViewportHeight: () => 20 },
  }
  const jumps: string[] = []
  const jumpHandle = {
    jumpToIndex: (i: number) => void jumps.push(`jump ${i}`),
    setSearchQuery: (query: string) => void jumps.push(`query ${JSON.stringify(query)}`),
    nextMatch: () => void jumps.push('next'),
    prevMatch: () => void jumps.push('prev'),
    setAnchor: () => void jumps.push('anchor'),
    warmSearchIndex: async () => 5,
    disarmSearch: () => void jumps.push('disarm'),
  }
  const use = (): TranscriptValue =>
    module.useChatSearch({
      fullscreen: true,
      virtualScrollEnabled: true,
      columns: size.columns ?? 100,
      mergedTools: [] as never,
      messages: rows,
      focusedInputDialog: undefined,
      captureScrollForFlip: () => void scroll.captures++,
      setFlipGeneration: () => void scroll.flips++,
      scrollRef: scrollRef as never,
      scrollRestoreRef: scroll.restore,
      onScroll: (sticky: boolean) => void scroll.calls.push(`onScroll ${sticky ? 'sticky' : 'away'}`),
      ...over,
    })
  function KeySink(): null {
    useInput(() => {})
    return null
  }
  const bottomOf = (value: TranscriptValue): import('react').ReactNode => {
    if (!value.inTranscript) return null
    const badged = value.committedSearchQuery !== '' && value.searchMatchCount !== null && value.searchMatchCount > 0
    return value.searchBarOpen
      ? h(module.TranscriptSearchBar, { columns: size.columns ?? 100, onQueryChange: value.previewSearch, onCommit: value.commitSearch, onCancel: value.cancelSearch, warmSearchIndex: value.warmSearchIndex, matchCount: value.searchMatchCount, matchCurrent: value.searchMatchCurrent })
      : h(module.TranscriptFooter, { toggleChord: 'ctrl+o', expandChord: 'ctrl+e', hasSearchBadge: badged, virtualScroll: value.inVirtualTranscript, showAllSuppressed: value.dumpMode, showAll: value.showAllInTranscript, status: value.editorStatus, badge: badged ? `${value.searchMatchCurrent}/${value.searchMatchCount}` : null })
  }
  const part = await mountPart(use, { columns: size.columns ?? 100, rows: size.rows ?? 12, draw: value => h(React.Fragment, null, h(KeySink), bottomOf(value)) })
  part.value().jumpRef.current = jumpHandle
  return {
    part,
    module,
    plant: async next => {
      over = next
      await part.set(use)
    },
    setRows: async next => {
      rows = next
      await part.set(use)
    },
    rowsOf,
    press: async (data, wait = 120) => {
      part.view.push(data)
      await settle(wait)
    },
    act: async run => {
      run()
      await settle(120)
    },
    frame: () => part.view.lines().join('\n'),
    highlights,
    jumps,
    scroll,
    editor,
    touched,
    close: async () => {
      part.unmount()
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
      slot.releaseFocusedSessionConnector()
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type AsksHook = typeof import('../../src/screen/chat/useChatAsks.tsx').useChatAsks
type AsksValue = ReturnType<AsksHook>

type AsksPart = {
  part: PartMount<AsksValue>
  module: typeof import('../../src/screen/chat/useChatAsks.tsx')
  calls: string[]
  notices: Array<{ key: string; text: string }>
  ask: (id: string, command: string) => SessionAskV1
  setAsks: (next: SessionAskV1[]) => Promise<void>
  setRunnerMode: (mode: PermissionMode | null) => Promise<void>
  refuseModes: (detail: string | null) => void
  mode: () => PermissionMode
  close: () => Promise<void>
}

export async function openAsksPart(tag: string, options: { keepHome?: boolean; held?: { mode: PermissionMode; facts: 'live' | 'record' } } = {}): Promise<AsksPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const module = await import('../../src/screen/chat/useChatAsks.tsx')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const buildAsk = await askBuilder()
  const calls: string[] = []
  const notices: Array<{ key: string; text: string }> = []
  let asks: SessionAskV1[] = []
  let runnerMode: PermissionMode | null = options.held?.mode ?? null
  let modeRefusal: string | null = null
  const resting = new NoSessionConnector()
  const held = options.held
  const listeners = { asks: new Set<() => void>(), mode: new Set<() => void>() }
  const hear = (set: Set<() => void>) => (listener: () => void): (() => void) => {
    set.add(listener)
    return () => void set.delete(listener)
  }
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => tag,
      ...(held === undefined ? {} : { modelFacts: () => ({ ...resting.modelFacts(), effectiveSource: held.facts }) }),
      asks: () => asks,
      subscribeAsks: hear(listeners.asks),
      settleAsk: (askId: string) => {
        calls.push(`settleAsk ${askId}`)
        asks = asks.filter(ask => ask.id !== askId)
        for (const listener of [...listeners.asks]) listener()
      },
      permissionMode: () => runnerMode,
      subscribePermissionMode: hear(listeners.mode),
      setPermissionMode: async (mode: PermissionMode) => {
        calls.push(`setPermissionMode ${mode}${modeRefusal === null ? '' : ' -> refused'}`)
        if (modeRefusal !== null) return { outcome: 'refused' as const, detail: modeRefusal }
        runnerMode = mode
        return { outcome: 'applied' as const }
      },
    }) as never,
  )
  const part = await mountPart(store =>
    module.useChatAsks({
      setAppState: updater => store.setState(updater),
      addNotification: (notice => void notices.push({ key: String((notice as { key: string }).key), text: String((notice as { text?: string }).text ?? '') })) as never,
    }),
  )
  return {
    part,
    module,
    calls,
    notices,
    ask: (id, command) => buildAsk(id, command, process.cwd(), word => void calls.push(word)),
    setAsks: async next => {
      asks = next
      for (const listener of [...listeners.asks]) listener()
      await settle(80)
    },
    setRunnerMode: async mode => {
      runnerMode = mode
      for (const listener of [...listeners.mode]) listener()
      await settle(80)
    },
    refuseModes: detail => {
      modeRefusal = detail
    },
    mode: () => part.store().getState().toolPermissionContext.mode,
    close: async () => {
      part.unmount()
      slot.releaseFocusedSessionConnector()
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type DraftHook = typeof import('../../src/screen/chat/useChatDraft.ts').useChatDraft
type DraftArgs = Parameters<DraftHook>[0]
type DraftValue = ReturnType<DraftHook>

type DraftPart = {
  part: PartMount<DraftValue>
  pending: typeof import('../../src/screen/composer/input-core/pending-input.ts')
  seed: typeof import('../../src/screen/cockpit/composerSeed.ts')
  pins: () => number
  scrolledAt: { current: number }
  plant: (over: Partial<DraftArgs>) => Promise<void>
  wallRows: (words: string) => Message[]
  close: () => Promise<void>
}

export async function openDraftPart(tag: string, options: { keepHome?: boolean; earlyInput?: string } = {}): Promise<DraftPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const module = await import('../../src/screen/chat/useChatDraft.ts')
  const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
  const seed = await import('../../src/screen/cockpit/composerSeed.ts')
  const { seedEarlyInput } = await import('../../src/boot/earlyInput.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => tag }) as never)
  pending.resetPendingInputForTests()
  seed.__composerSeedResetForTest()
  if (options.earlyInput !== undefined) seedEarlyInput(options.earlyInput)
  let pinned = 0
  const scrolledAt = { current: 0 }
  let over: Partial<DraftArgs> = {}
  const use = (): DraftValue => module.useChatDraft({ messages: [], fullscreen: true, repinToBottom: () => void pinned++, lastUserScrollAtRef: scrolledAt, ...over })
  const part = await mountPart(use)
  const stamp = new Date().toISOString()
  return {
    part,
    pending,
    seed,
    pins: () => pinned,
    scrolledAt,
    plant: async next => {
      over = next
      await part.set(use)
    },
    wallRows: words =>
      [
        { type: 'user', uuid: `${tag}-prompt`, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: words }] } },
        { type: 'assistant', uuid: `${tag}-wall`, timestamp: stamp, isApiErrorMessage: true, error: 'authentication_failed', message: { id: 'err', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'API Error: the sign-in expired' }], usage: {}, model: 'fixture', stop_reason: null, stop_sequence: null } },
      ] as never,
    close: async () => {
      part.unmount()
      pending.resetPendingInputForTests()
      seed.__composerSeedResetForTest()
      slot.releaseFocusedSessionConnector()
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type KeysProps = Parameters<typeof import('../../src/screen/chat/ChatKeys.tsx').ChatKeys>[0]
type KeysHandler = 'global' | 'command' | 'scroll' | 'actions' | 'cancel'

type KeysPart = {
  handed: Record<KeysHandler, Record<string, unknown> | null>
  mounted: KeysHandler[]
  props: () => KeysProps
  plant: (over: Partial<KeysProps>) => Promise<void>
  escapeHeld: () => boolean
  bodyMounts: () => number
  emit: (event: 'suspend' | 'resume') => Promise<void>
  written: string[]
  close: () => Promise<void>
}

export async function openKeysPart(tag: string, options: { keepHome?: boolean } = {}): Promise<KeysPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const React = await import('react')
  const h = React.createElement
  const handed: KeysPart['handed'] = { global: null, command: null, scroll: null, actions: null, cancel: null }
  const mounted: KeysHandler[] = []
  const spy = (name: KeysHandler) =>
    function Handler(props: Record<string, unknown>): null {
      const own = React.useRef(props)
      own.current = props
      handed[name] = props
      React.useEffect(() => {
        mounted.push(name)
        return () => {
          if (handed[name] === own.current) handed[name] = null
          mounted.splice(mounted.indexOf(name), 1)
        }
      }, [])
      return null
    }
  const realGlobal = { ...(await import('../../src/screen/chat/useGlobalKeybindings.tsx')) }
  mock.module('../../src/screen/chat/useGlobalKeybindings.tsx', () => ({ ...realGlobal, GlobalKeybindingHandlers: spy('global') }))
  const realCommand = { ...(await import('../../src/screen/chat/useCommandKeybindings.tsx')) }
  mock.module('../../src/screen/chat/useCommandKeybindings.tsx', () => ({ ...realCommand, CommandKeybindingHandlers: spy('command') }))
  const realScroll = { ...(await import('../../src/screen/scroll-keys/ScrollKeybindingHandler.tsx')) }
  mock.module('../../src/screen/scroll-keys/ScrollKeybindingHandler.tsx', () => ({ ...realScroll, ScrollKeybindingHandler: spy('scroll') }))
  const realActions = { ...(await import('../../src/screen/messages/messageActions.tsx')) }
  mock.module('../../src/screen/messages/messageActions.tsx', () => ({ ...realActions, MessageActionsKeybindings: spy('actions') }))
  const realCancel = { ...(await import('../../src/screen/chat/interruptKeys.ts')) }
  mock.module('../../src/screen/chat/interruptKeys.ts', () => ({ ...realCancel, CancelRequestHandler: spy('cancel') }))
  const { ChatKeys } = await import('../../src/screen/chat/ChatKeys.tsx')
  const { useEscapeOwned } = await import('../../src/screen/keys/useEscapeOwned.ts')
  const { useStdin } = await import('../../src/screen/themedRenderer.ts')
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  slot.setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => tag }) as never)
  let mounts = 0
  function Body(): null {
    React.useEffect(() => void mounts++, [])
    return null
  }
  let held = false
  let stdinEvents: { emit: (event: string) => boolean } | undefined
  function Reader(): null {
    held = useEscapeOwned()
    stdinEvents = useStdin().internal_eventEmitter
    return null
  }
  let props: KeysProps = {
    legacyTranscript: false,
    fullscreen: true,
    compactWork: { read: () => 'composer', set: () => {}, toggleSummary: () => {}, bindToggle: () => {}, detailState: { selectedId: null, detailTaskId: undefined } },
    screen: 'prompt',
    setScreen: () => {},
    showAllInTranscript: false,
    setShowAllInTranscript: () => {},
    messages: [],
    handleEnterTranscript: () => {},
    handleExitTranscript: () => {},
    inVirtualTranscriptMode: true,
    inVirtualTranscript: false,
    searchBarOpen: false,
    helpOpen: false,
    isSearchingHistory: false,
    messageCursorActive: false,
    messageActions: { handlers: {} },
    messageActionsDisabled: false,
    focusedInputDialog: undefined,
    toolUseConfirmQueue: [],
    showMessageSelector: false,
    showBashesDialog: false,
    vimMode: 'INSERT',
    dialogOwnsKeys: false,
    centredModalUp: false,
    permissionOverlay: null,
    viewStreamMode: 'responding',
    seatLive: IDLE_LIVE,
    onSubmit: async () => {},
    commands: [],
    scrollRef: { current: null },
    modalScrollRef: { current: null },
    onScroll: () => {},
    onTranscriptScroll: () => {},
    children: null,
  }
  const draw = (): import('react').ReactNode => h(React.Fragment, null, h(ChatKeys, props, h(Body)), h(Reader))
  const part = await mountPart(() => null, { draw })
  const written: string[] = []
  return {
    handed,
    mounted,
    props: () => props,
    plant: async over => {
      props = { ...props, ...over }
      await part.set(() => null)
    },
    escapeHeld: () => held,
    bodyMounts: () => mounts,
    emit: async event => {
      if (stdinEvents === undefined) throw new Error('the stdin events were not tapped')
      const real = process.stdout.write
      process.stdout.write = ((data: unknown): boolean => {
        written.push(String(data))
        return true
      }) as never
      try {
        stdinEvents.emit(event)
      } finally {
        process.stdout.write = real
      }
      await settle(80)
    },
    written,
    close: async () => {
      part.unmount()
      slot.releaseFocusedSessionConnector()
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type DialogsModule = typeof import('../../src/screen/chat/useChatDialogs.tsx')
type DialogsViewArgs = Parameters<DialogsModule['useChatDialogsView']>[0]
type DialogsViewValue = ReturnType<DialogsModule['useChatDialogsView']>

type DialogsPart = {
  module: DialogsModule
  part: PartMount<DialogsViewValue>
  plant: (over: Partial<DialogsViewArgs>) => Promise<void>
  frame: () => string
  costShown: boolean[]
  contexts: unknown[][]
  staged: unknown[]
  notices: Array<{ key: string; text: string }>
  removed: string[]
  hops: unknown[][]
  hop: { outcome: { ok: true } | { ok: false; reason: string } }
  setUsage: (costUSD: number, consoleBilling: boolean) => void
  close: () => Promise<void>
}

export async function openDialogsPart(tag: string, options: { keepHome?: boolean } = {}): Promise<DialogsPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const React = await import('react')
  const h = React.createElement
  const hops: unknown[][] = []
  const hop: DialogsPart['hop'] = { outcome: { ok: true } }
  const realHop = { ...(await import('../../src/daemon/switchboard/hopIntoSession.ts')) }
  mock.module('../../src/daemon/switchboard/hopIntoSession.ts', () => ({
    ...realHop,
    focusResumedSession: async (...call: unknown[]) => {
      hops.push(call)
      return hop.outcome
    },
  }))
  const module = await import('../../src/screen/chat/useChatDialogs.tsx')
  const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const before = slot.hasFocusedSession() ? slot.getFocusedSessionConnector() : null
  const base = new NoSessionConnector()
  const zeroUsage = base.usage()
  const noIdentity = base.identity()
  let usage = { totalCostUSD: 0, consoleBilling: false }
  slot.setFocusedSessionConnector(Object.assign(base, { sessionId: () => tag, usage: () => ({ ...zeroUsage, totalCostUSD: usage.totalCostUSD }), identity: () => ({ ...noIdentity, consoleBilling: usage.consoleBilling }) }) as never)
  const costShown: boolean[] = []
  const contexts: unknown[][] = []
  const staged: unknown[] = []
  const notices: Array<{ key: string; text: string }> = []
  const removed: string[] = []
  let args: Omit<DialogsViewArgs, 'store'> = {
    toolJSX: null,
    dialogSlotRef: { current: null },
    localJsx: false,
    compactDetailUp: false,
    setShowCostThreshold: show => void costShown.push(show),
    messages: [],
    fullscreen: true,
    compactWork: { read: () => 'composer', set: () => {}, toggleSummary: () => {}, bindToggle: () => {}, detailState: { selectedId: null, detailTaskId: undefined } },
    getToolUseContext: ((...call: unknown[]) => {
      contexts.push(call)
      return { planted: 'context' }
    }) as never,
    focusedEffectiveModel: 'claude-sonnet-4-5',
    chatSurfaceCovered: false,
    focusedInputDialog: undefined,
    elicitationQueue: [],
    respondToElicitation: () => {},
    dismissElicitationWaiting: () => {},
    crashResumeStaged: null,
    setCrashResumeStaged: next => void staged.push(next),
    addNotification: ((notice: { key: string; text?: string }) => void notices.push({ key: String(notice.key), text: String(notice.text ?? '') })) as never,
    removeNotification: ((key: string) => void removed.push(String(key))) as never,
  }
  const use = (store: AppStateStore): DialogsViewValue => module.useChatDialogsView({ ...args, store })
  const part = await mountPart(use, { columns: 110, rows: 30, draw: value => h(KeybindingSetup, null, h(React.Fragment, null, value.bottomImmediateJsx, value.inlineToolJsx, value.focusedBottomDialog)) })
  return {
    module,
    part,
    plant: async over => {
      args = { ...args, ...over }
      await part.set(use)
    },
    frame: () => part.view.lines().join('\n'),
    costShown,
    contexts,
    staged,
    notices,
    removed,
    hops,
    hop,
    setUsage: (costUSD, consoleBilling) => {
      usage = { totalCostUSD: costUSD, consoleBilling }
    },
    close: async () => {
      part.unmount()
      if (before === null) slot.releaseFocusedSessionConnector()
      else slot.setFocusedSessionConnector(before)
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type SessionModule = typeof import('../../src/screen/chat/useChatSession.ts')
type SessionArgs = Parameters<SessionModule['useChatSession']>[0]
type SessionValue = ReturnType<SessionModule['useChatSession']>

type SessionPart = {
  module: SessionModule
  part: PartMount<SessionValue>
  warmth: typeof import('../../src/screen/concourse-model/sessionWarmth.ts')
  route: typeof import('../../src/screen/routes/surfaceRoute.ts')
  plant: (over: Partial<SessionArgs>) => Promise<void>
  focus: (id: string | null, over?: Partial<SessionArgs>) => Promise<void>
  rekeys: string[]
  calls: string[]
  close: () => Promise<void>
}

export async function openSessionPart(tag: string, options: { keepHome?: boolean } = {}): Promise<SessionPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const rekeys: string[] = []
  const calls: string[] = []
  const realPending = { ...(await import('../../src/screen/composer/input-core/pending-input.ts')) }
  mock.module('../../src/screen/composer/input-core/pending-input.ts', () => ({
    ...realPending,
    rekeyToSession: (id: string | null, opts?: { landing?: boolean }) => {
      rekeys.push(`draft ${id ?? 'null'} landing=${opts?.landing === true}`)
      return realPending.rekeyToSession(id, opts)
    },
  }))
  const realQueue = { ...(await import('../../src/screen/composer/input-core/command-queue.ts')) }
  mock.module('../../src/screen/composer/input-core/command-queue.ts', () => ({
    ...realQueue,
    rekeyCommandQueueToSession: (id: string | null, opts?: { landing?: boolean }) => {
      rekeys.push(`queue ${id ?? 'null'} landing=${opts?.landing === true}`)
      realQueue.rekeyCommandQueueToSession(id, opts)
    },
  }))
  await import('../../src/screen/routes/SurfaceRouter.tsx')
  const module = await import('../../src/screen/chat/useChatSession.ts')
  const warmth = await import('../../src/screen/concourse-model/sessionWarmth.ts')
  const route = await import('../../src/screen/routes/surfaceRoute.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const before = slot.hasFocusedSession() ? slot.getFocusedSessionConnector() : null
  const fullscreenBefore = process.env.MERCURY_FULLSCREEN
  process.env.MERCURY_FULLSCREEN = '1'
  const connectorOf = (id: string): SessionArgs['focusedConnector'] => Object.assign(new NoSessionConnector(), { sessionId: () => id }) as never
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  warmth._resetSessionWarmthForTesting()
  let args: SessionArgs = {
    focusedConnector: connectorOf(tag),
    messages: [],
    compactWork: { read: () => 'composer', set: focus => void calls.push(`compactWork.set ${focus}`), toggleSummary: () => {}, bindToggle: () => {}, detailState: { selectedId: null, detailTaskId: undefined } },
    unseen: { onRepin: () => void calls.push('unseen.onRepin') },
    repinToBottom: () => void calls.push('repinToBottom'),
    setConversationId: id => void calls.push(`setConversationId ${id === '' ? "''" : id}`),
    setToolJSX: (next => void calls.push(`setToolJSX ${next === null ? 'null' : 'a dialog'}`)) as never,
    toolJSXRef: { current: null },
    localJsx: false,
    landing: false,
    armedMessage: null,
    chatSurfaceCovered: false,
    inVirtualTranscript: false,
    transcriptMessages: [],
  }
  slot.setFocusedSessionConnector(args.focusedConnector as never)
  const use = (): SessionValue => module.useChatSession(args)
  const part = await mountPart(use)
  return {
    module,
    part,
    warmth,
    route,
    plant: async over => {
      args = { ...args, ...over }
      await part.set(use)
    },
    focus: async (id, over = {}) => {
      const next = connectorOf(id ?? '')
      if (id === null) slot.releaseFocusedSessionConnector()
      else slot.setFocusedSessionConnector(next as never)
      args = { ...args, ...over, focusedConnector: next }
      await part.set(use)
    },
    rekeys,
    calls,
    close: async () => {
      part.unmount()
      warmth._resetSessionWarmthForTesting()
      realPending.resetPendingInputForTests()
      realQueue.resetCommandQueue()
      if (fullscreenBefore === undefined) delete process.env.MERCURY_FULLSCREEN
      else process.env.MERCURY_FULLSCREEN = fullscreenBefore
      if (before === null) slot.releaseFocusedSessionConnector()
      else slot.setFocusedSessionConnector(before)
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

export async function sessionRekeys(tag: string): Promise<{ atMount: string; hop: string; again: string; rest: string; landing: string }> {
  const session = await openSessionPart(tag, { keepHome: true })
  const said = (): string => session.rekeys.splice(0).join(' · ')
  const atMount = said()
  await session.focus(`${tag}-b`)
  const hop = said()
  await session.plant({ messages: [] })
  const again = said()
  await session.focus(null)
  const rest = said()
  await session.focus(`${tag}-c`)
  const landing = said()
  await session.close()
  return { atMount, hop, again, rest, landing }
}

type SelectorModule = typeof import('../../src/screen/chat/useChatSelector.tsx')
type SelectorArgs = Parameters<SelectorModule['useChatSelectorView']>[0]
type SelectorValue = ReturnType<SelectorModule['useChatSelectorView']>
type RewindAnswer = { outcome: 'applied' | 'noop' | 'refused'; mode: string; refusal?: string; detail?: string; conversation?: { removed: number }; code?: { filesChanged: string[]; insertions: number; deletions: number } }
type SelectorHandlers = {
  messages: Message[]
  preselectedMessage: Message | undefined
  providerOrigin: string
  onPreRestore: () => void
  onRestore: (message: Message | undefined, mode: 'both' | 'conversation' | 'code', files?: { filePath?: string; undo?: boolean; userMessageId?: string }) => Promise<RewindAnswer>
  onSummarize: () => Promise<void>
  onViewOnly: () => void
  onBranchCreated: (manifest: { branchSessionId: string; forkOrdinal: number }) => void
  onRerun: (message: Message) => Promise<{ ok: boolean; reason?: string }>
  onClose: () => void
}

type SelectorPart = {
  module: SelectorModule
  part: PartMount<SelectorValue>
  cursor: typeof import('../../src/screen/messages/messageCursorStore.ts')
  plant: (over: Partial<SelectorArgs>) => Promise<void>
  selector: () => SelectorHandlers
  press: (key: 'c' | 'enter', message: Message) => Promise<void>
  calls: string[]
  notices: Array<{ key: string; text: string }>
  session: { calls: string[]; records: Message[]; turnActive: boolean; onInterrupt: (() => void) | undefined; rewind: (request: Record<string, unknown>) => RewindAnswer; transcriptFile: string | null }
  draft: () => { text: string; mode: string }
  resumes: unknown[][]
  clipboard: { confirmation: string; copied: string[] }
  close: () => Promise<void>
}

export async function openSelectorPart(tag: string, options: { keepHome?: boolean } = {}): Promise<SelectorPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const clipboard = { confirmation: 'copied (the scripted clipboard)', copied: [] as string[] }
  const realOsc = { ...(await import('../../src/screen/renderer/termio/osc.ts')) }
  mock.module('../../src/screen/renderer/termio/osc.ts', () => ({
    ...realOsc,
    setClipboardWithReceipt: async (text: string) => {
      clipboard.copied.push(text)
      return { sequence: '', confirmation: clipboard.confirmation, settled: [] }
    },
  }))
  const module = await import('../../src/screen/chat/useChatSelector.tsx')
  const cursor = await import('../../src/screen/messages/messageCursorStore.ts')
  const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const before = slot.hasFocusedSession() ? slot.getFocusedSessionConnector() : null
  const calls: string[] = []
  const notices: Array<{ key: string; text: string }> = []
  const resumes: unknown[][] = []
  const session: SelectorPart['session'] = { calls: [], records: [], turnActive: false, onInterrupt: undefined, rewind: request => ({ outcome: 'applied', mode: String(request.mode), conversation: { removed: 2 } }), transcriptFile: null }
  slot.setFocusedSessionConnector(
    Object.assign(new NoSessionConnector(), {
      sessionId: () => tag,
      records: () => session.records,
      turnActive: () => session.turnActive,
      interrupt: () => {
        session.calls.push('interrupt')
        session.onInterrupt?.()
        return true
      },
      rewind: async (request: Record<string, unknown>) => {
        session.calls.push(`rewind ${JSON.stringify(request)}`)
        return session.rewind(request)
      },
      sendWords: async (text: string) => {
        session.calls.push(`sendWords ${JSON.stringify(text)}`)
        return { state: 'accepted' as const }
      },
      transcriptFile: () => session.transcriptFile ?? '',
    }) as never,
  )
  pending.resetPendingInputForTests()
  cursor._resetMessageCursorForTest()
  let args: SelectorArgs = {
    addNotification: ((notice: { key: string; text?: string }) => void notices.push({ key: String(notice.key), text: String(notice.text ?? '') })) as never,
    setInputValue: value => void calls.push(`setInputValue ${JSON.stringify(value)}`),
    setInputMode: mode => void calls.push(`setInputMode ${mode}`),
    setShowMessageSelector: show => void calls.push(`setShowMessageSelector ${show}`),
    messageSelectorPreselect: undefined,
    setMessageSelectorPreselect: message => void calls.push(`setMessageSelectorPreselect ${message === undefined ? 'undefined' : 'a message'}`),
    focusedInputDialog: 'message-selector',
    chatSurfaceCovered: false,
    messages: [],
    onCancel: () => void calls.push('onCancel'),
    focusedEffectiveModel: 'claude-sonnet-4-5',
    handleEnterTranscript: () => void calls.push('handleEnterTranscript'),
    setScreen: screen => void calls.push(`setScreen ${screen}`),
    setShowAllInTranscript: showAll => void calls.push(`setShowAllInTranscript ${showAll}`),
    isLoadingRef: { current: false },
    resume: async (...call) => void resumes.push(call),
  }
  const use = (): SelectorValue => module.useChatSelectorView(args)
  const part = await mountPart(use)
  return {
    module,
    part,
    cursor,
    plant: async over => {
      args = { ...args, ...over }
      await part.set(use)
    },
    selector: () => {
      const element = part.value().messageSelector as { props: SelectorHandlers } | null
      if (element === null) throw new Error('the message selector is not drawn')
      return element.props
    },
    press: async (key, message) => {
      part.value().messageNavRef.current = { enter: () => {}, prev: () => {}, next: () => {}, prevUser: () => {}, nextUser: () => {}, top: () => {}, bottom: () => {}, getSelected: () => message as never }
      cursor.setMessageCursor({ uuid: String((message as { uuid: string }).uuid), type: message.type as never, expanded: false })
      part.value().messageActions.handlers[`messageActions:${key}`]!()
      await settle(120)
    },
    calls,
    notices,
    session,
    draft: () => ({ text: pending.text(), mode: pending.mode() }),
    resumes,
    clipboard,
    close: async () => {
      part.unmount()
      cursor._resetMessageCursorForTest()
      pending.resetPendingInputForTests()
      if (before === null) slot.releaseFocusedSessionConnector()
      else slot.setFocusedSessionConnector(before)
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

type StatusModule = typeof import('../../src/screen/chat/useChatStatus.tsx')
type StatusRow = 'spinner' | 'hold' | 'rollup'
type StatusPlant = {
  seatLive: SessionLiveV1
  focusedInputDialog: Parameters<StatusModule['useChatSeatClock']>[0]['focusedInputDialog']
  textActive: boolean
  toolJSX: Parameters<StatusModule['useChatStatusStrip']>[0]['toolJSX']
  toolUseConfirmQueue: Parameters<StatusModule['useChatStatusStrip']>[0]['toolUseConfirmQueue']
  messages: Message[]
  isStopping: boolean
  streamingSuppressed: boolean
  isCompact: boolean
  spinnerTip: Parameters<StatusModule['useChatStatusStrip']>[0]['spinnerTip']
  verbose: boolean
}
type StatusValue = ReturnType<StatusModule['useChatTurnBoundary']> & ReturnType<StatusModule['useChatSeatClock']> & ReturnType<StatusModule['useChatTurnEnd']> & ReturnType<StatusModule['useChatStatusStrip']>

type StatusPart = {
  part: PartMount<StatusValue>
  signals: typeof import('../../src/screen/cockpit/turnSignals.ts')
  plant: (over: Partial<StatusPlant>) => Promise<void>
  handed: Record<StatusRow, Record<string, unknown> | null>
  mostSpinners: () => number
  notices: Array<{ key: string; text: string }>
  session: { chars: number; tokens: number | null; facts: Record<string, unknown>; completedAt: number | null; records: Message[]; warns: boolean }
  focus: (id: string, over?: Partial<StatusPlant>) => Promise<void>
  tips: { asked: Array<{ bashTools: string[] }>; next: string | null; shown: string[] }
  close: () => Promise<void>
}

export async function openStatusPart(tag: string, options: { keepHome?: boolean } = {}): Promise<StatusPart> {
  const home = options.keepHome === true ? null : pinScratchHome(tag)
  const React = await import('react')
  const handed: StatusPart['handed'] = { spinner: null, hold: null, rollup: null }
  let spinners = 0
  let most = 0
  const spy = (name: StatusRow) =>
    function Row(props: Record<string, unknown>): null {
      const own = React.useRef(props)
      own.current = props
      handed[name] = props
      React.useEffect(() => {
        if (name === 'spinner') most = Math.max(most, ++spinners)
        return () => {
          if (name === 'spinner') spinners--
          if (handed[name] === own.current) handed[name] = null
        }
      }, [])
      return null
    }
  const realSpinner = { ...(await import('../../src/screen/spinner/Spinner.tsx')) }
  mock.module('../../src/screen/spinner/Spinner.tsx', () => ({ ...realSpinner, SpinnerWithVerb: spy('spinner') }))
  const realHold = { ...(await import('../../src/screen/spinner/StreamingHoldRow.tsx')) }
  mock.module('../../src/screen/spinner/StreamingHoldRow.tsx', () => ({ ...realHold, StreamingHoldRow: spy('hold') }))
  const realRollup = { ...(await import('../../src/screen/chat/MercuryTurnRollup.tsx')) }
  mock.module('../../src/screen/chat/MercuryTurnRollup.tsx', () => ({ ...realRollup, MercuryTurnRollup: spy('rollup') }))
  const tips: StatusPart['tips'] = { asked: [], next: null, shown: [] }
  const realTips = { ...(await import('../../src/screen/tips/tipScheduler.ts')) }
  mock.module('../../src/screen/tips/tipScheduler.ts', () => ({
    ...realTips,
    getTipToShowOnSpinner: async (context?: { bashTools?: Set<string> }) => {
      tips.asked.push({ bashTools: [...(context?.bashTools ?? [])] })
      const words = tips.next
      return words === null ? undefined : { id: words, content: async () => words }
    },
    recordShownTip: (tip: { id: string }) => void tips.shown.push(tip.id),
  }))
  const module = await import('../../src/screen/chat/useChatStatus.tsx')
  const signals = await import('../../src/screen/cockpit/turnSignals.ts')
  const seatLive = await import('../../src/engine/connector/seatLive.ts')
  const slot = await import('../../src/engine/connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const before = slot.hasFocusedSession() ? slot.getFocusedSessionConnector() : null
  const session: StatusPart['session'] = { chars: 0, tokens: null, facts: { ...seatLive.IDLE_TURN_FACTS }, completedAt: null, records: [], warns: false }
  let plant: StatusPlant = { seatLive: seatLive.IDLE_LIVE, focusedInputDialog: undefined, textActive: false, toolJSX: null, toolUseConfirmQueue: [], messages: [], isStopping: false, streamingSuppressed: false, isCompact: false, spinnerTip: undefined, verbose: false }
  const connectorOf = (id: string): object =>
    Object.assign(new NoSessionConnector(), {
      sessionId: () => id,
      records: () => session.records,
      live: () => plant.seatLive,
      subscribeLive: () => () => {},
      tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
      turnChars: () => session.chars,
      turnOutputTokens: () => session.tokens,
      turnFacts: () => session.facts,
      lastTurnCompletedAtMs: () => session.completedAt,
      status: () => ({ title: id, projectLabel: 'proof-project', interrupting: false, hardStopping: false, wait: null, quietMs: session.warns ? 61_000 : null, watchdogMs: session.warns ? 120_000 : null, phaseMs: null, toolBudgetMs: null, stuck: session.warns, runner: null }),
    })
  let connector = connectorOf(tag)
  slot.setFocusedSessionConnector(connector as never)
  signals.resetTurnSignals()
  const notices: Array<{ key: string; text: string }> = []
  const addNotification = ((notice: { key: string; text?: string }) => void notices.push({ key: String(notice.key), text: String(notice.text ?? '') })) as never
  const getReadFileState = (() => new Map()) as never
  const use = (store: AppStateStore): StatusValue => {
    const isLoading = plant.seatLive.inFlight
    const setAppState = store.setState
    const boundary = module.useChatTurnBoundary({ isLoading, setAppState, addNotification })
    const clock = module.useChatSeatClock({ seatLive: plant.seatLive, focusedInputDialog: plant.focusedInputDialog, isLoading })
    const end = module.useChatTurnEnd({ focusedConnector: connector as never, isLoading, setAppState, themeName: 'dark' as never, getReadFileState, seatPausedMsRef: clock.seatPausedMsRef, seatPauseStartRef: clock.seatPauseStartRef })
    module.useChatTurnSignals({ isLoading, textActive: plant.textActive, toolUseConfirmQueue: plant.toolUseConfirmQueue, messages: plant.messages })
    const strip = module.useChatStatusStrip({ ...plant, isLoading, focusedConnector: connector as never, ...clock })
    return { ...boundary, ...clock, ...end, ...strip }
  }
  const part = await mountPart(use, { draw: value => value.workingStatusStrip })
  return {
    part,
    signals,
    plant: async over => {
      plant = { ...plant, ...over }
      await part.set(use)
    },
    handed,
    mostSpinners: () => most,
    notices,
    session,
    focus: async (id, over = {}) => {
      connector = connectorOf(id)
      slot.setFocusedSessionConnector(connector as never)
      plant = { ...plant, ...over }
      await part.set(use)
    },
    tips,
    close: async () => {
      part.unmount()
      signals.resetTurnSignals()
      if (before === null) slot.releaseFocusedSessionConnector()
      else slot.setFocusedSessionConnector(before)
      if (home !== null) await releaseScratchHome(home)
    },
  }
}

export async function closeStage(stage: Stage): Promise<void> {
  stage.view.unmount()
  await releaseScratchHome(stage.home)
}

async function holdReceiptExpiry(stage: Stage, key: string, show: () => Promise<void>): Promise<() => void> {
  const timers = await import('../../src/platform/async/timers.ts')
  const { RECEIPT_TIMEOUT_MS } = await import('../../src/screen/chat/limits.ts')
  const start = timers.startTimeout
  const store = stage.store()
  let hold: (() => void) | undefined
  let expire: (() => void) | undefined
  const tap = spyOn(timers, 'startTimeout').mockImplementation(<A extends unknown[]>(fire: (...args: A) => void, ms?: number, ...args: A) => {
    const timer = start(fire, ms, ...args)
    if (ms === RECEIPT_TIMEOUT_MS) hold = () => {
      timers.stopTimeout(timer)
      expire = () => fire(...args)
    }
    return timer
  })
  const stop = store.subscribe(() => {
    if (!expire && store.getState().notifications.current?.key === key) hold?.()
  })
  try { await show() } finally { stop(); tap.mockRestore() }
  if (!expire || store.getState().notifications.current?.key !== key) throw new Error(`hold the expiry of ${key} when its receipt is shown in scripts/ui/chatScenarios.ts`)
  return expire
}

const has = (words: string) => (frame: string): boolean => frame.includes(words)
const lacks = (words: string) => (frame: string): boolean => !frame.includes(words)
const PLACEHOLDER = 'Type a prompt'

export const SCENARIOS: Scenario[] = [
  {
    name: 'first-paint-session',
    covers: ['boot', 'title', 'draft'],
    run: async stage => {
      await stage.mark('the first settled frame with a session', has(PLACEHOLDER))
    },
  },
  {
    name: 'first-paint-empty-session',
    covers: ['boot', 'title'],
    options: { session: 'empty' },
    run: async stage => {
      await stage.mark('the first settled frame with a session that holds no rows', has(PLACEHOLDER))
    },
  },
  {
    name: 'no-chat-and-back',
    covers: ['boot', 'draft', 'scroll', 'session'],
    options: { session: 'none' },
    run: async stage => {
      await stage.mark('the first settled frame with no session: the screen has left for the boot face', () => stage.src.route.currentSurfaceRoute().kind !== 'repl')
      const session = stage.newSession('rec-landed', [stage.user('hello from the landed session'), stage.assistant('The landed session answers.')])
      stage.focus(session)
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('a session is focused and the route is the chat again', has('The landed session answers.'))
    },
  },
  {
    name: 'prompt-turn',
    covers: ['draft', 'submit', 'title', 'scroll', 'status'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('explain the gate')
      await stage.mark('a prompt is typed', has('explain the gate'))
      await stage.key(KEY.enter, 'enter sends the prompt', lacks('explain the gate'))
      stage.session.addRecords(stage.user('explain the gate'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      await stage.mark('the turn runs: thinking', has('explain the gate'))
      stage.session.setLive({ phase: 'tool', inProgressToolUseIDs: new Set(['toolu_rec_1']) })
      await stage.mark('the turn runs: a tool')
      stage.session.setLive({ phase: 'responding', inProgressToolUseIDs: new Set() })
      stage.session.stream('The gate runs every suite')
      await stage.mark('the turn runs: responding')
      stage.session.stream(null)
      stage.session.addRecords(stage.assistant('The gate runs every suite and prints one verdict.'))
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      stage.session.setCompletedAt(1)
      await stage.mark('the turn ended', has('prints one verdict'))
    },
  },
  {
    name: 'stream-reveal',
    covers: ['submit', 'scroll', 'status'],
    options: { reducedMotion: false },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('stream it'))
      stage.session.setLive({ inFlight: true, phase: 'responding', turnStartedAtMs: null })
      await stage.mark('a turn responds with no text yet', has('stream it'))
      stage.session.stream('STREAM-01 first line of the reply\nSTREAM-02 second line of the reply')
      await stage.mark('the tail streams two lines', has('STREAM-02'))
      stage.session.stream(null)
      stage.session.addRecords(stage.assistant('STREAM-01 first line of the reply\nSTREAM-02 second line of the reply'))
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the reply settled', has('STREAM-02'))
    },
  },
  {
    name: 'send-while-turn-runs',
    covers: ['submit', 'draft'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('a long job'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      await stage.mark('a turn runs', has('a long job'))
      await stage.type('and then the docs')
      await stage.key(KEY.enter, 'a prompt sent while the turn runs', lacks('and then the docs'))
      await stage.type('/compact')
      await stage.key(KEY.enter, 'a session command sent while the turn runs', has('queued'))
      stage.session.refuseSends('the session refused the line — it is closing')
      await stage.type('one more')
      await stage.key(KEY.enter, 'a refused send comes back to the composer', has('it is closing'))
    },
  },
  {
    name: 'ask-answered',
    covers: ['asks', 'dialogs', 'scroll'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('touch the marker'))
      stage.session.setLive({ inFlight: true, phase: 'tool', turnStartedAtMs: null })
      stage.session.setAsks([stage.askFor('toolu_ask_1', 'touch marker.txt'), stage.askFor('toolu_ask_2', 'rm marker.txt')])
      await stage.mark('an ask is shown with one more behind it', has('Do you want to proceed'))
      await stage.key('1', 'the first ask is allowed and the second shows', has('rm marker.txt'))
      await stage.key(KEY.esc, 'the second ask is declined with esc', lacks('Do you want to proceed'))
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the turn ended after the asks')
    },
  },
  {
    name: 'ask-under-words',
    covers: ['asks', 'dialogs', 'draft'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('touch the marker'))
      stage.session.setLive({ inFlight: true, phase: 'tool', turnStartedAtMs: null })
      stage.session.setAsks([stage.askFor('toolu_ask_3', 'touch marker.txt')])
      await stage.mark('an ask is shown', has('Do you want to proceed'))
      await stage.type('words under the card')
      await stage.whileTyped(async () => {
        await stage.mark('words typed while the card is up', has('words under the card'))
        await stage.key(SHIFT_TAB, 'shift+tab while the words are typed')
      })
      await stage.mark('the words have rested and the card stands with the words beneath it', has('Do you want to proceed'))
      await stage.key('1', 'the digit approves the card and the words stay in the composer', lacks('Do you want to proceed'))
    },
  },
  {
    name: 'permission-mode',
    covers: ['asks'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.key(SHIFT_TAB, 'shift+tab cycles the mode once')
      await stage.key(SHIFT_TAB, 'shift+tab cycles the mode twice')
      stage.session.setRunnerMode('default')
      await stage.mark('the runner reports its own mode and the screen adopts it')
      stage.session.refuseModes('the runner did not take it')
      await stage.key(SHIFT_TAB, 'a mode the session refuses', has('refused by the session'))
    },
  },
  {
    name: 'transcript-search',
    covers: ['search', 'keys', 'scroll'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.key(CTRL_O, 'ctrl+o opens the transcript', has('detailed transcript'))
      await stage.key('/', 'slash opens the search bar', lacks('detailed transcript'))
      await stage.type('manifest')
      await stage.mark('a query is typed', has('manifest'))
      await stage.key(KEY.enter, 'enter commits the query', has('detailed transcript'))
      await stage.key('n', 'n goes to the next match')
      await stage.key('N', 'N goes to the previous match')
      await stage.key('/', 'slash opens the search bar again', lacks('detailed transcript'))
      await stage.key(KEY.esc, 'esc cancels the search bar', has('detailed transcript'))
      await stage.key('g', 'g jumps to the top')
      await stage.key('G', 'G jumps to the bottom')
      await stage.key('q', 'q leaves the transcript', has(PLACEHOLDER))
    },
  },
  {
    name: 'transcript-dump-and-resize',
    covers: ['search', 'keys'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.key(CTRL_O, 'ctrl+o opens the transcript', has('detailed transcript'))
      await stage.key('/', 'slash opens the search bar', lacks('detailed transcript'))
      await stage.type('bundle')
      await stage.key(KEY.enter, 'enter commits the query', has('detailed transcript'))
      await stage.resize(100, 36, 'a resize drops the committed search')
      await stage.key('[', 'the bracket dumps the whole transcript')
      await stage.key(CTRL_O, 'ctrl+o leaves the transcript', has(PLACEHOLDER))
    },
  },
  {
    name: 'message-selector',
    covers: ['selector', 'dialogs', 'keys'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.view.push(KEY.esc)
      await settle(60)
      await stage.key(KEY.esc, 'esc twice opens the message selector', lacks(PLACEHOLDER))
      await stage.key(KEY.up, 'up moves to an earlier message')
      await stage.key(KEY.enter, 'enter chooses the message')
      await stage.key(KEY.enter, 'enter confirms the restore')
      await stage.mark('after the restore')
    },
  },
  {
    name: 'shell-line',
    covers: ['submit', 'draft'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('!')
      await stage.mark('a bang enters shell mode')
      await stage.type('ls -la')
      await stage.key(KEY.enter, 'enter sends the shell line', lacks('ls -la'))
    },
  },
  {
    name: 'slash-dialog',
    covers: ['submit', 'dialogs', 'keys'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('/usage')
      await stage.key(KEY.enter, 'a slash command opens its dialog', has('usage'))
      await stage.key(KEY.esc, 'esc closes the dialog', has(PLACEHOLDER))
      await stage.type('/nosuchcommand')
      await stage.key(KEY.enter, 'an unknown slash command is answered on the screen', has('Unknown command'))
    },
  },
  {
    name: 'interrupt',
    covers: ['keys', 'submit', 'status'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('a turn to stop'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      await stage.mark('a turn runs', has('a turn to stop'))
      await stage.key(KEY.esc, 'esc interrupts the turn')
      stage.session.setStatus({ interrupting: true })
      await stage.mark('the session says it is stopping')
      stage.session.setStatus({ interrupting: false })
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the turn stopped')
    },
  },
  {
    name: 'resize',
    covers: ['scroll', 'title'],
    run: async stage => {
      await stage.mark('first frame at 120x40', has(PLACEHOLDER))
      await stage.resize(60, 20, 'narrow: 60x20')
      await stage.resize(200, 50, 'wide: 200x50')
      await stage.resize(120, 40, 'back to 120x40')
    },
  },
  {
    name: 'compaction',
    covers: ['submit', 'title', 'status'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.setLive({ inFlight: true, phase: 'compacting', turnStartedAtMs: null })
      await stage.mark('the session compacts')
      await stage.type('held words')
      await stage.key(KEY.enter, 'a line sent while the session compacts', has('compact'))
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the compaction ended')
    },
  },
  {
    name: 'notices',
    covers: ['boot'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.setLostLine({ text: 'the line to the session was lost — reconnecting', atMs: 10 })
      await stage.mark('a lost line is told', has('was lost'))
      stage.session.setStoreFailing('the session transcript store is failing to write: disk full')
      await stage.mark('a failing transcript store is told', has('failing to write'))
      stage.session.setStoreFailing(null)
      await stage.mark('the store notice is taken back', lacks('disk full'))
    },
  },
  {
    name: 'session-switch',
    covers: ['draft', 'scroll', 'dialogs', 'session'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('a draft for the first session')
      await stage.mark('a draft is typed', has('a draft for the first session'))
      const other = stage.newSession('rec-other', [stage.user('the other session asks'), stage.assistant('The other session answers.')])
      stage.focus(other)
      await stage.mark('another session is focused', has('The other session answers.'))
    },
  },
  {
    name: 'long-scroll',
    covers: ['scroll'],
    run: async stage => {
      const rows = Array.from({ length: 12 }, (_, i) => [stage.user(`question ${i + 1}`), stage.assistant(Array.from({ length: 6 }, (_, l) => `ANSWER-${i + 1}-${l + 1} a line of the answer`).join('\n'))]).flat()
      stage.session.setRecords(rows)
      await stage.mark('a long transcript sits at its tail', has('ANSWER-12-6'))
      await stage.key(PAGE_UP, 'page up scrolls away from the tail')
      stage.session.addRecords(stage.assistant('NEW-1 a row that arrives while the reader is above'))
      await stage.mark('a new row arrives above the fold line')
      await stage.key(ALT_DOWN, 'alt+down returns to the tail', has('NEW-1'))
      stage.session.addRecords(stage.user('a human turn repins'))
      await stage.mark('a human turn arrives', has('a human turn repins'))
    },
  },
  {
    name: 'landing',
    covers: ['submit', 'draft', 'boot', 'session'],
    options: { session: 'none' },
    run: async stage => {
      let land: () => void = () => {}
      const landed = stage.src.slot.withLanding(new Promise<void>(resolve => (land = resolve)))
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('a session is landing and none is focused yet', has(PLACEHOLDER))
      await stage.type('a line typed while the session lands')
      await stage.key(KEY.enter, 'the line is held for the landing', has('your line sends when it lands'))
      await stage.type('/rename held')
      await stage.key(KEY.enter, 'a command is held for the landing too', has('/rename sends when it lands'))
      const session = stage.newSession('rec-landing', [])
      stage.focus(session)
      land()
      await landed
      await stage.mark('the session landed and the held lines were sent in order', () => stage.session.calls.length > 0 || stage.steps.length > 0)
    },
  },
  {
    name: 'model-switch-queued',
    covers: ['submit', 'title', 'status'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('a turn in which the model is switched'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      await stage.mark('a turn runs', has('the model is switched'))
      stage.store().setState(prev => ({ ...prev, pendingModelSwitch: { setting: 'claude-opus-4-5' } }))
      await stage.mark('a model switch waits for the turn to end')
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the turn ended and the queued model is applied', has('queued during the turn'))
      await stage.mark('the notice of the applied model has gone', lacks('queued during the turn'))
    },
  },
  {
    name: 'elicitation',
    covers: ['dialogs', 'asks'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      const answers: string[] = []
      stage.store().setState(prev => ({
        ...prev,
        elicitation: {
          queue: [
            {
              serverName: 'proof-server',
              requestId: 1,
              params: { message: 'Which branch should the server use?', requestedSchema: { type: 'object', properties: { branch: { type: 'string', title: 'Branch' } }, required: ['branch'] } },
              signal: new AbortController().signal,
              respond: (result: { action: string }) => void answers.push(result.action),
            },
          ],
        },
      }))
      await stage.mark('an elicitation is shown', has('Which branch should the server use?'))
      await stage.key(KEY.esc, 'esc declines the elicitation', lacks('Which branch should the server use?'))
      stage.session.calls.push(`elicitation answered: ${answers.join(',')}`)
      await stage.mark('after the elicitation')
    },
  },
  {
    name: 'rewind-during-turn',
    covers: ['selector', 'keys', 'submit'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.addRecords(stage.user('a turn that will be wound back'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      stage.session.hooks.onInterrupt = () => void setTimeout(() => stage.session.setLive({ inFlight: false, phase: 'idle' }), 250)
      await stage.mark('a turn runs', has('wound back'))
      await stage.type('/rewind')
      await stage.key(KEY.enter, 'the rewind command opens the message selector over the running turn', lacks(PLACEHOLDER))
      await stage.key(KEY.up, 'up moves to an earlier message')
      await stage.key(KEY.enter, 'enter chooses the message')
      await stage.key(KEY.enter, 'enter confirms: the turn is interrupted, waited for and wound back', has('rewound'))
    },
  },
  {
    name: 'crash-notice',
    covers: ['boot'],
    options: { plant: 'crash' },
    run: async stage => {
      await stage.mark('the first frame tells of the crash of an earlier session', has('a previous session crashed'))
    },
  },
  {
    name: 'help-and-history',
    covers: ['keys', 'draft'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.key('?', 'a question mark on the empty composer opens the shortcuts')
      await stage.key(KEY.esc, 'esc closes the shortcuts')
      await stage.key(CTRL_R, 'ctrl+r opens the history search')
      await stage.key(KEY.esc, 'esc closes the history search')
    },
  },
  {
    name: 'message-actions',
    covers: ['selector', 'keys'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.key(SHIFT_UP, 'shift+up puts the cursor on a message')
      await stage.key(KEY.up, 'up moves the cursor to an earlier message')
      await stage.key('c', 'c copies the message', has('opied'))
      await stage.key(KEY.esc, 'esc leaves the message cursor')
    },
  },
  {
    name: 'cost-threshold',
    covers: ['dialogs'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.setUsage(6, true)
      stage.session.addRecords(stage.assistant('An expensive answer.'))
      await stage.mark('the cost threshold dialog is shown', has('An expensive answer.'))
      await stage.key(KEY.enter, 'enter acknowledges the cost')
    },
  },
  {
    name: 'no-runner-refusal',
    covers: ['boot'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.setAdmissionRefusal('the daemon holds no seat for it')
      await stage.mark('a session with no runner says so and how to revive it', has('has no live runner'))
    },
  },
  {
    name: 'armed-line-throws',
    covers: ['submit'],
    options: { session: 'none' },
    run: async stage => {
      let land: () => void = () => {}
      const landed = stage.src.slot.withLanding(new Promise<void>(resolve => (land = resolve)))
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('a session is landing and none is focused yet', has(PLACEHOLDER))
      await stage.type('a line the session will not take')
      await stage.key(KEY.enter, 'the line is held for the landing', has('your line sends when it lands'))
      const session = stage.newSession('rec-faulty', [])
      session.failSends('the line to the session broke')
      stage.focus(session)
      land()
      await landed
      await stage.mark('the session landed, the send threw, and the screen stands', () => session.calls.some(call => call.endsWith('-> threw')))
    },
  },
  {
    name: 'transcript-degraded',
    covers: ['boot'],
    options: { columns: 200, rows: 40 },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
      const retired = join(stage.project, 'retired.jsonl')
      writeFileSync(retired, `${JSON.stringify(stage.user('a row in a format no longer read'))}\n`)
      await loadTranscriptFile(retired)
      await stage.mark('a transcript the loader refused is told', has('transcript refused on load'))
    },
  },
  {
    name: 'transcript-torn-line',
    covers: ['boot'],
    options: { columns: 200, rows: 40 },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
      const torn = join(stage.project, 'torn.jsonl')
      writeFileSync(torn, `${JSON.stringify({ schemaVersion: 1, recordId: 'rec-torn-1', payload: { kind: 'message' } })}\n{"schemaVersion": 1, "recordId": "rec-torn-2", "payl\n`)
      await loadTranscriptFile(torn)
      await stage.mark('a transcript with a line cut off and a record that fails its shape is told with its counts', has('transcript degraded on load'))
    },
  },
  {
    name: 'crash-resume-staged',
    covers: ['boot', 'dialogs'],
    options: { plant: 'crash-resumable' },
    run: async stage => {
      await stage.mark('a crashed session that can be opened again is offered', has('Resume that session'))
      await stage.key(KEY.esc, 'esc dismisses the offer', has(PLACEHOLDER))
    },
  },
  {
    name: 'worktree-tip',
    covers: ['boot'],
    options: { plant: 'worktree' },
    run: async stage => {
      await stage.mark('a worktree that took long to make gets the sparse-paths tip', has('worktree creation took'))
    },
  },
  {
    name: 'suspend-resume',
    covers: ['keys'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('words kept across the remount')
      await stage.mark('a draft is typed', has('words kept across the remount'))
      stage.emit('suspend')
      await stage.mark('the terminal suspends: a fullscreen screen writes nothing', has('words kept across the remount'))
      stage.emit('resume')
      await stage.mark('the terminal resumes: the layout is mounted again with the draft', has('words kept across the remount'))
    },
  },
  {
    name: 'entry-warmth',
    covers: ['session'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      const warmth = await import('../../src/screen/concourse-model/sessionWarmth.ts')
      const kept = [stage.user('what the warm session was asked'), stage.assistant('WARM-1 an answer kept from the last visit.')]
      warmth.rememberSessionWarmth('rec-warm', kept, 0)
      warmth.armEntryWarmth('rec-warm', 'the warm session', 'rec-session')
      await stage.mark('an entry is armed over the session in view: the kept rows are painted', has('WARM-1'))
      const warm = stage.newSession('rec-warm', [])
      stage.focus(warm)
      await stage.mark('the session is focused before its rows arrive: the kept rows stand', has('WARM-1'))
      warm.setRecords([...kept, stage.assistant('WARM-2 a row that arrived since.')])
      await stage.mark('its rows arrive and the entry settles', has('WARM-2'))
      warmth.armEntryWarmth('rec-cold', 'the cold session')
      const cold = stage.newSession('rec-cold', [])
      stage.focus(cold)
      await stage.mark('a session with nothing kept says it is loading', has('loading the conversation'))
      stage.focus(warm)
      await stage.mark('another session is focused instead and the entry is dropped', has('WARM-2'))
    },
  },
  {
    name: 'boot-preflight-fails',
    covers: ['boot'],
    options: { plant: 'preflight' },
    run: async stage => {
      await stage.mark('a failing check of the boot preflight is told', has('boot preflight: ripgrep failed'))
    },
  },
  {
    name: 'resume-fold-notice',
    covers: ['boot'],
    options: { plant: 'fold-notice' },
    run: async stage => {
      await stage.mark('a resumed run tells of its interrupted tools and its blocker', frame => frame.includes('tool call(s) interrupted') || frame.includes('the build waits for a sign-in'))
    },
  },
  {
    name: 'housekeeping-throws',
    covers: ['boot', 'submit'],
    options: { plant: 'housekeeping' },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('the first prompt')
      await stage.key(KEY.enter, 'the first prompt is sent though the housekeeping could not start', lacks('the first prompt'))
    },
  },
  {
    name: 'shell-road-notice',
    covers: ['boot'],
    options: { columns: 200, rows: 40, env: { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_SHELL_ENGINE: 'system' } },
    run: async stage => {
      await stage.mark('a host with no bash of any origin is told at the first frame', has('Bash tool absent'))
    },
  },
  {
    name: 'update-notice',
    covers: ['boot'],
    options: { plant: 'update-notice' },
    run: async stage => {
      await stage.mark('a newer version found by the quiet check is told and stays', has('9.9.9'))
    },
  },
  {
    name: 'daemon-handshake-line',
    covers: ['boot'],
    options: { columns: 160, rows: 40, plant: 'handshake' },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.handshake('the daemon runs an older build than this window')
      await stage.mark('a daemon of another build is told', has('the daemon runs an older build'))
      stage.handshake(null)
      await stage.mark('the daemon answers with this build and the line goes', lacks('the daemon runs an older build'))
    },
  },
  {
    name: 'tmux-hint',
    covers: ['boot'],
    options: { columns: 160, rows: 40, plant: 'tmux' },
    run: async stage => {
      await stage.mark('a fullscreen window inside tmux without the mouse is given the hint', has('tmux detected'))
    },
  },
  {
    name: 'submit-screen-commands',
    covers: ['submit'],
    options: { plant: 'commands' },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('/proof-says the words')
      await stage.key(KEY.enter, 'a command of the screen runs and its line is painted as rows', has('the scripted command said the words'))
      await stage.type('/proof-throws')
      await stage.key(KEY.enter, 'a command that throws is told as failed', has('a planted fault of the command'))
      await stage.type('/proof-throws-words')
      await stage.key(KEY.enter, 'a command that throws what is no Error is told as failed', has('a planted fault that is no Error'))
      stage.session.addRecords(stage.user('a turn the command stops'))
      stage.session.setLive({ inFlight: true, phase: 'thinking', turnStartedAtMs: null })
      await stage.mark('a turn runs', has('a turn the command stops'))
      await stage.type('/proof-stops')
      await stage.key(KEY.enter, 'a command that interrupts first stops the turn and then runs', has('stopped the turn first'))
      stage.session.setLive({ inFlight: false, phase: 'idle' })
      await stage.mark('the turn ended')
      await stage.type('//two slashes are words')
      await stage.key(KEY.enter, 'a line that begins with two slashes is sent as words', lacks('//two slashes are words'))
      await stage.type('words that stay')
      await stage.mark('other words are typed', has('words that stay'))
      stage.dispatch('/compact')
      await stage.mark('a command dispatched by a key is sent as one and the typed words stay', frame => frame.includes('words that stay') && stage.session.calls.some(call => call.includes('fromKeybinding')))
    },
  },
  {
    name: 'submit-route-alias',
    covers: ['submit'],
    options: { plant: 'commands' },
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('/proof-route')
      await stage.key(KEY.enter, 'a command that is a route opens the concourse', lacks(PLACEHOLDER))
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('back on the chat', has(PLACEHOLDER))
      await stage.type('/proof-route')
      await stage.mark('the route is typed and not sent', has('/proof-route'))
      stage.dispatch('/proof-route')
      await stage.mark('the same line dispatched by a key leaves the composer and opens the concourse', lacks('/proof-route'))
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('back on the chat again', has(PLACEHOLDER))
      stage.plainWorld()
      await stage.type('/proof-concourse-only')
      await stage.key(KEY.enter, 'a command of the concourse is answered as unavailable where no concourse is', has('proof-concourse-only'))
      await stage.type('/proof-route')
      await stage.key(KEY.enter, 'the route opens the concourse once more', lacks(PLACEHOLDER))
      stage.dispatch('/proof-route')
      await stage.mark('the route asked for again while the concourse is open')
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('back on the chat, which says the concourse was open already', has('already open'))
    },
  },
  {
    name: 'submit-dialog-commands',
    covers: ['submit', 'dialogs'],
    options: { plant: 'commands' },
    run: async stage => {
      const last = (): Stage['dialogs'][number] => stage.dialogs[stage.dialogs.length - 1]!
      await stage.mark('first frame', has(PLACEHOLDER))
      await stage.type('/proof-slow')
      await stage.key(KEY.enter, 'a dialog command that takes long to answer is sent', () => stage.dialogs.length === 1)
      await stage.type('/proof-dialog two')
      await stage.key(KEY.enter, 'a second dialog command waits behind the first', has('queued — runs when /proof-slow settles'))
      stage.dialogs[0]!.done()
      await stage.mark('the first answers with nothing to show and the second mounts', has('a scripted dialog (two)'))
      const second = last()
      second.done('the second dialog ended\nwith two lines')
      second.done()
      await stage.mark('a result of two lines is painted as rows, and a second done is ignored', has('with two lines'))
      await stage.type('/proof-dialog three')
      await stage.key(KEY.enter, 'a third dialog mounts', has('a scripted dialog (three)'))
      last().done(undefined, { display: 'skip', shouldQuery: true, metaMessages: ['meta words for the turn', ' '] })
      await stage.mark('a dialog that asks for a turn sends its meta words', () => stage.session.calls.some(call => call.includes('meta words for the turn')))
      stage.session.refuseSends('the session refused the meta words')
      await stage.type('/proof-dialog four')
      await stage.key(KEY.enter, 'a fourth dialog mounts', has('a scripted dialog (four)'))
      last().done(undefined, { shouldQuery: true, metaMessages: ['meta words the session refuses'] })
      await stage.mark('meta words the session refuses are told', has('could not start the turn'))
      stage.session.refuseSends(null)
      await stage.type('/proof-nothing')
      await stage.key(KEY.enter, 'a dialog command with nothing to show says so', has('had nothing to show'))
      await stage.type('/proof-dialog-throws')
      await stage.key(KEY.enter, 'a dialog command that throws is told as failed', has('a planted fault of the dialog'))
      const expireFailure = await holdReceiptExpiry(stage, 'command-proof-dialog-throws-words', async () => {
        await stage.type('/proof-dialog-throws-words')
        await stage.key(KEY.enter, 'a dialog command that throws what is no Error is told as failed', has('that is no Error'))
      })
      await stage.type('/logins')
      await stage.key(KEY.enter, 'the sign-in door mounts', has('a scripted sign-in door'))
      last().done()
      await stage.mark('the door closes with no prompt held behind a wall', lacks('a scripted sign-in door'))
      stage.session.addRecords(stage.user('a prompt behind a wall'), { ...stage.assistant('Sign in to go on.'), isApiErrorMessage: true, error: 'authentication_failed' } as Message)
      await stage.mark('a prompt refused at a sign-in wall goes back into the composer', frame => frame.includes('❯ a prompt behind a wall') || frame.split('a prompt behind a wall').length > 2)
      stage.dispatch('/model')
      await stage.mark('the model door mounts over the held prompt', has('a scripted model door'))
      stage.session.setModelFacts({ effective: 'claude-opus-4-5', main: 'claude-opus-4-5' })
      last().done()
      await stage.mark('another model was chosen behind the door: the held prompt is sent again', () => stage.session.calls.some(call => call.includes('a prompt behind a wall')))
      await stage.type('/proof-dialog typed')
      await stage.mark('a dialog command is typed and not sent', has('/proof-dialog typed'))
      stage.dispatch('/proof-dialog typed')
      await stage.mark('dispatched by a key it leaves the composer and mounts', has('a scripted dialog (typed)'))
      last().done(undefined, { nextInput: '  ', submitNextInput: true })
      await stage.mark('a blank next line is not sent', lacks('a scripted dialog (typed)'))
      await stage.type('/proof-dialog five')
      await stage.key(KEY.enter, 'a fifth dialog mounts', has('a scripted dialog (five)'))
      last().done(undefined, { nextInput: '/proof-says from a dialog', submitNextInput: true })
      expireFailure()
      await stage.mark('a next line a dialog submits is run', frame => frame.includes('the scripted command said from a dialog') && frame.includes('effort: medium · /effort to change'))
      await stage.type('/proof-dialog six')
      await stage.key(KEY.enter, 'a sixth dialog mounts', has('a scripted dialog (six)'))
      last().done(undefined, { nextInput: 'words a dialog hands to the composer' })
      await stage.mark('a next line a dialog does not submit stands in the composer', has('words a dialog hands to the composer'))
    },
  },
  {
    name: 'submit-landing-refused',
    covers: ['submit'],
    options: { session: 'none', plant: 'commands' },
    run: async stage => {
      let land: () => void = () => {}
      const landed = stage.src.slot.withLanding(new Promise<void>(resolve => (land = resolve)))
      stage.src.route.initializeSurfaceRoute(stage.src.route.ROOT_CHAT_ROUTE)
      await stage.mark('a session is landing and none is focused yet', has(PLACEHOLDER))
      await stage.type('a first held line')
      await stage.key(KEY.enter, 'the line is held for the landing', has('your line sends when it lands'))
      await stage.type('!')
      await stage.type('ls -la')
      await stage.key(KEY.enter, 'a shell line is held behind it', lacks('ls -la'))
      await stage.type('/mission ship it')
      await stage.key(KEY.enter, 'a mission with words is held too', has('/mission sends when it lands'))
      await stage.type('/whisper to the crew')
      await stage.key(KEY.enter, 'and a command of the screen', has('/whisper sends when it lands'))
      const session = stage.newSession('rec-refusing', [])
      session.refuseSends('the landed session refused the line')
      stage.focus(session)
      land()
      await landed
      await stage.mark('the session landed and refused: both lines come back joined, the commands ran', frame => frame.includes('a first held line') && frame.includes('the scripted whisper said to the crew'))
    },
  },
  {
    name: 'submit-refusal-under-words',
    covers: ['submit', 'draft'],
    run: async stage => {
      await stage.mark('first frame', has(PLACEHOLDER))
      stage.session.refuseSends('the session refused the line — it is closing')
      const release = stage.session.holdSends()
      await stage.type('a line the session will refuse')
      await stage.key(KEY.enter, 'the line is sent and its answer is not back yet', lacks('a line the session will refuse'))
      await stage.type('words typed since')
      await stage.mark('more words are typed', has('words typed since'))
      release()
      await stage.mark('the refusal is told and the words typed since stand', frame => frame.includes('it is closing') && frame.includes('words typed since'))
    },
  },
]

export async function recordScenario(name: string): Promise<Recording> {
  const scenario = SCENARIOS.find(entry => entry.name === name)
  if (scenario === undefined) throw new Error(`no scenario named ${name}: ${SCENARIOS.map(entry => entry.name).join(', ')}`)
  const stage = await openStage(name, scenario.options)
  try {
    await scenario.run(stage)
    return { scenario: name, size: `${scenario.options?.columns ?? 120}x${scenario.options?.rows ?? 40}`, warmups: stage.warmups(), steps: stage.steps }
  } finally {
    await closeStage(stage)
  }
}

export function renderRecording(recording: Recording): string {
  const out: string[] = [`scenario ${recording.scenario} · ${recording.size} · ${recording.steps.length} settled points`, `warm-ups, each a stand-in of the harness: ${recording.warmups}`]
  recording.steps.forEach((step, index) => {
    out.push('', `=== ${index + 1}. ${step.label}`, `title: ${step.title ?? '(none)'}`, `cursor: ${step.cursor}`)
    for (const call of step.calls) out.push(`call: ${call}`)
    for (const mode of step.modes) out.push(`mode: ${mode}`)
    out.push('--- screen', ...step.lines.map(line => `|${line}`), '--- end')
  })
  return out.join('\n') + '\n'
}

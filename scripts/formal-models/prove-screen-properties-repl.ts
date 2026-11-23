#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import stripAnsi from 'strip-ansi'
import { checker } from '../engine-durability/harness.ts'

const previousCwd = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-screen-props-repl-')))
const configHome = join(scratch, 'config')
const daemonDir = join(scratch, 'daemon')
const fixtureRoot = join(scratch, 'project')
mkdirSync(configHome, { recursive: true })
mkdirSync(daemonDir, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })

process.chdir(fixtureRoot)
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.HOME = configHome
process.env.USERPROFILE = configHome
process.env.MERCURY_CLIPBOARD_FILE = join(configHome, 'clipboard.txt')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_AWAY_SUMMARY = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.FORCE_COLOR = '0'
process.env.BROWSER = '/usr/bin/true'
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) {
    delete process.env[name]
  }
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const React = await import('react')
const h = React.createElement

const { __setBurstCrHostForTest } = await import('../../src/screen/renderer/input/input-decoder.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
registerBootDoors()
saveCurrentProjectConfig(cfg => ({
  ...cfg,
  hasCompletedProjectOnboarding: true,
  hasTrustDialogAccepted: true,
}))
saveGlobalConfig(cfg => ({
  ...cfg,
  prStatusFooterEnabled: false,
  hasCompletedOnboarding: true,
  theme: 'dark',
}))

const { markDaemonHaltStanddown } = await import('../../src/daemon/control/daemonStanddown.ts')
markDaemonHaltStanddown()

const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
const slot = await import('../../src/engine/connector/focusedConnector.ts')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { expandPastedTextRefs } = await import('../../src/sessions/promptHistory.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { App } = await import('../../src/boot/App.tsx')
const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.tsx')
const { Chat } = await import('../../src/screen/chat/Chat.tsx')
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')

type Message = import('../../src/engine/message-shapes/message.js').Message
type Paste = { id: number; type: 'text' | 'image'; content: string }

class FakeStdout extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
  write(): boolean {
    return true
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return this.chunks.shift() ?? null
  }
  get readableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}

const KEYS = {
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  backspace: '\x7f',
  ctrlU: '\x15',
  ctrlO: '\x0f',
  enter: '\r',
  esc: '\x1b[27u',
  pasteStart: '\x1b[200~',
  pasteEnd: '\x1b[201~',
} as const

let sentMessages: string[] = []
let faultRewriteSend: ((text: string) => string) | null = null

class FixtureConnector extends NoSessionConnector {
  private recs: readonly Message[] = []
  private recListeners = new Set<() => void>()

  override sessionId(): string {
    return 'repl-property-session'
  }

  override records(): readonly Message[] {
    return this.recs
  }

  override subscribeRecords = (listener: () => void): (() => void) => {
    this.recListeners.add(listener)
    return () => {
      this.recListeners.delete(listener)
    }
  }

  setRecords(next: readonly Message[]): void {
    this.recs = next
    for (const fn of this.recListeners) fn()
  }

  override sendWords = async (
    text: string,
    opts?: { pastedContents?: Record<number, Paste> },
  ): Promise<{ state: 'accepted' }> => {
    const expanded = expandPastedTextRefs(text, (opts?.pastedContents ?? {}) as never)
    sentMessages.push(faultRewriteSend ? faultRewriteSend(expanded) : expanded)
    return { state: 'accepted' }
  }
}

const connector = new FixtureConnector()
initializeSurfaceRoute(ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
slot.setFocusedSessionConnector(connector)
__setBurstCrHostForTest(false)
const COLS = 120
const ROWS = 34
const stdout = new FakeStdout(COLS, ROWS)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(COLS, ROWS) as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, false)

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function settleFrame(): Promise<string> {
  reconciler.flushSyncWork()
  await tick()
  reconciler.flushSyncWork()
  await tick()
  ink.onRender()
  return stripAnsi(ink.lastFrameText())
}

async function sendKey(seq: string): Promise<string> {
  stdin.push(seq)
  return settleFrame()
}

function buildTranscript(turnCount: number): { messages: Message[]; markers: string[] } {
  const messages: Message[] = []
  const markers: string[] = []
  for (let i = 0; i < turnCount; i++) {
    const tag = String(i + 1).padStart(2, '0')
    const userMarker = `UMSG-${tag}`
    const asstMarker = `AMSG-${tag}`
    markers.push(userMarker, asstMarker)
    messages.push(createUserMessage({ content: `${userMarker} topic-${tag}` }))
    messages.push(createAssistantMessage({ content: `${asstMarker} reply-${tag}` }))
  }
  return { messages, markers }
}

type EditOp =
  | { kind: 'type'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'backspace' }

type ComposeScenario = {
  turnCount: number
  ops: EditOp[]
  ending: 'send' | 'clear'
}

function applyOpToModel(state: { buf: string; cur: number }, op: EditOp): { buf: string; cur: number } {
  switch (op.kind) {
    case 'type':
      return {
        buf: state.buf.slice(0, state.cur) + op.text + state.buf.slice(state.cur),
        cur: state.cur + op.text.length,
      }
    case 'paste': {
      const before = state.buf.slice(0, state.cur)
      const after = state.buf.slice(state.cur)
      const padLeft = after.length === 0 && before.length > 0 && !/\s$/.test(before) && op.text.length > 0 ? ' ' : ''
      const inserted = `${padLeft}${op.text}`
      return {
        buf: before + inserted + after,
        cur: state.cur + inserted.length,
      }
    }
    case 'left':
      return { buf: state.buf, cur: Math.max(0, state.cur - 1) }
    case 'right':
      return { buf: state.buf, cur: Math.min(state.buf.length, state.cur + 1) }
    case 'home':
      return { buf: state.buf, cur: 0 }
    case 'end':
      return { buf: state.buf, cur: state.buf.length }
    case 'backspace':
      if (state.cur === 0) return state
      return {
        buf: state.buf.slice(0, state.cur - 1) + state.buf.slice(state.cur),
        cur: state.cur - 1,
      }
  }
}

function hasComposerPromptRow(frame: string): boolean {
  return !frame.includes('detailed transcript · ctrl+o to toggle') && frame.includes('│❯')
}
async function resetComposer(messages: readonly Message[]): Promise<string> {
  sentMessages = []
  connector.setRecords(messages)
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})
  let frame = await settleFrame()
  frame = await settleFrame()
  return frame
}

async function runComposeScenario(scenario: ComposeScenario): Promise<void> {
  const { messages, markers } = buildTranscript(scenario.turnCount)
  let frame = await resetComposer(messages)

  if (markers.length > 0) {
    const latestMarker = markers[markers.length - 1]!
    if (!frame.includes(latestMarker)) {
      throw new Error(`mount: latest transcript marker ${latestMarker} not painted on Chat:\n${frame}`)
    }
  }

  let model = { buf: '', cur: 0 }
  for (let i = 0; i < scenario.ops.length; i++) {
    const op = scenario.ops[i]!
    if (op.kind === 'type') {
      for (const ch of op.text) {
        frame = await sendKey(ch)
      }
    } else if (op.kind === 'paste') {
      frame = await sendKey(`${KEYS.pasteStart}${op.text}${KEYS.pasteEnd}`)
    } else {
      frame = await sendKey(KEYS[op.kind])
    }
    model = applyOpToModel(model, op)
    if (sentMessages.length !== 0) {
      throw new Error(`op[${i}](${op.kind}): message sent before Enter: ${JSON.stringify(sentMessages)}`)
    }
    const liveDraft = expandPastedTextRefs(pending.text(), pending.pastedContents() as never)
    if (liveDraft !== model.buf) {
      throw new Error(`op[${i}](${op.kind}): composer draft diverged: expected ${JSON.stringify(model.buf)}, got ${JSON.stringify(liveDraft)}`)
    }
    if (model.buf.trim().length > 0 && !frame.includes(model.buf.trim())) {
      throw new Error(`op[${i}](${op.kind}): painted composer did not show live draft ${JSON.stringify(model.buf)}:\n${frame}`)
    }
  }

  if (scenario.ending === 'clear') {
    frame = await sendKey(KEYS.ctrlU)
    if (sentMessages.length !== 0) {
      throw new Error(`Ctrl+U sent message unexpectedly: ${JSON.stringify(sentMessages)}`)
    }
    const afterClear = expandPastedTextRefs(pending.text(), pending.pastedContents() as never)
    const expectedRemainder = model.buf.slice(model.cur)
    if (afterClear !== expectedRemainder) {
      throw new Error(`Ctrl+U expected remainder ${JSON.stringify(expectedRemainder)}, got ${JSON.stringify(afterClear)}`)
    }
    return
  }
  frame = await sendKey(KEYS.enter)
  frame = await settleFrame()
  if (model.buf.trim().length === 0) {
    if (sentMessages.length !== 0) {
      throw new Error(`Enter on empty/whitespace draft sent ${JSON.stringify(sentMessages)}`)
    }
    return
  }
  if (sentMessages.length !== 1) {
    throw new Error(`Enter on ${JSON.stringify(model.buf)} sent ${sentMessages.length} messages, expected 1`)
  }
  if (sentMessages[0] !== model.buf.trim()) {
    throw new Error(`wrong message sent: composer ${JSON.stringify(model.buf.trim())} != sent ${JSON.stringify(sentMessages[0])}`)
  }
  if (pending.text() !== '') {
    throw new Error(`composer did not clear after Enter: left ${JSON.stringify(pending.text())}`)
  }
}

const editOpArb: fc.Arbitrary<EditOp> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      text: fc.constantFrom('a', 'b', 'hi', 'fix', '12', ' '),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('paste' as const),
      text: fc.constantFrom('pasted', 'chunk-42'),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'left' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'right' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'backspace' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'home' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'end' as const }) },
)

const composeScenarioArb: fc.Arbitrary<ComposeScenario> = fc.record({
  turnCount: fc.integer({ min: 0, max: 4 }),
  ops: fc.array(editOpArb, { minLength: 0, maxLength: 10 }),
  ending: fc.constantFrom('send' as const, 'clear' as const),
})

const t = checker()
const SEED_COMPOSE = 20261161
const SEED_MODES = 20261162
const SEED_FAULT = 20261163

try {
  ink.render(
    h(
      App,
      {
        initialState: getDefaultAppState(),
        getFpsMetrics: () => undefined,
        children: h(SurfaceRouter, {
          children: h(Chat, { commands: [], initialTools: [] }),
        }),
      },
    ),
  )
  await settleFrame()
  await settleFrame()

  t.section('§1 — Chat (repl): transcript paints data, composer edits match model, Enter sends exact draft and clears')
  {
    const result = await fc.check(
      fc.asyncProperty(composeScenarioArb, async scenario => {
        await runComposeScenario(scenario)
      }),
      { numRuns: 50, seed: SEED_COMPOSE },
    )
    t.check(
      `50 generated transcript/composer/paste scenarios held draft fidelity & send laws (seed ${SEED_COMPOSE})`,
      !result.failed,
      result.failed ? `path=${result.counterexamplePath} error=${String(result.errorInstance)}` : '',
    )
  }

  t.section('§2 — Chat (repl): transcript search with empty match and shell mode (!) always leave cleanly on Esc')
  {
    const searchArb = fc.record({
      turnCount: fc.integer({ min: 1, max: 4 }),
      query: fc.constantFrom('UMSG-01', 'reply', 'zzznohit', 'missing99'),
      commitBeforeEsc: fc.boolean(),
    })
    const searchRes = await fc.check(
      fc.asyncProperty(searchArb, async ({ turnCount, query, commitBeforeEsc }) => {
        const { messages } = buildTranscript(turnCount)
        let frame = await resetComposer(messages)
        if (!hasComposerPromptRow(frame)) {
          throw new Error(`before transcript search: composer prompt row missing:\n${frame}`)
        }
        frame = await sendKey(KEYS.ctrlO)
        if (hasComposerPromptRow(frame)) {
          throw new Error(`Ctrl+O did not enter transcript view:\n${frame}`)
        }
        frame = await sendKey('/')
        for (const ch of query) frame = await sendKey(ch)
        if (commitBeforeEsc) {
          frame = await sendKey(KEYS.enter)
        }
        for (let tries = 0; tries < 3 && !hasComposerPromptRow(frame); tries++) {
          frame = await sendKey(KEYS.esc)
        }
        if (!hasComposerPromptRow(frame) || sentMessages.length !== 0) {
          throw new Error(`Esc from transcript search('${query}', commit=${commitBeforeEsc}) did not return to prompt (sent=${sentMessages.length}):\n${frame}`)
        }
      }),
    )
    t.check(
      `20 generated transcript-search sequences (including empty matches) returned cleanly to prompt on Esc (seed ${SEED_MODES})`,
      !searchRes.failed,
      searchRes.failed ? `path=${searchRes.counterexamplePath} error=${String(searchRes.errorInstance)}` : '',
    )

    const shellArb = fc.record({
      cmd: fc.stringMatching(/^[a-z0-9]{1,6}$/),
      leaveWith: fc.constantFrom('home-esc' as const, 'ctrlU' as const, 'backspaces' as const),
    })
    const shellRes = await fc.check(
      fc.asyncProperty(shellArb, async ({ cmd, leaveWith }) => {
        await resetComposer([])
        let frame = await sendKey('!')
        for (const ch of cmd) frame = await sendKey(ch)
        if (pending.mode() !== 'bash' || pending.text() !== cmd) {
          throw new Error(`typing '!${cmd}' did not enter bash mode: mode=${pending.mode()} text=${JSON.stringify(pending.text())}`)
        }
        if (leaveWith === 'ctrlU') {
          frame = await sendKey(KEYS.ctrlU)
        } else if (leaveWith === 'home-esc') {
          frame = await sendKey(KEYS.home)
          frame = await sendKey(KEYS.esc)
        } else {
          for (let i = 0; i <= cmd.length; i++) {
            frame = await sendKey(KEYS.backspace)
          }
        }
        if (pending.mode() !== 'prompt' || sentMessages.length !== 0 || !hasComposerPromptRow(frame)) {
          throw new Error(`${leaveWith} from bash mode '!${cmd}' did not leave shell mode (mode=${pending.mode()}, sent=${sentMessages.length})`)
        }
      }),
      { numRuns: 20, seed: SEED_MODES + 10 },
    )
    t.check(
      `20 generated shell-mode (!) sequences left cleanly to prompt mode without sending (seed ${SEED_MODES + 10})`,
      !shellRes.failed,
      shellRes.failed ? `path=${shellRes.counterexamplePath} error=${String(shellRes.errorInstance)}` : '',
    )
  }

  t.section('§3 — Truncated send fault shrinks to a replayable minimal counterexample with seed and path')
  {
    const faultArb: fc.Arbitrary<ComposeScenario> = fc.record({
      turnCount: fc.constant(1),
      ops: fc.array(
        fc.oneof(
          fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('a', 'b', 'hi') }),
          fc.record({ kind: fc.constant('paste' as const), text: fc.constant('xy') }),
        ),
        { minLength: 1, maxLength: 6 },
      ),
      ending: fc.constant('send' as const),
    })

    const faultyProp = fc.asyncProperty(faultArb, async scenario => {
      faultRewriteSend = text => (text.length >= 2 ? text.slice(0, -1) : text)
      try {
        await runComposeScenario(scenario)
      } finally {
        faultRewriteSend = null
      }
    })

    const caught = await fc.check(faultyProp, { numRuns: 40, seed: SEED_FAULT })
    const shrinkPath = caught.counterexamplePath ?? ''
    t.check(
      `fault-injected truncated send failed with seed ${SEED_FAULT} and shrink path`,
      caught.failed && caught.seed === SEED_FAULT && shrinkPath.length > 0,
      `failed=${caught.failed} path=${shrinkPath}`,
    )

    const minimized = caught.counterexample?.[0]
    t.check(
      'shrunk counterexample is minimal (<= 2 ops)',
      minimized !== undefined && minimized.ops.length <= 2,
      minimized ? `ops=${JSON.stringify(minimized.ops)} shrinks=${caught.numShrinks}` : 'no counterexample',
    )

    const replay = await fc.check(faultyProp, {
      seed: caught.seed,
      path: shrinkPath,
      endOnFailure: true,
    })
    t.check(
      `replaying seed=${caught.seed} path=${shrinkPath} reproduced identical counterexample`,
      replay.failed &&
        JSON.stringify(replay.counterexample) === JSON.stringify(caught.counterexample) &&
        String(replay.errorInstance).includes('wrong message sent:'),
      `replay.failed=${replay.failed} err=${String(replay.errorInstance).slice(0, 140)}`,
    )

    const cleanReplay = await fc.check(
      fc.asyncProperty(faultArb, async scenario => {
        await runComposeScenario(scenario)
      }),
      { seed: caught.seed, path: shrinkPath, endOnFailure: true },
    )
    t.check(
      `unmodified Chat passed exact counterexample replay (seed=${caught.seed} path=${shrinkPath})`,
      !cleanReplay.failed,
      cleanReplay.failed ? String(cleanReplay.errorInstance) : '',
    )
  }
} finally {
  faultRewriteSend = null
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('screen-properties-repl')

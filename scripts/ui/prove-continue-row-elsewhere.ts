#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const previousCwd = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-continue-elsewhere-')))
const configHome = join(scratch, 'config')
const daemonDir = join(configHome, 'daemon')
const freshDir = join(scratch, 'fresh-folder')
const otherTrusted = join(scratch, 'other-trusted')
const otherUntrusted = join(scratch, 'other-untrusted')
const ownDir = join(scratch, 'own-project')
for (const d of [configHome, daemonDir, freshDir, otherTrusted, otherUntrusted, ownDir]) {
  mkdirSync(d, { recursive: true })
}

process.chdir(freshDir)
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.HOME = configHome
process.env.USERPROFILE = configHome
process.env.MERCURY_CLIPBOARD_FILE = join(configHome, 'clipboard.txt')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_FULLSCREEN = '1'
process.env.COLORTERM = 'truecolor'
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
process.env.BROWSER = '/usr/bin/true'
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) {
    delete process.env[name]
  }
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { mock } = await import('bun:test')
const React = await import('react')
const h = React.createElement

type AdmitReq = { op?: string; workspaceDir?: string; resumeSessionId?: string }
let admitCalls: AdmitReq[] = []

const realEnsure = await import('../../src/daemon/switchboard/ensureDaemon.ts')
mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({
  ...realEnsure,
  ensureOwnedDaemon: async () => true,
}))

const realControl = await import('../../src/daemon/control/controlSocket.ts')
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...realControl,
  daemonControlRpc: async (req: Record<string, unknown>) => {
    if (req.op === 'sessionAdmit') {
      const workspaceDir = String(req.workspaceDir ?? '')
      const resumeSessionId = String(req.resumeSessionId ?? '')
      admitCalls.push({ op: 'sessionAdmit', workspaceDir, resumeSessionId })
      const runnerId = 'concourse-w1'
      const record = {
        schema: 1,
        runnerId,
        sessionId: resumeSessionId,
        workspaceId: workspaceDir,
        isolation: 'shared',
        modelKey: 'claude-sonnet-5-5',
        spawnedAt: Date.now(),
        lastLiveAt: Date.now(),
        pid: process.pid,
      }
      writeFileSync(
        join(daemonDir, 'concourse-workers.json'),
        JSON.stringify({ version: 1, workers: { [runnerId]: record } }, null, 1) + '\n',
      )
      return { ok: true, runnerId, sessionId: resumeSessionId, workspaceId: workspaceDir }
    }
    return { ok: true }
  },
}))

const realWorkers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
mock.module('../../src/daemon/concourse-workers/concourseWorkers.ts', () => ({
  ...realWorkers,
  countLiveConcourseWorkers: () => 0,
  sessionOwnedByLiveWorker: () => null,
}))

const realActivity = await import('../../src/screen/concourse-model/projectActivity.ts')
mock.module('../../src/screen/concourse-model/projectActivity.ts', () => ({
  ...realActivity,
  runningByProjectKey: async () => new Map<string, number>(),
}))

const { enableConfigs, setPathTrusted } = await import('../../src/platform/settings/config.ts')
enableConfigs()
setPathTrusted(freshDir)
setPathTrusted(otherTrusted)
setPathTrusted(ownDir)

const bootstrapState = await import('../../src/boot/process-state/processState.ts')
const { getCwd } = await import('../../src/platform/files/cwd.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const surfaceRoute = await import('../../src/screen/routes/surfaceRoute.ts')
const focusedSlot = await import('../../src/engine/connector/focusedConnector.ts')
const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { BootSplashScreen } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')

const SID_OWN = '00000000-0000-4000-8000-000000000101'
const SID_OTHER = '00000000-0000-4000-8000-000000000202'
const SID_UNTRUSTED = '00000000-0000-4000-8000-000000000303'

function seedSession(projectDir: string, sessionId: string, prompt: string, mtimeMs: number): string {
  const store = getProjectDir(projectDir)
  mkdirSync(store, { recursive: true })
  const file = join(store, `${sessionId}.jsonl`)
  const ts = new Date(mtimeMs).toISOString()
  const rows = [
    {
      type: 'user',
      isSidechain: false,
      entrypoint: 'cli',
      cwd: projectDir,
      sessionId,
      version: '1.0.12',
      gitBranch: 'main',
      parentUuid: null,
      uuid: '00000000-0000-4000-8000-100000000001',
      timestamp: ts,
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      isSidechain: false,
      entrypoint: 'cli',
      cwd: projectDir,
      sessionId,
      version: '1.0.12',
      gitBranch: 'main',
      parentUuid: '00000000-0000-4000-8000-100000000001',
      uuid: '00000000-0000-4000-8000-100000000002',
      timestamp: ts,
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const at = new Date(mtimeMs)
  utimesSync(file, at, at)
  return file
}

function setGround(dir: string): void {
  process.chdir(dir)
  bootstrapState.setOriginalCwd(dir)
  bootstrapState.setProjectRoot(dir)
  bootstrapState.setCwdState(dir)
}

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
  down: '\x1b[B',
  enter: '\x1b[13u',
} as const

const stdout = new FakeStdout(120, 34)
const stdin = new FakeStdin()
const ink = new Ink({
  stdout: stdout as never,
  stdin: stdin as never,
  stderr: new FakeStdout(120, 34) as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
instances.set(stdout as never, ink)
ink.setAltScreenActive(true, false)

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function settleRaw(): Promise<string> {
  reconciler.flushSyncWork()
  await tick()
  reconciler.flushSyncWork()
  await tick()
  ink.onRender()
  return ink.lastFrameText()
}

async function sendKey(seq: string): Promise<{ raw: string; plain: string }> {
  stdin.push(seq)
  const raw = await settleRaw()
  return { raw, plain: stripAnsi(raw) }
}

let mountSeq = 0
async function mountFace(cwd: string, cols = 120, rows = 34): Promise<{ raw: string; plain: string }> {
  setGround(cwd)
  admitCalls = []
  focusedSlot.releaseFocusedSessionConnector()
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: {} }) + '\n')
  surfaceRoute._resetSurfaceRouteForTesting()
  surfaceRoute.registerChatPresence({ present: () => true, subscribe: () => () => {} })
  surfaceRoute.registerRouteSurface('boot-settings', { render: () => null })
  surfaceRoute.registerRouteSurface('concourse', { render: () => null })
  surfaceRoute.initializeSurfaceRoute({ kind: 'boot-settings' })
  stdout.columns = cols
  stdout.rows = rows
  mountSeq++
  ink.render(
    h(
      ThemeProvider as never,
      {},
      h(
        AppStateProvider as never,
        {},
        h(
          TerminalSizeContext.Provider,
          { value: { columns: cols, rows } },
          h(
            KeybindingSetup as never,
            {},
            h(
              Box,
              { width: cols, height: rows, flexDirection: 'column' },
              h(BootSplashScreen, { key: `boot-elsewhere-${mountSeq}` }),
            ),
          ),
        ),
      ),
    ),
  )
  const raw = await settleRaw()
  return { raw, plain: stripAnsi(raw) }
}

async function waitForAdmit(timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (admitCalls.length > 0 && surfaceRoute.currentSurfaceRoute().kind === 'repl') return
    await delay(20)
  }
}

let failures = 0
function check(label: string, cond: boolean, fixWhere: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${fixWhere}` : ''}`)
}

const FIX_ROW = 'change continueTarget in src/screen/boot-face/BootSplashScreen.tsx so cross-project Continue Last Session is not dim'
const FIX_ACTION = 'change case \'continue\' in runRowOf (src/screen/boot-face/splash/rowActions.ts) so it resumes facts.recentLast in its own folder and grounds trusted projects'

const NOW = Date.now()
seedSession(ownDir, SID_OWN, 'own project prompt', NOW - 180_000)
seedSession(otherTrusted, SID_OTHER, 'other trusted prompt', NOW - 60_000)

try {
  console.log('§1 — from a folder with no sessions, Continue Last Session shows in <project>, is not faint, and ↓ stops on it')
  {
    const initial = await mountFace(freshDir, 120, 34)
    const plainLines = initial.plain.split('\n')
    const rawLines = initial.raw.split('\n')
    const continuePlain = plainLines.find(l => l.includes('Continue Last Session')) ?? ''
    const continueRaw = rawLines.find(l => stripAnsi(l).includes('Continue Last Session')) ?? ''
    check(
      'full face paints Continue Last Session with "in other-trusted" and the → affordance',
      continuePlain.includes('in other-trusted') && continuePlain.includes('→'),
      FIX_ROW,
      continuePlain.trim(),
    )
    const loginsRaw = rawLines.find(l => stripAnsi(l).includes('Logins/Keys')) ?? ''
    const midcreamInk = '\x1b[38;2;168;152;128m'
    check(
      'full face draws Continue Last Session label in normal ink (same as Logins/Keys), not faint',
      continueRaw.includes(`${midcreamInk}Continue Last Session`) && loginsRaw.includes(`${midcreamInk}Logins/Keys`),
      FIX_ROW,
      `continue=${JSON.stringify(continueRaw.slice(0, 140))}`,
    )
    const afterDown = await sendKey(KEYS.down)
    const focused = afterDown.plain.split('\n').filter(l => l.includes('❯'))
    check(
      '↓ from New Session lands ❯ on Continue Last Session (does not skip to Logins/Keys)',
      focused.length === 1 && focused[0]!.includes('Continue Last Session'),
      FIX_ROW,
      focused.join(' | '),
    )

    await sendKey(KEYS.enter)
    await waitForAdmit()
    await settleRaw()
    const focusedWs = focusedSlot.hasFocusedSession() ? focusedSlot.getFocusedSessionConnector().workspace().cwd : null
    check(
      '§2 Enter on trusted cross-project Continue Last Session enters repl and admits the session in its own folder',
      surfaceRoute.currentSurfaceRoute().kind === 'repl' &&
        admitCalls.length === 1 &&
        admitCalls[0]!.resumeSessionId === SID_OTHER &&
        admitCalls[0]!.workspaceDir === otherTrusted &&
        focusedWs === otherTrusted,
      FIX_ACTION,
      JSON.stringify({ route: surfaceRoute.currentSurfaceRoute().kind, admitCalls, focusedWs, expected: otherTrusted }),
    )
    check(
      '§2 Enter on trusted cross-project Continue Last Session moves harness ground to the session project',
      getCwd() === otherTrusted,
      FIX_ACTION,
      `cwd=${getCwd()} expected=${otherTrusted}`,
    )

    const compactInit = await mountFace(freshDir, 84, 24)
    const compactAfterDown = await sendKey(KEYS.down)
    const compactFocused = compactAfterDown.plain.split('\n').filter(l => l.includes('❯'))
    check(
      'compact face keeps "in other-trusted" and ↓ lands ❯ on Continue Last Session',
      compactInit.plain.includes('in other-trusted') &&
        compactFocused.length === 1 &&
        compactFocused[0]!.includes('Continue Last Session'),
      FIX_ROW,
      compactFocused.join(' | '),
    )
  }

  console.log('§3 — from a folder with no sessions, Enter on an UNTRUSTED cross-project Continue Last Session resumes in its own folder without silently grounding it')
  {
    seedSession(otherUntrusted, SID_UNTRUSTED, 'untrusted project prompt', NOW - 10_000)
    const initial = await mountFace(freshDir, 120, 34)
    check(
      'boot face names the untrusted newest project ("in other-untrusted")',
      initial.plain.includes('in other-untrusted'),
      FIX_ROW,
      initial.plain.split('\n').find(l => l.includes('Continue Last Session'))?.trim() ?? '',
    )
    const afterDown = await sendKey(KEYS.down)
    const focused = afterDown.plain.split('\n').filter(l => l.includes('❯'))
    check(
      '↓ lands ❯ on Continue Last Session for the untrusted project too',
      focused.length === 1 && focused[0]!.includes('Continue Last Session'),
      FIX_ROW,
      focused.join(' | '),
    )
    await sendKey(KEYS.enter)
    await waitForAdmit()
    await settleRaw()
    const focusedWs = focusedSlot.hasFocusedSession() ? focusedSlot.getFocusedSessionConnector().workspace().cwd : null
    check(
      'Enter admits the untrusted project session in its own folder without changing harness ground',
      surfaceRoute.currentSurfaceRoute().kind === 'repl' &&
        admitCalls.length === 1 &&
        admitCalls[0]!.resumeSessionId === SID_UNTRUSTED &&
        admitCalls[0]!.workspaceDir === otherUntrusted &&
        focusedWs === otherUntrusted &&
        getCwd() === freshDir,
      FIX_ACTION,
      JSON.stringify({ route: surfaceRoute.currentSurfaceRoute().kind, admitCalls, focusedWs, cwd: getCwd() }),
    )
  }

  console.log('§4 — control: a folder with sessions of its own still continues its own last session')
  {
    const initial = await mountFace(ownDir, 120, 34)
    const contLine = initial.plain.split('\n').find(l => l.includes('Continue Last Session')) ?? ''
    check(
      'own-project face shows Continue Last Session without cross-project "in <other>" words',
      contLine.includes('Continue Last Session') && !contLine.includes('in other-'),
      FIX_ROW,
      contLine.trim(),
    )
    const afterDown = await sendKey(KEYS.down)
    const focused = afterDown.plain.split('\n').filter(l => l.includes('❯'))
    check(
      '↓ lands ❯ on Continue Last Session in own-project',
      focused.length === 1 && focused[0]!.includes('Continue Last Session'),
      FIX_ROW,
      focused.join(' | '),
    )
    await sendKey(KEYS.enter)
    await waitForAdmit()
    await settleRaw()
    const focusedWs = focusedSlot.hasFocusedSession() ? focusedSlot.getFocusedSessionConnector().workspace().cwd : null
    check(
      'Enter resumes own-project session in own-project',
      surfaceRoute.currentSurfaceRoute().kind === 'repl' &&
        admitCalls.length === 1 &&
        admitCalls[0]!.resumeSessionId === SID_OWN &&
        admitCalls[0]!.workspaceDir === ownDir &&
        focusedWs === ownDir,
      FIX_ACTION,
      JSON.stringify({ route: surfaceRoute.currentSurfaceRoute().kind, admitCalls, focusedWs }),
    )
  }
} finally {
  focusedSlot.releaseFocusedSessionConnector()
  surfaceRoute._resetSurfaceRouteForTesting()
  ink.unmount()
  instances.delete(stdout as never)
  disposeKeybindingWatcher()
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-continue-row-elsewhere: ALL PASS' : `\nprove-continue-row-elsewhere: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

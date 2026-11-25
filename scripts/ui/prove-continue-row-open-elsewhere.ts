#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const previousCwd = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-continue-open-elsewhere-')))
const configHome = join(scratch, 'config')
const daemonDir = join(configHome, 'daemon')
const freshDir = join(scratch, 'fresh-folder')
const otherDir = join(scratch, 'other-trusted')
const ownDir = join(scratch, 'own-project')
for (const d of [configHome, daemonDir, freshDir, otherDir, ownDir]) {
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
delete process.env.MERCURY_COMPUTER_USE
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

type Rpc = Record<string, unknown>
let rpcCalls: Rpc[] = []

const realEnsure = await import('../../src/daemon/switchboard/ensureDaemon.ts')
mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({
  ...realEnsure,
  ensureOwnedDaemon: async () => true,
}))

const realControl = await import('../../src/daemon/control/controlSocket.ts')
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...realControl,
  daemonControlRpc: async (req: Rpc) => {
    rpcCalls.push(req)
    return { ok: true, outcome: 'applied' }
  },
}))

const realActivity = await import('../../src/screen/concourse-model/projectActivity.ts')
mock.module('../../src/screen/concourse-model/projectActivity.ts', () => ({
  ...realActivity,
  runningByProjectKey: async () => new Map<string, number>(),
}))

const { enableConfigs, setPathTrusted } = await import('../../src/platform/settings/config.ts')
enableConfigs()
for (const d of [freshDir, otherDir, ownDir]) setPathTrusted(d)

const bootstrapState = await import('../../src/boot/process-state/processState.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const surfaceRoute = await import('../../src/screen/routes/surfaceRoute.ts')
const focusedSlot = await import('../../src/engine/connector/focusedConnector.ts')
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
const { disposeKeybindingWatcher } = await import('../../src/screen/keys/loadUserBindings.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { BootSplashScreen } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')

const SID_OTHER = '00000000-0000-4000-8000-000000000401'
const SID_OWN = '00000000-0000-4000-8000-000000000404'
const RUNNER = 'concourse-w7'
const WORDS = 'open in another window'
const ELSEWHERE = `operator:${process.ppid}`
const HERE = `operator:${process.pid}`

function transcriptOf(projectDir: string, sessionId: string): string {
  return join(getProjectDir(projectDir), `${sessionId}.jsonl`)
}

function seedSession(projectDir: string, sessionId: string, prompt: string): void {
  const file = transcriptOf(projectDir, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const ts = new Date().toISOString()
  const envelope = { isSidechain: false, entrypoint: 'cli', cwd: projectDir, sessionId, version: '1.0.12', gitBranch: 'main', timestamp: ts }
  writeFileSync(
    file,
    encodeSeedTranscript(
      [
        { ...envelope, type: 'user', parentUuid: null, uuid: '00000000-0000-4000-8000-100000000001', message: { role: 'user', content: prompt } },
        {
          ...envelope,
          type: 'assistant',
          parentUuid: '00000000-0000-4000-8000-100000000001',
          uuid: '00000000-0000-4000-8000-100000000002',
          message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ] as never,
      sessionId,
    ),
  )
  makeNewest(projectDir, sessionId)
}

let clock = Date.now() - 3_600_000
function makeNewest(projectDir: string, sessionId: string): void {
  clock += 10_000
  const at = new Date(clock)
  utimesSync(transcriptOf(projectDir, sessionId), at, at)
}

type Held = { sessionId: string; workspaceId: string; focusedBy?: string; attachedBy?: string; focusedAlso?: ReadonlyArray<{ by: string; at: number }>; endedAt?: number }
function seedRecords(held: Held[]): void {
  const workers = Object.fromEntries(
    held.map((row, i) => [
      i === 0 ? RUNNER : `concourse-w${8 + i}`,
      {
        schema: 1,
        runnerId: i === 0 ? RUNNER : `concourse-w${8 + i}`,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        isolation: 'shared',
        modelKey: 'claude-sonnet-5-5',
        spawnedAt: Date.now() - 120_000,
        lastLiveAt: Date.now(),
        pid: process.pid,
        ...(row.focusedBy !== undefined ? { focusedAt: Date.now() - 60_000, focusedBy: row.focusedBy } : {}),
        ...(row.attachedBy !== undefined ? { attachedAt: Date.now() - 60_000, attachedBy: row.attachedBy } : {}),
        ...(row.focusedAlso !== undefined ? { focusedAlso: row.focusedAlso } : {}),
        ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
      },
    ]),
  )
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers }, null, 1) + '\n')
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

const KEYS = { down: '\x1b[B', enter: '\x1b[13u' } as const

const stdout = new FakeStdout(120, 34)
const stdin = new FakeStdin()
const ink = new ScreenInstance({
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

type Frame = { raw: string; plain: string }
type Mounted = Frame & { later: string }
async function sendKey(seq: string): Promise<Frame> {
  stdin.push(seq)
  const raw = await settleRaw()
  return { raw, plain: stripAnsi(raw) }
}

let mountSeq = 0
async function mountFace(cwd: string, cols: number, rows: number, held: Held[]): Promise<Mounted> {
  setGround(cwd)
  rpcCalls = []
  focusedSlot.releaseFocusedSessionConnector()
  seedRecords(held)
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
          h(KeybindingSetup as never, {}, h(Box, { width: cols, height: rows, flexDirection: 'column' }, h(BootSplashScreen, { key: `boot-open-elsewhere-${mountSeq}` }))),
        ),
      ),
    ),
  )
  const raw = await settleRaw()
  await delay(150)
  return { raw, plain: stripAnsi(raw), later: stripAnsi(await settleRaw()) }
}

const continueLine = (text: string): string => text.split('\n').find(line => stripAnsi(line).includes('Continue Last Session')) ?? ''
const framesAt = process.argv.indexOf('--frames')
const FRAMES = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const keep = (name: string, frame: Mounted): Mounted => {
  if (FRAMES !== undefined) writeFileSync(join(FRAMES, `${name}.txt`), `${frame.plain.split('\n').map(line => line.trimEnd()).join('\n')}\n`)
  return frame
}

let failures = 0
function check(label: string, cond: boolean, fixWhere: string, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${fixWhere}` : ''}`)
}

const FIX_ROW = `the Continue Last Session row never carries "${WORDS}" or anything else for a session another window holds: its detail is the folder of a session from another project and nothing more (continueDetail and bootSplashCompositionOf in src/screen/boot-face/splash/face.tsx, the rows BootSplashScreen mounts with in src/screen/boot-face/BootSplashScreen.tsx)`
const FIX_ENTER = 'Enter on the row must go on joining the live runner through focusResumedSession in src/daemon/switchboard/hopIntoSession.ts (hopIntoBoardSession): no sessionAdmit, one focus by this terminal'

seedSession(otherDir, SID_OTHER, 'other trusted prompt')
seedSession(ownDir, SID_OWN, 'own project prompt')

const SIZES: Array<[number, number, string]> = [
  [120, 34, 'full'],
  [100, 34, 'full'],
  [80, 24, 'compact'],
]
const heldElsewhere: Array<[string, Held]> = [
  ['focused by another live terminal', { sessionId: SID_OTHER, workspaceId: otherDir, focusedBy: ELSEWHERE }],
  ['attached by another live terminal', { sessionId: SID_OTHER, workspaceId: otherDir, attachedBy: ELSEWHERE }],
  ['focused here and also by another live terminal', { sessionId: SID_OTHER, workspaceId: otherDir, focusedBy: HERE, focusedAlso: [{ by: ELSEWHERE, at: Date.now() - 60_000 }] }],
]

try {
  console.log(`§1 — this folder's own last session open in another window: the row reads Continue Last Session and nothing more, and the card is as wide as when it is open nowhere else`)
  for (const [cols, rows, layout] of SIZES) {
    const quiet = keep(`own-project-${cols}x${rows}`, await mountFace(ownDir, cols, rows, []))
    const held = keep(`own-project-open-elsewhere-${cols}x${rows}`, await mountFace(ownDir, cols, rows, [{ sessionId: SID_OWN, workspaceId: ownDir, focusedBy: ELSEWHERE }]))
    const row = stripAnsi(continueLine(held.plain))
    check(`${cols}x${rows} (${layout}): the row reads Continue Last Session and nothing more`, /Continue Last Session\s*[│]?\s*$/.test(row) && !held.plain.includes(WORDS), FIX_ROW, row.trim())
    check(`${cols}x${rows} (${layout}): the face is cell for cell the face of that session open nowhere else, so the card keeps its width`, held.plain === quiet.plain && held.plain === held.later, FIX_ROW, `rows that differ: ${JSON.stringify(held.plain.split('\n').filter((line, i) => line !== quiet.plain.split('\n')[i]).map(line => line.trim()))}`)
  }

  console.log('§2 — a session of another project open in another window: the row names its folder as it always did, and nothing more')
  makeNewest(otherDir, SID_OTHER)
  for (const [cols, rows, layout] of SIZES) {
    const quiet = keep(`other-project-${cols}x${rows}`, await mountFace(freshDir, cols, rows, []))
    for (const [name, record] of heldElsewhere) {
      const held = await mountFace(freshDir, cols, rows, [record])
      check(`${cols}x${rows} (${layout}), ${name}: the face is cell for cell the face of that session open nowhere else`, held.plain === quiet.plain && stripAnsi(continueLine(held.plain)).includes('in other-trusted') && !held.plain.includes(WORDS), FIX_ROW, stripAnsi(continueLine(held.plain)).trim())
    }
  }

  console.log('§3 — Enter on a row whose session is open in another window joins the runner that window is on: no admission, so no second runner')
  {
    await mountFace(freshDir, 120, 34, [{ sessionId: SID_OTHER, workspaceId: otherDir, focusedBy: ELSEWHERE }])
    const afterDown = await sendKey(KEYS.down)
    const focused = afterDown.plain.split('\n').filter(l => l.includes('❯'))
    check('↓ lands ❯ on the row: it can be chosen', focused.length === 1 && focused[0]!.includes('Continue Last Session'), FIX_ROW, focused.join(' | '))
    rpcCalls = []
    await sendKey(KEYS.enter)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && !(surfaceRoute.currentSurfaceRoute().kind === 'repl' && rpcCalls.some(c => c.action === 'focus'))) await delay(20)
    await settleRaw()
    const admits = rpcCalls.filter(c => c.op === 'sessionAdmit')
    const focuses = rpcCalls.filter(c => c.op === 'sessionControl' && c.action === 'focus')
    const connector = focusedSlot.hasFocusedSession() ? focusedSlot.getFocusedSessionConnector() : null
    check(
      'the chat opens on that session, in its own folder',
      surfaceRoute.currentSurfaceRoute().kind === 'repl' && connector?.sessionId() === SID_OTHER && connector.workspace().cwd === otherDir,
      FIX_ENTER,
      JSON.stringify({ route: surfaceRoute.currentSurfaceRoute().kind, session: connector?.sessionId() ?? null }),
    )
    check('no sessionAdmit went to the daemon: the runner the other window is on is the one joined', admits.length === 0, FIX_ENTER, JSON.stringify(admits))
    check(
      'this terminal asks the daemon for the focus stamp, once, for that session',
      focuses.length === 1 && focuses[0]!.sessionId === SID_OTHER && focuses[0]!.by === HERE,
      FIX_ENTER,
      JSON.stringify(focuses),
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

console.log(failures === 0 ? '\nprove-continue-row-open-elsewhere: ALL PASS' : `\nprove-continue-row-open-elsewhere: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

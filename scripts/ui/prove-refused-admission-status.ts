import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

pinSourceRef()
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ensurePath = join(root, 'src/services/switchboard/ensureDaemon.ts')
const controlPath = join(root, 'src/daemon/controlSocket.ts')
const escapePath = (p: string): string => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type ProofHooks = {
  ensureDaemon: () => Promise<boolean>
  controlRpc: (request: { op: string }) => Promise<Record<string, unknown>>
}
const hooks: ProofHooks = {
  ensureDaemon: async () => true,
  controlRpc: async () => ({ ok: true, outcome: 'applied' }),
}
;(globalThis as Record<string, unknown>).__refusedAdmissionHooks = hooks

;(Bun as unknown as { plugin: (p: { name: string; setup: (build: { onLoad: (opts: { filter: RegExp }, cb: () => { loader: string; contents: string }) => void }) => void }) => void }).plugin({
  name: 'refused-admission-transport',
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escapePath(ensurePath)}$`) }, () => {
      const real = readFileSync(ensurePath, 'utf8').replace(
        'export async function ensureOwnedDaemon(): Promise<boolean> {',
        'async function _realEnsureOwnedDaemon(): Promise<boolean> {',
      )
      return {
        loader: 'ts',
        contents: `${real}\nexport async function ensureOwnedDaemon(): Promise<boolean> { return ((globalThis as Record<string, unknown>).__refusedAdmissionHooks as { ensureDaemon: () => Promise<boolean> }).ensureDaemon() }\n`,
      }
    })
    build.onLoad({ filter: new RegExp(`^${escapePath(controlPath)}$`) }, () => {
      const real = readFileSync(controlPath, 'utf8').replace(
        'export async function daemonControlRpc(',
        'async function _realDaemonControlRpc(',
      )
      return {
        loader: 'ts',
        contents: `${real}\nexport async function daemonControlRpc(request: { op: string }): Promise<Record<string, unknown>> { return ((globalThis as Record<string, unknown>).__refusedAdmissionHooks as { controlRpc: (r: { op: string }) => Promise<Record<string, unknown>> }).controlRpc(request) }\n`,
      }
    })
  },
})

const HOME = pinScratchHome('refused-admission-status')
delete process.env.TYPESAFE_API_KEY
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_EFFORT_LEVEL
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
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
const WORK = join(HOME, 'work')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
mkdirSync(WORK, { recursive: true })
process.chdir(WORK)

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
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
const { getCommands } = await import('../../src/commands.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { getFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { focusResumedSession } = await import('../../src/services/switchboard/hopIntoSession.ts')
const { statusLine, statusRowWarns } = await import('../../src/components/SwitchboardTagBar.tsx')
type SeatStatusV1 = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1
type SessionLiveV1 = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1
type SendReceiptV1 = import('../../src/services/engine-connector/types.ts').SendReceiptV1

const commands = await getCommands(WORK)
const project = getProjectDir(WORK)
mkdirSync(project, { recursive: true })

type FocusedDaemonConnector = ReturnType<typeof getFocusedSessionConnector> & {
  live: () => SessionLiveV1
  status: () => SeatStatusV1
  readFacts: () => void
  admissionRefusal: () => string | null
  sendWords: (words: string, images: never[]) => Promise<SendReceiptV1>
}
const focused = (): FocusedDaemonConnector => getFocusedSessionConnector() as FocusedDaemonConnector
const words = (): string => statusLine(focused().live(), focused().status())
const statusRowOf = (m: Mounted): string => m.lines().find(line => line.includes('← back')) ?? ''

for (const [index, [cols, rows]] of ([[120, 40], [178, 51]] as const).entries()) {
  const tag = `${cols}x${rows}`
  const sid = `00000000-0000-4000-8000-00000000020${index + 1}`
  const transcript = join(project, `${sid}.jsonl`)
  writeFileSync(
    transcript,
    encodeSeedTranscript(
      [
        { type: 'user', uuid: `00000000-0000-4000-8000-00000000021${index + 1}`, parentUuid: null, sessionId: sid, cwd: WORK, timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'saved conversation' } },
        { type: 'assistant', uuid: `00000000-0000-4000-8000-00000000022${index + 1}`, parentUuid: `00000000-0000-4000-8000-00000000021${index + 1}`, sessionId: sid, cwd: WORK, timestamp: '2026-06-19T12:00:01.000Z', message: { id: 'saved-reply', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'saved answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
      sid,
    ),
  )
  const factsFile = sessionFactsPath(sid)
  mkdirSync(dirname(factsFile), { recursive: true })
  const baseSeed = {
    schema: 1,
    sessionId: sid,
    atMs: 1000,
    model: { effective: 'claude-sonnet-5', setting: 'claude-sonnet-5' },
    pendingModel: null,
    busy: false,
    usage: noSessionConnector().usage(),
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    workspace: { cwd: WORK, originalCwd: WORK, projectRoot: WORK },
    queue: [],
  }
  const publish = (atMs: number, model: string, runner?: Record<string, unknown>): void =>
    writeFileSync(factsFile, JSON.stringify({ ...baseSeed, atMs, model: { effective: model, setting: model }, ...(runner !== undefined ? { runner } : {}) }))
  const worker = {
    schema: 1,
    runnerId: `concourse-w${index + 1}`,
    sessionId: sid,
    workspaceId: WORK,
    isolation: 'shared',
    modelKey: 'claude-opus-4-8',
    spawnedAt: 900,
    lastLiveAt: 1000,
    parkedAt: 1050,
    parkedBy: 'operator:fixture',
  }
  const writeWorker = (changes: Record<string, unknown> = {}): void =>
    writeFileSync(join(process.env.MERCURY_DAEMON_DIR!, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { [worker.runnerId]: { ...worker, ...changes } } }))

  writeWorker()
  publish(1000, 'claude-sonnet-5')

  let resolveAdmit!: (reply: Record<string, unknown>) => void
  let pendingAdmit = new Promise<Record<string, unknown>>(resolve => { resolveAdmit = resolve })
  const holdNextAdmit = (): void => {
    pendingAdmit = new Promise<Record<string, unknown>>(resolve => { resolveAdmit = resolve })
  }
  hooks.ensureDaemon = async () => true
  hooks.controlRpc = async request => (request.op === 'sessionAdmit' ? pendingAdmit : { ok: true, outcome: 'applied' })

  releaseFocusedSessionConnector()
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  layoutChromeLive(cols, rows)
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})

  const m = await mountOffscreen(
    h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))),
    cols,
    rows,
  )
  try {
    const first = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    const paintedStarting = await waitFor(() => statusRowOf(m).includes('the runner is starting') && statusRowOf(m).includes('Opus 4.8'), 5000)
    await settle(80)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-admitting.txt`), m.lines().join('\n') + '\n')
    check(`${tag}: while admission is in flight the status row reads starting on the saved model`, paintedStarting, statusRowOf(m))

    resolveAdmit({ ok: false, error: 'workspace folder missing' })
    check(`${tag}: the refused admission resolves false`, (await first.admitted) === false)
    const paintedNotice = await waitFor(() => m.screen().includes('workspace folder missing') && m.screen().includes('revives it'), 5000)
    await settle(150)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-refused.txt`), m.lines().join('\n') + '\n')
    const connector = focused()
    const rowAfterRefusal = statusRowOf(m)
    check(`${tag}: Chat paints the no-live-runner refusal notice`, paintedNotice, m.screen().slice(-400))
    check(
      `${tag}: after admission is refused the status row stops reading starting and reads ready`,
      words() === 'ready' && connector.status().runner === null && !statusRowWarns(connector.live(), connector.status()) && rowAfterRefusal.includes('ready') && !rowAfterRefusal.includes('runner is starting'),
      `words=${JSON.stringify(words())} row=${JSON.stringify(rowAfterRefusal)}`,
    )
    check(
      `${tag}: refused admission keeps the saved worker model instead of stale pre-park facts`,
      connector.modelFacts().effective === 'claude-opus-4-8' && connector.modelFacts().effectiveSource === 'record' && rowAfterRefusal.includes('Opus 4.8') && !rowAfterRefusal.includes('Sonnet'),
      `modelFacts=${JSON.stringify(connector.modelFacts())} row=${JSON.stringify(rowAfterRefusal)}`,
    )
    connector.readFacts()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 5_000
      check(`${tag}: five seconds after refusal the status line still reads ready`, words() === 'ready', words())
    } finally {
      Date.now = realNow
    }

    releaseFocusedSessionConnector()
    hooks.ensureDaemon = async () => false
    const daemonDown = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    check(`${tag}: daemon-down refusal resolves false and reads ready`, (await daemonDown.admitted) === false && connector.admissionRefusal() === 'the daemon did not start' && words() === 'ready', `refusal=${connector.admissionRefusal()} words=${words()}`)

    releaseFocusedSessionConnector()
    hooks.ensureDaemon = async () => true
    holdNextAdmit()
    const reopened = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    check(
      `${tag}: reopening after a refusal clears the old refusal and re-arms starting`,
      connector.admissionRefusal() === null && words().startsWith('the runner is starting'),
      `refusal=${connector.admissionRefusal()} words=${words()}`,
    )
    writeWorker({ parkedAt: undefined, parkedBy: undefined })
    resolveAdmit({ ok: true })
    check(`${tag}: the reopened admission settles true`, await reopened.admitted)
    publish(1001, 'claude-opus-4-8')
    connector.readFacts()
    check(`${tag}: fresh runner facts settle the reopened session to ready and live`, words() === 'ready' && connector.modelFacts().effectiveSource === 'live', words())

    releaseFocusedSessionConnector()
    writeWorker({ parkedAt: 1200 })
    holdNextAdmit()
    const beforeRevive = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    const initialOpened = connector.status().runner?.sinceMs ?? Date.now()
    resolveAdmit({ ok: false, error: 'daemon busy' })
    await beforeRevive.admitted
    check(`${tag}: third resume refusal reads ready`, words() === 'ready', words())
    const reviveNow = Date.now
    try {
      Date.now = () => initialOpened + 120_000
      check(`${tag}: two minutes after refusal the status line still reads ready`, words() === 'ready', words())
      const receipt = await connector.sendWords('revive the runner', [])
      check(`${tag}: Enter dispatch revives and clears the refusal`, receipt.state === 'accepted' && connector.admissionRefusal() === null, JSON.stringify(receipt))
      check(`${tag}: revive starts a fresh starting clock at 0s rather than 2m`, words() === 'the runner is starting · 0s', words())
      Date.now = () => initialOpened + 121_000
      publish(1002, 'claude-opus-4-8', { state: 'starting', sinceMs: initialOpened + 120_500, respawns: 0, maxRespawns: 3 })
      connector.readFacts()
      check(`${tag}: one second into the revive the starting fact counts 1s from Enter rather than 2m from the refused open`, words() === 'the runner is starting · 1s', words())
      publish(1003, 'claude-opus-4-8')
      connector.readFacts()
      check(`${tag}: the revived runner clears its starting state when ready facts arrive`, connector.status().runner === null && !words().includes('runner is starting'), words())
    } finally {
      Date.now = reviveNow
    }
  } finally {
    m.unmount()
    releaseFocusedSessionConnector()
  }
}

console.log(`refused-admission-status: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)

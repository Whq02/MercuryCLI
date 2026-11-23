import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

pinSourceRef()

type ProofHooks = {
  ensureDaemon: () => Promise<boolean>
  controlRpc: (request: { op: string }) => Promise<Record<string, unknown>>
}
const hooks: ProofHooks = {
  ensureDaemon: async () => true,
  controlRpc: async () => ({ ok: true, outcome: 'applied' }),
}
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

const realEnsure = { ...(await import('../../src/daemon/switchboard/ensureDaemon.ts')) }
mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({
  ...realEnsure,
  ensureOwnedDaemon: () => hooks.ensureDaemon(),
}))
const realControl = { ...(await import('../../src/daemon/control/controlSocket.ts')) }
mock.module('../../src/daemon/control/controlSocket.ts', () => ({
  ...realControl,
  daemonControlRpc: (request: { op: string }) => hooks.controlRpc(request),
}))
const React = await import('react')
const h = React.createElement
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.tsx')
const { Chat } = await import('../../src/screen/chat/Chat.tsx')
const route = await import('../../src/screen/routes/surfaceRoute.ts')
const { resetChromeModeLatchForTests, layoutChromeLive } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
const { getCommands } = await import('../../src/commands/catalogue/commands.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { sessionFactsPath } = await import('../../src/engine/connector/seatProjections.ts')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { getFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.ts')
const { statusLine, statusRowWarns } = await import('../../src/screen/chat/SwitchboardTagBar.tsx')
type SeatStatusV1 = import('../../src/engine/connector/seatLive.ts').SeatStatusV1
type SessionLiveV1 = import('../../src/engine/connector/seatLive.ts').SessionLiveV1
type SendReceiptV1 = import('../../src/engine/connector/types.ts').SendReceiptV1

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
    check(`${tag}: while admission is in flight the status row reads starting on the saved model`, paintedStarting, `${statusRowOf(m)} — Fix statusLine in src/screen/chat/SwitchboardTagBar.tsx or the admission refusal path in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts).`)

    resolveAdmit({ ok: false, error: 'workspace folder missing' })
    check(`${tag}: the refused admission resolves false`, (await first.admitted) === false, 'focusResumedSession in src/daemon/switchboard/hopIntoSession.ts must resolve admitted to false when sessionAdmit replies ok:false')
    const paintedNotice = await waitFor(() => m.screen().includes('workspace folder missing') && m.screen().includes('revives it'), 5000)
    await settle(150)
    if (frameDir) writeFileSync(join(frameDir, `${tag}-refused.txt`), m.lines().join('\n') + '\n')
    const connector = focused()
    const rowAfterRefusal = statusRowOf(m)
    check(`${tag}: Chat paints the no-live-runner refusal notice`, paintedNotice, `${m.screen().slice(-400)} — the refusal notice built in src/daemon/switchboard/hopIntoSession.ts must reach the Chat screen`)
    check(
      `${tag}: after admission is refused the status row stops reading starting and reads ready`,
      words() === 'ready' && connector.status().runner === null && !statusRowWarns(connector.live(), connector.status()) && rowAfterRefusal.includes('ready') && !rowAfterRefusal.includes('runner is starting'),
      `words=${JSON.stringify(words())} row=${JSON.stringify(rowAfterRefusal)} — Fix statusLine in src/screen/chat/SwitchboardTagBar.tsx or the admission refusal path in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts).`,
    )
    check(
      `${tag}: refused admission keeps the saved worker model instead of stale pre-park facts`,
      connector.modelFacts().effective === 'claude-opus-4-8' && connector.modelFacts().effectiveSource === 'record' && rowAfterRefusal.includes('Opus 4.8') && !rowAfterRefusal.includes('Sonnet'),
      `modelFacts=${JSON.stringify(connector.modelFacts())} row=${JSON.stringify(rowAfterRefusal)} — after a refusal the focused connector (src/engine/connector/daemonConnector.ts) must report the saved worker model with source record`,
    )
    connector.readFacts()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 5_000
      check(`${tag}: five seconds after refusal the status line still reads ready`, words() === 'ready', `${words()} — Fix statusLine in src/screen/chat/SwitchboardTagBar.tsx or the admission refusal path in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts).`)
    } finally {
      Date.now = realNow
    }

    releaseFocusedSessionConnector()
    hooks.ensureDaemon = async () => false
    const daemonDown = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    check(`${tag}: daemon-down refusal resolves false and reads ready`, (await daemonDown.admitted) === false && connector.admissionRefusal() === 'the daemon did not start' && words() === 'ready', `refusal=${connector.admissionRefusal()} words=${words()} — fix the daemon-down branch of focusResumedSession (src/daemon/switchboard/hopIntoSession.ts)`)

    releaseFocusedSessionConnector()
    hooks.ensureDaemon = async () => true
    holdNextAdmit()
    const reopened = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    check(
      `${tag}: reopening after a refusal clears the old refusal and re-arms starting`,
      connector.admissionRefusal() === null && words().startsWith('the runner is starting'),
      `refusal=${connector.admissionRefusal()} words=${words()} — a new focusResumedSession (src/daemon/switchboard/hopIntoSession.ts) must clear admissionRefusal in src/engine/connector/daemonConnector.ts`,
    )
    writeWorker({ parkedAt: undefined, parkedBy: undefined })
    resolveAdmit({ ok: true })
    check(`${tag}: the reopened admission settles true`, await reopened.admitted, 'focusResumedSession in src/daemon/switchboard/hopIntoSession.ts must resolve admitted to true when sessionAdmit replies ok:true')
    publish(1001, 'claude-opus-4-8')
    connector.readFacts()
    check(`${tag}: fresh runner facts settle the reopened session to ready and live`, words() === 'ready' && connector.modelFacts().effectiveSource === 'live', `${words()} — readFacts in src/engine/connector/daemonConnector.ts must take the fresh runner facts as live`)

    releaseFocusedSessionConnector()
    writeWorker({ parkedAt: 1200 })
    holdNextAdmit()
    const beforeRevive = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    const initialOpened = connector.status().runner?.sinceMs ?? Date.now()
    resolveAdmit({ ok: false, error: 'daemon busy' })
    await beforeRevive.admitted
    check(`${tag}: third resume refusal reads ready`, words() === 'ready', `${words()} — Fix statusLine in src/screen/chat/SwitchboardTagBar.tsx or the admission refusal path in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts).`)
    const reviveNow = Date.now
    try {
      Date.now = () => initialOpened + 120_000
      check(`${tag}: two minutes after refusal the status line still reads ready`, words() === 'ready', `${words()} — Fix statusLine in src/screen/chat/SwitchboardTagBar.tsx or the admission refusal path in focusResumedSession (src/daemon/switchboard/hopIntoSession.ts).`)
      const receipt = await connector.sendWords('revive the runner', [])
      check(`${tag}: Enter dispatch revives and clears the refusal`, receipt.state === 'accepted' && connector.admissionRefusal() === null, `${JSON.stringify(receipt)} — sendWords in src/engine/connector/daemonConnector.ts must revive the runner and clear the refusal`)
      check(`${tag}: revive starts a fresh starting clock at 0s rather than 2m`, words() === 'the runner is starting · 0s', `${words()} — the revive must restart the starting clock; see statusLine in src/screen/chat/SwitchboardTagBar.tsx`)
      Date.now = () => initialOpened + 121_000
      publish(1002, 'claude-opus-4-8', { state: 'starting', sinceMs: initialOpened + 120_500, respawns: 0, maxRespawns: 3 })
      connector.readFacts()
      check(`${tag}: one second into the revive the starting fact counts 1s from Enter rather than 2m from the refused open`, words() === 'the runner is starting · 1s', `${words()} — the starting clock must count from the runner's sinceMs fact; see statusLine in src/screen/chat/SwitchboardTagBar.tsx`)
      publish(1003, 'claude-opus-4-8')
      connector.readFacts()
      check(`${tag}: the revived runner clears its starting state when ready facts arrive`, connector.status().runner === null && !words().includes('runner is starting'), `${words()} — a ready fact must clear the runner state; see statusLine in src/screen/chat/SwitchboardTagBar.tsx and readFacts in src/engine/connector/daemonConnector.ts`)
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

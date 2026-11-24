import { mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

pinSourceRef()

type ProofHooks = { controlRpc: (request: { op: string }) => Promise<Record<string, unknown>> }
const hooks: ProofHooks = { controlRpc: async () => ({ ok: true, outcome: 'applied' }) }
const HOME = pinScratchHome('enter-draws-the-spinner')
for (const name of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_EFFORT_LEVEL']) delete process.env[name]
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

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, 'change: the working row of the chat is drawn while a line is on its way to the session (useChatStatusStrip and useChatSeatClock in src/screen/chat/useChatStatus.tsx read sendingSinceMs from the focused connector, src/engine/connector/daemonConnector.ts over SendsPart in src/engine/connector/daemon/sends.ts)'].filter(Boolean).join(' | ')}`}`)
}

const realEnsure = { ...(await import('../../src/daemon/switchboard/ensureDaemon.ts')) }
mock.module('../../src/daemon/switchboard/ensureDaemon.ts', () => ({ ...realEnsure, ensureOwnedDaemon: async () => true }))
const realControl = { ...(await import('../../src/daemon/control/controlSocket.ts')) }
mock.module('../../src/daemon/control/controlSocket.ts', () => ({ ...realControl, daemonControlRpc: (request: { op: string }) => hooks.controlRpc(request) }))
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
const { SESSION_VERBS } = await import('../../src/daemon/runner-wire/sessionVerbs.ts')
type SessionLiveV1 = import('../../src/engine/connector/seatLive.ts').SessionLiveV1
type SendReceiptV1 = import('../../src/engine/connector/types.ts').SendReceiptV1
type Focused = ReturnType<typeof getFocusedSessionConnector> & { live: () => SessionLiveV1; sendingSinceMs?: () => number | null }
const focused = (): Focused => getFocusedSessionConnector() as Focused

const commands = await getCommands(WORK)
const project = getProjectDir(WORK)
mkdirSync(project, { recursive: true })
const WORKING_ROW = /… \((\d+)s/
const workingRowOf = (m: Mounted): string => m.lines().find(line => WORKING_ROW.test(line)) ?? ''
const SEND = SESSION_VERBS.sendWords.daemon.op

for (const [index, [cols, rows]] of ([[120, 40]] as const).entries()) {
  const tag = `${cols}x${rows}`
  const sid = `00000000-0000-4000-8000-00000000030${index + 1}`
  const transcript = join(project, `${sid}.jsonl`)
  writeFileSync(
    transcript,
    encodeSeedTranscript(
      [
        { type: 'user', uuid: `00000000-0000-4000-8000-00000000031${index + 1}`, parentUuid: null, sessionId: sid, cwd: WORK, timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'saved conversation' } },
        { type: 'assistant', uuid: `00000000-0000-4000-8000-00000000032${index + 1}`, parentUuid: `00000000-0000-4000-8000-00000000031${index + 1}`, sessionId: sid, cwd: WORK, timestamp: '2026-06-19T12:00:01.000Z', message: { id: 'saved-reply', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'saved answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
      sid,
    ),
  )
  const factsFile = sessionFactsPath(sid)
  mkdirSync(dirname(factsFile), { recursive: true })
  const facts = (atMs: number, busy: boolean): void =>
    writeFileSync(
      factsFile,
      JSON.stringify({ schema: 1, sessionId: sid, atMs, model: { effective: 'claude-sonnet-5', setting: 'claude-sonnet-5' }, pendingModel: null, busy, usage: noSessionConnector().usage(), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], workspace: { cwd: WORK, originalCwd: WORK, projectRoot: WORK }, queue: [] }),
    )
  writeFileSync(join(process.env.MERCURY_DAEMON_DIR!, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: WORK, isolation: 'shared', modelKey: 'claude-sonnet-5', spawnedAt: Date.now() - 5_000, lastLiveAt: Date.now() - 1_000 } } }))
  facts(Date.now(), false)

  let answer!: (reply: Record<string, unknown>) => void
  let held = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
  const holdNext = (): void => {
    held = new Promise<Record<string, unknown>>(resolve => { answer = resolve })
  }
  const sent: string[] = []
  hooks.controlRpc = async request => {
    if (request.op !== SEND) return { ok: true, outcome: 'applied' }
    sent.push(request.op)
    return held
  }

  releaseFocusedSessionConnector()
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetOverlayStackForTests()
  layoutChromeLive(cols, rows)
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})

  const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))), cols, rows)
  try {
    const opened = await focusResumedSession(sid, transcript, { firstPaintMs: 10 })
    await opened.admitted
    await waitFor(() => m.screen().includes('saved answer'), 5000)
    await settle(150)
    check(`${tag}: at rest no working row is drawn`, workingRowOf(m) === '' && focused().live().inFlight === false, `row ${JSON.stringify(workingRowOf(m))}`)

    const enterAt = Date.now()
    const first = (getFocusedSessionConnector() as { sendWords: (words: string) => Promise<SendReceiptV1> }).sendWords('the first line')
    const asked = await waitFor(() => sent.length === 1, 5000)
    const drawn = await waitFor(() => workingRowOf(m) !== '', 3000)
    const row = workingRowOf(m)
    check(`${tag}: the line is on its way and the session has not answered`, asked && focused().live().inFlight === false, `the send reached the control plane: ${asked}; inFlight ${focused().live().inFlight}`)
    check(`${tag}: the working row is drawn while the line is on its way`, drawn, `no row reads “… (Ns” in:\n${m.lines().slice(-14).join('\n')}`)
    check(`${tag}: its clock counts from the Enter`, drawn && Number(WORKING_ROW.exec(row)?.[1] ?? '99') <= 2, `row ${JSON.stringify(row)}, ${Date.now() - enterAt} ms after the Enter`)
    const since = focused().sendingSinceMs?.() ?? null
    check(`${tag}: the connector says since when a line is on its way`, since !== null && since >= enterAt && since <= Date.now(), `sendingSinceMs ${since}, Enter at ${enterAt}`)
    await waitFor(() => Number(WORKING_ROW.exec(workingRowOf(m))?.[1] ?? '0') >= 1, 4000)
    const before = Number(WORKING_ROW.exec(workingRowOf(m))?.[1] ?? '-1')

    answer({ ok: true })
    await first
    facts(Date.now(), true)
    const running = await waitFor(() => focused().live().inFlight && workingRowOf(m) !== '', 3000)
    const after = Number(WORKING_ROW.exec(workingRowOf(m))?.[1] ?? '-1')
    check(`${tag}: once the session has it the row still stands and its clock runs on from the Enter`, running && before >= 1 && after >= before && (focused().sendingSinceMs?.() ?? null) === null, `${before}s while on its way, ${after}s once delivered: ${JSON.stringify(workingRowOf(m))}`)

    facts(Date.now() + 1, false)
    await waitFor(() => !focused().live().inFlight && workingRowOf(m) === '', 15_000)
    holdNext()
    const second = (getFocusedSessionConnector() as { sendWords: (words: string) => Promise<SendReceiptV1> }).sendWords('the second line')
    await waitFor(() => sent.length === 2 && workingRowOf(m) !== '', 3000)
    answer({ ok: false, error: 'the session did not take it' })
    const receipt = await second
    const gone = await waitFor(() => workingRowOf(m) === '', 3000)
    check(`${tag}: a line the session refuses takes the working row away again`, receipt.state === 'refused' && gone && (focused().sendingSinceMs?.() ?? null) === null && focused().live().inFlight === false, `receipt ${JSON.stringify(receipt)} row ${JSON.stringify(workingRowOf(m))}`)
  } finally {
    m.unmount()
    releaseFocusedSessionConnector()
  }
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-enter-draws-the-spinner: all green' : `\nprove-enter-draws-the-spinner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

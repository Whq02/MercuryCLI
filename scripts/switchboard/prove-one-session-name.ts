#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'one-session-name-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

let failures = 0
function check(label: string, cond: boolean, detail: string, hint: string): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, hint].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { setCwdState, setOriginalCwd } = await import('../../src/boot/process-state/processState.js')
const PROJECT = join(SCRATCH, 'proj')
mkdirSync(PROJECT, { recursive: true })
setOriginalCwd(PROJECT)
setCwdState(PROJECT)

const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { buildConcourseSnapshot } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { projectIdentity } = await import('../../src/screen/boot-face/bootCardFacts.ts')
const { concourseWorkersPath, setConcourseSessionTitle, boardHomedSessionIds } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { listSessionsAcrossProjectsProgressive, enrichSessionListings } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { projectSessionPickerRows } = await import('../../src/screen/widgets/faces/sessionPickerModel.ts')
const { listSessionsImpl } = await import('../../src/sessions/transcripts/listSessions.ts')
const { writeMissionCard } = await import('../../src/sessions/mission-card/missionCard.ts')
const { buildMissionDirective, MISSION_HOLD_HEAD } = await import('../../src/permissions/guards/mission.ts')
const { createSeatReceiptMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { composeBuildBehindLine } = await import('../../src/tools/monitor/watchReceipts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import type { SessionListing } from '../../src/sessions/transcripts/transcriptEntries.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const NOW = Date.now()
const MIN = 60_000
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
for (const d of [crewDir, draftDir]) mkdirSync(d, { recursive: true })

const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`

function seedMultiPromptTranscript(
  sessionId: string,
  prompts: readonly string[],
  opts: { ageMs: number; customTitle?: string },
): void {
  const file = workerTranscriptPath({ sessionId, workspaceId: PROJECT })
  mkdirSync(dirname(file), { recursive: true })
  const rows: Record<string, unknown>[] = []
  let parentUuid: string | null = null
  for (let i = 0; i < prompts.length; i++) {
    const uUuid = `00000000-0000-4000-8000-${sessionId.slice(-8)}${String(i * 2).padStart(4, '0')}`
    const aUuid = `00000000-0000-4000-8000-${sessionId.slice(-8)}${String(i * 2 + 1).padStart(4, '0')}`
    const ts = new Date(NOW - opts.ageMs - (prompts.length - i) * 1000).toISOString()
    rows.push({
      isSidechain: false,
      entrypoint: 'cli',
      cwd: PROJECT,
      sessionId,
      version: '1.0.0-beta.1',
      gitBranch: 'main',
      parentUuid,
      uuid: uUuid,
      timestamp: ts,
      type: 'user',
      message: { role: 'user', content: prompts[i]! },
    })
    rows.push({
      isSidechain: false,
      entrypoint: 'cli',
      cwd: PROJECT,
      sessionId,
      version: '1.0.0-beta.1',
      gitBranch: 'main',
      parentUuid: uUuid,
      uuid: aUuid,
      timestamp: ts,
      type: 'assistant',
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: `reply ${i}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    parentUuid = aUuid
  }
  const lastPrompt = prompts[prompts.length - 1]
  if (lastPrompt !== undefined) {
    rows.push({ type: 'last-prompt', lastPrompt, sessionId })
  }
  if (opts.customTitle !== undefined) {
    rows.push({ type: 'custom-title', customTitle: opts.customTitle, sessionId })
  }
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const at = new Date(NOW - opts.ageMs)
  utimesSync(file, at, at)
}

const NOTICE = composeBuildBehindLine('68d369c7535d', '14fca308c142', false)

function seedNoticeFirstTranscript(
  sessionId: string,
  opts: { ageMs: number; prompt?: string; mission?: { goal: string; state: 'paused' | 'cleared' } },
): void {
  const file = workerTranscriptPath({ sessionId, workspaceId: PROJECT })
  mkdirSync(dirname(file), { recursive: true })
  const envelope = { isSidechain: false, entrypoint: 'cli', cwd: PROJECT, sessionId, version: '1.0.12', gitBranch: 'main' }
  const at = (n: number): string => new Date(NOW - opts.ageMs - (10 - n) * 1000).toISOString()
  const uuidOf = (n: number): string => `00000000-0000-4000-8000-${sessionId.slice(-8)}${String(n).padStart(4, '0')}`
  const rows: Record<string, unknown>[] = [{ ...createSeatReceiptMessage(NOTICE, 'warning'), ...envelope, parentUuid: null, uuid: uuidOf(0), timestamp: at(0) }]
  let parentUuid = uuidOf(0)
  const turn = (n: number, content: string, stamp: Record<string, unknown>): void => {
    rows.push({ ...envelope, ...stamp, parentUuid, uuid: uuidOf(n), timestamp: at(n), type: 'user', message: { role: 'user', content } })
    rows.push({
      ...envelope,
      parentUuid: uuidOf(n),
      uuid: uuidOf(n + 1),
      timestamp: at(n),
      type: 'assistant',
      message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `reply ${n}` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    })
    parentUuid = uuidOf(n + 1)
  }
  if (opts.prompt !== undefined) turn(1, opts.prompt, {})
  if (opts.mission !== undefined) {
    const directive = buildMissionDirective(opts.mission.goal)
    const origin = { kind: 'screen-command', command: 'mission' }
    rows.push({ type: 'queue-operation', operation: 'enqueue', timestamp: at(3), sessionId, content: directive, commandUuid: uuidOf(3), mode: 'prompt', isMeta: true, origin })
    turn(3, directive, { isMeta: true, origin })
    turn(5, `${MISSION_HOLD_HEAD} ${opts.mission.goal} — no close yet. Continue.`, { isMeta: true })
    const written = writeMissionCard({ schema: 1, sessionId, goal: opts.mission.goal, state: opts.mission.state, nextStep: null, iterations: 2, setAt: at(3), updatedAt: at(5) }, PROJECT)
    if (!written.ok) throw new Error(`the mission card of ${sessionId} was not written: ${written.error}`)
  }
  if (opts.prompt !== undefined) rows.push({ type: 'last-prompt', lastPrompt: opts.prompt, sessionId })
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const when = new Date(NOW - opts.ageMs)
  utimesSync(file, when, when)
}

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const path = concourseWorkersPath()
  mkdirSync(dirname(path), { recursive: true })
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(path, `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
}

async function readAllListings(): Promise<SessionListing[]> {
  const first = await listSessionsAcrossProjectsProgressive()
  let acc = first.logs
  let next = first.nextIndex
  while (next < first.allStatLogs.length) {
    const batch = await enrichSessionListings(first.allStatLogs, next, 50)
    next = batch.nextIndex
    acc = [...acc, ...batch.logs]
  }
  return acc
}

const S_THREE_UNHOSTED = sid('01')
const S_THREE_PARKED = sid('02')
const S_RENAMED_PARKED = sid('03')
const S_RENAMED_TRANSCRIPT = sid('04')

const FIRST_A = 'The tests in test_wordstats.py fail'
const FIRST_B = 'Add a command-line interface to wordstats'
const FIRST_C = 'Build the parser module first'
const FIRST_D = 'Inspect the billing ledger rows'

seedMultiPromptTranscript(S_THREE_UNHOSTED, [FIRST_A, 'Middle prompt A', 'Run exactly sudo -n true'], { ageMs: 10 * MIN })
seedMultiPromptTranscript(S_THREE_PARKED, [FIRST_B, 'Middle prompt B', 'Final prompt B'], { ageMs: 8 * MIN })
seedMultiPromptTranscript(S_RENAMED_PARKED, [FIRST_C, 'Middle prompt C', 'Yes, please remove ordstats.py'], { ageMs: 6 * MIN })
seedMultiPromptTranscript(S_RENAMED_TRANSCRIPT, [FIRST_D, 'Middle prompt D', 'Final prompt D'], { ageMs: 4 * MIN, customTitle: 'flow probes u23' })

const S_MISSION_ONLY = sid('05')
const S_MISSION_AFTER_PROMPT = sid('06')
const S_MISSION_CLEARED = sid('07')
const S_NOTICE_ONLY = sid('08')

const GOAL_ONLY = 'relay answers in 1s; never touch the config'
const GOAL_AFTER_PROMPT = 'every test in test_relay.py passes'
const FIRST_E = 'Look at the relay module with me'
const FIRST_F = 'Sketch the retry ladder'

seedNoticeFirstTranscript(S_MISSION_ONLY, { ageMs: 3 * MIN, mission: { goal: GOAL_ONLY, state: 'paused' } })
seedNoticeFirstTranscript(S_MISSION_AFTER_PROMPT, { ageMs: 2 * MIN, prompt: FIRST_E, mission: { goal: GOAL_AFTER_PROMPT, state: 'paused' } })
seedNoticeFirstTranscript(S_MISSION_CLEARED, { ageMs: 1 * MIN, prompt: FIRST_F, mission: { goal: 'a goal the operator cleared', state: 'cleared' } })
seedNoticeFirstTranscript(S_NOTICE_ONLY, { ageMs: 30_000 })

seedWorkers([
  {
    schema: 1,
    runnerId: 'concourse-w1',
    sessionId: S_THREE_PARKED,
    workspaceId: PROJECT,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 20 * MIN,
    lastLiveAt: NOW - 8 * MIN,
    lastDeliveryAt: NOW - 9 * MIN,
    lastTurnSettledAt: NOW - 8 * MIN,
    pid: 999_999_999,
    parkedAt: NOW - 8 * MIN,
    parkedBy: 'operator:test',
  },
  {
    schema: 1,
    runnerId: 'concourse-w2',
    sessionId: S_RENAMED_PARKED,
    workspaceId: PROJECT,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 18 * MIN,
    lastLiveAt: NOW - 6 * MIN,
    lastDeliveryAt: NOW - 7 * MIN,
    lastTurnSettledAt: NOW - 6 * MIN,
    pid: 999_999_999,
    parkedAt: NOW - 6 * MIN,
    parkedBy: 'operator:test',
  },
])

const renameRes = setConcourseSessionTitle(S_RENAMED_PARKED, 'cli feature u23', 'operator', 'operator')
check(
  'renaming the parked session through the Session Manager store succeeds',
  renameRes.outcome === 'applied',
  JSON.stringify(renameRes),
  'fix setConcourseSessionTitle in src/daemon/concourse-workers/focus.ts',
)

const snap = await buildConcourseSnapshot({ crewDir, draftDir, nowMs: NOW, project: projectIdentity(PROJECT) })
const managerById = new Map(snap.groups.flatMap(g => g.rows).map(r => [r.sessionId, r.title] as const))

const logs = await readAllListings()
const picker = projectSessionPickerRows(logs, {
  scope: 'project',
  projectDir: PROJECT,
  boardHomed: boardHomedSessionIds(),
  isCleared: () => false,
  nowMs: NOW,
})
const pickerById = new Map(picker.flat.map(f => [f.row.log.sessionId, f.row.label] as const))

const NAME_HINT = 'fix sessionLabelFacts in src/sessions/transcripts/sessionIndex.ts (first prompt before lastPrompt), rowLabel/projectSessionPickerRows in src/screen/widgets/faces/sessionPickerModel.ts (use sessionTitleOf with worker titles and customTitle), and parkedBoardRows in src/screen/concourse-model/concourseSnapshot.ts'

check(
  'unhosted 3-prompt session has the same first-prompt name in Session Manager and /sessions',
  managerById.get(S_THREE_UNHOSTED) === FIRST_A && pickerById.get(S_THREE_UNHOSTED) === FIRST_A,
  `manager=${JSON.stringify(managerById.get(S_THREE_UNHOSTED))} sessions=${JSON.stringify(pickerById.get(S_THREE_UNHOSTED))}`,
  NAME_HINT,
)

check(
  'hosted parked 3-prompt session has the same first-prompt name in Session Manager and /sessions',
  managerById.get(S_THREE_PARKED) === FIRST_B && pickerById.get(S_THREE_PARKED) === FIRST_B,
  `manager=${JSON.stringify(managerById.get(S_THREE_PARKED))} sessions=${JSON.stringify(pickerById.get(S_THREE_PARKED))}`,
  NAME_HINT,
)

check(
  'parked session renamed via Session Manager store (r key) shows that rename in BOTH Session Manager and /sessions',
  managerById.get(S_RENAMED_PARKED) === 'cli feature u23' && pickerById.get(S_RENAMED_PARKED) === 'cli feature u23',
  `manager=${JSON.stringify(managerById.get(S_RENAMED_PARKED))} sessions=${JSON.stringify(pickerById.get(S_RENAMED_PARKED))}`,
  NAME_HINT,
)

check(
  'unhosted session renamed in transcript shows that rename in BOTH Session Manager and /sessions',
  managerById.get(S_RENAMED_TRANSCRIPT) === 'flow probes u23' && pickerById.get(S_RENAMED_TRANSCRIPT) === 'flow probes u23',
  `manager=${JSON.stringify(managerById.get(S_RENAMED_TRANSCRIPT))} sessions=${JSON.stringify(pickerById.get(S_RENAMED_TRANSCRIPT))}`,
  NAME_HINT,
)

const MISSION_HINT = 'a session is named by its /rename title, else its mission\'s goal, else the first prompt typed, and never by a notice: headBriefLabel in src/screen/concourse-model/concourseSnapshot.ts, readLiteMetadata in src/sessions/transcripts/sessionListings.ts and readCandidate in src/sessions/transcripts/listSessions.ts must each read the goal through missionGoalBeside in src/sessions/mission-card/missionCard.ts, and sessionLabelFacts in src/sessions/transcripts/sessionIndex.ts must not take a record\'s content for a name'
const bothNames = (sessionId: string): string => `manager=${JSON.stringify(managerById.get(sessionId))} sessions=${JSON.stringify(pickerById.get(sessionId))}`

check(
  'a /mission session whose record opens on a build notice and holds no typed prompt is listed under its goal in BOTH Session Manager and /sessions',
  managerById.get(S_MISSION_ONLY) === GOAL_ONLY && pickerById.get(S_MISSION_ONLY) === GOAL_ONLY,
  bothNames(S_MISSION_ONLY),
  MISSION_HINT,
)

check(
  'a session with a typed prompt and a standing mission is listed under the mission\'s goal in BOTH',
  managerById.get(S_MISSION_AFTER_PROMPT) === GOAL_AFTER_PROMPT && pickerById.get(S_MISSION_AFTER_PROMPT) === GOAL_AFTER_PROMPT,
  bothNames(S_MISSION_AFTER_PROMPT),
  MISSION_HINT,
)

check(
  'a mission the operator cleared no longer names its session: its first prompt does, in BOTH',
  managerById.get(S_MISSION_CLEARED) === FIRST_F && pickerById.get(S_MISSION_CLEARED) === FIRST_F,
  bothNames(S_MISSION_CLEARED),
  MISSION_HINT,
)

check(
  'a session whose record holds a build notice and nothing typed is never listed under the notice\'s words',
  managerById.get(S_NOTICE_ONLY) === undefined && !(pickerById.get(S_NOTICE_ONLY) ?? '').includes('Mercury build'),
  bothNames(S_NOTICE_ONLY),
  MISSION_HINT,
)

const editorById = new Map((await listSessionsImpl({ dir: PROJECT })).map(row => [row.sessionId, row.summary] as const))
check(
  'the editor\'s session list (session/list) names each session by the same rule: the first prompt, the mission\'s goal, the rename, and no row for the notice',
  editorById.get(S_THREE_UNHOSTED) === FIRST_A &&
    editorById.get(S_RENAMED_TRANSCRIPT) === 'flow probes u23' &&
    editorById.get(S_MISSION_ONLY) === GOAL_ONLY &&
    editorById.get(S_MISSION_AFTER_PROMPT) === GOAL_AFTER_PROMPT &&
    editorById.get(S_MISSION_CLEARED) === FIRST_F &&
    !editorById.has(S_NOTICE_ONLY),
  JSON.stringify([S_THREE_UNHOSTED, S_RENAMED_TRANSCRIPT, S_MISSION_ONLY, S_MISSION_AFTER_PROMPT, S_MISSION_CLEARED, S_NOTICE_ONLY].map(id => editorById.get(id) ?? null)),
  MISSION_HINT,
)

const { mock } = await import('bun:test')
const React = await import('react')
const h = React.createElement
const { mountOffscreen, settle, waitFor, KEY } = await import('../lib/settingsPopupHarness.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ModalContext } = await import('../../src/screen/overlays/modalContext.js')
const { resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.js')
const { setFocusedSessionConnector, getFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')

const twelveLogs: SessionListing[] = Array.from({ length: 12 }, (_, idx) => {
  const n = String(idx + 1).padStart(2, '0')
  const modified = new Date(NOW - idx * MIN)
  return {
    date: modified.toISOString(),
    messages: [],
    fullPath: join(SCRATCH, `strip-${n}.jsonl`),
    value: idx,
    created: modified,
    modified,
    firstPrompt: `card title ${n}`,
    customTitle: `card title ${n}`,
    messageCount: 2,
    isSidechain: false,
    sessionId: sid(`9${n}`),
    projectPath: PROJECT,
    fileSize: 4096,
  } as SessionListing
})
const twelveFlat = projectSessionPickerRows(twelveLogs, {
  scope: 'project',
  projectDir: PROJECT,
  boardHomed: new Set(),
  isCleared: () => false,
  workerTitles: new Map(),
  nowMs: NOW,
}).flat

const realPickerModel = await import('../../src/screen/widgets/faces/sessionPickerModel.ts')
mock.module('../../src/screen/widgets/faces/sessionPickerModel.ts', () => ({
  ...realPickerModel,
  useSessionPickerModel: () => ({
    logs: twelveLogs,
    pendingMore: 0,
    readNotice: null,
    projectKey: 'proj',
    flat: twelveFlat,
    elsewhereCount: 0,
    dropSessions() {},
  }),
}))

const originalConnector = getFocusedSessionConnector()
setFocusedSessionConnector(new Proxy(originalConnector, {
  get(target, prop) {
    if (prop === 'sessionId') return () => sid('ff')
    const val = Reflect.get(target, prop)
    return typeof val === 'function' ? val.bind(target) : val
  },
}))

const { SessionManagerView } = await import('../../src/screen/widgets/faces/SessionManagerView.tsx')
const STRIP_HINT = 'fix arrow key handling in LiveSessionManager in src/screen/widgets/faces/SessionManagerView.tsx so rightArrow advances and scrolls the strip and leftArrow moves back before closing at index 0'

for (const band of [{ columns: 120, rows: 30 }, { columns: 80, rows: 24 }]) {
  resetOverlayStackForTests()
  let closed = false
  const node = h(
    App,
    { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never,
    h(
      KeybindingSetup,
      null,
      h(
        ModalContext.Provider,
        { value: { rows: band.rows, columns: band.columns, scrollRef: null } },
        h(SessionManagerView, {
          onClose: () => { closed = true },
          onNewSession: () => {},
          onResume: async () => {},
        }),
      ),
    ),
  )
  const view = await mountOffscreen(node, band.columns, band.rows)
  try {
    await waitFor(() => view.screen().includes('card title 01'), 2000)
    await settle(60)
    for (let step = 0; step < 11; step++) {
      view.push(KEY.right)
      await settle(30)
    }
    const reachedEnd = await waitFor(() => view.screen().includes('card title 12'), 2000)
    check(
      `${band.columns}x${band.rows}: right arrow scrolls /sessions strip to the 12th card beyond its initial window`,
      reachedEnd && !closed,
      `reachedEnd=${reachedEnd} closed=${closed}`,
      STRIP_HINT,
    )
    for (let step = 0; step < 11; step++) {
      view.push(KEY.left)
      await settle(30)
    }
    const backToStart = await waitFor(() => view.screen().includes('card title 01'), 2000)
    check(
      `${band.columns}x${band.rows}: left arrow walks back to the 1st card without closing`,
      backToStart && !closed,
      `backToStart=${backToStart} closed=${closed}`,
      STRIP_HINT,
    )
    view.push(KEY.left)
    const closedAtEdge = await waitFor(() => closed, 1500)
    check(
      `${band.columns}x${band.rows}: left arrow at card 0 still closes /sessions`,
      closedAtEdge,
      `closed=${closed}`,
      STRIP_HINT,
    )
  } finally {
    view.unmount()
  }
}

setFocusedSessionConnector(originalConnector)
removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-one-session-name: ALL LAWS HOLD' : `\nprove-one-session-name: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

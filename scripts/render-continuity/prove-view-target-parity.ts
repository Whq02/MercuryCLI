#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const {
  getActiveAgentForInput,
  getViewedAgent,
  projectViewedAgent,
  NON_VIEWABLE_TASK_TYPES,
  VIEWABLE_TASK_TYPES,
} = await import('../../src/state/selectors.ts')
const { isManageableTask } = await import(
  '../../src/components/tasks/taskStatusUtils.tsx'
)
const { interruptCrewmate } = await import('../../src/components/tasks/crewmateInterrupt.ts')
const { AGENT_INTERRUPT_BY_OPERATOR } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { runPulseArena } = await import('./lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()
const FRAMES = ((): string | undefined => {
  const at = process.argv.indexOf('--frames')
  return at >= 0 ? process.argv[at + 1] : undefined
})()
type Frame = { atMs: number; rows: string[] }
const keepFrames = (label: string, screens: Frame[]): void => {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  const out: string[] = []
  let prev = ''
  for (const s of screens) {
    const body = s.rows.map((r, i) => `${String(i + 1).padStart(2)}|${r}`).join('\n')
    if (body === prev) continue
    prev = body
    out.push(`━━ @${s.atMs}`, body)
  }
  writeFileSync(join(FRAMES, `${label}.txt`), out.join('\n') + '\n')
}
const sendsDue = (run: { sendLog: unknown[]; driverOut: string }, authored: number): void =>
  t.check(
    `every send became due (${authored} sends, each witness painted)`,
    run.sendLog.length === authored && !run.driverOut.includes('UNFIRED-SENDS'),
    `${run.sendLog.length}/${authored} · ${run.driverOut.split('\n').filter(l => l.includes('UNFIRED')).join(' ').slice(0, 300)}`,
  )

t.section('§1 the projection is exhaustive and honest')
{
  const localAgent = {
    type: 'local_agent',
    id: 'la-1',
    description: 'poise probe',
    status: 'running',
    agentType: 'mercury-crew',
    pendingMessages: [],
    messages: [],
  } as never
  const mainSession = {
    type: 'local_agent',
    id: 'main-1',
    description: 'main',
    status: 'running',
    agentType: 'main-session',
  } as never

  const registry = new Map([['probe-name', 'la-1']])
  const empty = new Map<string, string>()

  const pl = projectViewedAgent(localAgent, registry as never)
  t.check(
    'local agent projects with the REGISTRY name (labels are not identity)',
    pl?.kind === 'local_agent' && pl.name === 'probe-name' && pl.statusLabel === 'running',
    JSON.stringify(pl && { kind: pl.kind, name: pl.name }),
  )
  const plFallback = projectViewedAgent(localAgent, empty as never)
  t.check(
    'unregistered local agent falls back to its description honestly',
    plFallback?.name === 'poise probe',
    plFallback?.name,
  )
  t.check(
    'the main-session task NEVER projects as a viewed agent',
    projectViewedAgent(mainSession, registry as never) === undefined,
  )

  const doneAgent = { ...(localAgent as object), status: 'completed' } as never
  const pd = projectViewedAgent(doneAgent, registry as never)
  t.check(
    'completed local agent projects completed + not working',
    pd?.statusLabel === 'completed' && pd.isWorking === false,
  )

  t.check(
    'classification lists are disjoint and non-empty',
    VIEWABLE_TASK_TYPES.length === 1 &&
      NON_VIEWABLE_TASK_TYPES.length === 4 &&
      !VIEWABLE_TASK_TYPES.some(v => (NON_VIEWABLE_TASK_TYPES as readonly string[]).includes(v)),
    `${VIEWABLE_TASK_TYPES.join(',')} | ${NON_VIEWABLE_TASK_TYPES.join(',')}`,
  )

  const stateOf = (task: { id: string } | undefined): never =>
    ({
      viewingAgentTaskId: task?.id,
      tasks: task ? { [task.id]: task } : {},
      agentNameRegistry: registry,
    }) as never
  for (const [label, task, viewable] of [
    ['local agent', localAgent, true],
    ['main-session', mainSession, false],
  ] as [string, { id: string }, boolean][]) {
    const projected = getViewedAgent(stateOf(task)) !== undefined
    const routed = getActiveAgentForInput(stateOf(task)).type !== 'leader'
    t.check(
      `${label}: projection and input router agree (${viewable ? 'viewable' : 'never a destination'})`,
      projected === viewable && routed === viewable,
      `projected=${projected} routed=${routed}`,
    )
  }
}

t.section('§2 journey: header + CREW lead row + mouse return')
{
  const ESC = String.fromCharCode(27)
  const sgrClick = (col: number, row: number): string =>
    `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
  const ROOT_ROW = 3
  const CHILD_ROW = 4

  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        subagent_type: 'mercury-crew',
        run_in_background: true,
      },
      preText: 'Spawning the probe agent.',
    },
    {
      kind: 'paced',
      deltas: Array.from({ length: 24 }, (_, i) => `count ${i + 1}. `),
      gapMs: 900,
      whenSaid: 'Count to three slowly.',
    },
    { kind: 'text', text: 'Probe launched.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Settled.', whenBody: 'spawn the probe' },
    { kind: 'text', text: 'Spare.', whenBody: 'spawn the probe' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:spawn the probe\\r',
      `after:poise pro… · running:1000:${sgrClick(10, CHILD_ROW)}`,
      `after:x stop · p pause:2500:${sgrClick(10, ROOT_ROW)}`,
    ],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
  })
  sendsDue(run, 4)

  const s2Offsets = Array.from({ length: 44 }, (_, i) => String(S(6000 + i * 300)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...s2Offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    keepFrames('drill-120x40', screens)
    const frames = screens.filter(f => f.atMs !== -1)
    const has = (f: { rows: string[] }, needle: string | RegExp): boolean =>
      f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const idxOf = (start: number, pred: (f: { rows: string[] }) => boolean): number => {
      for (let i = Math.max(0, start); i < frames.length; i++) if (pred(frames[i]!)) return i
      return -1
    }
    const leadMarked = (f: { rows: string[] }): boolean => f.rows.some(r => /›\s*✶ Mercury Lead/.test(r))
    const childMarked = (f: { rows: string[] }): boolean => f.rows.some(r => /›\s*◉ poise pro/.test(r))
    const childRunning = (f: { rows: string[] }): boolean => f.rows.some(r => r.includes('poise pro') && r.includes('running'))
    const inView = (f: { rows: string[] }): boolean => has(f, /❯ message poise probe/)

    const iMain = idxOf(0, f => leadMarked(f) && childRunning(f) && !has(f, '❯ message poise'))
    t.check('at main, the lead row reads Mercury Lead and wears the › mark (its chat is the view)', iMain >= 0)
    const mf = frames[iMain] ?? { rows: [] as string[] }
    const rootIdx = mf.rows.findIndex(r => /✶ Mercury Lead/.test(r))
    const childIdx = mf.rows.findIndex(r => r.includes('poise pro'))
    t.check(
      `CREW lists Mercury Lead first at row ${ROOT_ROW} and the child under it`,
      iMain >= 0 && rootIdx + 1 === ROOT_ROW && childIdx + 1 === CHILD_ROW,
      `lead@${rootIdx + 1} child@${childIdx + 1}`,
    )

    const iView = idxOf(
      iMain + 1,
      f => inView(f) && childMarked(f) && !leadMarked(f) && has(f, 'esc interrupts') && has(f, 'sends to poise probe'),
    )
    t.check(
      'one click on the child opens it in the view: the composer addresses it, the › mark moves to its row, esc interrupts it, ↵ sends to it',
      iMain >= 0 && iView > iMain,
      iView >= 0
        ? frames[iView]!.rows.find(r => r.includes('❯ message poise probe'))?.trim().slice(0, 70)
        : 'no such frame after the main frame',
    )

    const iBack = idxOf(
      iView + 1,
      f => !inView(f) && leadMarked(f) && has(f, 'spawn the probe') && childRunning(f),
    )
    t.check(
      'one click on Mercury Lead in the rail returns to main WITHOUT stopping the child (return ≠ stop): the › mark back on the lead, the child still running',
      iView >= 0 && iBack > iView,
      iBack >= 0
        ? frames[iBack]!.rows.find(r => r.includes('poise pro'))?.trim().slice(0, 50)
        : 'no main frame with the child running after the view frame',
    )
  }
  run.cleanup()
}

t.section('§3 manage-visibility predicate + the one esc grammar')
{
  const la = (over: object): never =>
    ({
      type: 'local_agent',
      id: 'la-x',
      description: 'quick probe',
      status: 'running',
      agentType: 'mercury-crew',
      pendingMessages: [],
      ...over,
    }) as never
  const table: [string, never, boolean][] = [
    ['running agent', la({}), true],
    ['completed + retained (viewed)', la({ status: 'completed', retain: true }), true],
    ['completed inside the linger window', la({ status: 'completed', evictAfter: Date.now() + 30_000 }), true],
    ['completed past the linger deadline', la({ status: 'completed', evictAfter: Date.now() - 1 }), false],
    ['dismissed (evictAfter 0)', la({ status: 'completed', evictAfter: 0 }), false],
    ['main-session task never manageable once terminal', la({ status: 'completed', agentType: 'main-session', evictAfter: Date.now() + 30_000 }), false],
  ]
  for (const [label, task, want] of table) {
    t.check(`manageable: ${label} → ${want}`, isManageableTask(task) === want)
  }

  type Road = 'local' | 'hosted' | 'idle'
  const drive = (
    task: { id?: string } | undefined,
    facts: { running: boolean } | null | undefined,
  ): { road: Road; stops: string[]; aborted: unknown } => {
    const id = (task as { id?: string } | undefined)?.id ?? 'a-hosted'
    const state = { tasks: task ? { [id]: task } : {} } as never
    const stops: string[] = []
    const stopAgent = async (agentId: string, note?: string): Promise<unknown> => {
      stops.push(`${agentId}:${note ?? ''}`)
      return { outcome: 'ok' }
    }
    const road = interruptCrewmate(id, state, updater => void updater(state), stopAgent, { facts }) as Road
    const controller = (task as { abortController?: AbortController; currentWorkAbortController?: AbortController } | undefined)
    const signal = controller?.abortController?.signal ?? controller?.currentWorkAbortController?.signal
    return { road, stops, aborted: signal?.aborted ? signal.reason : undefined }
  }
  const escTable: [string, { id?: string } | undefined, { running: boolean } | null | undefined, Road, unknown][] = [
    ['local agent running → interrupted with the operator reason', la({ abortController: new AbortController() }), undefined, 'local', AGENT_INTERRUPT_BY_OPERATOR],
    ['local agent completed → idle (esc goes back to Mercury Lead)', la({ status: 'completed', abortController: new AbortController() }), undefined, 'idle', undefined],
    ['hosted crewmate running → the stop door once, with the typed note', undefined, { running: true }, 'hosted', undefined],
    ['hosted crewmate not running → idle, no stop sent', undefined, { running: false }, 'idle', undefined],
    ['hosted crewmate with unknown facts → the stop door (the road assumes live)', undefined, null, 'hosted', undefined],
  ]
  for (const [label, task, facts, want, reason] of escTable) {
    const got = drive(task, facts)
    const hostedStops = want === 'hosted' ? got.stops.length === 1 && got.stops[0] === `a-hosted:${AGENT_INTERRUPT_BY_OPERATOR}` : got.stops.length === 0
    t.check(
      `esc grammar: ${label}`,
      got.road === want && got.aborted === reason && hostedStops,
      `road=${got.road} aborted=${String(got.aborted)} stops=${JSON.stringify(got.stops)}`,
    )
  }

  const src = (p: string): string => readFileSync(join(HERE, '..', '..', p), 'utf8')
  const prompt = src('src/components/PromptInput/useComposerRawKeys.ts')
  t.check(
    "the composer's esc on a viewed crewmate consumes interruptCrewmate and, on idle, exitCrewmateView (esc back to Mercury Lead)",
    /key\.escape[\s\S]{0,900}?interruptCrewmate\(viewed/.test(prompt) && /road === 'idle'\)\s*\{\s*exitCrewmateView\(/.test(prompt),
  )
  t.check(
    'dialog f/m routes local_agent rows through enterCrewmateView',
    /local_agent'\s*\)\s*\{[^}]*enterCrewmateView/s.test(src('src/components/tasks/BackgroundTasksDialog.tsx')),
  )
  t.check(
    'agent detail card owns the f/m → onForeground pair',
    /onForeground\?\:/.test(src('src/components/tasks/AsyncAgentDetailDialog.tsx')) &&
      /action="foreground"/.test(src('src/components/tasks/AsyncAgentDetailDialog.tsx')),
  )
  t.check(
    'footer pill + prompt gate + dialog list share isManageableTask',
    ['src/components/tasks/BackgroundTaskStatus.tsx', 'src/components/PromptInput/PromptInputFooterLeftSide.tsx', 'src/components/PromptInput/PromptInput.tsx', 'src/components/tasks/BackgroundTasksDialog.tsx'].every(
      p => src(p).includes('isManageableTask'),
    ),
  )
  const dialog = src('src/components/tasks/BackgroundTasksDialog.tsx')
  t.check(
    'the tasks dialog binds Escape itself (kill/foreground/detail dispatch per kind)',
    /useKeybindings\(\s*\{\s*'confirm:no': \(\) => \{[\s\S]{0,200}?onDone\(\)/.test(dialog) && dialog.includes("{ context: 'Confirmation', isActive: !inDetail }"),
  )
}

t.section('§4 journey: completed agent stays reachable through the tasks board')
{
  const ESC = String.fromCharCode(27)
  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'quick probe',
        prompt: 'Reply with one word.',
        subagent_type: 'mercury-crew',
        run_in_background: true,
      },
      preText: 'Spawning the quick probe.',
    },
    { kind: 'text', text: 'done.', whenSaid: 'Reply with one word.' },
    { kind: 'text', text: 'Probe finished.', whenBody: 'run the quick probe' },
    { kind: 'text', text: 'Noted.', whenBody: 'run the quick probe' },
    { kind: 'text', text: 'Spare.', whenBody: 'run the quick probe' },
    { kind: 'text', text: 'Spare 2.', whenBody: 'run the quick probe' },
  ]

  const LANDING = '[Crewmate] quick probe · completed'
  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:run the quick probe\\r',
      { awaitText: LANDING, afterPrevMs: 2500, text: '/tasks\r' },
      { awaitText: 'agent › quick probe', afterPrevMs: 2500, text: ESC },
    ],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
  })
  sendsDue(run, 4)

  const offsets = Array.from({ length: 47 }, (_, i) => String(S(6000 + i * 300)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran (§4)', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    keepFrames('tasks-board-120x40', screens)
    const has = (f: { rows: string[] } | undefined, needle: string | RegExp): boolean =>
      f !== undefined && f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const actedOn = (step: number): { atMs: number; rows: string[] } | undefined => {
      const record = run.sendLog.find(s => s.step === step && s.screen !== undefined)
      return record === undefined ? undefined : { atMs: Math.round(record.atMs), rows: record.screen! }
    }
    const tasksPress = actedOn(0)
    const escPress = actedOn(1)
    const settled = screens[screens.length - 1]

    t.check(
      'after completion the transcript carries the landing and nothing is open over it (the screen the /tasks press acted on)',
      has(tasksPress, LANDING) && has(tasksPress, 'run the quick probe') && !has(tasksPress, /agent › quick probe/) && !has(tasksPress, /Mercury — runs/),
      tasksPress === undefined ? 'the /tasks press has no receipt screen' : `pressed @${tasksPress.atMs}`,
    )

    t.check(
      "the tasks board still reaches the COMPLETED agent: its card opens with the settled state ('landed') and its esc back hint (the screen the esc acted on)",
      has(escPress, /agent › quick probe/) && has(escPress, /state\s+landed/) && has(escPress, /esc back/),
      escPress === undefined ? 'the esc press has no receipt screen' : `${escPress.rows.find(r => /state\s+landed/.test(r))?.trim().slice(0, 70) ?? 'no state row'} · pressed @${escPress.atMs}`,
    )

    t.check(
      'esc returned to main (the card gone, the transcript back with the landing on it) — the settled frame',
      escPress !== undefined && !has(settled, /agent › quick probe/) && !has(settled, /Mercury — runs/) && has(settled, 'run the quick probe') && has(settled, LANDING),
      settled === undefined ? 'no settled frame' : `settled frame @${settled.atMs}`,
    )
  }
  run.cleanup()
}


t.finish('prove-view-target-parity')

#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/prove-view-target-parity.ts — PO-1: ONE exhaustive
//  view-target projection powers header, prompt chrome, and return actions.
//
//  §1 PROJECTION — projectViewedAgent/getViewedAgent over synthetic states:
//     every viewable kind projects identity+state; the main-session task and
//     every NON_VIEWABLE kind project nothing; the classification lists are
//     closed over the task union (compile-time gate in selectors.ts) and
//     agree with getActiveAgentForInput.
//  §2 JOURNEY — packaged dist, real PTY: the drilled LOCAL agent now shows
//     the breadcrumb header (`Main ‹ @name · running · esc main`); the CREW
//     rail projects the permanent ROOT row (`✶ Mercury`) whose verb flips to
//     the accented `‹ main` return affordance while a child is viewed; a
//     two-click on the root RETURNS to main WITHOUT stopping the child
//     (PO-05's mouse return); the child row sits under the root.
//
//  §3 CENSUS (classes 12+2) — the manage surface (footer pill · ↓/shift+↓ ·
//     dialog list) shares ONE predicate that survives completion through the
//     linger window; esc has ONE grammar owned by getViewedEscAction, and the
//     breadcrumb hint renders the same classification the handler consumes.
//  §4 JOURNEY — a fast-completing agent: the footer still offers ↓-manage
//     after completion, Enter reaches the detail card, f foregrounds the
//     COMPLETED agent (the PO-10 reply-flow target), esc returns to main.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const {
  getActiveAgentForInput,
  getViewedAgent,
  getViewedEscAction,
  projectViewedAgent,
  NON_VIEWABLE_TASK_TYPES,
  VIEWABLE_TASK_TYPES,
} = await import('../../src/state/selectors.ts')
const { isManageableTask } = await import(
  '../../src/components/tasks/taskStatusUtils.tsx'
)
const { runPulseArena } = await import('../pulse/lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()

// ── §1 projection truths ────────────────────────────────────────────────────
t.section('§1 the projection is exhaustive and honest')
{
  const teammate = {
    type: 'in_process_teammate',
    id: 'tm-1',
    identity: { agentName: 'scout', color: 'blue' },
    prompt: 'map the estate',
    isIdle: false,
    status: 'running',
  } as never
  const localAgent = {
    type: 'local_agent',
    id: 'la-1',
    description: 'poise probe',
    status: 'running',
    agentType: 'general-purpose',
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

  const pt = projectViewedAgent(teammate, empty as never)
  t.check(
    'teammate projects kind/name/color/subtitle/state',
    pt?.kind === 'in_process_teammate' &&
      pt.name === 'scout' &&
      pt.color === 'blue' &&
      pt.subtitle === 'map the estate' &&
      pt.isWorking === true &&
      pt.statusLabel === 'working',
    JSON.stringify(pt && { kind: pt.kind, name: pt.name, statusLabel: pt.statusLabel }),
  )
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

  const idleTeammate = { ...(teammate as object), isIdle: true } as never
  t.check(
    'idle teammate label is honest',
    projectViewedAgent(idleTeammate, empty as never)?.statusLabel === 'idle',
  )
  const doneAgent = { ...(localAgent as object), status: 'completed' } as never
  const pd = projectViewedAgent(doneAgent, registry as never)
  t.check(
    'completed local agent projects completed + not working',
    pd?.statusLabel === 'completed' && pd.isWorking === false,
  )

  t.check(
    'classification lists are disjoint and non-empty',
    VIEWABLE_TASK_TYPES.length === 2 &&
      NON_VIEWABLE_TASK_TYPES.length === 5 &&
      !VIEWABLE_TASK_TYPES.some(v => (NON_VIEWABLE_TASK_TYPES as readonly string[]).includes(v)),
    `${VIEWABLE_TASK_TYPES.join(',')} | ${NON_VIEWABLE_TASK_TYPES.join(',')}`,
  )

  // Parity with the input router over the same states.
  const stateOf = (task: { id: string } | undefined): never =>
    ({
      viewingAgentTaskId: task?.id,
      tasks: task ? { [task.id]: task } : {},
      agentNameRegistry: registry,
    }) as never
  for (const [label, task, viewable] of [
    ['teammate', teammate, true],
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

// ── §2 the packaged journey ─────────────────────────────────────────────────
t.section('§2 journey: header + CREW root + mouse return')
{
  const ESC = String.fromCharCode(27)
  const sgrClick = (col: number, row: number): string =>
    `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`
  // With the permanent root, the probe row sits at screen row 7; root at 6.
  const ROOT_ROW = 6
  const CHILD_ROW = 7

  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'poise probe',
        prompt: 'Count to three slowly.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      preText: 'Spawning the probe agent.',
    },
    {
      kind: 'paced',
      deltas: Array.from({ length: 24 }, (_, i) => `count ${i + 1}. `),
      gapMs: 900,
    },
    { kind: 'text', text: 'Probe launched.' },
    { kind: 'text', text: 'Settled.' },
    { kind: 'text', text: 'Spare.' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      // ≥2.4s between state transitions: hosted runners boot and render
      // slower, and the first dispatch proved a click can land before the
      // row it targets has painted (drive clock ≠ send clock zeros).
      '2000:\\r',
      '6000:spawn the probe\\r',
      `10600:${sgrClick(10, CHILD_ROW)}`,
      `11300:${sgrClick(10, CHILD_ROW)}`, // drill the child
      `14600:${sgrClick(10, ROOT_ROW)}`,
      `15300:${sgrClick(10, ROOT_ROW)}`, // two-click the ROOT: return to main
    ],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
  })

  // Dense ladder + ORDERED content sequence (no fixed instants — the boot
  // lag between the send schedule and the drive clock varies per machine).
  const s2Offsets = Array.from({ length: 44 }, (_, i) => String(S(6000 + i * 300)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...s2Offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as {
      screens: { atMs: number; rows: string[] }[]
    }
    const frames = screens.filter(f => f.atMs !== -1)
    const has = (f: { rows: string[] }, needle: string | RegExp): boolean =>
      f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const idxOf = (start: number, pred: (f: { rows: string[] }) => boolean): number => {
      for (let i = Math.max(0, start); i < frames.length; i++) if (pred(frames[i]!)) return i
      return -1
    }

    // (1) at main, pre-drill: the permanent root wears `lead`, the child sits
    //     under it, nothing is viewed yet — row positions checked on the
    //     CONTENT-selected frame, never a clock-selected one.
    const iMain = idxOf(
      0,
      f =>
        f.rows.some(r => /Mercury.*lead/.test(r)) &&
        f.rows.some(r => r.includes('poise pro')) &&
        !has(f, 'viewing') &&
        !has(f, /Main ‹/),
    )
    t.check('at main, the root verb is lead (you are here)', iMain >= 0)
    const mf = frames[iMain] ?? { rows: [] as string[] }
    const rootIdx = mf.rows.findIndex(r => r.includes('Mercury') && /lead/.test(r))
    const childIdx = mf.rows.findIndex(r => r.includes('poise pro'))
    t.check(
      `CREW projects the root at row ${ROOT_ROW} and the child under it`,
      iMain >= 0 && rootIdx + 1 === ROOT_ROW && childIdx + 1 === CHILD_ROW,
      `root@${rootIdx + 1} child@${childIdx + 1}`,
    )

    // (2) strictly later: the drill entered the view — breadcrumb + return
    //     hint + the root's accented `‹ main` affordance, in ONE frame.
    const iView = idxOf(
      iMain + 1,
      f =>
        has(f, 'viewing') &&
        has(f, /Main ‹ @poise probe/) &&
        has(f, /esc.*main/i) &&
        f.rows.some(r => /Mercury.*‹ main/.test(r)),
    )
    t.check(
      'the drill shows breadcrumb + esc hint + the accented root return affordance',
      iMain >= 0 && iView > iMain,
      iView >= 0
        ? frames[iView]!.rows.find(r => r.includes('Main ‹'))?.trim().slice(0, 70)
        : 'no such frame after the main frame',
    )

    // (3) strictly later: the two-click root return lands back at main with
    //     the child STILL RUNNING (return ≠ stop).
    const iBack = idxOf(
      iView + 1,
      f =>
        !has(f, /Main ‹/) &&
        has(f, 'spawn the probe') &&
        f.rows.some(r => r.includes('poise pro') && r.includes('running')),
    )
    t.check(
      'two-click on the root returns to main WITHOUT stopping the child',
      iView >= 0 && iBack > iView,
      iBack >= 0
        ? frames[iBack]!.rows.find(r => r.includes('poise pro'))?.trim().slice(0, 50)
        : 'no main frame with the child running after the view frame',
    )
  }
  run.cleanup()
}

// ── §3 census classes 12 + 2: completion keeps the manage surface; ONE esc ──
t.section('§3 manage-visibility predicate + the one esc grammar')
{
  const la = (over: object): never =>
    ({
      type: 'local_agent',
      id: 'la-x',
      description: 'quick probe',
      status: 'running',
      agentType: 'general-purpose',
      pendingMessages: [],
      ...over,
    }) as never
  const tm = (over: object): never =>
    ({
      type: 'in_process_teammate',
      id: 'tm-x',
      identity: { agentName: 'scout', color: 'blue' },
      isIdle: false,
      status: 'running',
      ...over,
    }) as never

  // The manage surface (footer pill · ↓/shift+↓ · dialog list) shares ONE
  // predicate: running work plus completed panel agents inside their linger.
  const table: [string, never, boolean][] = [
    ['running agent', la({}), true],
    ['completed + retained (viewed)', la({ status: 'completed', retain: true }), true],
    ['completed inside the linger window', la({ status: 'completed', evictAfter: Date.now() + 30_000 }), true],
    ['completed past the linger deadline', la({ status: 'completed', evictAfter: Date.now() - 1 }), false],
    ['dismissed (evictAfter 0)', la({ status: 'completed', evictAfter: 0 }), false],
    ['completed teammate (not a panel row)', tm({ status: 'completed' }), false],
    ['main-session task never manageable once terminal', la({ status: 'completed', agentType: 'main-session', evictAfter: Date.now() + 30_000 }), false],
  ]
  for (const [label, task, want] of table) {
    t.check(`manageable: ${label} → ${want}`, isManageableTask(task) === want)
  }

  // ONE esc grammar: interrupt exactly when the viewed task is an in-process
  // teammate with a live abortable turn; return-to-main everywhere else —
  // including the idle running teammate where the old status-only branch
  // aborted an absent controller and swallowed the key.
  const escTable: [string, never, 'interrupt' | 'main'][] = [
    ['teammate mid-turn (live controller)', tm({ currentWorkAbortController: new AbortController() }), 'interrupt'],
    ['teammate running but idle (no controller)', tm({}), 'main'],
    ['teammate completed (even with a stale controller)', tm({ status: 'completed', currentWorkAbortController: new AbortController() }), 'main'],
    ['local agent running (delegated never-stop work)', la({}), 'main'],
    ['local agent completed', la({ status: 'completed' }), 'main'],
  ]
  for (const [label, task, want] of escTable) {
    t.check(`esc grammar: ${label} → ${want}`, getViewedEscAction(task) === want)
  }

  // The header hint and the handler consume the SAME classification — the
  // projection carries it verbatim for both viewable kinds.
  const reg = new Map<string, string>()
  t.check(
    'projection carries escAction verbatim (teammate mid-turn)',
    projectViewedAgent(tm({ currentWorkAbortController: new AbortController() }), reg as never)?.escAction === 'interrupt',
  )
  t.check(
    'projection carries escAction verbatim (local agent)',
    projectViewedAgent(la({}), reg as never)?.escAction === 'main',
  )

  // Wiring pins (the journey below observes the real path; these keep the
  // specific consumers from silently reverting to private predicates).
  const src = (p: string): string => readFileSync(join(HERE, '..', '..', p), 'utf8')
  t.check(
    'dialog f/m routes local_agent rows through enterTeammateView',
    /local_agent'\s*\)\s*\{[^}]*enterTeammateView/s.test(src('src/components/tasks/BackgroundTasksDialog.tsx')),
  )
  t.check(
    'agent detail card owns the f/m → onForeground pair',
    /onForeground\?\:/.test(src('src/components/tasks/AsyncAgentDetailDialog.tsx')) &&
      /action="foreground"/.test(src('src/components/tasks/AsyncAgentDetailDialog.tsx')),
  )
  // Re-cut at the stranded-estate walk: the inline teammate VIEW retired
  // with Law 9 (useBackgroundTaskNavigation navigated a view that no longer
  // exists); management lives whole in the footer pill + the tasks dialog,
  // which own kill/foreground/detail and bind Escape themselves.
  t.check(
    'footer pill + prompt gate + dialog list share isManageableTask',
    ['src/components/tasks/BackgroundTaskStatus.tsx', 'src/components/PromptInput/PromptInputFooterLeftSide.tsx', 'src/components/PromptInput/PromptInput.tsx', 'src/components/tasks/BackgroundTasksDialog.tsx'].every(
      p => src(p).includes('isManageableTask'),
    ),
  )
  t.check(
    'the tasks dialog binds Escape itself (kill/foreground/detail dispatch per kind)',
    src('src/components/tasks/BackgroundTasksDialog.tsx').includes('Escape is bound here'),
  )
}

// ── §4 journey: completion keeps ↓-manage → f foregrounds → esc returns ─────
t.section('§4 journey: completed agent stays reachable from the footer')
{
  const ESC = String.fromCharCode(27)
  const turns: ScriptedTurn[] = [
    {
      kind: 'tool_use',
      name: 'Agent',
      input: {
        description: 'quick probe',
        prompt: 'Reply with one word.',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      preText: 'Spawning the quick probe.',
    },
    { kind: 'text', text: 'done.' }, // the agent's own call — completes at once
    { kind: 'text', text: 'Probe finished.' }, // main post-tool turn
    { kind: 'text', text: 'Noted.' }, // completion-notification auto-turn
    { kind: 'text', text: 'Spare.' },
    { kind: 'text', text: 'Spare 2.' },
  ]

  const run = await runPulseArena({
    turns,
    sends: [
      '2000:\\r',
      '6000:run the quick probe\\r',
      `13000:${ESC}[B`, // ↓ — select the tasks pill (must exist POST-completion)
      `14000:${ESC}[B`, // ↓ again — open manage; one row ⇒ straight to the detail card
      // (Enter here would ALSO work, but jumps straight into the agent view —
      // footer:openSelected enters the first visible agent task directly.)
      '15200:f', // f — foreground the COMPLETED agent (the reply-flow target)
      `17200:${ESC}`, // esc — local agent view always returns to main
    ],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
  })

  // Content-conditioned SEQUENCE over a dense frame series — fixed-instant
  // grabs drift 300–800 ms against the send schedule under load (the s2
  // method card), so every law below is "a frame with X exists, strictly
  // after the frame with W" — never "the frame AT t shows X".
  const offsets = Array.from({ length: 36 }, (_, i) => String(S(9000 + i * 300)))
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran (§4)', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as {
      screens: { atMs: number; rows: string[] }[]
    }
    const has = (f: { rows: string[] }, needle: string | RegExp): boolean =>
      f.rows.some(r => (typeof needle === 'string' ? r.includes(needle) : needle.test(r)))
    const findFrom = (start: number, pred: (f: { rows: string[] }) => boolean): number => {
      for (let i = start; i < screens.length; i++) if (pred(screens[i]!)) return i
      return -1
    }

    // (1) post-completion main view: the pill + its keyboard affordance
    //     survive ('↓ manage' unselected · '↵ view tasks' when pre-selected),
    //     the CREW rail still lists the agent, no view/dialog open yet.
    const iPill = findFrom(
      0,
      f =>
        has(f, '1 local agent') &&
        has(f, /manage|view tasks/) &&
        has(f, 'quick pro') &&
        !has(f, /Main ‹/) &&
        !has(f, /agent › quick probe/),
    )
    t.check(
      'after completion the footer still offers the manage surface (CREW agrees)',
      iPill >= 0,
      iPill >= 0 ? `frame @${screens[iPill]!.atMs}` : 'no such frame in the series',
    )

    // (2) strictly later: the detail card is open for the COMPLETED agent and
    //     offers the f/m foreground pair.
    const iCard = findFrom(
      iPill + 1,
      f => has(f, /agent › quick probe/) && has(f, /foreground/) && has(f, /Completed/),
    )
    t.check(
      'the manage surface reaches the detail card offering foreground for the COMPLETED agent',
      iPill >= 0 && iCard > iPill,
      iCard >= 0 ? `frame @${screens[iCard]!.atMs}` : 'no card frame after the pill frame',
    )

    // (3) strictly later: f foregrounded it — breadcrumb with the honest
    //     completed state and the one esc grammar (esc main for local agents).
    const iView = findFrom(
      iCard + 1,
      f => has(f, /Main ‹ @quick probe/) && has(f, /completed/) && has(f, /esc.*main/i),
    )
    t.check(
      'f foregrounded the completed agent: breadcrumb + completed + esc main',
      iCard >= 0 && iView > iCard,
      iView >= 0
        ? screens[iView]!.rows.find(r => r.includes('Main ‹'))?.trim().slice(0, 70)
        : 'no breadcrumb frame after the card frame',
    )

    // (4) strictly later: esc returned to main (breadcrumb gone, transcript back).
    const iBack = findFrom(
      iView + 1,
      f => !has(f, /Main ‹/) && has(f, 'run the quick probe'),
    )
    t.check(
      'esc returned to main (breadcrumb gone, transcript back)',
      iView >= 0 && iBack > iView,
      iBack >= 0 ? `frame @${screens[iBack]!.atMs}` : 'no main frame after the view frame',
    )
  }
  run.cleanup()
}


t.finish('prove-view-target-parity')

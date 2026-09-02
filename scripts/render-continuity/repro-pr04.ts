#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/repro-pr04.ts — (D1) reproduction.
//
//  Journey (packaged TUI, 120x40):
//    1. MAIN view, empty prompt: press ← — the /manager keybinding. EXPECTED
//       (and asserted): the manager surface-index panel opens. esc closes it.
//       This is the in-run CONTRAST leg for.
//    2. Spawn a background local agent; drill into its transcript view via
//       the CREW rail row (mouse: first click selects, second activates).
//    3. In the agent view, while the agent streams:
//         · type the REGISTERED session command  /health   + Enter
//         · type the UNKNOWN slash command       /frobnicate + Enter
//         · press ← on the EMPTY prompt (the same /manager keybinding)
//
//  D1 at unfixed HEAD, asserted from the drive replay + captured bodies:
//    a. all three inputs paint as USER ROWS in the agent transcript;
//    b. the manager panel does NOT open in the agent view (contrast with 1);
//    c. none of the three ever reaches a model call (the agent's running
//       turn outlives the queue; pending guidance is never drained) — the
//       silent-loss shape feeding PO-3.
//
//  Exit 0 = journey conclusive (receipt written, either verdict).
//  Exit 2 = journey inconclusive (navigation drifted; fix constants).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPulseArena } from '../pulse/lib/pulseArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const RECEIPTS = join(HERE, 'receipts')

const ESC = String.fromCharCode(27)
const LEFT = `${ESC}[D`
const sgrClick = (col: number, row: number): string =>
  `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`

// CREW agent row position in the 120x40 arena (1-based SGR cells). Asserted
// against the pre-click frame below — layout drift fails loudly, never a
// silent mis-click.
const CREW_ROW = 6
const CREW_COL = 10

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
  // Agent call 1 — slow-paced so it stays RUNNING through the whole journey
  // (24 deltas x 900ms ~ 21.6s).
  {
    kind: 'paced',
    deltas: Array.from({ length: 24 }, (_, i) => `count ${i + 1}. `),
    gapMs: 900,
  },
  // Spares, consumed FIFO by whichever call arrives next (main post-tool,
  // any drained resume call, the task-notification auto-turn, ...).
  { kind: 'text', text: 'Probe launched.' },
  { kind: 'text', text: 'Acknowledged.' },
  { kind: 'text', text: 'Settled.' },
  { kind: 'text', text: 'Complete.' },
  { kind: 'text', text: 'Spare.' },
]

const run = await runPulseArena({
  turns,
  sends: [
    '2000:\\r', // take the splash deck
    `5000:${LEFT}`, // MAIN empty-prompt ← : manager panel must open
    `6600:${ESC}`, // close the manager panel
    '7600:spawn the probe\\r',
    `11000:${sgrClick(CREW_COL, CREW_ROW)}`, // click 1: select the CREW row
    `11700:${sgrClick(CREW_COL, CREW_ROW)}`, // click 2: activate -> drill
    '13000:/health\\r', // registered session command
    '14700:/frobnicate\\r', // unknown slash command
    `16500:${LEFT}`, // PR-05: agent-view empty-prompt ←
  ],
  seconds: 36,
  cols: 120,
  rows: 40,
  keep: true,
})

const grab = spawnSync(
  '/usr/bin/python3',
  [
    SCREENGRAB,
    run.paths.drive,
    '120',
    '40',
    '5900', // manager panel open (main)
    '7300', // manager closed
    '10800', // pre-click layout assert
    '12600', // post-drill: agent view
    '17600', // after all three agent-view inputs
    '-1', // settled end state
  ],
  { encoding: 'utf8' },
)
if (grab.status !== 0) {
  console.error(`screengrab failed: ${grab.stderr}`)
  process.exit(2)
}
const { screens } = JSON.parse(grab.stdout) as {
  screens: { atMs: number; rows: string[] }[]
}
const frame = (atMs: number): { atMs: number; rows: string[] } => {
  const f = screens.find(s => s.atMs === atMs)
  if (!f) throw new Error(`no frame @${atMs}`)
  return f
}

// ── Leg 1: main-view ← opens the manager (contrast baseline) ────────────────
const managerOpen = frame(5900)
// The surface index is a full panel; its distinctive chrome is discovered
// from THIS run's own frame, then asserted absent in agent-view frames.
const managerMarkerRow = managerOpen.rows.find(r => /manager|surface/i.test(r))
if (!managerMarkerRow) {
  console.error('INCONCLUSIVE: main-view ← did not open the manager panel; frame:')
  console.error(managerOpen.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}
const managerMarker = managerMarkerRow.trim().slice(0, 40)

// ── Navigation asserts ──────────────────────────────────────────────────────
const pre = frame(10800)
const crewIdx = pre.rows.findIndex(r => r.includes('poise pro'))
if (crewIdx === -1) {
  console.error('INCONCLUSIVE: no CREW row containing "poise pro" in pre-click frame')
  console.error(pre.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}
if (crewIdx + 1 !== CREW_ROW) {
  console.error(
    `INCONCLUSIVE: CREW row is screen row ${crewIdx + 1} (1-based), clicks went to ${CREW_ROW}.`,
  )
  process.exit(2)
}
const post = frame(12600)
if (!post.rows.some(r => r.includes('viewing'))) {
  console.error('INCONCLUSIVE: no "viewing" marker after the two-click drill; frame:')
  console.error(post.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}

// ── D1 oracles ──────────────────────────────────────────────────────────────
const after = frame(17600)
const rowPainted = (cmd: string): boolean =>
  after.rows.some(r => r.includes(`❯ ${cmd}`) || r.includes(`> ${cmd}`))
const healthRow = rowPainted('/health')
const frobRow = rowPainted('/frobnicate')
const managerRow = rowPainted('/manager')

const agentViewFrames = screens.filter(s => s.atMs >= 12600 || s.atMs === -1)
const managerPanelInAgentView = agentViewFrames.some(s =>
  s.rows.some(r => r.trim().startsWith(managerMarker)),
)

type Msg = { role: string; content: unknown }
const bodies = run.fixture.requests
  .map(r => r.body as { messages?: Msg[] } | null)
  .filter((b): b is { messages: Msg[] } => Boolean(b?.messages))
const userTextIncludes = (needle: string): boolean =>
  bodies.some(b =>
    b.messages.some(
      m =>
        m.role === 'user' &&
        (typeof m.content === 'string'
          ? m.content.includes(needle)
          : Array.isArray(m.content) &&
            m.content.some(
              (c: { type?: string; text?: string }) =>
                c?.type === 'text' && typeof c.text === 'string' && c.text.includes(needle),
            )),
    ),
  )
const deliveredHealth = userTextIncludes('/health')
const deliveredFrob = userTextIncludes('/frobnicate')
const deliveredManager = userTextIncludes('/manager')

const final = frame(-1)
const completed = bodies.some(b =>
  b.messages.some(
    m =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some(
        (c: { type?: string; text?: string }) =>
          c?.type === 'text' &&
          typeof c.text === 'string' &&
          c.text.includes('<task-notification>') &&
          c.text.includes('completed'),
      ),
  ),
)
const pendingGlyphAtEnd = final.rows.find(r => r.includes('⤳'))

// ── Receipt ─────────────────────────────────────────────────────────────────
const lines: string[] = []
const log = (s: string): void => {
  lines.push(s)
  console.log(s)
}
log('── PR-04/PR-05 (D1) journey receipt ──')
log(`main-view empty-prompt ← opened the manager panel: true (marker "${managerMarker}")`)
log(`crew row asserted at screen row ${crewIdx + 1}; drill entered agent view (viewing marker)`)
log('')
log('agent-view leg (agent streaming throughout):')
log(`  typed /health\\r     painted as agent-transcript user row: ${healthRow}`)
log(`  typed /frobnicate\\r painted as agent-transcript user row: ${frobRow}`)
log(`  empty-prompt ←      painted "/manager" user row (PR-05):   ${managerRow}`)
log(`  manager panel opened in agent view: ${managerPanelInAgentView}`)
log('')
log('delivery (captured /v1/messages bodies):')
log(`  /health reached a model call:     ${deliveredHealth}`)
log(`  /frobnicate reached a model call: ${deliveredFrob}`)
log(`  /manager reached a model call:    ${deliveredManager}`)
log(`  agent completed (task-notification observed): ${completed}`)
log(`  pending-queue glyph in final statusbar: ${pendingGlyphAtEnd ? pendingGlyphAtEnd.trim().slice(0, 80) : 'none'}`)

const reproduced =
  healthRow &&
  frobRow &&
  managerRow &&
  !managerPanelInAgentView &&
  !deliveredHealth &&
  !deliveredFrob &&
  !deliveredManager
log('')
log(
  reproduced
    ? 'D1 REPRODUCED: agent-view slash + keybinding input becomes agent conversation rows, ' +
        'executes nothing locally, and (queued during a running turn) never reaches the model.'
    : 'D1 shape differs from expectation — read the frames below.',
)

for (const s of screens) {
  lines.push(`\n════ screen @${s.atMs}ms ════`)
  lines.push(s.rows.filter(r => r.trim() !== '').join('\n'))
}
lines.push('\n── captured model call last-user summaries ──')
for (const b of bodies) {
  const lastUser = [...b.messages].reverse().find(m => m.role === 'user')
  const summary =
    typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content)
  lines.push(`messages=${b.messages.length} lastUser=${(summary ?? '').slice(0, 300)}`)
}

mkdirSync(RECEIPTS, { recursive: true })
writeFileSync(join(RECEIPTS, 'pr04-pr05-head-6fe78a3d.txt'), lines.join('\n'))
console.log('receipt: scripts/render-continuity/receipts/pr04-pr05-head-6fe78a3d.txt')
run.cleanup()
process.exit(0)

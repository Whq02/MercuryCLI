#!/usr/bin/env bun
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
  {
    kind: 'paced',
    deltas: Array.from({ length: 24 }, (_, i) => `count ${i + 1}. `),
    gapMs: 900,
  },
  { kind: 'text', text: 'Probe launched.' },
  { kind: 'text', text: 'Acknowledged.' },
  { kind: 'text', text: 'Settled.' },
  { kind: 'text', text: 'Complete.' },
  { kind: 'text', text: 'Spare.' },
]

const run = await runPulseArena({
  turns,
  sends: [
    '2000:\\r',
    `5000:${LEFT}`,
    `6600:${ESC}`,
    '7600:spawn the probe\\r',
    `11000:${sgrClick(CREW_COL, CREW_ROW)}`,
    `11700:${sgrClick(CREW_COL, CREW_ROW)}`,
    '13000:/health\\r',
    '14700:/frobnicate\\r',
    `16500:${LEFT}`,
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
    '5900',
    '7300',
    '10800',
    '12600',
    '17600',
    '-1',
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

const managerOpen = frame(5900)
const managerMarkerRow = managerOpen.rows.find(r => /manager|surface/i.test(r))
if (!managerMarkerRow) {
  console.error('INCONCLUSIVE: main-view ← did not open the manager panel; frame:')
  console.error(managerOpen.rows.filter(r => r.trim()).join('\n'))
  process.exit(2)
}
const managerMarker = managerMarkerRow.trim().slice(0, 40)

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

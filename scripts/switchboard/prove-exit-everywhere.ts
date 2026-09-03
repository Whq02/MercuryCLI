#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-exit-everywhere.ts — CTRL+C EVERYWHERE, ONE LAW
//  (ledger L22, the operator's own boot: "control c only works from the main
//  repl's composer … it should work anywhere in any of the screens, twice,
//  same rule as the main repl, show the warning in the bottom left").
//
//  Part 0 — the structural laws, read off the tree (no build needed):
//    · ONE owner (SurfaceExitChord) mounted in the route host AHEAD of the
//      surface subtree, counting ctrl+c by the REPL composer's own spelling
//      and NEVER consuming it; the notice painted after the subtree at the
//      bottom-left of the frame.
//    · ONE spelling of the notice in src (ExitChordNotice) — the REPL footer
//      and the owner paint the same component.
//    · the second press routes through the ONE graceful shutdown
//      (prompt_input_exit); POISON: a raw process.exit reachable from a
//      screen.
//    · the REPL composer keeps its own chord byte-for-byte (useTextInput),
//      and the concourse keeps its first-press meaning (a draft clears).
//
//  Part 1 — the chord FIRES on every route surface, on the built bundle
//  (vshot, hermetic scratch homes, the fixture board, a closed API port):
//    A  the boot face                 (bare boot)
//    B  the concourse with a DRAFT    (the first press clears it AND arms)
//    C  the concourse UNDER A CARD    (the key atlas — a modal never
//                                      imprisons the exit)
//    D  the split view                (140×40, the chat pane up)
//    E  the reduced stage             (--concourse-off, the live view)
//    F  the WINDOW LAPSE              (one press, a fresh draft typed, 3 s
//                                      pass: the notice is gone, the draft
//                                      SURVIVES — no local meaning re-fires
//                                      — and the process is alive)
//    H  the concourse under a CONSENT (the seat-overload card, a Select
//       card                           that owns its keys — "users get
//                                      blocked" made testable)
//    I  the concourse under a MANAGER (the interview card, armed from a
//       card                           pre-seeded conversation)
//    G  the main REPL, the control    (the arena: the existing chord, the
//                                      same words, byte-identical)
//  THE FIRST-PRESS LAW, pinned twice: leg B arms THROUGH a local handler
//  that stops propagation (the draft clear), leg F proves the lapse
//  disarms with nothing re-firing; legs C · H · I prove no card — help,
//  consent, manager — can swallow the chord.
//  The exit fact on the vshot legs is the rig's own: endReason 'eof' — the
//  child left the PTY after the second press; the lapse leg must NOT.
//  Every send is strictly gated on its needle (requireAwait) and every
//  post-send frame is a follow-up empty send with a mark (the rig snapshots
//  a mark BEFORE writing that send's bytes).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { vshotBudgetScale } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

// ── part 0: the structural laws ──────────────────────────────────────────────
console.log('part 0 — the structural laws')
const owner = read('src/components/SurfaceExitChord.tsx')
const router = read('src/components/SurfaceRouter.tsx')
const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
const textInput = read('src/hooks/useTextInput.ts')
const screen = read('src/components/concourse/ConcourseScreen.tsx')
const SPELLING = 'twice to close Mercury'

check("the owner counts ctrl+c by the REPL composer's own spelling and NEVER consumes the press",
  owner.includes("if (key.ctrl && input === 'c') press()") && !owner.includes('stopImmediatePropagation'))
check('the second press routes through the ONE graceful shutdown (prompt_input_exit)',
  owner.includes("gracefulShutdown(0, 'prompt_input_exit')"))
check("the chord rides the REPL's own window (EXIT_CHORD_WINDOW_MS through useDoublePress)",
  owner.includes('EXIT_CHORD_WINDOW_MS') && owner.includes('useDoublePress('))
check("ctrl+d is not this owner's key (it keeps its own rules where it has any)", !/input === 'd'/.test(owner))
const host = router.slice(router.indexOf('function RouteSurfaceHost'))
const iChord = host.indexOf('<SurfaceExitChord ')
const iChildren = host.indexOf('{children}')
const iNotice = host.indexOf('<SurfaceExitChordNotice ')
check('the owner mounts in the route host AHEAD of the surface subtree (registration order = dispatch order)',
  iChord > 0 && iChildren > iChord, `chord@${iChord} children@${iChildren}`)
check('the notice paints AFTER the surface subtree (later siblings paint on top)', iNotice > iChildren, `notice@${iNotice}`)
check('the REPL route mounts no host — the owner is structurally absent there (the REPL keeps its own chord)',
  router.includes('{entry ? (') && router.includes('<RouteSurfaceHost'))
const carriers = walk(join(REPO, 'src')).filter(f => readFileSync(f, 'utf8').includes(SPELLING)).map(f => relative(REPO, f))
check('ONE spelling of the notice in src (ExitChordNotice alone)',
  carriers.length === 1 && carriers[0] === 'src/components/PromptInput/ExitChordNotice.tsx', carriers.join(','))
check('the REPL footer paints that one component (its words byte-identical)',
  footer.includes('<ExitChordNotice keyName={exitKeyName} />') && !footer.includes(SPELLING))
check('the owner paints that one component too, sized from its own bytes',
  owner.includes('<ExitChordNotice keyName="Ctrl-C" />') && owner.includes('exitChordNoticeText('))
check('the notice sits at the bottom-left of the host viewport (absolute, last row, column 0, opaque)',
  owner.includes('position="absolute"') && owner.includes('top={Math.max(0, rows - 1)}') && owner.includes('left={0}') && owner.includes('opaque={true}'))
check('the REPL composer keeps its own chord (useTextInput: handleCtrlC over the same window, the notice through onExitMessage)',
  textInput.includes('const handleCtrlC = useDoublePress(') && textInput.includes("onExitMessage?.(show, 'Ctrl-C')") && textInput.includes('EXIT_CHORD_WINDOW_MS'))
check("the concourse's first-press meaning survives (a non-empty draft clears)",
  screen.includes("key.ctrl && input === 'c' && side.ref.current.text.length > 0"))
const screenFiles = [
  'src/components/SurfaceExitChord.tsx',
  'src/components/SurfaceRouter.tsx',
  'src/components/BootSplashScreen.tsx',
  'src/components/BootSettingsScreen.tsx',
  ...walk(join(REPO, 'src', 'components', 'concourse')).map(f => relative(REPO, f)),
]
const rawExits = screenFiles.filter(f => /process\.exit\(/.test(read(f)))
check('POISON: no raw process.exit reachable from a screen', rawExits.length === 0, rawExits.join(','))

// ── part 1: the chord fires on every route surface (the built bundle) ───────
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const { resolveCaptureDriver, captureEngineEntry } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') {
  console.error(`✗ no capture driver: ${driver.reason} — ${driver.remedy}`)
  process.exit(1)
}
const ENGINE = captureEngineEntry(driver, REPO)
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

const OUT_DIR = process.env.EXIT_EVERYWHERE_CAPTURE_DIR ?? join(tmpdir(), `exit-everywhere-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][] }
type Payload = Grid & { endReason: string; endedAtTick: number; marks?: ({ label: string } & Grid)[] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

interface Send {
  data: string
  awaitText?: string
  awaitSettleTicks?: number
  requireAwait?: boolean
  afterPrevTicks?: number
  mark?: string
}

const CTRL_C = '\x03'
const NOTICE = 'press ctrl+c twice to close Mercury'
const NOTICE_ROW = `  ${NOTICE}`

interface Capture {
  marks: Map<string, string[]>
  endReason: string
  final: string[]
}

function capture(tag: string, argv: string[], sends: Send[], opts: { cols: number; rows: number; total: number; env: Record<string, string> }): Capture {
  const out = join(OUT_DIR, `${tag}.json`)
  const cfgPath = join(OUT_DIR, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv, cwd: REPO, sends, total: opts.total, cols: opts.cols, rows: opts.rows, out }))
  const res = spawnSync(driver.python, [ENGINE, cfgPath], { encoding: 'utf8', timeout: 300_000, env: opts.env })
  if (res.status !== 0) {
    console.error(`✗ vshot (${tag}) failed: ${(res.stderr ?? '').slice(-800)}`)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
  const marks = new Map<string, string[]>()
  for (const m of payload.marks ?? []) {
    marks.set(m.label, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return { marks, endReason: payload.endReason, final: linesOf(payload) }
}
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const noticeBottomLeft = (lines: string[]): boolean => lines.length > 0 && lines[lines.length - 1]!.startsWith(NOTICE_ROW)
const noticeOnlyOnLastRow = (lines: string[]): boolean => lines.slice(0, -1).every(l => !l.includes(NOTICE))

// One scratch home per leg — a fresh onboarded, trusting home; the fixture
// board keeps the Tab ring deterministic (no needs-you rows).
function freshHome(tag: string, shape?: (fixture: ReturnType<typeof referenceFixtureSnapshot>) => void): { home: string; fixturePath: string } {
  const home = join(tmpdir(), `exit-everywhere-${process.pid}-${tag}-home`)
  rmSync(home, { recursive: true, force: true })
  seedFirstRun(home, [REPO])
  const fixture = referenceFixtureSnapshot()
  fixture.needsYou = []
  fixture.counts.needsYou = 0
  shape?.(fixture)
  const fixturePath = join(home, 'exit-everywhere-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  return { home, fixturePath }
}
function envFor(home: string, fixturePath: string | null): Record<string, string> {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: '',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREW_DIR: join(home, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  delete base.MERCURY_CONCOURSE
  delete base.MERCURY_CONCOURSE_FIXTURE
  if (fixturePath !== null) {
    base.MERCURY_CONCOURSE = 'always'
    base.MERCURY_CONCOURSE_FIXTURE = fixturePath
  }
  return base
}
// The armed frame + the second press: the same tail on every exiting leg.
const armThenExit: Send[] = [
  { data: '', requireAwait: true, awaitText: NOTICE, awaitSettleTicks: 1, mark: 'armed' },
  { data: CTRL_C, afterPrevTicks: 1 },
]

// ── A: the boot face ─────────────────────────────────────────────────────────
console.log('leg A — the boot face')
{
  const { home } = freshHome('face')
  const c = capture('A-face', ['node', BIN], [
    { data: CTRL_C, requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 4 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, null) })
  const armed = c.marks.get('armed') ?? []
  check('A: the first press arms — the notice paints bottom-left, the face still up', noticeBottomLeft(armed) && has(armed, 'New Session'))
  check('A: the notice lives on the last row alone', noticeOnlyOnLastRow(armed))
  check('A: the second press EXITS (the child left the PTY — endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── B: the concourse with a draft ────────────────────────────────────────────
console.log('leg B — the concourse with a draft (the first press clears it AND arms)')
{
  const { home, fixturePath } = freshHome('draft')
  const DRAFT = 'zq-draft-zq'
  const c = capture('B-draft', ['node', BIN], [
    { data: DRAFT, requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: CTRL_C, requireAwait: true, awaitText: DRAFT, awaitSettleTicks: 2 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const armed = c.marks.get('armed') ?? []
  check('B: the notice paints bottom-left on the board', noticeBottomLeft(armed) && has(armed, 'SESSIONS'))
  check("B: the first press kept its local meaning — the draft cleared (poison: the owner consuming the press)", !has(armed, DRAFT))
  check('B: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── C: the concourse under a card ───────────────────────────────────────────
console.log('leg C — the concourse under a card (the key atlas owns every key; the exit still fires)')
{
  const { home, fixturePath } = freshHome('card')
  const c = capture('C-card', ['node', BIN], [
    { data: '?', requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: CTRL_C, requireAwait: true, awaitText: 'COORDINATOR (its composer)', awaitSettleTicks: 2 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const armed = c.marks.get('armed') ?? []
  check('C: the atlas stands AND the notice paints bottom-left (a modal never imprisons the exit)',
    noticeBottomLeft(armed) && has(armed, 'COORDINATOR (its composer)'))
  check('C: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── D: the split view ────────────────────────────────────────────────────────
console.log('leg D — the split view (140×40)')
{
  const { home, fixturePath } = freshHome('split')
  const c = capture('D-split', ['node', BIN], [
    { data: '\t', requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: 's', afterPrevTicks: 3 },
    { data: CTRL_C, requireAwait: true, awaitText: 'FOCUSED CHAT', awaitSettleTicks: 3 },
    ...armThenExit,
  ], { cols: 140, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const armed = c.marks.get('armed') ?? []
  check('D: the split frame stands AND the notice paints bottom-left', noticeBottomLeft(armed) && has(armed, 'FOCUSED CHAT'))
  check('D: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── E: the reduced stage ─────────────────────────────────────────────────────
console.log('leg E — the reduced stage (--concourse-off: the face, then the live view)')
{
  const { home, fixturePath } = freshHome('reduced')
  const env = envFor(home, fixturePath)
  delete env.MERCURY_CONCOURSE // the switch off lands on the face; 'o' is the live view's door
  const c = capture('E-reduced', ['node', BIN, '--concourse-off'], [
    { data: 'o', requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 4 },
    { data: CTRL_C, requireAwait: true, awaitText: 'the concourse is off', awaitSettleTicks: 3 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env })
  const armed = c.marks.get('armed') ?? []
  check('E: the live view stands AND the notice paints bottom-left', noticeBottomLeft(armed) && has(armed, 'live view'))
  check('E: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── F: the window lapse ──────────────────────────────────────────────────────
console.log('leg F — the window lapse (one press never exits; the notice clears with the window; nothing re-fires)')
{
  const { home, fixturePath } = freshHome('lapse')
  const AFTER = 'zq-after-zq'
  const c = capture('F-lapse', ['node', BIN], [
    { data: CTRL_C, requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: '', requireAwait: true, awaitText: NOTICE, awaitSettleTicks: 1, mark: 'armed' },
    // A fresh draft typed INSIDE the armed window: the lapse must disarm
    // the chord without the local meaning (the draft clear) re-firing.
    { data: AFTER, afterPrevTicks: 1 },
    { data: '', afterPrevTicks: 22, mark: 'lapsed' },
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const lapsed = c.marks.get('lapsed') ?? []
  check('F: the first press armed (the notice painted)', noticeBottomLeft(c.marks.get('armed') ?? []))
  check('F: 4 s later the notice is gone (the window lapsed)', !has(lapsed, NOTICE))
  check('F: the draft typed inside the window SURVIVES the lapse (poison: the local clear re-firing on disarm)', has(lapsed, AFTER))
  check('F: the process is ALIVE — one press never exits (poison: an exit on the first press)', c.endReason !== 'eof' && has(c.final, 'SESSIONS'), c.endReason)
}

// ── H: the concourse under a CONSENT card ────────────────────────────────────
console.log('leg H — the concourse under a consent card (the seat-overload Select owns its keys; the exit still fires)')
{
  // The fixture's live count past the seeded ceiling (5): words sent from
  // the self-managed composer raise the seat-overload card before any
  // launch — a standing consent card, the operator's exact "blocked" case.
  const { home, fixturePath } = freshHome('consent', fixture => {
    fixture.counts.live = 9
  })
  const c = capture('H-consent', ['node', BIN], [
    { data: 'hello seat', requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: '\r', afterPrevTicks: 3 },
    { data: CTRL_C, requireAwait: true, awaitText: "Past the machine's reading", awaitSettleTicks: 3 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const armed = c.marks.get('armed') ?? []
  check('H: the consent card stands AND the notice paints bottom-left (a consent card never imprisons the exit)',
    noticeBottomLeft(armed) && has(armed, "Past the machine's reading"))
  check('H: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── I: the concourse under a MANAGER card ────────────────────────────────────
console.log('leg I — the concourse under a manager card (the interview card owns its keys; the exit still fires)')
{
  const { home, fixturePath } = freshHome('manager')
  // The conversation store's own envelope (fileStore: object-shaped stores
  // carry `_v`): one coordinator reply carrying an interview ask — the
  // card arms the moment the composer's shift+tab turns the mode on.
  writeFileSync(
    join(home, 'coordinator-conversation.json'),
    JSON.stringify({
      _v: 1,
      entries: [
        {
          id: 'co:seed-ask',
          role: 'coordinator',
          text: 'which stack?',
          ts: Date.now(),
          ask: { question: 'which stack?', options: ['bun', 'node'], index: 1 },
        },
      ],
    }),
  )
  const c = capture('I-manager', ['node', BIN], [
    { data: '\x1b[Z', requireAwait: true, awaitText: 'COORDINATOR', awaitSettleTicks: 4 },
    { data: CTRL_C, requireAwait: true, awaitText: 'enough — plan it', awaitSettleTicks: 3 },
    ...armThenExit,
  ], { cols: 120, rows: 40, total: 150, env: envFor(home, fixturePath) })
  const armed = c.marks.get('armed') ?? []
  check('I: the manager card stands AND the notice paints bottom-left (a manager card never imprisons the exit)',
    noticeBottomLeft(armed) && has(armed, 'enough — plan it') && has(armed, 'manager mode on'))
  check('I: the second press EXITS (endReason eof)', c.endReason === 'eof', c.endReason)
}

// ── G: the main REPL, the control (the existing chord, byte-identical) ──────
console.log('leg G — the main REPL (the control: the same words, the same exit)')
{
  const { runArtifactArena, grabScreens, firstOutputTs } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [{ kind: 'text', text: 'Spare.' }],
    // Both presses anchor on the ONE stable needle, 1100ms apart — inside
    // the 2s chord window. The notice-text anchor never ARMED: the REPL's
    // composer paints the notice as an ink DIFF over the hint row (cursor
    // jumps between changed segments), so the needle splits in the OUTPUT
    // STREAM even though the frame check reads it whole on the grid.
    // The two presses must land inside the chord's 3 s window in the product's
    // own clock: the gap is handed to the driver pre-divided by the stretch.
    sends: ['after:Type a prompt:1500:\x03', `after:Type a prompt:${1500 + Math.round(1100 / vshotBudgetScale())}:\x03`],
    seconds: 25,
    cols: 120,
    rows: 40,
    keep: true,
  })
  try {
    const t0 = firstOutputTs(run)
    const presses = run.sendLog
      .filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === CTRL_C)
      .map(s => s.sent)
      .sort((a, b) => a - b)
    check('G: both presses were sent', presses.length === 2, String(presses.length))
    const second = presses[1] ?? t0 + 5000
    const grabs = grabScreens(run, 120, 40, [Math.max(0, second - t0 - 300), -1])
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    check("G: the REPL's own notice stood before the second press (the same words)", text(grabs[0]!).includes(NOTICE))
    const lastTee = run.teeLines.length > 0 ? run.teeLines[run.teeLines.length - 1]!.ts : 0
    check('G: the process left well inside the budget after the second press (the existing exit)', lastTee > 0 && lastTee - second < 6000, `${lastTee - second}ms`)
    check('G: the final screen holds no composer (the chat is gone)', !text(grabs[1]!).includes('Type a prompt'))
  } finally {
    run.cleanup()
  }
}

console.log(failures === 0 ? '\nexit everywhere: GREEN' : `\nexit everywhere: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)

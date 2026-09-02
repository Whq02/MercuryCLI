#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-hold-takeover.ts — the launcher
//  hold → Ink takeover is a TRANSACTION on every boot surface.
//
//  The operator's grounded evidence:
//  on the Resume Session path the picker text sat inside dark word-sized
//  background slabs while the splash's atmospheric field stayed smooth, and
//  the surface ended mid-viewport with the stale "starting…" hold
//  frame beneath. Root: bare `--resume` rendered the picker INLINE while the
//  splash still held the alternate buffer — nothing consumed the hold, no
//  erase ever fired, and the inline writer (which by charter never erases)
//  punched default-ground glyph runs into the splash's explicit-bg gradient.
//
//  The fix (ResumeConversation.tsx): under a pending launcher hold the
//  interactive phases mount inside <AlternateScreen> — the outermost mount
//  consumes the hold and arms the atomic takeover erase, and the in-place
//  swap to <REPL> rides the NESTED alt-screen path (erase folded, no
//  exit/re-enter flash). These legs drive the BUILT BINARY in a real PTY
//  behind a faithful fake of the splash hold frame (full-viewport explicit
//  truecolor-bg gradient + brand + hint + parked SGR, the exact byte shape
//  of mercury-splash.mjs holdFrame) and assert on the pyte cell grid + the
//  raw byte tee:
//
//    L1  hold → picker: ZERO stale gradient cells, no hold text — the
//        takeover erase cleared every cell the picker didn't own.
//    L2  hold → cockpit (control): the REPL root path stays green.
//    L3  direct --resume (no hold): the inline charter is byte-honest —
//        no alt entry, no erase, no background cells (unchanged).
//    L4  hold → picker → select → cockpit: the whole journey stays inside
//        ONE alternate-screen session — the fake splash's ?1049h is the
//        only entry, there is NO ?1049l (no main-screen flash between
//        picker and cockpit), and the erase fired for both the takeover
//        and the nested swap.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const RUNTIME_CWD = (process.env.MERCURY_RENDER_CWD ?? REPO).normalize('NFC')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — seeded absent-only for RUNTIME_CWD by the ONE
// seeder (firstRunSeed.ts), so every leg boots past onboarding.
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))

const SCRATCH = join(tmpdir(), `spectra-hold-${process.pid}`)
mkdirSync(SCRATCH, { recursive: true })

if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — build first (bun run build.ts)')
  process.exit(1)
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── the faithful hold-frame painter (mercury-splash.mjs holdFrame shape) ────
// printf '\033…' only — the source never carries raw control bytes.
function holdScript(cols: number, rows: number, hermesArgs: string): string {
  return `#!/bin/bash
printf '\\033[?1049h\\033[?1007h\\033[?25l\\033[2J'
y=0
while [ "$y" -lt ${rows} ]; do
  g=$((42 + y % 6))
  printf '\\033[%d;1H\\033[48;2;19;%d;48m%*s' "$((y + 1))" "$g" ${cols} ''
  y=$((y + 1))
done
cy=$((${rows} / 2))
printf '\\033[%d;%dH\\033[48;2;19;44;48m\\033[38;2;221;68;68m (>_) \\033[38;2;238;231;217mMERCURY \\033[0m' "$cy" "$((${cols} / 2 - 7))"
printf '\\033[%d;%dH\\033[48;2;19;44;48m\\033[2m\\033[38;2;122;138;134mstarting…  (stuck? type: reset)\\033[0m' "$((cy + 2))" "$((${cols} / 2 - 20))"
printf '\\033[H\\033[38;2;9;22;26m\\033[48;2;9;22;26m\\033[?25l'
export MERCURY_ALT_HELD=1
exec node ${JSON.stringify(BIN)} ${hermesArgs}
`
}

type Cell = { c: string; bg: string }
type Grid = { grid: Cell[][] }

function runCapture(
  leg: string,
  opts: {
    argv: string[]
    sends?: Array<Record<string, unknown>>
    total: number
    cols?: number
    rows?: number
    tee?: boolean
    readyText?: string[]
    /** Pin the INLINE surface policy (MERCURY_FULLSCREEN=0) — the L3 leg
     *  proves the inline charter, and fullscreen is the product default. */
    inline?: boolean
  },
): { grid: Grid; text: string[]; tee: Buffer } {
  const gridPath = join(SCRATCH, `${leg}.grid.json`)
  const teePath = join(SCRATCH, `${leg}.tee.bin`)
  const cfg = {
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 44,
    total: opts.total,
    argv: opts.argv,
    sends: opts.sends ?? [],
    out: gridPath,
    cwd: RUNTIME_CWD,
    ...(opts.readyText ? { readyText: opts.readyText, stableTicks: 8 } : {}),
  }
  const cfgPath = join(SCRATCH, `${leg}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  // ONE home for the fixture writer AND the dist child (the render-tui law:
  // the child would otherwise resolve Mercury's own ~/.mercury home while the
  // prover stages fixtures under its own home — every staged session 404s).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    // The display animations every capture pins still (the critter's sway
    // and blink, its gaze and sleep, the header's live seconds, the live
    // glyphs): a settle gate reads the whole grid, and a recorded frame
    // must never land on an arbitrary animation phase.
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
  }
  delete env.VSHOT_ACTIVE
  // Ambient-state pin: a canonical MERCURY_FULLSCREEN would outrank the
  // compat '1' above at the splash/runtime pair decode. The inline leg pins
  // the policy off explicitly — unset means fullscreen (the default).
  delete env.MERCURY_FULLSCREEN
  if (opts.inline) env.MERCURY_FULLSCREEN = '0'
  if (opts.tee) env.VSHOT_TEE = teePath
  else delete env.VSHOT_TEE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { env, timeout: vshotBudgetMs(120_000), stdio: 'pipe' })
  if (res.status !== 0) {
    throw new Error(`vshot failed for ${leg}: ${res.stderr?.toString().slice(-400)}`)
  }
  const grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
  const text = grid.grid.map(row => row.map(c => c.c).join(''))
  const tee = opts.tee && existsSync(teePath) ? readFileSync(teePath) : Buffer.alloc(0)
  return { grid, text, tee }
}

/** Cells still carrying the fake splash gradient (48;2;19;42-47;48 → 132a30…132f30). */
function staleGradientCells(grid: Grid): number {
  let n = 0
  for (const row of grid.grid) for (const c of row) if (/^132[a-f]30$/.test(c.bg)) n++
  return n
}

function teeBytes(tee: Buffer): Buffer {
  // frames: >II (tick, len) + raw bytes
  const chunks: Buffer[] = []
  let off = 0
  while (off + 8 <= tee.length) {
    const len = tee.readUInt32BE(off + 4)
    off += 8
    chunks.push(tee.subarray(off, off + len))
    off += len
  }
  return Buffer.concat(chunks)
}

function count(hay: Buffer, needle: string): number {
  let n = 0
  let i = 0
  const nb = Buffer.from(needle, 'latin1')
  for (;;) {
    i = hay.indexOf(nb, i)
    if (i < 0) return n
    n++
    i += nb.length
  }
}

// ── the run-unique resume fixture (concurrent-capture safe by nonce) ────────
const NONCE = `spectra rehearsal ${process.pid.toString(16)}`
const FIX_SID = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
function writeFixture(): void {
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: FIX_SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const lines = [
    base({
      parentUuid: null,
      type: 'user',
      uuid: '00000000-0000-4000-8000-00000000e001',
      message: { role: 'user', content: NONCE },
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-00000000e001',
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-00000000e002',
      requestId: 'req_spectra_1',
      message: {
        id: 'msg_spectra_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'acknowledged.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-06-19T12:00:02.000Z',
    }),
  ]
  mkdirSync(PROJECTS, { recursive: true })
  // The session file holds RECORD lines — the shape the picker's select
  // resumes (a raw entry file is refused, and the L4 journey never reaches
  // its cockpit).
  writeFileSync(join(PROJECTS, `${FIX_SID}.jsonl`), encodeSeedTranscript(lines, FIX_SID))
}
function cleanupFixture(): void {
  try {
    rmSync(join(PROJECTS, `${FIX_SID}.jsonl`))
  } catch {
    /* gone */
  }
}

console.log('launcher-hold takeover transaction (built binary, PTY + cell grid)')
try {
  // Stage the fixture for EVERY leg (CI-portability, the verify-
  // finding): a fresh HOME must still show a non-empty picker with the
  // "Mercury · resume" header. The config home was seeded by resolveProofHome
  // above (absent-only — a real home is never touched).
  writeFixture()

  // L0 — POSITIVE CONTROL for the stale-gradient detector:
  // the fake hold painter alone (no takeover) must land its gradient in the
  // pyte grid as exactly the bg strings staleGradientCells matches — a
  // vshot/pyte encoding change would otherwise silently defang L1/L2 into
  // vacuous 0 === 0.
  {
    const sh = join(SCRATCH, 'hold-only.sh')
    writeFileSync(sh, holdScript(120, 44, '').replace(/export MERCURY_ALT_HELD=1\nexec node .*\n/, 'sleep 3\n'), {
      mode: 0o755,
    })
    const { grid, text } = runCapture('l0', { argv: ['bash', sh], total: 25 })
    const stale = staleGradientCells(grid)
    check('L0 control: the hold painter alone yields detectable gradient cells', stale > 4000, `${stale} cells`)
    check('L0 control: the hold text is on screen pre-takeover', text.some(l => l.includes('starting…')))
  }

  // L1 — hold → resume picker: the takeover must clear every stale cell.
  {
    const sh = join(SCRATCH, 'hold-picker.sh')
    writeFileSync(sh, holdScript(120, 44, '--resume'), { mode: 0o755 })
    const { grid, text } = runCapture('l1', { argv: ['bash', sh], total: 70, readyText: ['Mercury · resume'] })
    check('L1 picker paints (Mercury · resume header present)', text.some(l => l.includes('Mercury · resume')))
    const stale = staleGradientCells(grid)
    check('L1 ZERO stale hold-gradient cells after takeover', stale === 0, `${stale} cells still carry the hold bg`)
    check('L1 no stale hold text beneath the picker', !text.some(l => l.includes('starting…')))
  }

  // L2 — hold → cockpit (control): the REPL root path stays green. The
  // landing rule lands a bare boot on the Boot face — the face-↵ prelude
  // enters New Session, then the chat's own hint line is the ready gate.
  {
    const sh = join(SCRATCH, 'hold-repl.sh')
    writeFileSync(sh, holdScript(120, 44, ''), { mode: 0o755 })
    const { grid, text } = runCapture('l2', {
      argv: ['bash', sh],
      total: 70,
      sends: [{ atTick: 999, awaitText: 'New Session', minTick: 8, awaitSettleTicks: 4, awaitStableTicks: 3, data: '\r', mark: 'face' }],
      readyText: ['? for shortcuts'],
    })
    const stale = staleGradientCells(grid)
    check('L2 cockpit control: zero stale hold-gradient cells', stale === 0, `${stale} cells`)
    check('L2 cockpit control: no stale hold text', !text.some(l => l.includes('starting…')))
  }

  // L3 — direct --resume, INLINE policy pinned (no hold): the inline
  // charter stays byte-honest. Fullscreen is the product default, so the
  // leg pins MERCURY_FULLSCREEN=0 — the explicitly-inline picker is the
  // surface whose charter forbids alt entry and erases.
  {
    const { grid, text, tee } = runCapture('l3', {
      argv: ['node', BIN, '--resume'],
      total: 70,
      tee: true,
      readyText: ['Mercury · resume'],
      inline: true,
    })
    const raw = teeBytes(tee)
    check('L3 direct picker paints inline', text.some(l => l.includes('Mercury · resume')))
    check('L3 direct picker never enters the alt screen', count(raw, '\x1b[?1049h') === 0)
    check('L3 direct picker never erases (inline charter)', count(raw, '\x1b[2J') === 0)
    // LUSTRE L2: the inline charter admits EXACTLY the selection
    // band — the picker's selected row wears tokens.selectionBand (ONE color,
    // ONE row) even inline; anything else (a second color, a second row, a
    // ground slab) stays RED. The pre-LUSTRE law was bgCells === 0.
    const bgCells = grid.grid.flat().filter(c => c.bg !== 'default')
    const bgColors = new Set(bgCells.map(c => c.bg))
    const bgRows = new Set<number>()
    grid.grid.forEach((row, y) => {
      if (row.some(c => c.bg !== 'default')) bgRows.add(y)
    })
    check(
      'L3 direct picker paints no background BEYOND the selection band (≤1 color · ≤1 row)',
      bgColors.size <= 1 && bgRows.size <= 1,
      `${bgCells.length} bg cells · ${bgColors.size} colors · ${bgRows.size} rows`,
    )
  }

  // L4 — hold → picker → select → cockpit: ONE alt-screen session end to end.
  {
    const sh = join(SCRATCH, 'hold-journey.sh')
    writeFileSync(sh, holdScript(120, 44, '--resume'), { mode: 0o755 })
    const { text, tee } = runCapture('l4', {
      argv: ['bash', sh],
      total: 160,
      tee: true,
      sends: [
        { atTick: 60, awaitText: 'Mercury · resume', minTick: 10, data: NONCE },
        // The pid-nonce filters the list to exactly the prover's own fixture
        // (settle ticks let the filtered row paint under the cursor). The
        // FIRST ↵ exits the search field (useSearchInput's onExit contract);
        // the SECOND selects the focused row.
        { atTick: 100, awaitText: NONCE, minTick: 14, awaitSettleTicks: 6, data: '\r' },
        { atTick: 110, afterPrevTicks: 4, data: '\r' },
      ],
      readyText: ['? for shortcuts'],
    })
    const raw = teeBytes(tee)
    check('L4 journey reaches the cockpit', text.some(l => l.includes('? for shortcuts')))
    check(
      'L4 the fake splash owns the ONLY alt entry (Mercury adds none)',
      count(raw, '\x1b[?1049h') === 1,
      `${count(raw, '\x1b[?1049h')} entries`,
    )
    check(
      'L4 no main-screen flash between picker and cockpit (zero ?1049l)',
      count(raw, '\x1b[?1049l') === 0,
      `${count(raw, '\x1b[?1049l')} exits`,
    )
    // The tee records the WHOLE PTY stream, so the fake splash's own 2J is
    // erase #1: takeover = #2, the nested picker→REPL swap
    // = #3. The ≥3 threshold is what actually pins BOTH product erases.
    const erases = count(raw, '\x1b[2J')
    check('L4 the erase fired for takeover AND nested swap (≥3 incl. the fixture 2J)', erases >= 3, `${erases} erases`)
    check('L4 no stale hold text in the final cockpit', !text.some(l => l.includes('starting…')))
  }
} finally {
  cleanupFixture()
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} HOLD-TAKEOVER PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL HOLD-TAKEOVER PROOFS PASS')

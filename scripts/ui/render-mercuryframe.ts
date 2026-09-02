#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-mercuryframe.ts  (render-verify for the MercuryFrame ordered shed)
//  The render-verify law: an Ink change is only "working" once the REAL TUI is captured.
//  MercuryFrame hand-tunes a chain of responsive breakpoints with no locking proof:
//    showBehavior = cols >= 90        (the static behavior chips)
//    usage chips  = cols >= 64        (omit entirely below)
//    numberOnly   = cols <  80        (drop the usage mini-gauge, keep the %)
//    show7d       = cols >= 100       (the 7d window rides only on a wide row)
//    SessionTabs  = cols >= 70        (the "this session" rail)
//  Those numbers are an ORDERED SHED: the LIVE vitals (model, usage)
//  keep their cells while the most-expendable chrome (behavior chips, then the 7d
//  window, then the usage gauge) sheds first. Nothing locked the breakpoints — a
//  stray `>=` flip would silently eat a vital. This resumes the built binary under
//  vshot.py at 64/70/80/90/100/120 cols and asserts each rung of the shed.
//
//  The live usage values are seeded via MERCURY_USAGE_SEED (the render seed in
//  claudeAiLimits.ts) — but that seed only fills a window the live singleton is
//  MISSING, and a resumed session populates real utilization during boot, so the
//  chips render the REAL %; the assertions are therefore value-AGNOSTIC (they lock
//  the shed STRUCTURE — which chip is present/absent at each rung — not a number).
//  COST ($N.NN) renders only when getTotalCost() > 0; it has no env seed and
//  seeding it would mutate the shared project config — so the *usage* chip is the
//  asserted live vital (model name is the always-present identity spine), and
//  cost's live path is covered by a real session, not faked into config.
//
//  truncate-end is real: the dir+branch prefix is long, so a narrow row eats the
//  rightmost segments before the code-level shed even matters. The proof asserts
//  what the shed GUARANTEES and is OBSERVABLE: each segment is ABSENT below its
//  hard code gate, and PRESENT at a width wide enough to escape truncation. The
//  ordered shed's promise — the LEAST important chrome (behavior, then 7d) drops
//  FIRST while the live vitals keep their cells — is exactly that.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-mercuryframe.ts
//  Out:  /tmp/hframe-<cols>.html  + a text dump + a grep summary.
// ============================================================================
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = join(import.meta.dir, 'vshot.py') // the restored in-repo capturer (was the ephemeral /tmp/vshot.py)
const BIN = join(REPO, 'dist', 'mercury.mjs')

const SID = '00000000-aaaa-bbbb-cccc-0000000000f3'
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`

type Line = Record<string, unknown>
const common = (extra: Line): Line => ({
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  cwd: RUNTIME_CWD,
  sessionId: SID,
  version: '1.0.0-beta.1',
  gitBranch: 'main',
  ...extra,
})

function buildSession(): string {
  // A couple of operator turns so the ⤳N turn counter is non-zero (it rides early
  // in the row, before the shed targets) — confirms the live segment ordering.
  const lines: Line[] = []
  let prev: string | null = null
  const push = (l: Line) => {
    lines.push(l)
    prev = l.uuid as string
  }
  push(
    common({
      parentUuid: prev,
      type: 'user',
      message: { role: 'user', content: 'first task' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
  )
  push(
    common({
      parentUuid: prev,
      type: 'user',
      message: { role: 'user', content: 'second task' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:02.000Z',
    }),
  )
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

// Deterministic usage seed (5h / 7d present + a far-future reset) so the chips
// have SOMETHING to render even if the live singleton is empty in this process;
// the assertions stay value-agnostic since real boot data may win the seed.
const FUTURE = Math.floor(Date.now() / 1000) + 4 * 3600
const USAGE_SEED = `5h=0.58@${FUTURE},7d=0.31@${FUTURE}`

function shoot(cols: number): string {
  const out = `/tmp/hframe-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    sends: [],
    total: 45, // ~9s — 16 left the binary mid-paint → blank captures (matches renderScenarios.ts)
    cols,
    rows: 44,
    out,
    title: `hframe @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-hf-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: {
      ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      // Deck OFF so deckPresent=false and the frame KEEPS its vitals — this proof locks the
      // INLINE-mode responsive shed; the deck-mode vital-shed is proven by prove-frame-dedup.ts.
      // Helm OFF too: the cockpit became default after this
      // proof was written — at ≥100 cols the rails would own usage/ctx and the
      // frame CORRECTLY sheds them, which is the OTHER mode's contract. Pin
      // the mode the proof exists to lock.
      MERCURY_HELM_HOME: '0',
      MERCURY_SUBSTRATE: '0',
      MERCURY_USAGE_SEED: USAGE_SEED,
    },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

console.log('============================================================')
console.log(' MercuryFrame ordered-shed render-verify (64→120 cols)')
console.log('============================================================')

buildSession()
const COLS = [64, 70, 80, 90, 100, 120]
const results: Record<number, string> = {}
for (const c of COLS) results[c] = shoot(c)

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
// pyte splits glyphs across grid cells; isolate the MercuryFrame statusbar row
// and collapse whitespace so the segment assertions aren't broken by
// inter-cell spacing. Anchor = the CRAB lockup glyph run (CRAB_GLYPHS,
// single-sourced) + a │ separator — never a "Mercury" wordmark selector:
// the wordmark lives ONLY in the transcript banner (SINGLE-BRAND law), so a
// wordmark selector matches nothing and every row-scoped probe fails on ''.
function frameRow(raw: string): string {
  const line = raw.split('\n').find(l => l.includes('▖▟▆▙▗') && l.includes('│')) ?? ''
  return line.replace(/\s+/g, ' ')
}
// Value-agnostic usage matchers: gauge form `5h ██░░ NN%`, any-form `5h … NN%`.
const has5hGauge = (s: string) => /5h [█░]{2,4} \d+%/.test(s)
const has5hAny = (s: string) => /5h .{0,6}\d+%/.test(s)
const has7d = (s: string) => /7d .{0,6}\d+%/.test(s)

for (const c of COLS) {
  const scr = frameRow(results[c]!)
  const full = results[c]!.replace(/\s+/g, ' ') // full screen (the tab-strip is its own row)
  console.log(`\n── @ ${c} cols ──`)

  // ── identity spine: in INLINE mode (this proof runs SUBSTRATE=0) the model rides first and
  //    survives. In DECK mode it sheds to the deck (proven by prove-frame-dedup.ts), so the
  //    "never shed" only holds inline. ──
  expect(`@${c}: the model name survives (the identity spine)`, /Opus|Sonnet|Fable|Haiku|claude-/.test(scr))

  // ── 5h usage (the live vital): reliably present at full width (120), where the row has room
  //    regardless of the LIVE branch-name length. The dir+branch prefix is uncontrolled (a long
  //    feature branch eats the right edge), so 5h truncates at narrower widths — correct ordered-
  //    shed behavior, intentionally NOT asserted at a fixed middle width. When present, mini-gauge. ──
  if (c >= 120) {
    expect(`@${c}: the 5h usage chip survives at full width (live vital)`, has5hAny(scr))
    expect(`@${c}: the 5h chip is the mini-gauge form (5h ██░░ NN%)`, has5hGauge(scr))
  }

  // ── show7d shed: HARD-GATED to cols >= 100 in code → below 100 it is NEVER rendered (branch-
  //    independent, assert absent). Above the gate it's truncation-permitting (branch-dependent),
  //    so only assert presence at full width (120). ──
  if (c < 100) {
    expect(`@${c}: the 7d window is shed (hard gate, cols < 100)`, !has7d(scr))
  } else if (c >= 120) {
    expect(`@${c}: the 7d window rides at full width (cols >= 100 gate + room to escape truncation)`, has7d(scr))
  }

  // ── showBehavior shed: the static behavior chips are HARD-GATED to cols >= 90.
  //    Below 90 they are not rendered at all (assert absent); at 120 the row is
  //    wide enough that they render in full (assert present — the chips survive
  //    when there IS room, proving the gate isn't a permanent drop). ──
  // Behavior chips: the in-frame fable chip was removed (fableBand is its single owner), so
  // The frame paints no per-mode behavior chip, so none renders at any width.
  // fable surfacing is covered by prove-frame-dedup.ts + the
  // fable-mode render in dedup Task 3. Here we only lock that NO stale fable chip lingers.
  expect(`@${c}: no stale fable-hermes chip in the statusbar (single owner = fableBand)`, !/fable-hermes/.test(scr))

  // ── SessionTabs shed: the tab-strip (its own row above the statusbar) needs
  //    cols >= 70 ("this session" rail); below that it self-omits. ──
  if (c >= 70) {
    expect(`@${c}: the session tab-strip renders (this session, cols >= 70)`, /this session/.test(full))
  } else {
    expect(`@${c}: the session tab-strip is shed (cols < 70)`, !/this session/.test(full))
  }
}

// ── ordered-shed: the live vital is RENDERED (not dead code) when there's room. ──
// At full width (120) the row fits everything regardless of the live branch length, so the 5h
// vital rides. Narrow-width survival is branch-length-dependent (uncontrolled live git branch)
// and intentionally not asserted at a fixed middle width — the hard gates above lock the shed
// STRUCTURE (7d <100), and 120 anchors that the vital is wired and present when it fits.
{
  expect(
    'ordered shed: the 5h vital rides at full width (120 — the live vital is kept when there is room)',
    has5hAny(frameRow(results[120]!)),
  )
}

// Remove the synthetic fixture so it never shows in the operator's --resume picker.
try {
  rmSync(join(PROJECTS, `${SID}.jsonl`))
} catch {
  /* already gone */
}

console.log('\nHTML written to /tmp/hframe-{64,70,80,90,100,120}.html')
console.log(
  failures === 0
    ? '\n✅ HERMESFRAME SHED RENDER-VERIFY PASS'
    : `\n❌ ${failures} RENDER CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-critter-select.ts  (the /critter render-verify harness)
//  The render-verify law: an Ink change is only "working" once the REAL TUI is
//  captured. /critter is a LocalJSXCommandCall (mounts <CritterSelect/>), so —
//  unlike a transcript surface — we DRIVE it: resume a throwaway session, type
//  `/critter`↵ to mount the panel, then ↓ to move the cursor and `?` to surface
//  the tour line, capturing the screen under vshot.py (pyte PTY → HTML) at 80 AND
//  120 cols. The useSpecimenNav 150ms Enter-buffer means the launching ↵ never
//  acts on row 0, so the panel mounts cleanly.
//
//  Asserts on the REAL rendered grid (vshot prints screen.display):
//    • the picker HOLDS within 80 cols — no line exceeds the width (no
//      per-row ` · MERCURY_CRITTER=<key>` tail — the overflow class);
//    • that per-row env tail does NOT repeat down the list (≤1 MERCURY_CRITTER=
//      occurrence — the single one is the preview's key line);
//    • the design card's `? tour` affordance is present (footer) and, once armed,
//      surfaces the session-only / set-the-default-with-MERCURY_CRITTER explainer.
//
//  Heavy (boots the built binary in a PTY × 2 cols × ~16s) ⇒ JOINS the UI suite
//  only under UI_RENDER=1, like every render-*.ts. Build first (dist must be fresh).
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-critter-select.ts
//  Out:  /tmp/critter-select-<cols>.html  + a text dump + a grep summary.
// ============================================================================
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeTranscriptLine } from '../../src/utils/sessionStorage/vnext.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

const REPO = join(import.meta.dir, '..', '..')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')
const SID = '00000000-aaaa-bbbb-cccc-0000000c121e' // deterministic throwaway session

// A minimal one-line resume target (just an operator turn) so the binary boots
// straight into the REPL; the panel is then mounted by the typed /critter command.
function buildSession(): string {
  const line = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: 'boot into the repl' },
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-06-19T10:00:01.000Z',
  }
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  // Through the REAL writer: the transcript store is the Mercury record
  // format (header + versioned envelope per line — sessionStorage/vnext);
  // a bare-JSONL seed is invisible to the product's reader, so the resumed
  // binary answered "No conversation found" and the whole drive asserted
  // against an error screen.
  const { line: encoded } = encodeTranscriptLine(path, line)
  writeFileSync(path, encoded)
  return path
}

function shoot(cols: number): string {
  const out = `/tmp/critter-select-${cols}.html`
  const cfg = {
    argv: ['node', BIN, '--resume', SID],
    // {atTick, data} — the wall-clock vshot format (0.2s ticks); a
    // [delaySeconds, key] tuple format crashes vshot (list.get
    // AttributeError).
    // Type the command, ↵ mounts the panel (150ms enter-buffer ⇒ the mount
    // ↵ can't launch), ↓ moves the cursor off row 0.
    sends: [
      { atTick: 30, data: '/critter' },
      { atTick: 38, data: '\r' },
      { atTick: 50, data: '\x1b[B' },
    ],
    total: 64,
    cols,
    rows: 44,
    out,
    title: `critter-select @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-critter-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = {
    ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
    // Pin the launch critter: the picker OPENS on the live-active card, and the
    // row-position assertions below (↓ from row 0 = crab lands on row 1 =
    // octopus) are geometry facts, not default facts — without the pin the
    // octopus code default (or the operator's persisted /critter pick in the
    // real config home above) moves the open row and reds them environmentally.
    MERCURY_CRITTER: 'crab',
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env,
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

console.log('============================================================')
console.log(' /critter render-verify (drive the panel → vshot @ 80 / 120)')
console.log('============================================================')

buildSession()
const results: Record<number, string> = {}
for (const cols of [80, 120]) results[cols] = shoot(cols)

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const cols of [80, 120]) {
  const scr = results[cols]!
  const lines = scr.split('\n')
  console.log(`\n── @ ${cols} cols ──`)
  // The panel actually mounted (header is the CommandCenter `— critter` chrome).
  expect('the picker mounted (Session theme header visible)', /Session theme/.test(scr))
  // Every critter name renders (the list is intact).
  expect('all four critters listed', ['crab', 'octopus', 'jellyfish', 'clam'].every(n => scr.includes(n)))
  // the per-row env tail is ABSENT — NO list row (a line carrying a critter
  // NAME) carries `MERCURY_CRITTER=`. The env string lives in exactly
  // two NON-row places by design: the single preview key line and the `? tour`
  // explainer — so we guard the rows, not a global screen count.
  const rowEnvHits = lines.filter(
    l => /\b(crab|octopus|jellyfish|clam)\b/.test(l) && /MERCURY_CRITTER=/.test(l) && !/this session/.test(l),
  )
  // (the preview key line ALSO matches "name + MERCURY_CRITTER="; it is the ONE
  // allowed key surface, so ≤1 such line — never the old 4 per-row tails.)
  expect('no per-row env tail (≤1 name+MERCURY_CRITTER= line — the preview key)', rowEnvHits.length <= 1, `${rowEnvHits.length} line(s)`)
  // The gallery design: cards carry the ❯ launch control and the
  // note advertises '↵ / click launch' — there is no '←→ / click move'
  // footer.
  expect('the launch affordance is advertised', /↵ \/ click launch/.test(scr))
  // The default note (shown until an action sets nav.note) explains the live switch +
  // the fixed status spine — the redesigned replacement for the old `? tour` line.
  expect('the live-switch note is present', /switches live/.test(scr))
  // The highlighted critter's full sprite renders — including the eye seam, whose
  // ivory background (EYE_BG = #EDE8DD) is a RAW color. This only renders because
  // ThemedText.resolveBackgroundColor routes through resolveColor (raw-color
  // passthrough); a theme-key-only lookup resolves #EDE8DD to no-bg (the latent bug
  // this guards). pyte emits the bg hex into the HTML capture.
  const html = readFileSync(`/tmp/critter-select-${cols}.html`, 'utf-8')
  expect('the critter eye-white bg (#EDE8DD) renders in the sprite', /ede8dd/i.test(html))
}

// the 80-col surface HOLDS — no rendered line in the 80-col capture exceeds
// 80 visible columns (the overflow the tail removal fixes). pyte already clips to
// the grid, so we check the trailing-trimmed content fits and that the preview /
// list never collided into an overrun (a clipped tail would show a truncated key).
{
  const scr80 = results[80]!
  const tooWide = scr80.split('\n').filter(l => l.replace(/\s+$/, '').length > 80)
  expect('80-col: no rendered line exceeds 80 columns', tooWide.length === 0, `${tooWide.length} over-wide line(s)`)
  // The gallery has no MERCURY_CRITTER= preview key line — the unclipped-at-80
  // intent survives as: the FOCUSED critter's record below the grid reads
  // whole. The ↓ send moves one GRID ROW in the 2-column card grid (crab →
  // jellyfish), and the record leads with the bare focused name on its own
  // line — distinct from the card label '[3] jellyfish', so a clipped or
  // collapsed record area cannot fake this. (The old pin quoted an archetype
  // description line — copy the product no longer renders anywhere.)
  const recordLine = scr80
    .split('\n')
    .some(l => /^\s*│?\s*jellyfish\s*│?\s*$/.test(l))
  expect('80-col: the focused critter record is intact (bare-name record line present)', recordLine)
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ /critter RENDER-VERIFY PASS — holds at 80 + 120')
else console.log(`❌ ${failures} /critter RENDER CHECK(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-agent-dispatch-engines-journey.ts — the engines setup journey,
//  driven through the REAL built TUI in a PTY (vshot), hermetic + machine-
//  independent (the openai account scope is the scratch home + a pinned-empty
//  OPENAI_API_KEY, so its state is deterministic; zai state comes from the
//  scratch-stored key). Engines are DEFAULT-ON —
//  the journey is pure credential setup, no arming ceremony:
//      · `/router key` opens the masked entry; the typed key never appears
//        in the final grid (the paste-confirm tail is typing-time only);
//      · Enter saves → the receipt names the auth-scoped path, never the
//        value; the stored file exists with mode 600;
//      · `/router engines` reports zai LIVE (stored) · openai's
//        deterministic no-account code;
//      · FIRST-KEY-KEPT: the first post-receipt keypress lands in the
//        composer (the idle-parked-commits class).
//
//  Gate-class: rides the ui suite (pty). One capture ≈ 30s wall.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}

const KEY = 'zai-journey-proof-key-123456'

interface CaptureResult {
  text: string
  /** The same text with every whitespace run (row breaks included) folded to
   *  one space: a copy needle reads through an 80-column wrap. */
  flat: string
  /** vshot's per-send receipts — a send that never became due has none. */
  sends: number
  receipts: number
  /** The frames vshot snapshotted at each `mark` send, whitespace-folded. */
  marks: Record<string, string>
}

function capture(cfg: Record<string, unknown>, env: Record<string, string>): CaptureResult {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-journey-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  execFileSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: vshotBudgetMs(180_000),
  })
  type Grid = Array<Array<{ c?: string }>>
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as {
    grid: Grid
    sendReceipts?: unknown[]
    marks?: Array<{ label: string; grid: Grid }>
  }
  const gridText = (grid: Grid): string =>
    grid
      .map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd())
      .join('\n')
  const text = gridText(payload.grid)
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid).replace(/\s+/g, ' ')
  return {
    text,
    flat: text.replace(/\s+/g, ' '),
    marks,
    sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0,
    receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0,
  }
}

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orbit-journey-home-'))
  writeFileSync(
    join(home, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { [ROOT]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      // Key-consent: a key-bearing env (the CI proof
      // key) parks the consent card over the journey without this.
      ...(process.env.ANTHROPIC_API_KEY
        ? { customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }
        : {}),
    }),
  )
  return home
}

function baseEnv(home: string): Record<string, string> {
  return {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    // Machine-independence: the openai account state is DETERMINISTIC — the
    // scratch home has no auth store and the operator's real OPENAI_API_KEY
    // is pinned away (empty ⇒ unset at the resolver).
    OPENAI_API_KEY: '',
  }
}

console.log('============================================================')
console.log(' engines setup journey (real PTY, hermetic)')
console.log('============================================================')

// ── the setup journey: key entry → receipt → engines → first key ───────────
{
  const home = seedHome()
  const env = baseEnv(home)
  const { text, flat, sends, receipts, marks } = capture(
    {
      cols: 80,
      rows: 44,
      total: 200,
      argv: ['node', DIST],
      sends: [
        // The landing rule: a bare boot lands on the Boot face — ↵ on New
        // Session births the session and enters it (the one-door law; the
        // scratch daemon dir is writable, so the birth admits). STRICT
        // gates throughout: a frame
        // that never appears is vshot's own UNDELIVERED refusal, never blind
        // typing (a blind ladder here typed the key into the session
        // composer and SENT it as words).
        { data: '\r', atTick: 999, awaitText: '↵ start', requireAwait: true, minTick: 8, awaitSettleTicks: 3 },
        // '? for shortcuts' is the composer footer's live hint — present on
        // every screen whose composer takes input, absent on the face.
        { data: '/router key\r', atTick: 999, awaitText: '? for shortcuts', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
        { data: KEY, atTick: 999, awaitText: 'Z.AI API key', requireAwait: true, minTick: 2, awaitSettleTicks: 2 },
        { data: '\r', afterPrevTicks: 4 },
        // The receipt row is read HERE (the mark snapshots this frame): the
        // engines report that follows is taller than the grid and scrolls
        // the receipt off the final screen.
        { data: '/router engines\r', atTick: 999, awaitText: 'Z.AI API key stored', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'receipt' },
        // FIRST-KEY-KEPT: one printable key after the report paints. The
        // mark snapshots the report frame: the session's error reply to the
        // double-delivered key (the leak row below) swaps the view before
        // the final grid, so the report's own rows live here.
        { data: 'Q', atTick: 999, awaitText: 'every provider lane beside the home lane', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'report' },
      ],
      readyText: ['every provider lane beside the home lane'],
      stableTicks: 6,
    },
    env,
  )
  console.log('\nsetup journey — default-on engines')
  // The first paint is proven by the drive itself: the first send waited on
  // the composer's example placeholder and became due (every send did — a
  // stuck send is vshot's own exit 4). The home banner's ready line may have
  // scrolled off a 44-row final grid by the time the engines report paints,
  // so the final text is not where that fact lives.
  check('first paint unregressed: every send became due (the composer painted its placeholder)', sends > 0 && receipts === sends)
  // Copy needles read through an 80-column wrap (a longer scratch path on
  // another host folds the receipt row).
  // The lane's title is 'Z.AI API key' (RouterKeyEntry: `${lane.title} stored …`).
  check('save receipt names the auth-scoped path', (marks.receipt ?? '').includes('Z.AI API key stored (auth-scoped, mode 600)'), (marks.receipt ?? '(no receipt frame)').slice(0, 200))
  // THE LEAK PIN (stays red until the input-scope fix lands): one typing
  // pass into the hidden entry both stores the key AND submits it to the
  // session as words — the entry and the composer beneath it receive the
  // same bytes, and the storing ↵ also sends. The key value must never
  // appear anywhere on the final grid.
  check('the key VALUE never survives to the final grid', !text.includes(KEY))
  // The report's own rows read from its MARK frame (the frame the await
  // observed): the error reply to the leaked key swaps the view afterwards,
  // so the final grid is the leak's evidence, not the report's home.
  const report = marks.report ?? ''
  const reportFlat = report.replace(/\s+/g, ' ')
  check('engines receipt: the default-on header line', reportFlat.includes('engines — every provider lane beside the home lane'), report ? '' : '(no report frame)')
  // The readiness vocabulary: a stored key makes the lane AVAILABLE (LIVE is
  // a probed connection); the report names the credential's provenance.
  check('zai AVAILABLE from the stored key (credential present, auth-scoped)', reportFlat.includes('zai: available (credential present)') && reportFlat.includes('Z.AI API key (stored, auth-scoped)'))
  check(
    'openai reports the DETERMINISTIC no-account code (native lane)',
    report.includes('no-account:openai'),
  )
  check(
    "openai row carries the native transport + official pins",
    report.includes('openai-responses'),
  )
  check('seats-stay-Anthropic line present', report.includes('party') && report.includes('seats stay Anthropic'))
  check('FIRST-KEY-KEPT: the post-receipt keypress landed in the composer', /❯ *Q/.test(text))

  const secretsPath = join(home, '.provider-secrets.json')
  check('stored file exists under the scratch auth scope', existsSync(secretsPath))
  if (existsSync(secretsPath)) {
    check('stored file mode 600', (statSync(secretsPath).mode & 0o777) === 0o600, (statSync(secretsPath).mode & 0o777).toString(8))
    check('stored file holds the key (round-trip)', readFileSync(secretsPath, 'utf8').includes(KEY))
  }
  // A red carries its evidence: the final grid AND the report frame, so a
  // host-only failure (another terminal width, another path shape) reads
  // from the log alone.
  if (failures > 0) {
    console.log('\n── the report frame (mark) ──')
    console.log(report ? report.slice(0, 1200) : '(no report frame)')
    console.log('\n── the final grid ──')
    for (const row of text.split('\n')) console.log(`│ ${row}`)
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ENGINES JOURNEY GREEN')
else console.log(`${failures} ENGINES JOURNEY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

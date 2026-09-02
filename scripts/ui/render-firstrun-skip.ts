#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-firstrun-skip.ts — the first-run SKIP PATH end to end
//  on the BUILT dist: a virgin scratch home boots the real walk in a PTY,
//  "sign in later" continues it with NO credential, and the cockpit opens
//  logged-out with /logins still one command away.
//
//    A · the trust station continues the shrunken rail (trust · 5/5) after
//        theme → skip → guardrails → terminal — captured 100 + 120;
//    B · the cockpit lands logged-out (composer footer painted, no
//        credential anywhere) — captured 100 + 120;
//    C · the full journey: cockpit → /logins opens the nine-family card →
//        esc → /accounts tells the logged-out truth and names /logins.
//
//  Hermetic: virgin MERCURY_CONFIG_DIR per run, every endpoint base pinned
//  dead, BROWSER=true, no credential env — the whole walk touches no
//  network (the connectivity pre-gate is gone by design; each leg reports
//  its own reachability where it is chosen).
//  Every station transition is a STRICT-gated send (requireAwait): a
//  station that never paints lands in vshot's undelivered-sends refusal.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = resolve(import.meta.dir, '../..')
const DIST = join(ROOT, 'dist/mercury.mjs')
const VSHOT = join(ROOT, 'scripts/ui/vshot.py')
const DEAD = 'http://127.0.0.1:9'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.error('render-firstrun-skip: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

type Send = {
  data: string
  atTick?: number
  minTick?: number
  awaitText?: string
  awaitSettleTicks?: number
  afterPrevTicks?: number
  requireAwait?: boolean
}

// ── the walk's send script, station by station (strict-gated) ───────────────
const WALK_TO_TERMINAL: Send[] = [
  { requireAwait: true, awaitText: 'welcome — pick our colors', awaitSettleTicks: 4, data: '\r' },
  { requireAwait: true, awaitText: 'Sign in later', awaitSettleTicks: 3, data: '\x1b[B' },
  ...Array.from({ length: 8 }, (): Send => ({ afterPrevTicks: 2, data: '\x1b[B' })),
  { afterPrevTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'Guardrails', awaitSettleTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'Terminal keys', awaitSettleTicks: 3, data: '\x1b[B' },
  { afterPrevTicks: 2, data: '\r' },
]
const THROUGH_TRUST: Send[] = [
  ...WALK_TO_TERMINAL,
  // The ↵ is gated on the CONTINUED rail tag — the trust station must carry
  // the shrunken walk's rail (5 stations), not a rewritten one.
  { requireAwait: true, awaitText: 'trust · 5/5', awaitSettleTicks: 3, data: '\r' },
]

function drive(tag: string, cols: number, sends: Send[], readyText: string[], total: number): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), `firstrun-skip-${tag}-`))
  const cwd = join(home, 'workspace')
  mkdirSync(cwd, { recursive: true })
  // VIRGIN for the walk (no theme, no hasCompletedOnboarding): an empty
  // config home. A boot reaches no network on its own.
  const configHome = join(home, 'confighome')
  mkdirSync(configHome, { recursive: true })
  const out = join(home, 'grid.json')
  const cfg = join(home, 'cfg.json')
  writeFileSync(cfg, JSON.stringify({ argv: ['node', DIST], cwd, sends, readyText, readySettleTicks: 3, stableTicks: 4, total, cols, rows: 40, out }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: join(home, 'confighome'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    // The vscode fingerprint would otherwise start the editor-extension
    // auto-install against the REAL machine's editor state.
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_TABULA_MINERVA: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
  }
  for (const key of [
    'NODE_ENV', 'IS_DEMO',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR',
    'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
    'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
  ]) {
    delete env[key]
  }
  try {
    execFileSync('/usr/bin/python3', [VSHOT, cfg], { encoding: 'utf-8', timeout: vshotBudgetMs(110000), env, cwd })
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
    const text = payload.grid.map(row => row.map(cell => cell.c || ' ').join('')).join('\n')
    const keep = process.env.FIRSTRUN_CAPTURE_DIR
    if (keep) {
      mkdirSync(keep, { recursive: true })
      writeFileSync(join(keep, `firstrun-${tag}-${cols}.txt`), text)
    }
    return text
  } catch (error) {
    check(`${tag}@${cols}: the drive completed`, false, String((error as Error).message ?? error).slice(0, 300))
    return ''
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('============================================================')
console.log(' first-run skip path — the BUILT dist on a virgin home')
console.log('============================================================')

for (const cols of [100, 120]) {
  console.log(`\n  ── A · the trust station continues the shrunken rail @ ${cols} ──`)
  const grid = drive('trust', cols, WALK_TO_TERMINAL, ['Is this a project you created'], 200)
  check(`@${cols}: the trust dialog paints after the credential-free walk`, grid.includes('Is this a project you created'))
  check(`@${cols}: the rail carried through (trust · 5/5, sign in marked walked)`, grid.includes('trust · 5/5') && grid.includes('sign in'))
  check(`@${cols}: the trust rows are the real ones`, grid.includes('Yes, I trust this folder'))
}

for (const cols of [100, 120]) {
  console.log(`\n  ── B · the cockpit lands logged-out @ ${cols} ──`)
  const grid = drive('cockpit', cols, THROUGH_TRUST, ['? for shortcuts'], 250)
  check(`@${cols}: the composer landed (the walk ended in a live cockpit)`, grid.includes('? for shortcuts'))
  check(`@${cols}: the identity line tells the truth AT GLANCE and names the way in`, grid.includes('Not logged in · Run /logins'))
  check(`@${cols}: no credential was invented (no "Signed in as" claim on the glance frame)`, !grid.includes('Signed in as'))
}

console.log('\n  ── C · /logins still opens, /accounts tells the truth @ 100 ──')
{
  const grid = drive(
    'journey',
    100,
    [
      ...THROUGH_TRUST,
      { requireAwait: true, awaitText: '? for shortcuts', awaitSettleTicks: 5, data: '/logins' },
      { afterPrevTicks: 5, data: '\r' },
      // The nine-family card must open INSIDE the logged-out cockpit; esc
      // closes it (gated on a row only the card paints).
      { requireAwait: true, awaitText: 'Claude subscription account', awaitSettleTicks: 3, data: '\x1b' },
      { afterPrevTicks: 4, data: '/accounts' },
      { afterPrevTicks: 5, data: '\r' },
    ],
    ['not signed in'],
    300,
  )
  check('/accounts opened and tells the logged-out truth', grid.includes('not signed in'))
  check('/accounts names /logins as the way in', grid.includes('/logins'))
}

console.log(failures === 0 ? '\nFIRSTRUN SKIP: ALL GREEN' : `\nFIRSTRUN SKIP: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

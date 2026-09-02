#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-permission-modes.ts  (render-verify for the mode carousel UI)
//  The render-verify law: an Ink change is only "working" once the REAL TUI is
//  captured. The shift+tab permission-mode carousel paints a full-width modeBand
//  at the TOP of MercuryFrame (above the statusbar) for every non-default mode:
//    strategy    →  ◇ strategy mode on (shift+tab to cycle)
//    apollo      →  ∵ apollo mode on (shift+tab to cycle)
//    implement   →  ± implement mode on (shift+tab to cycle)
//    flow (fork) →  ✦ flow on (shift+tab to cycle)
//    sovereign   →  ⊠ sovereign mode on — all tool calls auto-approved (loud)
//  (the Mercury mode-seal family, GLYPH.mode* — assertions read the helpers
//  live, so the expected glyphs above are documentation, not a second pin)
//  Nothing locked the rendered band before this — prove-carousel.ts (the /model
//  entry logic) explicitly DEFERRED the chip render to "the vshot render-verify
//  (separate)". This is that proof: it resumes the built binary under vshot.py at
//  80 AND 120 cols with each mode seeded via the native --permission-mode flag
//  (bypass via --dangerously-skip-permissions) and asserts the band shows the
//  mode's title AND its symbol read FROM permissionModeSymbol() — the SAME source
//  the band renders from after the single-source-of-truth fix. So a future
//  hardcoded-glyph regression (the U+25B8/U+23F5 divergence this proof was added
//  alongside) fails here instead of shipping silently.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/render-permission-modes.ts
//  Out:  /tmp/permmode-<mode>-<cols>.html  + a text dump + a grep summary.
// ============================================================================
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

// Read the band's two sources of truth so the assertions track the helpers, not
// a hardcoded glyph (the whole point of the bug this proof guards). Fork-sim the
// MACRO so the stamp-only modes (auto) resolve in PermissionMode.ts when imported.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { permissionModeSymbol, permissionModeTitle } = (await import(
  '../../src/utils/permissions/PermissionMode.js'
)) as typeof import('../../src/utils/permissions/PermissionMode.js')

const REPO = join(import.meta.dir, '..', '..')
// The proof's config home (scripts/lib/proofHome.ts): the inherited pin, else
// a fresh seeded scratch — the fixture below and the spawned binary share it.
const CONFIG_HOME = resolveProofHome([RUNTIME_CWD])
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const BIN = join(REPO, 'dist', 'mercury.mjs')

// Deterministic id/timestamp so the rendered clock is stable across runs.
const SID = '00000000-aaaa-bbbb-cccc-0000000000c1'
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
  // A single operator line is enough — the modeBand is chrome (state-driven), not
  // transcript-driven, so it paints regardless of message content.
  const lines: Line[] = [
    common({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
  ]
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  const path = join(PROJECTS, `${SID}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

function shoot(mode: string, cols: number, args: string[]): string {
  const out = `/tmp/permmode-${mode}-${cols}.html`
  // 16s capture window (boot + resume-render) — matches the other render-verify
  // harnesses; a tighter window flaked on the screen mid-boot under load.
  const cfg = {
    argv: ['node', BIN, '--resume', SID, ...args],
    sends: [],
    total: 16,
    cols,
    rows: 44,
    out,
    title: `permmode ${mode} @ ${cols}`,
  }
  const cfgPath = `/tmp/vshot-pm-${mode}-${cols}.json`
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf-8',
    // NO_FLICKER=1 keeps the fullscreen alt-screen pyte can capture.
    env: { ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME },
    timeout: vshotBudgetMs(30000),
  })
  return (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')
}

// Each non-default mode + how the harness seeds it (the native flags, not a
// synthesized shift+tab keystroke — the band reads toolPermissionContext.mode,
// which initialPermissionModeFromCLI populates from these).
const MODES: { mode: string; args: string[]; bypass?: boolean }[] = [
  { mode: 'strategy', args: ['--permission-mode', 'strategy'] },
  { mode: 'apollo', args: ['--permission-mode', 'apollo'] },
  { mode: 'implement', args: ['--permission-mode', 'implement'] },
  { mode: 'flow', args: ['--permission-mode', 'flow'] },
  // bypass is gated behind the explicit launch flag (setPermissionModeWithGuards),
  // so it can ONLY be reached via --dangerously-skip-permissions, never the flag.
  { mode: 'sovereign', args: ['--dangerously-skip-permissions'], bypass: true },
]

console.log('============================================================')
console.log(' Permission-mode carousel render-verify (modeBand → band)')
console.log('============================================================')

buildSession()
const results: Record<string, string> = {}
for (const cols of [80, 120]) {
  for (const m of MODES) results[`${m.mode}-${cols}`] = shoot(m.mode, cols, m.args)
}

let failures = 0
function expect(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
// pyte splits the band's glyph + text across grid cells; collapse whitespace so a
// `± implement mode on` assertion isn't broken by inter-cell spacing.
const flat = (s: string) => s.replace(/\s+/g, ' ')

for (const cols of [80, 120]) {
  console.log(`\n── @ ${cols} cols ──`)
  for (const m of MODES) {
    const scr = flat(results[`${m.mode}-${cols}`]!)
    const sym = permissionModeSymbol(m.mode as never)
    const title = permissionModeTitle(m.mode as never).toLowerCase()
    if (m.bypass) {
      // The loud CRIMSON alarm — its OWN tail, but the GLYPH must come from the
      // config (the guarded class: a band hardcoding U+25B8 ▸▸ while the config
      // says otherwise — the assertion reads permissionModeSymbol live).
      // The station's display name is "Sovereign
      // Mode" (internal id bypassPermissions) — the title half of
      // the assertion reads the helper, the honest tail stays literal.
      expect(
        `${m.mode}: the alarm renders ("${title} on — all tool calls auto-approved")`,
        new RegExp(`${title} on . all tool calls auto.approved`).test(scr),
      )
      expect(
        `${m.mode}: the band glyph == permissionModeSymbol('bypassPermissions') (${JSON.stringify(sym)}) — no hardcoded-glyph drift`,
        scr.includes(`${sym} ${title} on`),
        scr.includes('▸▸ bypass') ? 'STILL renders the legacy ▸▸ (U+25B8) — band/config diverge' : '',
      )
    } else {
      // The shared band: <symbol> <title> on (shift+tab to cycle) — both fields
      // sourced from the permissionMode* helpers (one source of truth).
      expect(
        `${m.mode}: the band shows "${sym} ${title} on" (symbol+title from the helpers)`,
        scr.includes(`${sym} ${title} on`),
      )
      expect(
        `${m.mode}: the band carries the cycle hint (shift+tab to cycle)`,
        /shift\+tab to cycle/.test(scr),
      )
    }
  }
}

// Remove the synthetic fixture so it never shows in the operator's --resume picker.
try {
  rmSync(join(PROJECTS, `${SID}.jsonl`))
} catch {
  /* already gone */
}

console.log('\nHTML written to /tmp/permmode-{strategy,apollo,implement,flow,sovereign}-{80,120}.html')
console.log(
  failures === 0
    ? '\n✅ PERMISSION-MODE RENDER-VERIFY PASS'
    : `\n❌ ${failures} RENDER CHECK(S) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

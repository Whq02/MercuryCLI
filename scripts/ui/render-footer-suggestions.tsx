#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-footer-suggestions.tsx — RENDER-VERIFY for (opt-in,
//  joins the ui suite only under UI_RENDER=1).
//
//  Drives the REAL binary over a resumed synthetic session (a bare cold boot
//  lands on the onboarding/home flow and paints no prompt footer — tested),
//  types `/` so PromptInputFooter renders the full uncapped slash-command list
//  (well over the 5-6 window), and ASSERTS the dim "X of Y" overflow count row
//  appears AND the prompt line stays unclipped — the production condition the
//  de-_c'd PromptInputFooterSuggestions must satisfy.
//
//  Run:  UI_RENDER=1 ~/.bun/bin/bun run scripts/ui/render-footer-suggestions.tsx
// ============================================================================
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
// CI-portability: derive the checkout root — never a machine literal.
const RUNTIME_CWD = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(root, 'dist', 'mercury.mjs')
const VSHOT = join(dirname(fileURLToPath(import.meta.url)), 'vshot.py') // in-repo capturer
if (!existsSync(VSHOT) || !existsSync(BIN)) {
  console.error('vshot.py or dist/mercury.mjs missing — the render-verify harness (scripts/ui/vshot.py) and a build (bun run build.ts, AGENTS.md) are required.')
  process.exit(1)
}

// ── synthetic session so --resume paints the live prompt footer ─────────────
// (mirrors render-mercuryframe.ts buildSession; distinct SID so concurrent
// proofs never collide on the fixture file)
const CONFIG_HOME = (process.env.MERCURY_CONFIG_DIR ?? join(process.env.HOME!, '.claude')).normalize('NFC')
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))
const SID = '00000000-aaaa-bbbb-cccc-0000000000f9'
let u = 0
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`
function buildSession(): void {
  const common = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: RUNTIME_CWD,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const lines = [
    common({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'first task' },
      uuid: uuid(),
      timestamp: '2026-06-19T12:00:01.000Z',
    }),
  ]
  if (!existsSync(PROJECTS)) mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(join(PROJECTS, `${SID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

console.log('============================================================')
console.log(' HB-0194 render-verify: / slash menu overflow count row')
console.log('============================================================')

const capture = (cols: number, rows: number): string => {
  const cfg = `/tmp/vs-slash-${cols}x${rows}.json`
  writeFileSync(
    cfg,
    JSON.stringify({
      argv: ['node', BIN, '--resume', SID],
      // vshot sends are [{atTick, data}] in 0.2s ticks — type `/` once the
      // resumed session has settled (~6s; matches renderScenarios.ts timing).
      sends: [{ atTick: 32, data: '/' }],
      total: 70,
      cols,
      rows,
      out: `/tmp/slash-${cols}x${rows}.json`,
    }),
  )
  // vshot.py never reads cfg.env — fork selection rides execFileSync's env.
  return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
    encoding: 'utf-8',
    timeout: 60000,
    // Split-home guard: fixture under CONFIG_HOME vs the env-less fork child's
    // ~/.mercury (sovereign-home flip) — pin the pair to ONE home.
    env: { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME },
  })
}

buildSession()
try {
  for (const [cols, rows] of [
    [90, 18],
    [120, 20],
  ] as const) {
    const grid = capture(cols, rows)
    const countRow = grid.split('\n').find(l => /\b\d+ of \d+\b/.test(l)) ?? ''
    console.log(`  ${cols}x${rows} count row: ${countRow.trim() || '(none)'}`)
    // the uncapped slash list is far more than the window → overflow → count row present
    check(`${cols}x${rows}: a dim "X of Y" overflow count row is rendered`, /\b\d+ of \d+\b/.test(grid))
    // the count's Y (total) far exceeds the window (≥ ~6) — proves it's the real overflow signal
    const m = countRow.match(/\b(\d+) of (\d+)\b/)
    check(`${cols}x${rows}: the count's total >> the visible window (a real overflow signal)`, !!m && parseInt(m[2]!, 10) > 6, m ? `total=${m[2]}` : '')
    // the prompt input line (caret U+276F then the typed `/`) is still visible —
    // the reserved-line budget must not let the suggestions clip it off-screen.
    check(`${cols}x${rows}: the prompt input caret/line stays visible (not clipped)`, /❯\s*\//.test(grid))
  }
} finally {
  // Remove the fixture so it never shows in the operator's --resume picker.
  try {
    rmSync(join(PROJECTS, `${SID}.jsonl`))
  } catch {
    /* already gone */
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0194 render-verify — overflow count row renders, prompt unclipped')
  process.exit(0)
} else {
  console.log(` ❌ HB-0194 render-verify — ${failures} check(s) failed`)
  process.exit(1)
}

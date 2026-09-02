#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-frame-trace.ts — the frame latency trace (
//  HZ8): a bounded ring of render-pipeline timings with schema-first privacy.
//
//  The trace answers "which stage consumed the frame budget" from the
//  engine's OWN measurements (onFrame phases), attributes the newest
//  keystroke by its RESOLUTION (an Action Graph id or null — never the
//  keystroke), and the /trace frames section renders it live.
//
//  The guarded gap: frame-trace.ts does not exist; /trace has no frames
//  section; a slow paint can only be guessed at.
//
//  §1 the schema is numbers + identifiers by construction
//  §2 ring mechanics: attribution, cap, one-frame lifetime
//  §3 REAL BINARY: keystrokes fill the ring; /trace renders the attribution
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  _resetFrameTraceForTesting,
  readFrameTrace,
  recordFrameTrace,
  traceKeyResolved,
} from '../../src/ink/root/frame-trace.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-ftrace-'))

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the schema is numbers + identifiers by construction')
{
  const src = readFileSync('src/ink/root/frame-trace.ts', 'utf8')
  // The row type's ONLY string-typed fields are the two bounded identifier
  // slots (+ the contexts identifier list). A new free-text field must show
  // up here and justify itself.
  const iface = src.slice(src.indexOf('export interface FrameTraceRow'), src.indexOf('const RING_CAP'))
  // TOTAL over the token 'string' (review finding 2: the old per-line regex
  // missed optional fields, unions and same-line comments — a `note?: string`
  // slipped both the count and the name check). EVERY line of the interface
  // that mentions `string` must be one of the three allowlisted identifier
  // slots, exactly as declared — anything else (new field, optional marker,
  // widened union, extras bag) is a schema change that must justify itself.
  const ALLOWED = new Set([
    'lastClearReason: string | null',
    'actionId: string | null',
    'contexts: string[]',
  ])
  const stringLines = iface
    .split('\n')
    .map(l => l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim())
    .filter(l => /\bstring\b/.test(l))
  t.check(
    'every string-typed declaration is an allowlisted identifier slot',
    stringLines.length === 3 && stringLines.every(l => ALLOWED.has(l)),
    stringLines.join(' · ') || 'none',
  )
  t.check('no extras bag', !iface.includes('Record<') && !iface.includes('unknown'))
  const interceptor = readFileSync('src/keybindings/KeybindingProviderSetup.tsx', 'utf8')
  t.check(
    'the interceptor stamps the RESOLUTION, never the keystroke',
    interceptor.includes("traceKeyResolved(result.type === 'match' ? result.action : null, contexts)"),
  )
  const helpers = readFileSync('src/interactiveHelpers.tsx', 'utf8')
  t.check('the renderer onFrame feeds the ring', /const onFrame = \(event: FrameEvent\): void => \{[\s\S]{0,300}recordFrameTrace\(\{\s*durationMs: event\.durationMs,/.test(helpers))
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — ring mechanics')
{
  _resetFrameTraceForTesting()
  const EV = (ms: number): Parameters<typeof recordFrameTrace>[0] => ({
    durationMs: ms,
    phases: { renderer: ms / 2, diff: 1, optimize: 0.2, write: 0.8, patches: 3, yoga: 1, commit: 0.5 },
    flickers: [],
  })
  traceKeyResolved('app:commandPalette', ['Chat', 'Global'])
  recordFrameTrace(EV(8))
  recordFrameTrace(EV(4))
  const rows = readFrameTrace()
  t.check('two frames filed', rows.length === 2)
  t.check(
    'the keystroke attributed to the NEXT frame only',
    rows[0]!.actionId === 'app:commandPalette' &&
      rows[0]!.inputToFrameMs !== null &&
      rows[1]!.actionId === null &&
      rows[1]!.inputToFrameMs === null,
    `${rows[0]!.actionId}/${rows[1]!.actionId}`,
  )
  t.check('contexts ride as identifiers', rows[0]!.contexts.join('/') === 'Chat/Global')
  t.check('phases file verbatim', rows[0]!.rendererMs === 4 && rows[0]!.patches === 3)
  for (let i = 0; i < 300; i++) recordFrameTrace(EV(1))
  t.check('the ring is bounded at 256', readFrameTrace().length === 256)
  t.check(
    'sequence stays monotonic across eviction',
    readFrameTrace().every((r, i, a) => i === 0 || r.seq === a[i - 1]!.seq + 1),
  )
  const clearEv = EV(2)
  clearEv.flickers = [{ reason: 'resize' }]
  recordFrameTrace(clearEv)
  const last = readFrameTrace().at(-1)!
  t.check('full clears carry their bounded reason id', last.fullClears === 1 && last.lastClearReason === 'resize')
  _resetFrameTraceForTesting()
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — REAL BINARY: keystrokes fill the ring; /trace renders it')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const home = join(scratch, 'pty-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-ftrace'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    const out = join(scratch, 'ftrace.json')
    const cfg = {
      cols: 120,
      rows: 40,
      total: 240,
      argv: ['node', BIN],
      out,
      cwd: process.cwd(),
      sends: [
        // Ordinary typing first — the ring must fill from real keystrokes.
        // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'x' },
        { afterPrevTicks: 3, data: '' },
        { atTick: 999, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 2, data: '/trace\r' },
      ],
      readyText: 'input→frame',
      readySettleTicks: 4,
    }
    const cfgPath = join(scratch, 'ftrace-cfg.json')
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: FIXTURE_KEY,
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(180_000),
    })
    let text = ''
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
      text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
    } catch {
      /* empty */
    }
    t.check('the journey completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
    t.check('the frames section renders with named sample count', /n=\d+ · p50 /.test(text))
    t.check('the slowest frame is stage-attributed', text.includes('slowest ') && text.includes('compose '))
    t.check(
      // Classified label, never content. Since the TASK-009 fold the ↵ is a
      // REAL return atom, so the /trace submit attributes as chat:submit
      // (the glued 'text↵' chunk would otherwise mislabel it 'typed') — the line
      // names whichever classified input was slowest.
      'keystroke attribution rendered (classified label, no content)',
      text.includes('input→frame') && /typed|chat:submit|chord/.test(text) && !text.includes("'x'"),
    )
    t.check('the capability tier + evidence line renders', text.includes('profile '))
  }
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-frame-trace')

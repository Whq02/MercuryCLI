#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  _resetFrameTraceForTesting,
  FRAME_TRACE_RING_CAP,
  readFrameTrace,
  recordFrameTrace,
  traceKeyResolved,
} from '../../src/ink/root/frame-trace.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-ftrace-'))

t.section('§1 — the schema is numbers + identifiers by construction')
{
  const src = readFileSync('src/ink/root/frame-trace.ts', 'utf8')

  const iface = src.slice(src.indexOf('export interface FrameTraceRow'), src.indexOf('const RING_CAP'))

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

        { requireAwait: true, awaitText: '↑↓ choose', awaitPattern: '↑↓ choose', awaitSettleTicks: 2, mark: 'boot-ready', data: '\r' },
        { requireAwait: true, awaitText: ' ready · ', awaitPattern: ' ready · [\\s\\S]*Type a prompt, start a slash command', awaitSettleTicks: 3, mark: 'chat-ready', data: 'x' },
        { requireAwait: true, awaitText: '│❯ x ', awaitPattern: '│❯ x ', awaitSettleTicks: 2, mark: 'typed-x', data: '\x7f' },
        { requireAwait: true, awaitText: 'Type a prompt, start a slash command', awaitPattern: 'Type a prompt, start a slash command', awaitSettleTicks: 2, mark: 'trace-requested', data: '/trace\r' },
      ],
      readyText: ['input→frame', 'slowest ', 'compose ', 'profile '],
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
        MERCURY_HEALTH_STATE_DIR: join(scratch, 'health'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(180_000),
    })
    let text = ''
    let marks: string[] = []
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>>; marks?: Array<{ label: string }> }
      text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
      marks = (payload.marks ?? []).map(mark => mark.label)
    } catch {
    }
    t.check('the journey completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
    t.check('refusals: no navigation send runs before its product-ready mark', marks.join(',') === 'boot-ready,chat-ready,typed-x,trace-requested', marks.join(','))
    if (r.status !== 0) console.log(r.stdout, r.stderr, text)

    t.check(
      'the frames section renders the sample count over the cap and the live span',
      new RegExp(`n=\\d+/${FRAME_TRACE_RING_CAP} · last \\d+(?:\\.\\d+)?[sm] · p50 `).test(text),
    )
    t.check('the slowest frame is stage-attributed', text.includes('slowest ') && text.includes('compose '))
    t.check(

      'keystroke attribution rendered (classified label, no content)',
      text.includes('input→frame') && /typed|chat:submit|chord/.test(text) && !text.includes("'x'"),
    )
    t.check('the capability tier + evidence line renders', text.includes('profile '))
  }
}

if (t.failures() === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`frame trace evidence kept at ${scratch}`)
t.finish('prove-frame-trace')

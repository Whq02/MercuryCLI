#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-empty-tool-input-render.ts — a legal-but-unusual
//  tool call never takes the harness down, proven on the SHIPPED artifact.
//
//  The operator asked GPT-5.6 to "make a tool call that does nothing"; the
//  model emitted a Bash tool_use whose arguments were empty, and the
//  transcript's collapse classifier read `input.command.trim()` off an
//  undefined command — the render tree threw, the app-root boundary ended
//  the process, the live view was lost (crash-1787460762852). A tool call
//  the model is allowed to make must render, never crash.
//
//  This drives the REAL built binary via --resume onto a synthetic session
//  whose assistant turn carries a Bash tool_use with `input: {}` and its
//  settled validation-error result — the exact shape that reaches the
//  collapse classifier on mount, deterministically (no streaming-window
//  timing). Survival is read from three witnesses:
//    1. no RENDER ERROR frame, and the session's own rows paint;
//    2. no app-root crash report under the (scratch) config home;
//    3. the harness reaches its idle composer (it lived past the transcript).
//
//  Set MERCURY_ARENA_DIST to point at another artifact — a
//  before/after run put the pre-fix bundle through this file (RENDER ERROR +
//  an app-root report) and the fixed bundle (clean render).
//
//  Run:  ~/.bun/bin/bun run scripts/streaming/prove-empty-tool-input-render.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DIST = process.env.MERCURY_ARENA_DIST || join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error(`artifact missing at ${DIST} — run \`bun run build.ts\` first`)
  process.exit(2)
}

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── stage a synthetic session carrying the crash shape ──────────────────────
const home = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'empty-tool-home-'))
// realpath: macOS mkdtemp hands back a /var symlink; the CLI keys project
// trust by the RESOLVED cwd, so seed with that or the trust dialog blocks boot.
const cwd = realpathSync(mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'empty-tool-cwd-')))
const configDir = join(home, '.claude')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
)
const slug = cwd.replace(/[/.]/g, '-')
const projectDir = join(configDir, 'projects', slug)
mkdirSync(projectDir, { recursive: true })
const SID = '00000000-aaaa-bbbb-cccc-000000000001'
const base = (extra: Record<string, unknown>) => ({
  isSidechain: false, userType: 'external', entrypoint: 'cli',
  cwd, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra,
})
// The assistant turn's Bash tool_use carries `input: {}` — the shape a no-op
// or a partial/streamed argument object leaves on the persisted transcript —
// and the settled result is the schema's own validation error (the production
// persisted shape for a command-less Bash call).
const rows = [
  base({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000000001',
    message: { role: 'user', content: 'make a tool call that does nothing' },
    timestamp: '2026-06-19T12:00:01.000Z' }),
  base({ parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000002', requestId: 'req_empty_1',
    message: { id: 'msg_empty_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: 'toolu_empty', name: 'Bash', input: {} }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    timestamp: '2026-06-19T12:00:02.000Z' }),
  base({ parentUuid: '00000000-0000-4000-8000-000000000002', type: 'user',
    uuid: '00000000-0000-4000-8000-000000000003',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_empty', content: 'InputValidationError: command is required' }] },
    toolUseResult: 'InputValidationError: command is required',
    timestamp: '2026-06-19T12:00:03.000Z' }),
]
// The session file holds RECORD lines — the shape the product opens.
writeFileSync(join(projectDir, `${SID}.jsonl`), encodeSeedTranscript(rows, SID))

// ── boot the real binary --resume onto the staged session, capture ──────────
const drive = join(home, 'drive.jsonl')
const nodeBin = process.env.NODE_BIN ?? spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '8', '--out', drive, '--', nodeBin, DIST, '--resume', SID],
  {
    cwd, encoding: 'utf8', timeout: vshotBudgetMs(60_000),
    env: {
      // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
      // env drops the job-wide knob and ptydrive falls back to scale 1 -
      // authored-time sends race 3x-slow hosted boots (the undelivered-sends
      // class; gate run 3's arena zero-observation shapes). Forward it.
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: home, PATH: `/usr/bin:/bin:${dirname(nodeBin)}`, TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: configDir, MERCURY_TERMINAL_TITLE: '0', MERCURY_BOOT_PREFLIGHT: '0',
    },
  },
)
const grab = spawnSync(
  '/usr/bin/python3',
  [join(HERE, 'screengrab.py'), drive, '120', '40', '-1'],
  { encoding: 'utf8', timeout: vshotBudgetMs(30_000), maxBuffer: 64 * 1024 * 1024 },
)
let screen = ''
try {
  screen = (JSON.parse(grab.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
} catch {
  screen = `(screengrab failed) ${grab.stderr}`
}

const crashes = join(configDir, 'crashes')
const reports = existsSync(crashes) ? readdirSync(crashes) : []
const appRoot = reports.filter(name => name.includes('app-root'))

console.log(`── empty-tool-input --resume render (${DIST.includes('/dist/') ? 'repo dist' : DIST}) ──`)
check('no RENDER ERROR frame', !/RENDER ERROR|hit a render error|had to close|Restart Mercury/.test(screen),
  screen.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' / '))
check('no app-root crash report under the config home', appRoot.length === 0,
  appRoot.map(name => {
    try {
      return (JSON.parse(readFileSync(join(crashes, name), 'utf8')) as { message?: string }).message ?? name
    } catch {
      return name
    }
  }).join(' | '))
// The command-less Bash call renders as a collapsed bash row (not a crash):
// its user prompt and the collapsed row both paint.
check('the resumed session rows paint', /make a tool call that does nothing/.test(screen),
  screen.trim().length < 40 ? 'screen empty (process died?)' : 'prompt row absent')
check('the command-less Bash call renders as a transcript row', /bash command|Bash/.test(screen))
check('the harness reached its idle composer', /type a prompt|↵ sends|for commands|ask minerva/.test(screen))

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })

console.log(failures === 0 ? '✅ empty-tool-input render GREEN' : `❌ empty-tool-input render RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

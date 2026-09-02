#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-panel-captures.ts — the BUILT bundle, driven
//  in a PTY (vshot) at 120x40 AND 100x30: one capture per promise of the
//  prompts panel, needles on what the operator literally sees.
//
//  Legs (each at both sizes; grids + PNGs land under CAPTURE_DIR):
//    L1  PROMPTS populated — the receipt roll: time · mode · first line,
//        plain/bash/slash, a long prompt truncated with its +N lines, newest
//        at the bottom (the cursor lands on it).
//    L1x PROMPTS expanded — ↵ on the multi-line prompt shows the whole text.
//    L1e PROMPTS empty — a chat with nothing sent yet: the honest line.
//    L3  CREW TRAFFIC populated — two agents threaded (launch brief · sends ·
//        a reply), and L3e empty — 'no agent traffic this session'.
//    L6  the limits line on every PROMPTS capture (since HH:MM · resumed).
//    L7e SAVED PROMPTS empty · L7w a draft written (a, type, ↵), a second
//        one, [ reorders · L7s `s` hands one to the composer (the panel
//        closes; the composer holds the text, unsent).
//    L8u /tabula — Minerva's room WITHOUT a model: the honest line.
//    L8m /tabula WITH a model pinned: the status line + the saved prompts.
//    L9  a refinement landing BESIDE the original (a loopback Minerva
//        answers 'tighten prompt 2'; ✧ appears under prompt 2, prompt 2's
//        own line unchanged).
//    L10 the retired WORK options do not reappear (no WORK/LANES/REVIEW/
//        GRAPH labels anywhere in the panel captures).
//
//  Sheet line 2 (follows the focused chat across concourse hops) rides the
//  ONE connector slot (useSessionConnector) — proved by census here and
//  driven live in L2 when a second session can be hopped to in a capture.
//
//  Run: ~/.bun/bin/bun run scripts/prompts-panel/prove-panel-captures.ts
//  (dist must exist — `bun run build.ts`)
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CONFIG_HOME, RUNTIME_CWD, SID, cleanupScenario, encodeFixtureTranscript, scenario } from '../ui/renderScenarios.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { FIXTURE_MODEL } from './minerva-fixture-server.ts'
import { projectSlug, sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { readSessionWorkers } from '../../src/daemon/concourseSupervisor.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

/** A bare-boot capture's ↵ births a session whose runner outlives the
 *  capture's screen inside the shared render daemon; reap it (and the
 *  daemon, which re-spawns on the next boot) so the next ↵ admits
 *  exclusively instead of carving a worktree beside a live twin. */
function reapRenderDaemonSessions(): void {
  const dir = process.env.MERCURY_DAEMON_DIR
  if (!dir) return
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.pid !== undefined && rec.endedAt === undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
        /* gone */
      }
    }
  }
  try {
    const pidFile = join(dir, 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
    /* gone */
  }
}

const VSHOT = join(import.meta.dir, '..', 'ui', 'vshot.py')
const REPO = join(import.meta.dir, '..', '..')
const CAPTURE_DIR = process.env.PROMPTS_PANEL_CAPTURE_DIR ?? join(tmpdir(), 'prompts-panel-captures')
const FIXTURE_PORT = 36211
const PROJECTS = join(CONFIG_HOME, 'projects', sanitizePath(RUNTIME_CWD))

type Cell = { c: string }
type Grid = { grid: Cell[][]; endReason?: string }
const text = (g: Grid): string => g.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
/** Frame- and wrap-tolerant form for phrase needles: a narrow terminal wraps
 *  a long line across the box border, so the phrase is read with the frame
 *  glyphs and line breaks collapsed to single spaces. */
const flat = (s: string): string => s.replace(/[│╭╮╰╯─▔]/g, ' ').replace(/\s+/g, ' ')
const painted = (g: Grid): number => g.grid.reduce((n, r) => n + r.filter(c => c.c && c.c !== ' ').length, 0)

const ESC = '\u001b'
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
const ENTER = '\r'
const TAB = '\t'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

mkdirSync(CAPTURE_DIR, { recursive: true })

// ── the fixture transcript: plain · multi-line · bash · slash prompts plus
//    crew traffic (an Agent launch, three sends, two replies) ──────────────
function base(extra: Record<string, unknown>): Record<string, unknown> {
  return { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra }
}
function chain(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let prev: string | null = null
  return rows.map((r, i) => {
    const uuid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
    const out = base({ ...r, uuid, parentUuid: prev })
    prev = uuid
    return out
  })
}
const at = (m: number, s = 0): string => `2026-08-26T09:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
const assistant = (content: unknown[], ts: string, id: string): Record<string, unknown> => ({
  type: 'assistant',
  requestId: `req_${id}`,
  message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  timestamp: ts,
})
const userRow = (content: unknown, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra })

const POPULATED = chain([
  userRow('audit the retry ladder and report file:line', at(1)),
  assistant([{ type: 'text', text: 'Reading the ladder now.' }], at(1, 30), 'p1'),
  userRow('refactor the switchboard focus path\n- keep the reap law\n- one pool per boundary', at(3, 10)),
  assistant([{ type: 'tool_use', id: 'toolu_agent_panel', name: 'Agent', input: { name: 'PANEL', description: 'Prompts panel implementer lane', prompt: 'You are lane PANEL, the prompts-panel implementer. Read the sheet whole first.' } }], at(4), 'p2'),
  userRow([{ type: 'tool_result', tool_use_id: 'toolu_agent_panel', content: 'PANEL launched' }], at(4, 5), { toolUseResult: { status: 'launched' } }),
  userRow('<bash-input>git status --short</bash-input>', at(5)),
  userRow('<bash-stdout> M src/commands/workbench/index.ts</bash-stdout>', at(5, 2)),
  userRow('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', at(6)),
  userRow('<local-command-stdout>Set model to opus</local-command-stdout>', at(6, 1)),
  assistant([{ type: 'tool_use', id: 'toolu_send_1', name: 'SendMessage', input: { to: 'PANEL', summary: 'go', message: 'Build tab one first; report per landed tab.' } }], at(7), 'p3'),
  userRow('<teammate-message teammate_id="PANEL" summary="tab one landed">PROMPTS tab landed on fix/prompts-panel — captures at both sizes attached.</teammate-message>', at(8)),
  assistant([{ type: 'tool_use', id: 'toolu_send_2', name: 'SendMessage', input: { to: 'CLAM', message: 'Keep the splash untouched while PANEL lands.' } }], at(9), 'p4'),
  userRow('<teammate-message teammate_id="CLAM">understood — the splash stays.</teammate-message>', at(9, 30)),
  userRow('ship it', at(10)),
  assistant([{ type: 'text', text: 'Shipping.' }], at(10, 20), 'p5'),
])

const NO_CREW = chain([
  userRow('first task', at(1)),
  assistant([{ type: 'text', text: 'Done.' }], at(1, 30), 'q1'),
  userRow('second task', at(2)),
])

function writeTranscript(rows: Array<Record<string, unknown>>): void {
  mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(join(PROJECTS, `${SID}.jsonl`), encodeFixtureTranscript(rows, SID))
}

// THE BARE BIRTHS' CREDENTIAL (the probe-key idiom): the scenario harness
// deliberately strips keys for its key-status visual pins, but a bare-boot
// panel leg BIRTHS a session, and the admit door validates the model
// against signed-in families — keyless, Enter on New Session stands the
// face and the leg burns its budget. The fixture key rides ONLY these
// captures' env (presence, never validity) with its consent pre-approved.
const PANEL_FIXTURE_KEY = 'sk-ant-panel-captures-probe'
{
  const cfgPath = join(CONFIG_HOME, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['customApiKeyResponses'] = { approved: [PANEL_FIXTURE_KEY.slice(-20)], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

const savedPromptsDir = join(CONFIG_HOME, 'saved-prompts')
function clearSavedPrompts(): void {
  rmSync(savedPromptsDir, { recursive: true, force: true })
}
function seedSavedPrompts(drafts: Array<{ id: string; text: string; refinedText?: string }>): string {
  mkdirSync(savedPromptsDir, { recursive: true })
  // The store keys by the INJECTIVE slug since FC-008 (sanitised spelling +
  // short content hash); a fixture seeded at the pre-hash spelling would be
  // adopted-by-rename once and then shadowed by later seeds.
  const file = join(savedPromptsDir, `${projectSlug(RUNTIME_CWD.normalize('NFC'))}.json`)
  writeFileSync(
    file,
    JSON.stringify({ _v: 1, drafts: drafts.map(d => ({ ...d, createdAt: '2026-08-26T09:00:00.000Z', updatedAt: '2026-08-26T09:00:00.000Z' })) }, null, 2),
  )
  return file
}

type Send = { atTick?: number; afterPrevTicks?: number; awaitText?: string; minTick?: number; awaitSettleTicks?: number; data: string }

function capture(
  tag: string,
  cols: number,
  rows: number,
  opts: {
    transcript?: Array<Record<string, unknown>> | 'none'
    sends: Send[]
    readyText: string | string[]
    total?: number
    env?: Record<string, string | undefined>
  },
): Grid {
  const gridPath = join(CAPTURE_DIR, `${tag}-${cols}x${rows}.grid.json`)
  const cfg = { ...scenario('tabula-empty', cols, rows), out: gridPath } as Record<string, unknown> & { argv: string[]; sends: Send[] }
  if (opts.transcript === 'none') {
    cfg.argv = cfg.argv.filter((a: string) => a !== '--resume' && a !== SID)
  } else if (opts.transcript) {
    writeTranscript(opts.transcript)
  }
  cfg.sends = opts.sends
  cfg.readyText = opts.readyText
  cfg.readySettleTicks = 3
  cfg.total = opts.total ?? 140
  const cfgPath = join(CAPTURE_DIR, `${tag}-${cols}x${rows}.vshot.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: CONFIG_HOME, ANTHROPIC_API_KEY: PANEL_FIXTURE_KEY, ...(opts.env ?? {}) }
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k]
  let grid: Grid = { grid: [] }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf-8', timeout: vshotBudgetMs(120000), env })
    if (res.status !== 0) {
      console.log(`    (vshot exit ${res.status}: ${(res.stderr || '').slice(-300)})`)
      continue
    }
    grid = JSON.parse(readFileSync(gridPath, 'utf8')) as Grid
    if (painted(grid) >= 40) break
  }
  if (opts.transcript === 'none') reapRenderDaemonSessions()
  const txt = text(grid)
  writeFileSync(join(CAPTURE_DIR, `${tag}-${cols}x${rows}.txt`), txt + '\n')
  void gridToPng(gridPath, join(CAPTURE_DIR, `${tag}-${cols}x${rows}.png`)).catch(() => {})
  return grid
}

// Observed-ready entries, never blind ticks (the bare-boot precedent below,
// applied to the RESUME worlds too): a POPULATED resume paints its composer
// later than tick 30 at 100x30, and a blind '/workbench' typed before the
// chat hint stood landed nowhere — the whole capture then burned its budget.
const then = (awaitText: string, data: string, settle = 2): Send => ({ atTick: 999, awaitText, minTick: 5, awaitSettleTicks: settle, data })
const after = (ticks: number, data: string): Send => ({ afterPrevTicks: ticks, data })
const OPEN_PANEL: Send[] = [then('? for shortcuts', '/workbench'), then('/workbench', ENTER)]
const OPEN_ROOM: Send[] = [then('? for shortcuts', '/tabula'), then('/tabula', ENTER)]
// A BARE boot (no --resume, no prompt argv) lands on the Boot face — the
// landing rule. The drive walks the REAL road: ↵ on the face's default New
// Session row BIRTHS a session and enters it (the one-door law — the render
// daemon dir is writable, so the birth admits), and the panel opens only
// once the chat's ready line is on screen (observed-ready, never blind
// ticks). Every bare-boot capture therefore leaves a live runner behind in
// the shared render daemon; capture() reaps it so the next ↵ admits
// exclusively (a live twin in the same folder would carve a worktree).
const OPEN_PANEL_BARE: Send[] = [
  then('New Session', ENTER),
  // The painted placeholder spells 'Type a prompt…' — the lowercase needle
  // never matched the frame.
  then('Type a prompt', '/workbench'),
  then('/workbench', ENTER),
]

const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
]

console.log('============================================================')
console.log(' PROMPTS PANEL — captures on the built bundle (120x40 · 100x30)')
console.log('============================================================')

for (const [cols, rows] of SIZES) {
  const size = `${cols}x${rows}`
  console.log(`\n▶ ${size}`)

  // L1 + L6 — PROMPTS populated
  {
    clearSavedPrompts()
    const g = text(capture('L1-prompts', cols, rows, { transcript: POPULATED, sends: OPEN_PANEL, readyText: 'SAVED PROMPTS' }))
    check(`[${size}] L1 the three tabs are on screen`, /PROMPTS/.test(g) && /CREW TRAFFIC/.test(g) && /SAVED PROMPTS/.test(g))
    check(`[${size}] L1 the receipt roll lists the sent prompts in order`, g.indexOf('audit the retry ladder') !== -1 && g.indexOf('audit the retry ladder') < g.indexOf('refactor the switchboard') && g.indexOf('refactor the switchboard') !== -1 && g.indexOf('refactor the switchboard') < g.indexOf('ship it'))
    check(`[${size}] L1 modes read plain · bash · slash`, /plain/.test(g) && /bash/.test(g) && /slash/.test(g))
    check(`[${size}] L1 a bash send reads as typed (! git status --short)`, /! git status --short/.test(g))
    check(`[${size}] L1 a slash send reads /model opus`, /\/model opus/.test(g))
    check(`[${size}] L1 the long prompt is truncated honestly (+2 lines)`, /\+2 lines/.test(g))
    check(`[${size}] L1 the newest prompt is at the bottom under the cursor`, /▸.*ship it/.test(g))
    check(`[${size}] L6 the limits line says since when and that the transcript was resumed`, /5 prompts since \d\d:\d\d · resumed transcript included/.test(g))
    check(`[${size}] L10 no retired WORK option label reappears`, !/\bLANES\b|\bREVIEW\b|\bGRAPH\b|TO-REVIEW|no running work/.test(g))
    check(`[${size}] L4 the footer teaches the panes grammar (tab/1-9 · esc close)`, /tab\/1-9 section/.test(g) && /esc close/.test(g))
  }

  // L1x — expand the multi-line prompt (↑ ×3 from the newest: ship it → /model → ! git → refactor)
  {
    const g = text(
      capture('L1-prompts-expanded', cols, rows, {
        transcript: POPULATED,
        sends: [...OPEN_PANEL, then('SAVED PROMPTS', UP), after(1, UP), after(1, UP), after(1, ENTER)],
        readyText: 'the prompt as sent',
      }),
    )
    check(`[${size}] L1x ↵ expands the long prompt — the whole text shows`, /keep the reap law/.test(g) && /one pool per boundary/.test(g))
    check(`[${size}] L1x the detail names the prompt (prompt #2)`, /prompt #2/.test(g))
    check(`[${size}] L1x the length facts are honest (3 lines)`, /3 lines/.test(g))
  }

  // L1e — PROMPTS empty (a fresh chat, nothing sent)
  {
    const g = text(capture('L1-prompts-empty', cols, rows, { transcript: 'none', sends: OPEN_PANEL_BARE, readyText: 'SAVED PROMPTS' }))
    check(`[${size}] L1e an empty chat says so honestly`, /no prompts sent in this chat yet/.test(g))
    check(`[${size}] L6e the limits line reads nothing sent`, /0 prompts · nothing sent in this chat yet/.test(g))
  }

  // L3 — CREW TRAFFIC populated (tab 2)
  {
    const g = text(capture('L3-crew', cols, rows, { transcript: POPULATED, sends: [...OPEN_PANEL, then('SAVED PROMPTS', '2')], readyText: 'PANEL replied' }))
    check(`[${size}] L3 two agent threads (PANEL · CLAM), first-seen order`, g.indexOf('PANEL') !== -1 && g.indexOf('PANEL') < g.indexOf('CLAM'))
    check(`[${size}] L3 the lead's messages TO an agent and the reply back`, /to PANEL/.test(g) && /PANEL replied/.test(g) && /to CLAM/.test(g))
    check(`[${size}] L3 the launch brief is marked`, /brief ·/.test(g))
    check(`[${size}] L3 thread counts are honest (PANEL 3 messages · CLAM 2 messages)`, /3 messages/.test(g) && /2 messages/.test(g))
    check(`[${size}] L3 the header counts the agents`, /2 agents/.test(g))
  }

  // L3e — CREW TRAFFIC empty
  {
    const g = text(capture('L3-crew-empty', cols, rows, { transcript: NO_CREW, sends: [...OPEN_PANEL, then('SAVED PROMPTS', '2')], readyText: 'no agent traffic this session' }))
    check(`[${size}] L3e no agents ⇒ the honest empty line`, /no agent traffic this session/.test(g))
  }

  // L7e — SAVED PROMPTS empty (tab 3)
  {
    clearSavedPrompts()
    const g = text(capture('L7-saved-empty', cols, rows, { transcript: NO_CREW, sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3')], readyText: 'no saved prompts yet' }))
    check(`[${size}] L7e an empty list says so and teaches a`, /no saved prompts yet — a writes one/.test(g))
    check(`[${size}] L7e the footer offers a new`, /a new/.test(g))
    check(`[${size}] L7e an empty tab never advertises c clear (armed ⇔ advertised)`, !/c clear/.test(g))
  }

  // L7w — write two saved prompts, reorder with [
  {
    clearSavedPrompts()
    const g = text(
      capture('L7-saved-written', cols, rows, {
        transcript: NO_CREW,
        sends: [
          ...OPEN_PANEL,
          then('SAVED PROMPTS', '3'),
          then('no saved prompts yet', 'a'),
          then('new saved prompt', 'audit the retry ladder — MUST name file:line'),
          after(2, ENTER),
          then('written', 'a'),
          then('new saved prompt', 'write the release notes for 1.5.8'),
          after(2, ENTER),
          // A new saved prompt lands at the BOTTOM; the cursor stays where it
          // was — step down onto #2 before moving it up.
          then('release notes', DOWN),
          after(2, '['),
        ],
        readyText: 'moved #2 up',
      }),
    )
    check(`[${size}] L7w both saved prompts are listed`, /audit the retry ladder — MUST name file:line/.test(g) && /write the release notes for 1\.5\.8/.test(g))
    check(`[${size}] L7w [ reordered — the release notes now sit above the audit`, g.indexOf('write the release notes') !== -1 && g.indexOf('write the release notes') < g.indexOf('audit the retry ladder — MUST'))
    check(`[${size}] L7w the receipt names the move`, /moved #2 up/.test(g))
    check(`[${size}] L7w the footer teaches the verbs (s to composer · e edit · d delete · c clear)`, /s to composer/.test(g) && /e edit/.test(g) && /d delete/.test(g) && /c clear/.test(g))
    const files = existsSync(savedPromptsDir) ? readdirSync(savedPromptsDir) : []
    check(`[${size}] L7w the list persisted to ONE per-project JSON under the config home`, files.length === 1 && files[0]!.endsWith('.json'), files.join(', '))
    if (files.length === 1) {
      const parsed = JSON.parse(readFileSync(join(savedPromptsDir, files[0]!), 'utf8')) as { drafts: Array<{ text: string }> }
      check(`[${size}] L7w the file holds the reordered list (release notes first)`, parsed.drafts.length === 2 && parsed.drafts[0]!.text.startsWith('write the release notes'))
    }
  }

  // L7c — `c` clears the list behind ONE confirm (sheet line 7c); the list persisted from L7w
  {
    const g = text(
      capture('L7-saved-clear-confirm', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3'), then('release notes', 'c')],
        readyText: 'clear all 2 saved prompts?',
      }),
    )
    check(`[${size}] L7c the confirm paints in place before anything is wiped`, /clear all 2 saved prompts\? · ↵ clears · esc keeps them/.test(flat(g)))
    check(`[${size}] L7c the list is still there behind the confirm`, /write the release notes for 1\.5\.8/.test(g) && /audit the retry ladder — MUST/.test(g))
    check(`[${size}] L7c the row verbs are parked while the confirm owns input`, !/s to composer/.test(g) && /esc composer/.test(g))
    const g2 = text(
      capture('L7-saved-cleared', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3'), then('release notes', 'c'), then('clear all', ENTER)],
        readyText: 'no saved prompts yet',
      }),
    )
    check(`[${size}] L7c ↵ clears — the honest empty state paints`, /no saved prompts yet — a writes one/.test(g2))
    check(`[${size}] L7c the receipt says what was cleared`, /cleared 2 saved prompts — the list is empty/.test(flat(g2)))
    check(`[${size}] L7c the empty list no longer advertises c clear (armed ⇔ advertised)`, !/c clear/.test(g2))
    const files = existsSync(savedPromptsDir) ? readdirSync(savedPromptsDir) : []
    if (files.length === 1) {
      const parsed = JSON.parse(readFileSync(join(savedPromptsDir, files[0]!), 'utf8')) as { drafts: unknown[] }
      check(`[${size}] L7c on disk: the list is empty (survives a restart empty)`, parsed.drafts.length === 0)
    } else {
      check(`[${size}] L7c on disk: one per-project file`, false, files.join(', '))
    }
    // Restore the two prompts for the send leg below.
    seedSavedPrompts([
      { id: 'cc33dd', text: 'write the release notes for 1.5.8' },
      { id: 'dd44ee', text: 'audit the retry ladder — MUST name file:line' },
    ])
  }

  // L7s — `s` hands the selected saved prompt to the composer (the list re-seeded after L7c)
  {
    const g = text(
      capture('L7-saved-sent', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3'), then('release notes', 's')],
        readyText: 'write the release notes for 1.5.8',
        total: 120,
      }),
    )
    check(`[${size}] L7s the panel closed and the composer holds the saved prompt, unsent`, /write the release notes for 1\.5\.8/.test(g) && !/SAVED PROMPTS \(/.test(g))
  }

  // L7x — a hand-corrupted saved-prompts file: the tab says so in one honest
  // line (never 'reading…' for ever, never a crash) and still offers a fresh
  // write (the checker's drive found the tab stuck on the loading line).
  {
    clearSavedPrompts()
    mkdirSync(savedPromptsDir, { recursive: true })
    writeFileSync(join(savedPromptsDir, `${projectSlug(RUNTIME_CWD.normalize('NFC'))}.json`), '{"_v":1,"drafts":[{"id":"aa11bb","text":"was here" this is not json')
    const g = text(capture('L7-saved-corrupt', cols, rows, { transcript: NO_CREW, sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3')], readyText: 'could not be read' }))
    check(`[${size}] L7x a damaged file is said out loud in the tab (never 'reading…' for ever)`, /the saved-prompts file could not be read/.test(flat(g)) && /saved prompts unreadable/.test(flat(g)))
    check(`[${size}] L7x the tab still offers a (a fresh list)`, /a new/.test(g))
    check(`[${size}] L7x no crash — the panel's chrome is whole`, /SAVED PROMPTS \(0\)/.test(g) && /esc close/.test(g))
  }

  // L8u — Minerva's room without a model
  {
    clearSavedPrompts()
    seedSavedPrompts([
      { id: 'aa11bb', text: 'audit the retry ladder — MUST name file:line' },
      { id: 'bb22cc', text: 'write the release notes for 1.5.8' },
    ])
    // Observed-ready on the LIST text (it lives only in the seeded store):
    // the saved-prompts read is async, and a composer-line needle can settle
    // one tick before the list paints — catching "reading saved prompts …".
    const g = text(capture('L8-room-unset', cols, rows, { transcript: NO_CREW, sends: OPEN_ROOM, readyText: 'write the release notes for 1.5.8', env: { MERCURY_MINERVA_MODEL: undefined } }))
    check(`[${size}] L8u the room says no model is set, in one honest line`, /no Minerva model set — \/submodels pins one · your saved prompts sit as written/.test(flat(g)))
    check(`[${size}] L8u the saved prompts sit, listed`, /audit the retry ladder — MUST name file:line/.test(g) && /write the release notes for 1\.5\.8/.test(g))
    check(`[${size}] L8u the ARROW FOCUS lands on the list — the ❯ caret sits on the newest prompt`, /❯\s+2\s+write the release notes/.test(g))
    check(`[${size}] L8u the footer teaches the landed keys (↵ ask minerva to refine · ↑↓ pick · m edit in message box · esc close)`, /↵ ask minerva to refine/.test(g) && /↑↓ pick/.test(g) && /m edit in message box/.test(g) && /esc close/.test(g))
    check(`[${size}] L8u the room is shaped like the console (a message line beneath the list)`, /message minerva/.test(g))
    // The room renders below the cockpit; the TABULA rail card above it
    // (untouched by the room) still says /note — scope the needle to the
    // room's own box.
    const roomBox = g.slice(g.indexOf("Minerva's room"))
    check(`[${size}] L8u the room offers no note-leaving`, !/a add/.test(roomBox) && !/\/note/.test(roomBox))
    check(`[${size}] L8u the room names itself`, /Minerva's room/.test(g))
  }

  // L8m — Minerva's room with a model pinned (no call until ↵)
  {
    const g = text(capture('L8-room-model', cols, rows, { transcript: NO_CREW, sends: OPEN_ROOM, readyText: 'message minerva', env: { MERCURY_MINERVA_MODEL: FIXTURE_MODEL } }))
    check(`[${size}] L8m the status line names the model and the law`, new RegExp(`minerva · ${FIXTURE_MODEL.replace(/[/.]/g, '\\$&')}`).test(g) && /refines a saved prompt only when you ask · never sends anything/.test(g))
    check(`[${size}] L8m the footer says ↵ is the one billed call`, /one billed call/.test(g))
  }

  // L9 — a refinement lands BESIDE the original (loopback Minerva)
  {
    const server = spawn(process.execPath, [join(import.meta.dir, 'minerva-fixture-server.ts'), '--port', String(FIXTURE_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let serverOut = ''
    server.stdout.on('data', (c: Buffer) => {
      serverOut += c.toString('utf8')
    })
    const started = Date.now()
    while (!/listening/.test(serverOut) && Date.now() - started < 10000) {
      spawnSync('sleep', ['0.2'])
    }
    // THE BOX PATH (the ruled spec): the list lands the focus, tab reaches
    // the chat box, and a typed ask still works exactly as before.
    const g = text(
      capture('L9-room-refined', cols, rows, {
        transcript: POPULATED,
        sends: [...OPEN_ROOM, then('message minerva', TAB), then('↵ send to minerva', 'tighten prompt 2'), after(2, ENTER)],
        readyText: 'refined prompt 2',
        total: 200,
        env: {
          MERCURY_MINERVA_MODEL: FIXTURE_MODEL,
          MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${FIXTURE_PORT}/api/v1`,
          OPENROUTER_API_KEY: 'sk-or-fixture-key',
        },
      }),
    )
    check(`[${size}] L9 tab reached the box — Minerva's reply landed under the typed line`, /tighten prompt 2/.test(g) && /refined prompt 2/.test(g))
    check(`[${size}] L9 the refinement sits BESIDE prompt 2 (the refined line under it — ✦ on the selected row, ✧ elsewhere)`, /[✧✦] Refined: write the release notes for 1\.5\.8/.test(g))
    // THE LIST-↵ PATH: a fresh room, arrow focus landed on the newest
    // prompt — ↵ alone sends it to Minerva ("refine prompt 2" in the log).
    seedSavedPrompts([
      { id: 'ee55ff', text: 'audit the retry ladder — MUST name file:line' },
      { id: 'ff66aa', text: 'write the release notes for 1.5.8' },
    ])
    const gk = text(
      capture('L9-room-list-enter', cols, rows, {
        transcript: POPULATED,
        sends: [...OPEN_ROOM, then('message minerva', ENTER)],
        readyText: 'refined prompt 2',
        total: 200,
        env: {
          MERCURY_MINERVA_MODEL: FIXTURE_MODEL,
          MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${FIXTURE_PORT}/api/v1`,
          OPENROUTER_API_KEY: 'sk-or-fixture-key',
        },
      }),
    )
    // L8i — THE ESC·ESC LADDER (the operator's ruled amendment): at the
    // composer while Minerva runs a turn, ONE esc paints the again-hint and
    // does NOT interrupt; only esc·esc aborts. The awaitText ladder IS the
    // pin — the second esc fires only after the hint painted, and a
    // one-esc-abort build would never paint it (the drive would die on the
    // stuck send instead of reaching the abort note).
    const gi = text(
      capture('L8-room-esc-esc', cols, rows, {
        transcript: NO_CREW,
        sends: [
          ...OPEN_ROOM,
          then('message minerva', TAB),
          then('↵ send to minerva', 'slow: think about it'),
          after(2, ENTER),
          then('minerva thinking', ESC),
          then('esc again interrupts', ESC),
        ],
        readyText: 'aborted — nothing landed',
        total: 200,
        env: {
          MERCURY_MINERVA_MODEL: FIXTURE_MODEL,
          MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${FIXTURE_PORT}/api/v1`,
          OPENROUTER_API_KEY: 'sk-or-fixture-key',
        },
      }),
    )
    check(`[${size}] L8i one esc while Minerva runs paints the hint, esc·esc aborts — nothing landed`, /aborted — nothing landed/.test(gi))
    check(`[${size}] L8i the interrupted exchange lands no refinement reply`, !/refined prompt/.test(gi))
    // L12b — the M key STAGES, the operator's ↵ SENDS (the ruled pair,
    // through the wire): panel `m` → the room opens with the box prefilled;
    // ↵ then makes exactly ONE exchange. The awaitText '❯ <text>' (a single
    // space — the composer's own line, never the numbered list row) gates
    // the ↵ on the STAGED state, so an auto-sending build never reaches it.
    const gm = text(
      capture('L12-stage-then-send', cols, rows, {
        transcript: NO_CREW,
        sends: [
          ...OPEN_PANEL,
          then('SAVED PROMPTS', '3'),
          then('audit the retry ladder', 'm'),
          then('❯ audit the retry ladder', ENTER),
        ],
        readyText: 'I am Minerva',
        total: 200,
        env: {
          MERCURY_MINERVA_MODEL: FIXTURE_MODEL,
          MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${FIXTURE_PORT}/api/v1`,
          OPENROUTER_API_KEY: 'sk-or-fixture-key',
        },
      }),
    )
    check(`[${size}] L12b the staged text became the SENT message on the operator's own ↵ — exactly one exchange`, /❯ audit the retry ladder — MUST/.test(gm) && /I am Minerva/.test(gm) && /the conversation \(1\)/.test(gm))
    server.kill('SIGTERM')
    check(`[${size}] L9k ↵ on the landed selection asks by itself — "refine prompt 2" in the log`, /refine prompt 2/.test(gk) && /refined prompt 2/.test(gk))
    check(`[${size}] L9k the refinement landed beside the selected prompt (✦ on the selected row)`, /✦ Refined: write the release notes for 1\.5\.8/.test(gk))
    check(`[${size}] L9 prompt 2's own wording is unchanged on screen`, /2  write the release notes for 1\.5\.8/.test(g))
    check(`[${size}] L9 prompt 1 untouched (no ✧ under it)`, !/[✧✦] Refined: audit/.test(g))
    check(`[${size}] L9 the receipt says one refined, beside your wording`, /1 refined · beside your wording/.test(flat(g)))
    const files = readdirSync(savedPromptsDir)
    if (files.length === 1) {
      const parsed = JSON.parse(readFileSync(join(savedPromptsDir, files[0]!), 'utf8')) as { drafts: Array<{ id: string; text: string; refinedText?: string }> }
      check(`[${size}] L9 on disk: prompt 2 refined beside, prompt 1 byte-kept`, parsed.drafts[1]!.refinedText !== undefined && parsed.drafts[1]!.text === 'write the release notes for 1.5.8' && parsed.drafts[0]!.refinedText === undefined)
    } else {
      check(`[${size}] L9 on disk: one per-project file`, false, files.join(', '))
    }
  }

  // L8e — esc FROM THE LIST closes the room (the landed focus IS the list,
  // so one esc at open is the ruled close road).
  {
    const g = text(
      capture('L8-room-esc-close', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_ROOM, then('message minerva', ESC)],
        readyText: 'second task',
        total: 140,
      }),
    )
    check(`[${size}] L8e esc from the list closes the room — the chat is back`, !/Minerva's room/.test(g) && /second task/.test(g))
  }

  // L12a — THE M KEY STAGES, NEVER SENDS (the ruled poison = an auto-send):
  // panel `m` on a saved row opens Minerva's room with the box PREFILLED;
  // the conversation stays at ZERO exchanges. Model unset on purpose — an
  // auto-sending build would land the /submodels hint as an exchange row
  // and flunk the (0) count.
  {
    const g = text(
      capture('L12-stage-only', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_PANEL, then('SAVED PROMPTS', '3'), then('audit the retry ladder', 'm')],
        readyText: '❯ audit the retry ladder',
        env: { MERCURY_MINERVA_MODEL: undefined },
      }),
    )
    check(`[${size}] L12a m stages the prompt into the room's box — prefilled, panel closed`, /Minerva's room/.test(g) && /❯ audit the retry ladder — MUST/.test(g) && !/SAVED PROMPTS \(/.test(g))
    check(`[${size}] L12a NOTHING sent — zero exchanges until the operator's own ↵`, /the conversation \(0\)/.test(g))
    // L12c — the room's own m: list focus (newest selected) → m stages that
    // prompt; the box takes it as an editable draft, focus flips to the box.
    const gr = text(
      capture('L12-room-m', cols, rows, {
        transcript: NO_CREW,
        sends: [...OPEN_ROOM, then('write the release notes', 'm')],
        readyText: '❯ write the release notes',
        env: { MERCURY_MINERVA_MODEL: undefined },
      }),
    )
    check(`[${size}] L12c the room's own m stages the selected prompt into the box`, /❯ write the release notes for 1\.5\.8/.test(gr) && /the conversation \(0\)/.test(gr) && /↵ send to minerva/.test(gr))
  }

  // L11 — THE WORKBENCH RAIL CARD (ruled): under the Minerva (TABULA) card,
  // always carrying the operator's LAST SENT PROMPT (an honest placeholder
  // before any); activating opens /workbench. Needles are scoped to the
  // rail band (the left columns) so the transcript's own copy of the prompt
  // can never satisfy a rail assertion. At a height where the card sheds,
  // the ONE honest pointer line must name /workbench instead.
  {
    const band = (s: string): string => s.split('\n').map(l => l.slice(0, 26)).join('\n')
    // At the ruled 120x40 berth the CARD ITSELF must paint — the shed
    // pointer is the honest state only where the glass genuinely cannot
    // afford the card (100x30). The pointer-satisfied disjunction at 120x40
    // was the poison: phantom shed-billing kept the card invisible at the
    // cockpit's home size while this pin stayed green.
    const berth = cols >= 120
    const gp = band(text(capture('L11-rail-populated', cols, rows, { transcript: POPULATED, sends: [], readyText: 'ship it', total: 90 })))
    const cardShown = /WORKBENCH/.test(gp) && /ship it/.test(gp)
    const pointerShown = /more: [^\n]*\/workbench/.test(gp)
    if (berth) {
      check(`[${size}] L11 the card paints at the ruled berth and carries the LAST sent prompt`, cardShown, gp.includes('WORKBENCH') ? 'header without content' : pointerShown ? 'only the shed pointer — the card is missing at the berth' : 'no WORKBENCH in the rail band')
    } else {
      check(`[${size}] L11 the card carries the LAST sent prompt (or the honest shed pointer names /workbench)`, cardShown || pointerShown, gp.includes('WORKBENCH') ? 'header without content' : 'no WORKBENCH in the rail band')
    }
    if (cardShown) {
      check(`[${size}] L11 the card sits UNDER the Minerva card`, gp.indexOf('MINERVA') !== -1 && gp.indexOf('MINERVA') < gp.indexOf('WORKBENCH'))
    }
    const ge = band(text(capture('L11-rail-empty', cols, rows, { transcript: 'none', sends: [then('New Session', ENTER)], readyText: 'type a prompt', total: 110 })))
    // The narrow rail (100 cols) ellipsizes the placeholder honestly
    // ("no prompts sent y…"); the prefix is the stable spelling.
    const emptyShown = /WORKBENCH/.test(ge) && /no prompts sent/.test(ge)
    const emptyPointer = /more: [^\n]*\/workbench/.test(ge)
    if (berth) {
      check(`[${size}] L11e before any prompt the card says so honestly at the ruled berth`, emptyShown, ge.includes('WORKBENCH') ? 'header without placeholder' : emptyPointer ? 'only the shed pointer — the card is missing at the berth' : 'no WORKBENCH in the rail band')
    } else {
      check(`[${size}] L11e before any prompt the card says so honestly (or the shed pointer names /workbench)`, emptyShown || emptyPointer, ge.includes('WORKBENCH') ? 'header without placeholder' : 'no WORKBENCH in the rail band')
    }
  }
}

cleanupScenario('tabula-empty')
clearSavedPrompts()
console.log(`\n  captures: ${CAPTURE_DIR}`)
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-panel-captures — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)

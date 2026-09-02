#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-paste-safety.ts — pasted control sequences stay
//  INERT everywhere they can reach a screen (CN-05; the
//  class Codex CLI hardened in July 2026: "pasted control sequences can no
//  longer corrupt rendering or resumed history").
//
//  Two legs against the SHIPPED dist/mercury.mjs in a real PTY (vshot):
//
//    §1  COMPOSER ECHO — a bracketed paste carrying OSC (title + OSC 52
//        clipboard write), CSI (2J clear + SGR), and C0 bytes (BEL, BS)
//        renders as its printable payload only. The strip owner is the ONE
//        text-insert arm (stripAnsi + \r normalization in
//        src/hooks/useTextInput.ts); this leg pins the surface: printables
//        survive in order, the frame is not wiped, and the child NEVER
//        re-emits the pasted OSC payloads or the paste-adjacent 2J
//        (VSHOT_TEE raw-byte scan — the sequences arrived on stdin only).
//
//    §2  RESUMED HISTORY — a session whose PERSISTED user/assistant text
//        already carries raw control bytes (the dangerous
//        shape: whatever an old client stored must not detonate on replay)
//        boots via --resume: the transcript renders the printable payload,
//        the frame stays intact, and the raw OSC/clear sequences from
//        history are never written to the terminal.
//
//  Method laws honored: escapes (\x1b) in source, never raw bytes; scratch
//  homes via mkdtemp outside the repo; env pinned per invocation.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const BIN = 'dist/mercury.mjs'
const scratch = mkdtempSync(join(tmpdir(), 'contour-paste-safety-'))
const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-paste'

type Cell = { c: string }
const asLines = (g?: Cell[][]): string[] =>
  (g ?? []).map(row => row.map(c => c.c).join('').replace(/\s+$/, ''))

interface VshotResult {
  status: number | null
  lines: string[]
  tee: string
}

function runVshot(
  name: string,
  home: string,
  cfg: Record<string, unknown>,
): VshotResult {
  const out = join(scratch, `${name}.json`)
  const tee = join(scratch, `${name}.tee`)
  const cfgPath = join(scratch, `${name}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out }))
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
      VSHOT_TEE: tee,
    },
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
  })
  let lines: string[] = []
  try {
    lines = asLines((JSON.parse(readFileSync(out, 'utf8')) as { grid?: Cell[][] }).grid)
  } catch {
    /* reported by the exit check */
  }
  let teeRaw = ''
  try {
    teeRaw = readFileSync(tee).toString('latin1')
  } catch {
    /* reported below */
  }
  if (r.status !== 0) console.log((r.stdout ?? '').slice(-1200) + (r.stderr ?? '').slice(-1200))
  return { status: r.status, lines, tee: teeRaw }
}

function seedHome(name: string): string {
  const home = join(scratch, name)
  spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
    env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
  })
  return home
}

if (!existsSync(BIN)) {
  t.check('dist exists (build first)', false, BIN)
  t.finish('prove-paste-safety')
}

t.section('§1 — composer echo: a control-sequence paste renders printables only')
{
  const home = seedHome('home-echo')
  const PASTE =
    '\x1b[200~A1\x1b]0;PWNED-TITLE\x07\x1b[2JM2\x1b[31mR3\x1b[0m\x07\x08B4\x1b]52;c;UFdORUQ=\x07E5\x1b[201~'
  const r = runVshot('echo', home, {
    cols: 100,
    rows: 30,
    total: 90,
    argv: ['node', BIN],
    cwd: process.cwd(),
    sends: [
      // THE LANDING RULE: a bare boot lands
      // on the Boot face — ↵ on New Session enters the chat first. The old
      // single-send scene pasted at '? for shortcuts', which the face's
      // shared footer ALSO paints, so the payload typed into the face (the
      // composer-finder even matched the face's own ❯ row cursor) — the
      // chain-3 debut red. The paste now anchors on the chat-distinct
      // empty-composer placeholder.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 3, data: PASTE },
    ],
    readySettleTicks: 6,
  })
  t.check('the journey completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
  const composer = [...r.lines].reverse().find(l => l.includes('❯')) ?? ''
  t.check(
    'the composer holds the printable payload EXACTLY, in order (controls stripped)',
    composer.includes('❯ A1M2R3B4E5'),
    composer.trim() || '(no composer row)',
  )
  t.check(
    'the frame survived the paste (the 2J inside the paste never executed)',
    r.lines.some(l => l.includes('SESSION')) && r.lines.some(l => l.includes('↵ sends')),
    'chrome rows present',
  )
  t.check('tee captured child output', r.tee.length > 0, `${r.tee.length} bytes`)
  t.check(
    'the pasted OSC title is never re-emitted by the child',
    !r.tee.includes(']0;PWNED-TITLE'),
    'no ]0;PWNED-TITLE in output',
  )
  t.check(
    'the pasted OSC 52 clipboard write is never re-emitted',
    !r.tee.includes(']52;c;UFdORUQ='),
    'no ]52; payload in output',
  )
  t.check(
    'the paste-adjacent clear-screen is never replayed (A1 followed by 2J)',
    !r.tee.includes('A1\x1b[2J'),
    'no A1+CSI-2J pair in output',
  )
}

t.section('§2 — resumed history: persisted control bytes replay inert')
{
  const home = seedHome('home-resume')
  const cwd = process.cwd()
  const SID = `00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
  const projects = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projects, { recursive: true })
  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  // The persisted shape an OLD client could have stored: raw OSC/CSI/C0 in
  // both a user message and the assistant reply.
  const USER_TEXT = 'HISTA1\x1b]0;PWNED-HIST\x07\x1b[2JHISTB2\x1b[31mHISTC3\x07\x08\x1b[0m done'
  const REPLY_TEXT = 'REPLYD4\x1b]52;c;U0VDUkVU\x07REPLYE5'
  const lines = [
    base({
      parentUuid: null,
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000001',
      message: { role: 'user', content: USER_TEXT },
      timestamp: '2026-07-30T12:00:01.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-000000000001',
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000002',
      requestId: 'req_paste_hist',
      message: {
        id: 'msg_paste_hist',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: REPLY_TEXT }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-07-30T12:00:02.000Z',
    }),
  ]
  // The session file holds RECORD lines — the shape the product opens.
  writeFileSync(join(projects, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))

  const r = runVshot('resume', home, {
    cols: 100,
    rows: 35,
    total: 110,
    argv: ['node', BIN, '--resume', SID],
    cwd,
    readyText: 'REPLYE5',
    readySettleTicks: 6,
  })
  t.check('the resume completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
  const all = r.lines.join('\n')
  t.check(
    'the resumed user line renders EXACTLY its printable payload, in order (controls stripped)',
    r.lines.some(l => l.includes('❯ HISTA1HISTB2HISTC3 done')),
    r.lines.find(l => l.includes('HISTA1'))?.trim() ?? '(user line missing)',
  )
  t.check(
    'the resumed assistant reply renders its printable payload',
    all.includes('REPLYD4') && all.includes('REPLYE5'),
    r.lines.find(l => l.includes('REPLYD4'))?.trim() ?? '(reply line missing)',
  )
  // The empty post-resume composer shows its placeholder + the shortcuts
  // footer (no `↵ sends` — that copy appears only with text in the buffer).
  // The user line's own ❯ caret must NOT satisfy this check, so anchor on
  // chrome the history bytes cannot fake: header + footer.
  t.check(
    'the frame survived the replay (history 2J never executed)',
    r.lines.some(l => l.includes('SESSION')) && r.lines.some(l => l.includes('? for shortcuts')),
    'SESSION header + shortcuts footer present after replay',
  )
  t.check(
    'the historical OSC title is never written to the terminal',
    !r.tee.includes(']0;PWNED-HIST'),
    'no ]0;PWNED-HIST in output',
  )
  t.check(
    'the historical OSC 52 clipboard write is never written to the terminal',
    !r.tee.includes(']52;c;U0VDUkVU'),
    'no ]52; payload in output',
  )
  t.check(
    'the history-adjacent clear-screen is never replayed (HISTA1 followed by 2J)',
    !r.tee.includes('HISTA1\x1b[2J'),
    'no HISTA1+CSI-2J pair in output',
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-paste-safety')

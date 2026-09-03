#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-route-silence.ts — the LIVE
//  route byte-capture (boot-settings leg; §8.3's contract).
//
//  Boots the SHIPPED dist in the hermetic PTY arena, opens the in-process
//  Boot Settings route (/bootmenu ↵), returns with Esc, and asserts over the
//  ROUTE WINDOW's raw PTY bytes:
//
//    · ZERO standing DEC private-mode changes — alt-screen (1049), focus
//      (1004), bracketed paste (2004), mouse (1000-1006), alternate scroll
//      (1007), kitty/modifyOtherKeys — a route swap re-arms NOTHING;
//    · ZERO OSC writes (ground 11, title 0/2) — no ground/title churn;
//    · sync-update (2026) stays BALANCED — per-frame BSU/ESU brackets are
//      frame atomicity, not a mode change (each h pairs an l);
//    · the surface actually painted (the Boot SPLASH face — two of its
//      action rows; the settings projection lives one 's' deeper) and
//      Esc actually restored the session (receipt visible, face gone) —
//      silence without the surface would prove nothing.
//
//  Cursor show/hide (?25) is deliberately NOT zero-asserted: the declared-
//  cursor system legitimately toggles visibility inside composed frames
//  (delivery.ts patch vocabulary). The STANDING cursor obligation is proven
//  at the ledger (prove-terminal-ledger-shutdown §4/§5). Counts are recorded
//  in the failure detail either way.
//
//  The CONCOURSE legs (the full cycle) ride a second
//  arena boot below — MERCURY_CONCOURSE=always + the registered fixture
//  seam land the boot ON the concourse; the drive then cycles
//  concourse → ⇧← the Boot face → (the arena's own ↵ births the chat and
//  enters it) → ⇧← concourse → ⇧→ the chat → /concourse ↵ → concourse →
//  esc → the chat, and the same census (zero standing DEC/OSC, balanced
//  2026) runs over the WHOLE multi-swap window.
//
//  The reserved
//  chat stop retires. The legs that stepped "esc → root REPL" on a bare
//  boot walked into a chat that no longer exists (the strip counts its
//  stops from what exists — a bare boot has the menu and the concourse;
//  ⇧→ from the board with no chat is no movement), so the cycle births a
//  chat first (the arena presses ↵ on New Session the moment the face's
//  ready line shows) and every later swap moves between present stops.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { grabScreens, requireDist, runArtifactArena, visibleText, type ArenaRun } from '../streaming/artifactArena.ts'
import { referenceFixtureSnapshot } from './concourseReferenceSeed.ts'

const t = checker()
scratchRoot('route-silence')
requireDist()

// ── drive ───────────────────────────────────────────────────────────────────
//  6.5 s  type /bootmenu   (boot is long settled — b01 measured first output
//  ~0.7 s; the composer needs only the settled prompt)
//  8.0 s  ↵ submit         (route opens — CB-09: /bootmenu deep-links, so
//  the settings layer mounts OVER the canonical face)
// 10.0 s Esc (settings layer closes → the canonical face)
// 11.5 s Esc (route returns)
//  window under test: 7.6 s → end (submit → restored frame, with margin
//  before the submit so the opening paint is inside the census).

const OPEN_AT = 6500
const SUBMIT_AT = 8000
const LAYER_ESC_AT = 10000
const ESC_AT = 11500
const WINDOW_FROM = 7600

//  THE HEAL FENCE: the app re-asserts its modes on the first stdin byte after
//  a quiet spell longer than STDIN_GAP_REASSERT_MS (App.tsx, 5 s — the
//  session-wide tmux-attach / laptop-wake heal, adjudicated NOT route bytes;
//  its bytes are exactly the 1004/2004/mouse/1007 family this census counts).
//  The engine stretches every authored gap under the hosted profile (×3 on
//  the gate), so an authored 2 s station gap is 6 s there and the heal fired
//  inside the window on every later station — one full re-assert per station,
//  the hosted red. A focus-in report between stations keeps every quiet spell
//  under the threshold on every profile (1.4 s authored ⇒ 4.2 s at ×3); the
//  app's focus-in road stamps a time and emits its focus event — it writes
//  nothing to the terminal, and it is not a key on any surface.
const HEAL_FENCE_EVERY_MS = 1400
const healFence = (fromMs: number, toMs: number): string[] => {
  const out: string[] = []
  for (let at = fromMs; at < toMs; at += HEAL_FENCE_EVERY_MS) out.push(`${at}:\x1b[I`)
  return out
}

const run: ArenaRun = await runArtifactArena({
  turns: [],
  // Send specs carry the runtime CR/ESC bytes (TS escapes in source;
  // ptydrive's unescape passes raw control bytes through unchanged).
  sends: [
    `${OPEN_AT}:/bootmenu`,
    `${SUBMIT_AT}:\r`,
    `${LAYER_ESC_AT}:\x1b`,
    `${ESC_AT}:\x1b`,
    `${ESC_AT + 1500}:\x1b`,
    ...healFence(OPEN_AT + 850, ESC_AT + 1500),
  ],
  seconds: 16,
  cols: 120,
  rows: 36,
  keep: true,
})

interface DriveEntry {
  ts?: number
  b64?: string
  /** Present on ptydrive's send records. */
  sent?: number
  atMs?: number
}

try {
  const entries: DriveEntry[] = []
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as DriveEntry)
    } catch {
      /* torn tail line */
    }
  }
  const chunks = entries
    .filter(e => typeof e.ts === 'number' && typeof e.b64 === 'string')
    .map(e => ({ ts: e.ts as number, text: Buffer.from(e.b64 as string, 'base64').toString('latin1') }))
  // Window anchor (sanity-fork #1 finding 1): the SUBMIT keystroke's own
  // `sent` stamp — anchoring on first-output drifted the window open ~300 ms
  // AFTER the submit, letting the route-OPEN transition's first bytes escape
  // the census. A small pre-submit margin keeps the echo covered too.
  const sentStamps = entries.filter(
    (e): e is DriveEntry & { sent: number; atMs: number } =>
      typeof (e as { sent?: unknown }).sent === 'number' && typeof (e as { atMs?: unknown }).atMs === 'number',
  )
  // The drive record's atMs is the SCALED schedule (the engine stretches the
  // timeline under the hosted profile), so the identity match and the
  // drive-relative fallback ride the same knob.
  const submitSent = sentStamps.find(e => e.atMs === S(SUBMIT_AT))?.sent
  const base = chunks.length ? chunks[0]!.ts : 0
  const windowStart = submitSent !== undefined ? submitSent - 200 : base + S(WINDOW_FROM)
  const windowText = chunks
    .filter(c => c.ts >= windowStart)
    .map(c => c.text)
    .join('')

  t.section('§1 — the surface painted and returned (silence needs a live subject)')
  {
    // visibleText strips inter-cell spacing — needles compare space-blind.
    const squash = (rows: { rows: unknown[] } | undefined): string =>
      ((rows?.rows ?? []) as Parameters<typeof visibleText>[0][]).map(visibleText).join('\n').replace(/\s+/g, '')
    // OBSERVED-READY open grab (the same F2 recipe §3 got — §1 carried the
    // identical fixed-tick class and bit on: submit/open/receipt
    // all HAPPENED, the fixed +1.6 s frame just missed the paint). First
    // rung from the CAUSAL submit stamp where the surface painted WHOLE
    // (header + the registry's menu row); rungs past ESC_AT are naturally
    // skipped by the predicate; a never-completing paint keeps the deadline
    // frame and the assertions below still fail it.
    const openFrom = submitSent !== undefined ? submitSent - base : S(SUBMIT_AT)
    const OPEN_LADDER = [400, 800, 1200, 1600, 2000, 2400, 3200, 4800, 7000, 10_000].map(d => S(d))
    // The boot-settings route paints the CANONICAL face; the
    // /bootmenu entry deep-links INTO the settings layer (CB-09), so the
    // WHOLE-face needles — two independent card rows (squashed,
    // face-unique; the settings projection paints neither) — land on the
    // rungs AFTER the first esc reveals the face beneath. The rows are the
    // seven-row card's own (splash-core assembleCardRows): the New Session
    // row's context `start fresh here` and the Boot Menu row's `configure
    // boot env`.
    const openReady = (s: string): boolean => s.includes('startfreshhere') && s.includes('configurebootenv')
    const openOffsets = OPEN_LADDER.map(d => Math.round(openFrom + d))
    const grabbed1 = grabScreens(run, 120, 36, [...openOffsets, -1])
    const byAt1 = new Map(grabbed1.map(g => [g.atMs, squash(g)]))
    const openRungs = openOffsets.map(o => byAt1.get(o)).filter((s): s is string => s !== undefined)
    const open = openRungs.find(openReady) ?? openRungs[openRungs.length - 1]!
    const final = byAt1.get(-1)!
    t.check('the canonical Boot face painted on the route (settings esc → face)', open.includes('startfreshhere'), open.slice(0, 200) || '(blank)')
    t.check('a second card action row painted (the face came WHOLE)', open.includes('configurebootenv'), 'action row needle')
    t.check('the second Esc restored the session frame (the face gone)', !final.includes('startfreshhere'), final.slice(0, 200) || '(blank)')
    t.check('the route receipt reached the transcript', final.includes('BootSettingsopened'), 'receipt needle')
  }

  t.section('§2 — zero standing DEC/OSC mode changes across the route window')
  {
    const standing: Record<string, RegExp> = {
      'alt-screen (1049)': /\x1b\[\?1049[hl]/g,
      'focus-events (1004)': /\x1b\[\?1004[hl]/g,
      'bracketed-paste (2004)': /\x1b\[\?2004[hl]/g,
      'mouse (1000-1006)': /\x1b\[\?100[0-6][hl]/g,
      'alt-scroll (1007)': /\x1b\[\?1007[hl]/g,
      'kitty-kbd (push/pop)': /\x1b\[[<>=]\d*u/g,
      'modifyOtherKeys': /\x1b\[>4(;\d+)?m/g,
      'ground OSC 11': /\x1b\]11;/g,
      'title OSC 0/2': /\x1b\][02];/g,
    }
    for (const [name, re] of Object.entries(standing)) {
      const hits = windowText.match(re) ?? []
      t.check(`${name}: ZERO writes in the route window`, hits.length === 0, `${hits.length} hit(s)`)
    }
    const bsu = (windowText.match(/\x1b\[\?2026h/g) ?? []).length
    const esu = (windowText.match(/\x1b\[\?2026l/g) ?? []).length
    t.check('sync-update (2026) stays balanced (frame brackets, not a mode change)', bsu === esu, `h=${bsu} l=${esu}`)
    const hide = (windowText.match(/\x1b\[\?25l/g) ?? []).length
    const show = (windowText.match(/\x1b\[\?25h/g) ?? []).length
    t.check('cursor toggles recorded (declared-cursor frame chrome — informational)', true, `hide=${hide} show=${show}`)
  }
} finally {
  run.cleanup()
}

// ── the concourse legs ─────────────────────────────────
//  Boot lands ON the concourse ('always' + the fixture seam). The census
//  window opens just before the FIRST route swap (⇧←) — §8.3 scopes the
//  silence contract to AFTER the initial takeover.

//  WARM_AT absorbs the >5s stdin-gap terminal heal (App.tsx
//  STDIN_RESUME_GAP_MS: idle+keypress re-asserts mouse/alt-scroll — a
//  SESSION-WIDE tmux-attach/laptop-wake feature that fires on any first key
//  after boot silence, route or no route; adjudicated NOT route bytes). A
//  harmless rail ↓ eats it BEFORE the census window; every later gap is
//  under the threshold, so the window sees only what the ROUTE SWAPS emit.
const WARM_AT = 6000
//  B_AT: ⇧← concourse → the Boot face. The arena's observed-ready ↵ (150 ms
//  after the face's ready line) presses New Session: the ONE birth door
//  creates the chat and enters it — from here a chat stop exists.
const B_AT = 7000
//  LEFT_AT: ⇧← the chat → the concourse (the strip's own move; no token).
const LEFT_AT = 10000
//  RIGHT_AT: ⇧→ the concourse → the focused chat (the stop the birth made;
//  on a bare board this chord would not move).
const RIGHT_AT = 12000
//  WAKE_AT: the chat just regained the frame at RIGHT_AT — the first
//  keypress after an idle-parked stretch can be EATEN by parked commits
//  (the recorded input-path class), which under pool load turned the '/'
//  of /concourse into a swallowed byte and the submit into a no-op. A
//  sacrificial space+backspace pair wakes the composer first.
const WAKE_AT = 13400
const WAKE_BS_AT = 13800
const CMD_AT = 14200
const CMD_SUBMIT_AT = 15700
const ESC3_AT = 18200

const fixtureDir = mkdtempSync(join(tmpdir(), 'route-silence-concourse-'))
const fixturePath = join(fixtureDir, 'concourse-fixture.json')
writeFileSync(fixturePath, JSON.stringify(referenceFixtureSnapshot()))

const crun: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [
    `${WARM_AT}:\x1b[B`,
    `${B_AT}:\x1b[1;2D`,
    `${LEFT_AT}:\x1b[1;2D`,
    `${RIGHT_AT}:\x1b[1;2C`,
    `${WAKE_AT}: `,
    `${WAKE_BS_AT}:\x7f`,
    `${CMD_AT}:/concourse`,
    `${CMD_SUBMIT_AT}:\r`,
    // Flake-hardened (the parked-commit input class): a wake ↓
    // absorbs a possible post-entry eat, and the esc under test is sent
    // TWICE a beat apart — the law is 'esc exits'; a second esc on the
    // revealed chat is a no-op, so the double-send can never overshoot.
    `${ESC3_AT - 800}:\x1b[B`,
    `${ESC3_AT}:\x1b`,
    `${ESC3_AT + 900}:\x1b`,
    // The heal fence (see the first leg): every quiet spell between the
    // stations stays under the app's re-assert threshold on every profile.
    ...healFence(B_AT + 350, ESC3_AT + 900),
  ],
  seconds: 26,
  cols: 142,
  rows: 38,
  keep: true,
  // A concourse boot never paints the chat composer's placeholder, so the
  // arena's default state anchor would HOLD every fixed-ms send from the
  // nominal onward — nothing typed, every station the concourse. Null runs
  // the schedule as authored; the face's observed-ready ↵ is unaffected.
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir, 'crew'),
  },
})

try {
  const entries: DriveEntry[] = []
  for (const line of readFileSync(crun.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as DriveEntry)
    } catch {
      /* torn tail line */
    }
  }
  const chunks = entries
    .filter(e => typeof e.ts === 'number' && typeof e.b64 === 'string')
    .map(e => ({ ts: e.ts as number, text: Buffer.from(e.b64 as string, 'base64').toString('latin1') }))
  const sentStamps = entries.filter(
    (e): e is DriveEntry & { sent: number; atMs: number } =>
      typeof (e as { sent?: unknown }).sent === 'number' && typeof (e as { atMs?: unknown }).atMs === 'number',
  )
  const bSent = sentStamps.find(e => e.atMs === B_AT)?.sent
  const base = chunks.length ? chunks[0]!.ts : 0
  const windowStart = bSent !== undefined ? bSent - 200 : base + B_AT
  const windowText = chunks
    .filter(c => c.ts >= windowStart)
    .map(c => c.text)
    .join('')

  t.section('§3 — the concourse cycle painted every station (subjects)')
  {
    const squash = (rows: { rows: unknown[] } | undefined): string =>
      ((rows?.rows ?? []) as Parameters<typeof visibleText>[0][]).map(visibleText).join('\n').replace(/\s+/g, '')
    // OBSERVED-READY station grabs (the two-phase paint law;
    // pooled red: fixed "+1.5 s" offsets sized for solo lag missed the
    // BOOTSETTINGS paint under full-machine pool load and cascaded).
    // Each station takes the FIRST rung of a bounded ladder from its CAUSAL
    // send stamp (output clock; spawn-clock fallback when a stamp is
    // missing) where its READY predicate holds; a station that never
    // becomes ready keeps its last-rung deadline frame, so the assertions
    // below still fail it — same needles, same teeth, no tolerance widened.
    // Absence predicates carry a non-blank floor: a mid-swap blank frame
    // can never satisfy them vacuously.
    const sentRel = (atMs: number): number => {
      const st = sentStamps.find(e => e.atMs === atMs)?.sent
      return st !== undefined ? st - base : atMs
    }
    const LADDER = [400, 800, 1200, 1600, 2200, 3000, 4200, 6000, 8000, 10_000]
    const NONBLANK = 200
    // A chat on screen: the focused chat's status row ("⇧← back") or the
    // composer's placeholder ("Type a prompt"), whitespace squashed.
    const isChat = (s: string): boolean => s.includes('⇧←back') || s.includes('Typeaprompt')
    const stations: Array<{ from: number; ready: (s: string) => boolean }> = [
      { from: 0, ready: s => s.includes('SESSIONCONCOURSE') },
      // ⇧← lands the Boot face; the arena's ↵ on New Session births the
      // chat and enters it — the SETTLED station is the chat (the face is
      // a ~150 ms stop on the way).
      { from: sentRel(B_AT), ready: s => isChat(s) && !s.includes('SESSIONCONCOURSE') },
      { from: sentRel(LEFT_AT), ready: s => s.includes('SESSIONCONCOURSE') },
      { from: sentRel(RIGHT_AT), ready: s => isChat(s) && !s.includes('SESSIONCONCOURSE') },
      { from: sentRel(CMD_SUBMIT_AT), ready: s => s.includes('SESSIONCONCOURSE') },
      { from: sentRel(ESC3_AT), ready: s => !s.includes('SESSIONCONCOURSE') && s.length >= NONBLANK },
    ]
    // screengrab.py SORTS its stops and returns screens in SORTED order —
    // rungs must be matched back by their atMs tag, never by input position
    // (station-major position slicing shuffled frames across stations).
    const offsets = stations.flatMap(st => LADDER.map(d => Math.round(st.from + d)))
    const byAt = new Map(grabScreens(crun, 142, 38, offsets).map(g => [g.atMs, squash(g)]))
    const picked = stations.map(st => {
      const mine = LADDER.map(d => byAt.get(Math.round(st.from + d))).filter((s): s is string => s !== undefined)
      return mine.find(st.ready) ?? mine[mine.length - 1]!
    })
    const [boot, afterB, afterLeft, afterRight, afterCmd, final] = picked
    t.check("the boot LANDED on the concourse ('always' + registration ordering)", boot!.includes('SESSIONCONCOURSE'), boot!.slice(0, 160) || '(blank)')
    t.check('⇧← opened the Boot face over it and the arena\'s ↵ on New Session birthed and entered the chat (the strip\'s left stop, then the one birth door)', isChat(afterB!) && !afterB!.includes('SESSIONCONCOURSE'), afterB!.slice(0, 160) || '(blank)')
    t.check('⇧← from the chat is the concourse (the strip\'s own move — no return token)', afterLeft!.includes('SESSIONCONCOURSE') && !isChat(afterLeft!), afterLeft!.slice(0, 160) || '(blank)')
    t.check('⇧→ from the concourse re-enters the focused chat (the stop the birth created; a bare board would not move)', isChat(afterRight!) && !afterRight!.includes('SESSIONCONCOURSE'), afterRight!.slice(0, 160) || '(blank)')
    t.check('/concourse ↵ re-entered the surface (the command entry)', afterCmd!.includes('SESSIONCONCOURSE'))
    t.check('the final esc restored the chat again (home is the focused chat; repeat cycles hold)', !final!.includes('SESSIONCONCOURSE'))
  }

  t.section('§4 — zero standing DEC/OSC across the WHOLE multi-swap window')
  {
    const standing: Record<string, RegExp> = {
      'alt-screen (1049)': /\x1b\[\?1049[hl]/g,
      'focus-events (1004)': /\x1b\[\?1004[hl]/g,
      'bracketed-paste (2004)': /\x1b\[\?2004[hl]/g,
      'mouse (1000-1006)': /\x1b\[\?100[0-6][hl]/g,
      'alt-scroll (1007)': /\x1b\[\?1007[hl]/g,
      'kitty-kbd (push/pop)': /\x1b\[[<>=]\d*u/g,
      'modifyOtherKeys': /\x1b\[>4(;\d+)?m/g,
      'ground OSC 11': /\x1b\]11;/g,
      'title OSC 0/2': /\x1b\][02];/g,
    }
    for (const [name, re] of Object.entries(standing)) {
      const hits = windowText.match(re) ?? []
      t.check(`${name}: ZERO writes across six route swaps (the birth's route flip included)`, hits.length === 0, `${hits.length} hit(s)`)
    }
    const bsu = (windowText.match(/\x1b\[\?2026h/g) ?? []).length
    const esu = (windowText.match(/\x1b\[\?2026l/g) ?? []).length
    t.check('sync-update (2026) stays balanced across the cycle', bsu === esu, `h=${bsu} l=${esu}`)
  }
} finally {
  crun.cleanup()
  rmSync(fixtureDir, { recursive: true, force: true })
}

t.finish('prove-route-silence')

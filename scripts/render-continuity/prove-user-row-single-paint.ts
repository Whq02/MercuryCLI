#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/prove-user-row-single-paint.ts — the ONE-USER-ROW LAW.
//
//  A submitted prompt has TWO writers: the optimistic echo placeholder
//  (REPL.tsx userInputOnProcessing → createEchoMessage, appended to
//  displayedMessages) and the committed transcript row (runQuery →
//  setMessages → Messages). The dedupe seam between them is the echo
//  baseline gate (echoBaselineRef + the echoActive count clause). This
//  prover pins the law the operator's duplicate-row report (
//  older build) violated: EVERY frame of a submitted turn paints the
//  prompt text on EXACTLY ONE transcript row — from first paint through
//  settlement, with no gap frame where the typed line vanishes.
//
//  Scenes (packaged dist, PTY, fixture provider — the real submit path):
//    A paced stream + held settle — the pre-settle overlap window where the
//      committed row lands while the echo is still eligible (the deferred
//      catch-up render is the historical double-paint frame);
//    B error turn (401 authentication_error) — the not-logged-in class: the
//      turn fails fast and the settle path must retire the echo exactly
//      once, never leaving a pair;
//    C queued follow-up — a second prompt submitted mid-turn drains through
//      the command queue and must land as one row too (its composer queue
//      chip is composer chrome, excluded by the transcript-row shape).
//
//  Cross-provider turns (the report named both providers): covered by the
//  seam's position, not a GPT-wire scene — both writers act BEFORE provider
//  dispatch (runQuery appends newMessages ahead of any codec; the gate reads
//  only transcript length + isHumanTurn), so provider choice can only vary
//  settle timing, which scenes A (held settle) and B (fail-fast) bracket.
//
//  Scene D pins the SUBMISSION side of the same operator report (the keys
//  finder's root cause): Enter has two listeners — the raw text input
//  (child-first, so registered AHEAD of the typeahead; its
//  stopImmediatePropagation cannot fence it) and the completion menu's
//  accept. With a SELF-SUBMITTING menu open (command names), one Enter used
//  to submit twice: the raw buffer executed first ('/mod' → the junk
//  'Unknown skill: mod' row) and the accepted completion ('/model') queued
//  behind it. The law: one Enter with the menu open = ONE execution — the
//  accepted command runs (the picker mounts), no junk-prefix execution, no
//  queue operation for the duplicate.
//
//  Scenes F and G pin two more one-Enter-one-send laws. F — a draft with
//  TRAILING whitespace is cleared by its submission: the composer trims
//  before submitting, so the REPL's "still what was submitted" clear must
//  ignore trailing whitespace too, or the sent line stays in the composer
//  for a second Enter (a second row carrying the same text). G — two return
//  atoms in ONE stdin chunk (a held key's coalesced repeat) submit once:
//  the composer's same-dispatch fence refuses the second, never a duplicate
//  queued behind the first reservation.
//
//  The row shape: a transcript user row carries the ❯ prompt sigil with the
//  text; the composer's own draft line is excluded by requiring the row to
//  NOT be the composer (the composer paints inside the input frame with the
//  caret cell, and after \r the draft is cleared same-write anyway).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { runPulseArena } = await import('../pulse/lib/pulseArena.ts')
const { checker } = await import('../engine-durability/harness.ts')
type ScriptedTurn = import('../lib/fixtureApi.ts').ScriptedTurn

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')
const t = checker()
const DUMP = process.env.SINGLE_PAINT_DUMP === '1'

type Frame = { atMs: number; rows: string[] }

type Scene = {
  name: string
  probes: string[]
  turns: ScriptedTurn[]
  sends: string[]
  seconds: number
  /** Lattice tail after the LAST probe send's recorded moment (authored ms). */
  tailMs: number
  grabStep: number
}

// STATE-ANCHORED sends (ptydrive's after: form — proof-hygiene) with
// SEND-DERIVED lattices: the old fixed schedule ('2000:\r' face-↵, probe at
// 6000) raced today's heavier cockpit boot even locally at scale 1 — a
// swallowed probe left 'paints at all' red with nothing submitted. The
// face-↵ waits for the face's own card row; each probe waits for the chat
// composer's placeholder; and the grab lattice anchors on the probe send's
// RECORDED moment in the drive log (screengrab offsets are relative to the
// first output chunk), so the frames bracket the same authored window
// wherever the boot lands. Graces and spans ride the hosted knob.
const scenes: Scene[] = [
  {
    name: 'A paced stream + held settle (the pre-settle overlap window)',
    probes: ['duplicate paint probe'],
    turns: [
      { kind: 'paced', deltas: ['alpha stream body. ', 'bravo stream body. ', 'charlie stream body. ', 'delta stream body. '], gapMs: 400, settleDelayMs: 2000 },
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:duplicate paint probe\\r'],
    seconds: 20,
    tailMs: 7050,
    grabStep: 150,
  },
  {
    name: 'B error turn (401 — the not-logged-in class)',
    probes: ['errored paint probe'],
    turns: [
      { kind: 'error', status: 401, errorType: 'authentication_error', message: 'OAuth token has expired.' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:errored paint probe\\r'],
    seconds: 16,
    tailMs: 4420,
    grabStep: 120,
  },
  {
    name: 'C queued follow-up (submit during an active turn)',
    probes: ['duplicate paint probe', 'queued follow probe'],
    turns: [
      { kind: 'paced', deltas: ['alpha stream body. ', 'bravo stream body. ', 'charlie stream body. ', 'delta stream body. '], gapMs: 500, settleDelayMs: 1500 },
      { kind: 'text', text: 'Follow answer.' },
      { kind: 'text', text: 'Spare.' },
    ],
    // The follow-up anchors on the stream's FIRST delta so it queues into a
    // genuinely active turn (the paced stream holds ~3.5s + the settle).
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:duplicate paint probe\\r', 'after:alpha stream body.:700:queued follow probe\\r'],
    seconds: 22,
    tailMs: 7750,
    grabStep: 150,
  },
  {
    name: 'F trailing-whitespace draft (one Enter clears the composer)',
    probes: ['trailing space probe'],
    turns: [
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    // The draft carries a trailing space; the transcript row reads the
    // trimmed text, and the composer must be EMPTY afterwards — never a
    // second row holding the same text for a second Enter.
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:trailing space probe \\r'],
    seconds: 16,
    tailMs: 3150,
    grabStep: 150,
  },
  {
    name: 'G two return atoms in ONE chunk (a held key) = ONE submission',
    probes: ['double enter probe'],
    turns: [
      { kind: 'text', text: 'Spare.' },
      { kind: 'text', text: 'Spare.' },
    ],
    // Both CRs land in one stdin read and dispatch back-to-back before the
    // REPL's clear has run; the buggy shape sent the draft twice (the
    // second queued behind the first's reservation) — two identical rows.
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:double enter probe\\r\\r'],
    seconds: 18,
    tailMs: 5150,
    grabStep: 150,
  },
]

/** The first output chunk's epoch ts — screengrab's zero. */
function driveZero(drivePath: string): number {
  for (const line of readFileSync(drivePath, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line) as { ts?: number }
      if (typeof r.ts === 'number') return r.ts
    } catch {
      /* not a record */
    }
  }
  return 0
}

/** Drive-relative ms of the send whose payload contains `needle`. */
function sendOffOf(sendLog: Array<{ sent: number; b64: string }>, needle: string, zero: number): number | null {
  const hit = sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').includes(needle))
  return hit ? hit.sent - zero : null
}

/** Transcript-row hits for a probe: rows carrying the text OUTSIDE the
 *  composer. The composer draft renders inside the bordered input frame —
 *  its row carries the frame's vertical border glyph │ at the left edge
 *  before the caret cell; a transcript user row starts flush (❯ text).
 *  The queued-commands chip also lives inside that frame. */
function transcriptHits(rows: string[], probe: string): number[] {
  const hits: number[] = []
  const sigiled = new RegExp(`❯[^│]*${probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  rows.forEach((row, index) => {
    if (!row.includes(probe)) return
    // Only prompt-sigil rows count: the transcript user row ([user] ❯ text)
    // and the composer draft (│❯ text) — the PAIR the one-row law
    // adjudicates. The product now lawfully echoes the prompt words on
    // OTHER surfaces too (the ◐ status strip, rail tile titles); counting
    // those turned every submit into a phantom double-paint (run 2's
    // "doubled at 6150ms" and this box at scale 1 alike).
    if (!sigiled.test(row)) return
    hits.push(index)
  })
  return hits
}

for (const scene of scenes) {
  const run = await runPulseArena({
    turns: scene.turns,
    sends: scene.sends,
    seconds: scene.seconds,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section(scene.name)
  // Every declared send must have DELIVERED (an after: send whose needle
  // never paints silently never fires — the journey must refuse, not
  // shorten): the drive log is the receipt.
  t.check(`the journey ran whole (${scene.sends.length} sends delivered)`, run.sendLog.length === scene.sends.length, `${run.sendLog.length}/${scene.sends.length}`)
  const zero = driveZero(run.paths.drive)
  const probeOffs = scene.probes
    .map(p => sendOffOf(run.sendLog, p, zero))
    .filter((v): v is number => v !== null)
  if (probeOffs.length !== scene.probes.length) {
    t.check('every probe send is in the drive log', false, `${probeOffs.length}/${scene.probes.length}`)
    run.cleanup()
    continue
  }
  const offsets: string[] = []
  // Send-derived lattice: from just after the FIRST probe's recorded moment
  // to the authored tail after the LAST — graces and spans ride the hosted
  // knob; the anchor is the recorded truth, immune to boot variance.
  const from = Math.min(...probeOffs) + S(150)
  const to = Math.max(...probeOffs) + S(scene.tailMs)
  for (let ms = from; ms <= to; ms += S(scene.grabStep)) offsets.push(String(Math.round(ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
    run.cleanup()
    continue
  }
  const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
  const final = screens[screens.length - 1]!
  const timed = screens.filter(f => f.atMs !== -1)

  for (const probe of scene.probes) {
    const frames = [...timed, final]
    const firstPaintIdx = frames.findIndex(f => transcriptHits(f.rows, probe).length > 0)
    t.check(`「${probe}」 paints at all`, firstPaintIdx !== -1)
    if (firstPaintIdx === -1) continue
    let doubled: Frame | null = null
    let gap: Frame | null = null
    for (const f of frames.slice(firstPaintIdx)) {
      const hits = transcriptHits(f.rows, probe)
      if (hits.length > 1 && doubled === null) doubled = f
      if (hits.length === 0 && gap === null) gap = f
      if (DUMP) {
        console.log(`  frame@${f.atMs} 「${probe}」 x${hits.length}`)
        for (const h of hits) console.log(`      row${h}: ${f.rows[h]!.trimEnd()}`)
      }
    }
    if (doubled) {
      console.log(`  DOUBLED frame@${doubled.atMs}:`)
      for (const h of transcriptHits(doubled.rows, probe)) {
        console.log(`      row${h}: ${doubled.rows[h]!.trimEnd()}`)
      }
    }
    t.check(`「${probe}」 paints on EXACTLY ONE row in every frame from first paint to final`, doubled === null, doubled ? `doubled at ${doubled.atMs}ms` : '')
    t.check(`「${probe}」 never vanishes after first paint (no gap frame)`, gap === null, gap ? `gone at ${gap.atMs}ms` : '')
  }
  run.cleanup()
}

// ── scene D · one Enter with the completion menu open = ONE execution ──────
{
  const { readdirSync, readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const run = await runPulseArena({
    turns: [
      { kind: 'text', text: 'Spare one.' },
      { kind: 'text', text: 'Spare two.' },
    ],
    // '/mod' leaves the command menu OPEN (fuzzy prefix); Enter arrives as
    // its own send with the menu unmistakably up (state-anchored like the
    // lattice scenes: face-↵ on the card row, the type on the placeholder,
    // the accept a beat later).
    sends: ['after:New Session:800:\\r', 'after:Type a prompt:900:/mod', 'after:Type a prompt:2100:\\r'],
    seconds: 17,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section('D menu-open slash Enter (one execution, no duplicate)')
  t.check('the journey ran whole (3 sends delivered)', run.sendLog.length === 3, `${run.sendLog.length}/3`)
  const dZero = driveZero(run.paths.drive)
  const acceptOff = sendOffOf(run.sendLog, '/mod', dZero)
  const dMid = acceptOff !== null ? String(Math.round(acceptOff + S(2800))) : '-1'
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', dMid, '-1'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    const anyFrameHas = (needle: string): boolean =>
      screens.some(f => f.rows.some(r => r.includes(needle)))
    t.check(
      'the accepted command EXECUTED (the /model picker is on screen)',
      anyFrameHas('CHOOSE A MODEL'),
    )
    t.check(
      'no junk raw-prefix execution painted (no Unknown-skill row)',
      !anyFrameHas('Unknown skill'),
    )
  }
  // The session log is the execution ledger: the buggy shape wrote the raw
  // execution's junk row plus an enqueue/dequeue pair for the duplicate.
  let logText = ''
  const projectsRoot = join(run.paths.home, '.claude', 'projects')
  if (existsSync(projectsRoot)) {
    for (const dir of readdirSync(projectsRoot)) {
      const pdir = join(projectsRoot, dir)
      for (const f of readdirSync(pdir)) {
        if (f.endsWith('.jsonl')) logText += readFileSync(join(pdir, f), 'utf8')
      }
    }
  }
  t.check('the session log records no Unknown-skill execution', !logText.includes('Unknown skill'))
  t.check(
    'the session log records no queued duplicate submission',
    !(logText.includes('"operation":"enqueue"') && logText.includes('/model')),
  )
  run.cleanup()
}

// ── scene E · rail compose one-owner (the tab-then-type leak) ──────────────
{
  const run = await runPulseArena({
    turns: [{ kind: 'text', text: 'Spare.' }],
    // Tab moves helm focus into the lanes rail (telemetry folds at this
    // width); typing begins the minerva compose. The law: every keystroke
    // has ONE owner — the compose line paints the text, the main composer
    // stays on its placeholder (the raw buffer's focus prop gates off helm
    // focus; its listener registers child-first, so propagation-stopping in
    // the rail arm alone could never fence it). Esc returns home; typing
    // then belongs to the composer alone.
    sends: [
      'after:New Session:800:\\r',
      'after:Type a prompt:900:\t',
      'after:Type a prompt:1600:railprobe',
      `after:Type a prompt:3400:${String.fromCharCode(27)}`,
      `after:Type a prompt:4000:${String.fromCharCode(27)}`,
      'after:Type a prompt:4700:composerprobe',
    ],
    seconds: 18,
    cols: 120,
    rows: 40,
    keep: true,
  })
  t.section('E rail compose one-owner (tab-then-type)')
  t.check('the journey ran whole (6 sends delivered)', run.sendLog.length === 6, `${run.sendLog.length}/6`)
  const eZero = driveZero(run.paths.drive)
  const railOff = sendOffOf(run.sendLog, 'railprobe', eZero)
  const composerOff = sendOffOf(run.sendLog, 'composerprobe', eZero)
  const offsets: string[] = []
  if (railOff !== null) for (let ms = railOff + S(500); ms <= railOff + S(2000); ms += S(300)) offsets.push(String(Math.round(ms)))
  if (composerOff !== null) for (let ms = composerOff + S(1600); ms <= composerOff + S(2600); ms += S(500)) offsets.push(String(Math.round(ms)))
  offsets.push('-1')
  const grab = spawnSync(
    '/usr/bin/python3',
    [SCREENGRAB, run.paths.drive, '120', '40', ...offsets],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (grab.status !== 0) {
    t.check('screengrab ran', false, grab.stderr)
  } else {
    const { screens } = JSON.parse(grab.stdout) as { screens: Frame[] }
    const count = (f: Frame, needle: string): number =>
      f.rows.filter(r => r.includes(needle)).length
    const railFrames = screens.filter(f => count(f, 'railprobe') > 0)
    t.check('the rail compose received the typed text', railFrames.length > 0)
    const railDoubled = railFrames.find(f => count(f, 'railprobe') > 1)
    if (railDoubled) {
      for (const r of railDoubled.rows) {
        if (r.includes('railprobe')) console.log(`      leak row: ${r.trimEnd()}`)
      }
    }
    t.check(
      'rail-compose keystrokes paint in EXACTLY ONE place (no composer leak)',
      railDoubled === undefined,
      railDoubled ? `doubled at ${railDoubled.atMs}ms` : '',
    )
    const composerFrames = screens.filter(f => count(f, 'composerprobe') > 0)
    t.check('the composer received the post-Esc typing', composerFrames.length > 0)
    const composerDoubled = composerFrames.find(f => count(f, 'composerprobe') > 1)
    t.check(
      'composer keystrokes paint in EXACTLY ONE place (no rail leak)',
      composerDoubled === undefined,
      composerDoubled ? `doubled at ${composerDoubled.atMs}ms` : '',
    )
    const final = screens[screens.length - 1]!
    t.check('the exited compose leaves no residue in the final frame', count(final, 'railprobe') === 0)
  }
  run.cleanup()
}

t.finish('prove-user-row-single-paint')

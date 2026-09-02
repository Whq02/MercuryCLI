#!/usr/bin/env node
/* ============================================================================
   mercury-splash.mjs — the Mercury ENTER SCREEN (launcher splash).

   Ground-up rebuild around the Mercury head logo (the operator's reference):
   the winged-helmet profile in cream with the red band, the thin
   red rule carrying the (>_) terminal sigil, and the pixel MERCURY wordmark.

   FIDELITY: the grids below are EXTRACTED 1:1 from the reference PNG
   (scripts/splash/extract-logo.py), not drawn by hand. The head is a TONE
   GRID: the source image supersampled at the target cell resolution and
   POSTERIZED onto the brand ramp — cream #F0E8D6 · mid-cream #B3AC9C ·
   TERRA red #DD4444 · deep red #7B3232 — then despeckled. (Two earlier
   approaches were tried and CUT: hard binary pixels exposed ragged extraction
   edges; continuous-tone AA read as muddy grey in real terminals. Posterized
   downscaling reads as deliberate pixel-art shading.) Two baked sizes: STD
   (fits 80×30) and LG (tall terminals); the wordmark is the hard-pixel
   extraction at the reference's own art grid.

   BEHAVIOUR (one menu, one seam):
     · FULLSCREEN boots are ANIMATION-FIRST: paint the settled hero frame
       (the flat NIGHT ground + placed hero + the ready line — no card, no
       strip, no stop), auto-run the code trace on the next tick, exit 0 into the
       held handoff. ↵ fast-forwards the trace; ^C cancels (130); every
       other byte is inert. The ORIGINAL 7-row card + strip land IN-PROCESS
       on the runtime Boot face (the same composeLockup composition — the
       cinematic frame composes the full block for geometry so the hero
       never moves across the seam).
     · INLINE boots (MERCURY_FULLSCREEN defined-falsy) keep the whole
       stop-and-choose deck below — card, boot menu, projects picker —
       because route surfaces have no frame there (CB-10). Everything from
       here down describes that inline waiting world (plus captures via
       MERCURY_SPLASH_VIEW / ONESHOT).
     · TTY-only; MERCURY_SPLASH=off / =static / non-TTY ⇒ exit silently
       (static is the launcher's one-line banner, never this asset).
     · ALT-SCREEN LIFETIME: the splash owns the alternate screen
       from first paint to exit — zero scrollback residue on ANY path, and a
       terminal RESIZE (fullscreen → minimised) simply clears + recomposes the
       ladder at the live size (the old in-place cursor-up erase math broke
       the moment the terminal rewrapped a shrunken window). Exits restore the
       main screen, then print the one-line brand into scrollback.
     · Draw the centered lockup (head · rule+(>_) · MERCURY · enter hint).
     · Wait for a key: a bare ↵ (its own data event — a buffered paste
       stays inert) ⇒ the launch RIPPLE (the ember wave from the
       old splash, held brand at the eye of the storm — skipped under
       MERCURY_LAUNCH_RIPPLE=0 / MERCURY_REDUCED_MOTION=1), then the screen
       clears to ONE compact brand line, exit 0 — the launcher boots the app.
       Ctrl-C ⇒ instant collapse, exit 130.
     · `m` ⇒ the BOOT MENU (paper-triad Slice D): rows baked from
       src/substrate/startupMenu.ts (scripts/splash/bake-menu.mjs — do not
       hand-edit the MENU block), ↑↓/jk move, ↵/space/→ cycle, `s` saves
       $CONFIG_HOME/boot-env.json {version:1, savedAt, env} and launches,
       esc backs out. Plain ↵ still boots straight — zero added friction.
       Mercury applies the file at boot (applyBootMenuEnv: registry keys
       only, explicit real env always wins). Too-small terminals simply
       don't offer the menu.
     · The PROJECTS picker (the consolidated
       project surface): the card's ◆ row lists every repo the session
       store knows (newest first). ONE other repo ⇒ ↵ jumps directly (the
       classic Recent Project); TWO+ ⇒ ↵ opens the in-splash picker
       (↑↓/jk pick · ↵ hands over the validated 'project' action — the
       launcher cd's there · esc back). Launched from ANY directory, this
       is the way into any repo Mercury has worked in.
     · Degrades honestly: short terminals drop the head (rule + wordmark
       only); very small ⇒ a one-line brand; no truecolor ⇒ 256-color
       approximations.
     · MERCURY_SPLASH_ONESHOT=1 ⇒ draw once and exit (captures + proofs);
       MERCURY_SPLASH_VIEW=menu|projects ⇒ start on that view.

   DEPLOY: the launcher (~/.local/bin/mercury) runs $CONFIG_HOME/splash.mjs —
   `bash scripts/splash/deploy.sh` copies this file there. This file is the
   canonical source; the deployed copy is a build artifact.
   ========================================================================== */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { adoptGroundFamily, createSplashCore, HEADSTD, WORD, MENU, MODEL_NAMES, GROUND, assembleCardRows, fmtAge, ACCENT_FAMILIES, DEFAULT_CRITTER, accentFamilyKeyOf, glowPhaseAt, glowSettled, GLOW_TICK_MS, WORD_W, CARD_LABEL_W, cpWidth, MARK_RE } from './splash-core.mjs'

const out = process.stdout

// ── palette (the reference's own = the brand palette) ──────────────────────
// ONE colour-capability law with the app (mirrors the
// src/ink/colorize.ts shouldHonorNoColor + the MERCURY_TRUECOLOR registry
// row; the baked CAPABILITY_TRUTH in splash-core.mjs is the shared contract and
// prove-ramp-parity.ts holds it to the canonical owners):
//   · NO_COLOR set non-empty AND FORCE_COLOR not set non-empty ⇒ the PLAIN
//     zero-SGR path (layout identical, no styling bytes at all);
//   · MERCURY_TRUECOLOR=0 ⇒ the 256 fallback;
//   · TERM dumb|linux ⇒ the 256 fallback (unchanged).
// Raw env reads are correct here: standalone pre-boot asset, no src imports.
const NOCOLOR =
  !!(process.env.NO_COLOR && process.env.NO_COLOR.length > 0) &&
  !(process.env.FORCE_COLOR && process.env.FORCE_COLOR.length > 0)
const TRUECOLOR =
  !NOCOLOR &&
  !/^(dumb|linux)$/.test(process.env.TERM || '') &&
  process.env.MERCURY_TRUECOLOR !== '0'

// ── the shared compose core (ruling 1 — share-by-extraction) ────────────────
// The pure composition (palette · grids · rasterHard · the lockup/card
// compose · placeBlock · the baked MENU/MODEL_NAMES/RAMP/ACCENT blocks)
// lives in splash-core.mjs, consumed by BOTH hosts: this standalone driver
// (which owns env capability, alt-screen, stdin, gradient, receipts) and
// the in-process Boot face (src/components/BootSplashScreen.tsx). The
// driver binds the core to ITS capability law (NOCOLOR/TRUECOLOR above)
// AND its resolved critter accent family (the boot
// menu's accent is unpinned), so every emitted byte is exactly the
// pre-split contract on a crab family. Constructed BELOW, after the
// config-home ladder and the critter resolution exist (the accent read
// needs them); every use is call-time, well after construction.

// ── compose the lockup ──────────────────────────────────────────────────────
// The composition itself is the core's composeLockup; this wrapper injects
// the STANDALONE host's data — the launcher card rows, the ↵/m hint
// segments, the status strip — and mirrors the core's outputs onto the
// module state paintView/ripple/hold read (lockupWordRow, lockupCardShown).
function compose(cols, rows) {
  // The one-placement law: the CINEMATIC frame composes
  // the FULL block — original card + strip — so the placement, wordmark row
  // and focus peak are byte-equal to the runtime landing's; paintView then
  // paints only the hero + ready line (the card cells stay canvas). The
  // cinematic hint drops 'm menu' (dead during the animation) and the
  // '↑↓ choose' appendix (no card on screen); ↵ remains truthful — it
  // fast-forwards the trace to the handoff.
  const res = composeLockup(cols, rows, {
    cardRows: cardRows(),
    cardSel,
    hintSegments: [
      { key: '↵ ', label: 'start', tone: 'ivory' },
      ...(!CINEMATIC && menuAvailable ? [{ key: 'm', label: ' menu', tone: 'faint' }] : []),
    ],
    tinyHint: '↵ start',
    stripLines: w => composeStrip(w),
    ...(CINEMATIC ? { hintCinematic: true } : {}),
    // GLOW: the live greeting phases (null once settled / cleared) — the
    // cinematic frame never arms them (glowEnabled), so frame 0 there stays
    // the settled composition byte-for-byte.
    glowWord: glowWordPhase(),
    glowRow: glowRowPhase(),
  })
  lockupCardShown = CINEMATIC ? false : res.cardShown
  lockupWordRow = res.wordRow
  lockupActionLines = res.actionLines
  return res.lines
}

// ── the launch RIPPLE — the ember wave:
//    expanding cosine rings in the deep→main→soft family ramp with sparkle
//    crests, the brand held at the eye of the storm; ~18 frames, then clear.
//    The trail hues are the ACCENT FAMILY's own: heads
//    bloom toward the family soft, tails cool main→deep — the crab family
//    byte-equals the authored CLAW→TERRA→BELLY ember exactly. ──────────────
const WHITE = [255, 255, 255]
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── the launch CODE-TRACE (the ONE-SCENE rework): lines of code
//    glyphs flow OUT of the brand like circuit traces — Manhattan paths that
//    run, turn 90°, run again — heads bright toward ivory, tails cooling
//    main→deep into the canvas, a `·` wake, an etched code-glyph residue.
//    INCREMENTAL painter: every frame only touches trail cells (~300), so
//    frames are cheap and the motion stays fluid on any window ("a bit
//    laggy" was the full-canvas per-frame repaint). Deterministic per-path
//    LCG — same window, same trace.
//    HERO mode (cinematic boots): the composed hero frame is the scene's
//    inviolate anchor — traces spawn on its bounding box and route around
//    it (pins off the die); the run RESOLVES into the hold via the settle
//    fade, and a mid-animation RESIZE reseats the same run at the live
//    geometry (never an abort, never a restart). LEGACY mode (inline ↵ /
//    menu / projects launches): the chosen deck is done — the run opens on
//    the held one-line brand, exactly the pre-rework shape, and a resize
//    still aborts to the (restored-screen) exit. Reduced-motion never
//    enters either mode. ──────────────────────────────────────────────────
const CODE_GLYPHS = '{}();=<>+*#$_/\\|'
async function ripple() {
  inRipple = true
  let epochSeen = sizeEpoch
  // WI-1: every frame await races a FRESH interrupt promise — cancel
  // (Ctrl-C/SIGINT/idle) and resize act MID-FRAME, not only at the next
  // loop top. Per-frame promises (not one shared) because a reseat CONTINUES
  // the run: a consumed resolver must never leave later races pre-resolved.
  const abortAtStart = rippleAbort
  const interrupt = () => new Promise(res => { rippleWake = res })
  const rippleAborted = () => rippleAbort !== abortAtStart
  let COLS = Math.max(24, out.columns || 80)
  let ROWS = Math.max(10, out.rows || 24)
  // The scene anchor: HERO mode rides the painted cinematic hero (cells +
  // box from the paint's captureHeroFacts); LEGACY mode anchors the one-line
  // brand and keeps the pre-rework behavior whole.
  const HERO = CINEMATIC && view === 'lockup' && heroBox !== null
  const cxi = Math.round((COLS - 1) / 2)
  // The brand holds the PLACED wordmark row from the splash's
  // last paint (one shared placement — splash, ripple and hold), so pressing
  // ↵ no longer jumps the wordmark from its optical placement to geometric
  // centre at the most-watched moment of the boot. Fallback: true centre
  // (menu/projects launches, or a pre-paint race); clamped to the live grid.
  // HERO mode never paints this brand — the hero block owns the scene.
  const cyi =
    placedBrandRow !== null && placedBrandRow >= 1 && placedBrandRow < ROWS - 1
      ? placedBrandRow
      : Math.round((ROWS - 1) / 2)
  const WORDLN = ' (>_) MERCURY '
  const wlen = WORDLN.length
  const wcol0 = Math.round(cxi - wlen / 2)
  // Pace against the TERMINAL, not just the clock. On win32,
  // TTY writes are asynchronous — frames QUEUE instead of blocking, the
  // wall-clock pacer drives the sleep toward its floor, and the backlog
  // compounds into judder. Awaiting the write callback alongside the pacer
  // means the loop never queues faster than the terminal drains.
  // WI-1 (a field wedge): the await itself is CAPPED — the file's
  // own drain rule (collapse/ONESHOT race a 2s cap) applied to the ONE drain
  // that lacked it. A callback that never fires (the acrylic/HD-4600 stall
  // class) resolves at the cap and counts a capped frame; the loop breaks to
  // the exit funnel on the first capped frame, so a dead terminal never
  // holds the process. Healthy drains resolve on the real callback and the
  // pacing is byte-for-byte unchanged.
  const FRAME_DRAIN_CAP_MS = 2000
  let cappedFrames = 0
  const writeFrame = buf2 =>
    new Promise(resolve => {
      let settled = false
      const done = drained => {
        if (settled) return
        settled = true
        clearTimeout(cap)
        cappedFrames = drained ? 0 : cappedFrames + 1
        resolve()
      }
      const cap = setTimeout(() => done(false), FRAME_DRAIN_CAP_MS)
      cap.unref?.()
      out.write(buf2, () => done(true))
    })
  const at = (x, y) => `\x1b[${y + 1};${x + 1}H`
  // Deterministic LCG (no Math.random — same window ⇒ same trace, and the
  // PTY proofs stay reproducible).
  let lcgS = (COLS * 31 + ROWS * 17 + 7) >>> 0
  const lcg = () => ((lcgS = (lcgS * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  // ── the SCENE GEOMETRY (mutable across reseats) ─────────────────────────
  // The obstacle + the inviolate ink: HERO mode walls the hero's per-row
  // silhouette hull (heroWalls) — traces flow into the block's empty corners
  // and the art sits IN the field, not in a cut-out rectangle; text rows
  // (divider, wordmark, status) span their full width, so their bands stay
  // clean by construction. LEGACY walls the one-line brand rect. The box
  // stays as the spawn band + side-gate + anchor-centre geometry.
  let box = HERO
    ? { ...heroBox }
    : { x0: wcol0 - 1, y0: cyi - 1, x1: wcol0 + wlen, y1: cyi + 1 }
  const masked = (x, y) =>
    HERO ? heroCells.has(x + ',' + y) : y === cyi && x >= wcol0 && x < wcol0 + wlen
  const wallAt = (x, y) =>
    HERO ? heroWallAt(x, y) : x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
  // Vertical steps advance 1 row, horizontal 2 cols (equal VISUAL speed —
  // rows are ~2× tall).
  const DIRS = [[2, 0], [-2, 0], [0, 1], [0, -1]]
  // DENSITY follows the window's area; tiny windows get a calm handful
  // (24 paths on 45×12 was a crowd), ordinary ones a real fleet, and LARGE
  // ones a leaner one — past the respawn gate every live path still rides
  // to its corner, and at 160×60 that ungovernable ride-paint alone is
  // ~0.1+ of the canvas: fewer, longer traces keep the articulation (the
  // elbows and runs) instead of settling into uniform dust.
  const fleetSize = () => {
    const area = COLS * ROWS
    return area < 1500
      ? Math.max(8, Math.min(14, Math.round(area / 90)))
      : area > 8000
        ? Math.max(16, Math.min(52, Math.round(area / 210)))
        : Math.max(16, Math.min(88, Math.round(area / 150)))
  }
  // Spawn sides carry the canvas they open onto MINUS what already filled
  // there (the fill follows the free area, per geometry, SELF-BALANCING):
  // the band below a high-set hero fills from the box's bottom edge
  // directly, and once a region densifies its spawn slots shift to the thin
  // flanks (the 80×24 preview showed a rich lower field beside near-empty
  // hero flanks — a static area weight kept feeding the already-full side).
  // A side with almost no canvas spawns nothing.
  const sidePainted = [0, 0, 0, 0] // right · left · down · up (trail pushes)
  const sideOfCell = (x, y) =>
    x > box.x1 ? 0 : x < box.x0 ? 1 : y > box.y1 ? 2 : 3
  const sideWeights = () => {
    const area = [
      (COLS - 2 - box.x1) * ROWS, // 0 right
      (box.x0 - 1) * ROWS, // 1 left
      (ROWS - 2 - box.y1) * (box.x1 - box.x0 + 1), // 2 down (the box band)
      (box.y0 - 1) * (box.x1 - box.x0 + 1), // 3 up
    ]
    const gate = [COLS - 2 - box.x1 >= 6, box.x0 - 1 >= 6, ROWS - 2 - box.y1 >= 3, box.y0 - 1 >= 3]
    return area.map((a, s) => (gate[s] ? Math.max(0, a - sidePainted[s] * 2.2) : 0))
  }
  const spawnPath = (i, forceSide = null) => {
    const w = sideWeights()
    const tot = w[0] + w[1] + w[2] + w[3]
    let side = i % 4
    if (forceSide !== null && w[forceSide] > 0) side = forceSide
    else if (tot > 0) {
      let pick = lcg() * tot
      side = 0
      while (side < 3 && pick >= w[side]) { pick -= w[side]; side++ }
    }
    // A slot along the side's band, padded past the box corners (a narrow
    // side — the one-line brand — must not stack every path on three rows),
    // one cell outside the wall, heading outward. HERO pins snap flush to
    // the silhouette hull — they come off the die's real face; the box is
    // only the slot band.
    const PAD = 3
    let x, y
    if (side <= 1) {
      y = Math.round(box.y0 - PAD + lcg() * (box.y1 - box.y0 + 2 * PAD))
      x = side === 0 ? box.x1 + 1 : box.x0 - 1
      if (HERO) {
        const iv = heroWalls.get(Math.max(0, Math.min(ROWS - 1, y)))
        if (iv) x = side === 0 ? iv[1] + 1 : iv[0] - 1
      }
    } else {
      x = Math.round(box.x0 - PAD + lcg() * (box.x1 - box.x0 + 2 * PAD))
      y = side === 2 ? box.y1 + 1 : box.y0 - 1
      if (HERO) {
        const cx = Math.max(0, Math.min(COLS - 1, x))
        if (side === 2) {
          let yy = box.y1 + 1
          while (yy > box.y0 && !heroWallAt(cx, yy - 1)) yy--
          if (yy > box.y0) y = yy
        } else {
          let yy = box.y0 - 1
          while (yy < box.y1 && !heroWallAt(cx, yy + 1)) yy++
          if (yy < box.y1) y = yy
        }
      }
    }
    let px = Math.max(0, Math.min(COLS - 1, x))
    let py = Math.max(0, Math.min(ROWS - 1, y))
    // THE PIN INVARIANT: a spawn pin sits OUTSIDE the wall. The clamp above
    // can land inside it when the hull runs flush to a grid edge; walk the
    // pin outward along its own heading, and a grid that cannot host it
    // yields a DEAD slot for the next respawn wave — never a movement-locked
    // path that holds run completion to the frame cap.
    let hosted = true
    if (HERO && heroWallAt(px, py)) {
      const [odx, ody] = DIRS[side]
      while (heroWallAt(px, py)) {
        const qx = px + Math.sign(odx)
        const qy = py + Math.sign(ody)
        if (qx < 0 || qx >= COLS || qy < 0 || qy >= ROWS) {
          hosted = false
          break
        }
        px = qx
        py = qy
      }
    }
    return {
      x: px,
      y: py,
      dir: side,
      // Next turn after 3-9 steps; each path turns several times en route.
      untilTurn: 3 + Math.floor(lcg() * 7),
      trail: [], // [{x,y}] newest last
      alive: hosted,
      edgeRiding: false,
    }
  }
  let N_PATHS = fleetSize()
  const paths = []
  {
    // The FIRST wave allocates weighted-with-a-floor: every ELIGIBLE side
    // gets a base share (an eighth of the fleet) so the hero flanks get
    // their runs before the respawn gate can close (the 80×24 class), and
    // the remainder follows the canvas weights so the deep side still owns
    // its majority (pure round-robin starved it). Later waves stay
    // emptiness-weighted.
    const w0 = sideWeights()
    const eligible = w0.map((w, s) => (w > 0 ? s : -1)).filter(s => s >= 0)
    const seedPlan = []
    if (eligible.length > 0) {
      const floor = Math.max(1, Math.floor(N_PATHS / 8))
      for (const s of eligible) for (let k = 0; k < floor; k++) seedPlan.push(s)
      const tot = eligible.reduce((a, s) => a + w0[s], 0)
      while (seedPlan.length < N_PATHS) {
        let pick = lcg() * tot
        let s = eligible[0]
        for (const cand of eligible) { s = cand; if (pick < w0[cand]) break; pick -= w0[cand] }
        seedPlan.push(s)
      }
    }
    for (let i = 0; i < N_PATHS; i++) {
      paths.push(spawnPath(i, seedPlan.length > i ? seedPlan[i] : null))
    }
  }
  const TRAIL = 16
  // ── the COVERAGE governor + the settle fade's ledger ────────────────────
  // Respawn keeps the field growing until the geometry's coverage target —
  // the per-geometry balance instrument (a fixed frame window under-filled
  // large windows and over-filled small ones). The etched residue records
  // in first-etch order: the settle fade dissolves it oldest-first.
  const paintedSet = new Set()
  const residue = [] // [{x,y}] first-etch order — the fade's cohorts
  const residueSet = new Set()
  const RESIDUE_TONE = mixc(FAM.deep, VOID, 0.55)
  const fillTarget = () => {
    const area = COLS * ROWS
    return area < 1500 ? 0.26 : area > 8000 ? 0.32 : 0.36
  }
  const freeArea = () => Math.max(1, COLS * ROWS - (HERO ? heroCells.size : wlen))
  // No maroon backing plate:
  // an animating brand painting a red highlight the settled frame then
  // loses is a visible restate. The trace brand matches the hold frame
  // byte-for-byte: bare glyphs on the one flat ground.
  const HOLD_BRAND =
    at(wcol0, cyi) +
    accentFg() + ' (>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY ' + R
  // Frame 0 — LEGACY only: clear the grid ONCE (plain spaces — the terminal
  // ground shows through) + the brand; every later frame touches only trail
  // cells. HERO mode paints NOTHING here: the arrival frame already on
  // screen IS the canvas, and clearing it was the one-scene law's first
  // hard cut (the hero lived ~1ms). Frames are wrapped in DEC 2026
  // synchronized-output brackets (?2026h/l) so a supporting terminal
  // applies each frame ATOMICALLY — the mid-frame shear on busy windows was
  // the "a bit laggy" texture; terminals without 2026 ignore the brackets
  // (16 bytes/frame).
  if (!HERO) {
    let buf = '\x1b[?2026h\x1b[?25l\x1b[H'
    for (let y = 0; y < ROWS; y++) {
      buf += ' '.repeat(COLS) + R + (y < ROWS - 1 ? '\n' : '')
    }
    buf += HOLD_BRAND
    // drain the full-canvas frame (D3) — raced so a stall/cancel/resize on
    // the LARGEST single write cannot wedge the boot (WI-1)
    await Promise.race([writeFrame(buf + '\x1b[?2026l'), interrupt()])
  }
  // The run ends on COMPLETION — every path off-screen and every trail
  // drained (the operator: "the screen transitions before it fills") —
  // with NF only as a runaway cap. The cap scales with the edge distance
  // (a 200-col window must reach its corners; a laptop must not dawdle):
  // ~1.7-2.6s of trace at the 24ms tick, at every geometry.
  const frameCeil = () =>
    Math.round(Math.min(110, Math.max(72, 24 + Math.max(COLS / 2, ROWS) * 1.1)))
  let NF = frameCeil()
  let respawnCeil = Math.round(NF * 0.55)
  // ── the RESIZE RESEAT (first-class law, HERO mode) ──────────────────────
  // A mid-animation resize recomposes the hero at the live geometry, filters
  // the field to the new bounds, retunes the fleet, repaints the canvas ONCE
  // inside sync brackets, and the SAME run continues — never an abort, never
  // a restart from zero. Bounded like every frame by the WI-1 drain cap.
  const reseat = async () => {
    COLS = Math.max(24, out.columns || 80)
    ROWS = Math.max(10, out.rows || 24)
    cols = COLS
    rowsAvail = ROWS
    lcgS = (COLS * 31 + ROWS * 17 + 7) >>> 0
    const placed = composeCinematicHero(COLS, ROWS)
    if (heroBox) box = { ...heroBox }
    const inBox = (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1
    // The reflowed hero's silhouette hull evicts the old field — the wall
    // bands (letter gaps and divider spacing included) would otherwise be
    // repainted by the aging writer inside the standing ink; survivors in
    // the block's empty corners are legitimate field.
    const inWall = (x, y) => (HERO ? heroWallAt(x, y) : inBox(x, y))
    const survives = c => c.x < COLS && c.y < ROWS && !inWall(c.x, c.y)
    const kept = residue.filter(survives)
    residue.length = 0
    residue.push(...kept)
    residueSet.clear()
    for (const c of residue) residueSet.add(c.x + ',' + c.y)
    for (const k of [...paintedSet]) {
      const [x, y] = k.split(',').map(Number)
      if (x >= COLS || y >= ROWS) paintedSet.delete(k)
    }
    // Recount the per-side balance ledger against the reflowed box.
    sidePainted.fill(0)
    for (const k of paintedSet) {
      const [x, y] = k.split(',').map(Number)
      sidePainted[sideOfCell(x, y)]++
    }
    for (const p of paths) {
      p.trail = p.trail.filter(survives)
      if (p.x >= COLS || p.y >= ROWS || inWall(p.x, p.y)) {
        // Heads off the new grid, or under the reflowed hero, retire; their
        // trails drain through the normal aging.
        p.alive = false
        p.x = Math.min(p.x, COLS - 1)
        p.y = Math.min(p.y, ROWS - 1)
      }
    }
    N_PATHS = fleetSize()
    let alive = paths.filter(p => p.alive).length
    for (const p of paths) {
      if (alive <= N_PATHS) break
      if (p.alive) { p.alive = false; alive-- }
    }
    while (paths.length < N_PATHS) paths.push(spawnPath(paths.length))
    NF = Math.min(140, Math.max(NF, fNow + Math.round(frameCeil() * 0.7)))
    respawnCeil = Math.round(frameCeil() * 0.55)
    // ONE bracketed repaint: clear, hero, surviving residue. Live trails
    // rejoin on the very next frame (the aging writer repaints every trail
    // cell each frame).
    let buf = '\x1b[?2026h\x1b[2J\x1b[H' + placed.join('\n')
    for (const c of residue) {
      buf += at(c.x, c.y) + rgbFg(RESIDUE_TONE) +
        CODE_GLYPHS[(c.x * 7 + c.y * 13) % CODE_GLYPHS.length] + R
    }
    await Promise.race([writeFrame(buf + '\x1b[?2026l'), interrupt()])
  }
  // Drift-compensated pacing: sleep(24) drifted by the frame's own compose +
  // write time (heavier frames → slower cadence → visible judder). Pace
  // against the wall clock instead: each frame TARGETS tBase + 24ms·(n+1),
  // re-based at each reseat so a resize never triggers a catch-up burst.
  const tickMs = 24
  let t0 = Date.now()
  let fBase = 0
  let fNow = 0
  for (let f = 0; f < NF; f++) {
    fNow = f
    if (rippleAborted() || cappedFrames > 0) break
    if (sizeEpoch !== epochSeen) {
      // LEGACY keeps its abort-to-exit (the restored main screen is the
      // destination anyway); HERO reseats and the run continues.
      if (!HERO) break
      epochSeen = sizeEpoch
      await reseat()
      if (rippleAborted() || cappedFrames > 0) break
      fBase = f
      t0 = Date.now()
      continue
    }
    let buf = '\x1b[?2026h'
    let anyAlive = false
    let pi = 0
    const bcx = (box.x0 + box.x1) / 2
    const bcy = (box.y0 + box.y1) / 2
    // The COMMITTED fill: cells already painted plus what the live fleet
    // will still etch as its trails drain (~TRAIL cells each). Gating the
    // respawn on the committed value stops the feed BEFORE the in-flight
    // paint overshoots the target — the 160×60 preview measured +0.17 of
    // lag when the gate read only the painted count.
    const aliveN = paths.reduce((n, p) => n + (p.alive ? 1 : 0), 0)
    const committed = (paintedSet.size + aliveN * TRAIL * 0.8) / freeArea()
    for (const p of paths) {
      pi++
      // Wave respawn: an exited path re-emerges from the anchor while the
      // field is still below its coverage target — the per-geometry balance
      // instrument (respawnCeil is the runaway bound).
      if (!p.alive && p.trail.length === 0 && f - fBase < respawnCeil && committed < fillTarget()) {
        Object.assign(p, spawnPath(pi + f))
      }
      // Age every trail cell: head → mid → tail → wake → etched.
      for (let k = 0; k < p.trail.length; k++) {
        const cell = p.trail[k]
        const age = p.trail.length - 1 - k // 0 = newest
        if (masked(cell.x, cell.y)) continue
        if (age >= TRAIL) {
          // Etched residue (the operator: "fill more of the screen"): a
          // trace's wake stays as a permanent faint glyph — the board fills
          // as the fleet works. It keeps its CODE GLYPH at a deep quiet tone
          // (the settled field reads as circuitry, not dust), and records in
          // etch order for the settle fade.
          buf += at(cell.x, cell.y) + rgbFg(RESIDUE_TONE) +
            CODE_GLYPHS[(cell.x * 7 + cell.y * 13) % CODE_GLYPHS.length] + R
          const key = cell.x + ',' + cell.y
          if (!residueSet.has(key)) {
            residueSet.add(key)
            residue.push({ x: cell.x, y: cell.y })
          }
        } else {
          const a = 1 - age / TRAIL
          const fg =
            a > 0.85
              ? mixc(FAM.soft, WHITE, ((a - 0.85) / 0.15) * 0.6)
              : a > 0.45
                ? mixc(FAM.main, FAM.soft, (a - 0.45) / 0.4)
                : mixc(FAM.deep, FAM.main, a / 0.45)
          const glyph =
            a < 0.15 ? '·' : CODE_GLYPHS[(cell.x * 7 + cell.y * 13) % CODE_GLYPHS.length]
          buf += at(cell.x, cell.y) + rgbFg(fg) + glyph + R
        }
      }
      p.trail = p.trail.filter((_, k) => p.trail.length - 1 - k < TRAIL)
      if (!p.alive) continue
      // Advance; turn 90° when the counter expires (never reverse). Turns
      // are OUTWARD-BIASED (75%) away from the anchor box — the circuit look
      // survives, but the fleet reliably reaches the edges instead of
      // wandering. A path that MEETS an edge doesn't die there: it turns and
      // RIDES the edge to its corner (the operator's original ask — "lines
      // that trace to the corners"); only a corner ends it.
      if (!p.edgeRiding && --p.untilTurn <= 0) {
        const horiz = p.dir <= 1
        if (horiz) {
          const away = p.y <= bcy ? 3 : 2 // up when above the anchor, down below
          p.dir = lcg() < 0.75 ? away : away === 3 ? 2 : 3
        } else {
          const away = p.x <= bcx ? 1 : 0 // left when left of the anchor
          p.dir = lcg() < 0.75 ? away : away === 1 ? 0 : 1
        }
        p.untilTurn = 4 + Math.floor(lcg() * 8)
      }
      const [dx, dy] = DIRS[p.dir]
      // Two sub-steps per frame for horizontal runs (dx=±2) — record each
      // cell so the line is CONTINUOUS, not dotted.
      const sub = Math.max(Math.abs(dx), Math.abs(dy))
      for (let s2 = 0; s2 < sub; s2++) {
        const nx = p.x + Math.sign(dx)
        const ny = p.y + Math.sign(dy)
        const xOut = nx < 0 || nx >= COLS
        const yOut = ny < 0 || ny >= ROWS
        if (xOut || yOut) {
          const atXBound = p.x === 0 || p.x === COLS - 1
          const atYBound = p.y === 0 || p.y === ROWS - 1
          if ((xOut && atYBound) || (yOut && atXBound)) {
            p.alive = false // corner reached — the trace completes here
            break
          }
          // Turn onto the edge toward the NEARER corner and ride it.
          p.edgeRiding = true
          if (xOut) {
            p.x = nx < 0 ? 0 : COLS - 1
            p.dir = p.y <= bcy ? 3 : 2
          } else {
            p.y = ny < 0 ? 0 : ROWS - 1
            p.dir = p.x <= bcx ? 1 : 0
          }
          break // resume along the edge next frame (a visible elbow)
        }
        // THE OBSTACLE LAW (one-scene): the wall is the hero's silhouette
        // hull (HERO — traces reach the art's stepped outline, so the head
        // rises out of the field) or the brand box (LEGACY) — a path that
        // meets it turns and rides along its face, never crossing the ink
        // and never teleporting behind it.
        if (wallAt(nx, ny)) {
          p.dir = dy === 0 ? (p.y <= bcy ? 3 : 2) : (p.x <= bcx ? 1 : 0)
          p.untilTurn = 2 + Math.floor(lcg() * 5)
          break // resume along the box face next frame (a visible elbow)
        }
        p.x = nx
        p.y = ny
        if (!masked(p.x, p.y)) {
          p.trail.push({ x: p.x, y: p.y })
          const key = p.x + ',' + p.y
          if (!paintedSet.has(key)) {
            paintedSet.add(key)
            sidePainted[sideOfCell(p.x, p.y)]++
          }
        }
      }
      anyAlive = anyAlive || p.alive
    }
    if (!HERO) buf += HOLD_BRAND
    // D3: never queue faster than the terminal drains — the frame write and
    // the wall-clock pacer complete TOGETHER before the next frame composes.
    const drawn = writeFrame(buf + '\x1b[?2026l')
    if (!anyAlive && paths.every(p => p.trail.length === 0)) {
      await Promise.race([drawn, interrupt()])
      break
    }
    await Promise.race([
      Promise.all([drawn, sleep(Math.max(6, tickMs * (f - fBase + 1) - (Date.now() - t0)))]),
      interrupt(),
    ])
  }
  // ── the SETTLE (the one-scene law's phase C) ──────────────────────────────
  // The field dissolves INTO the hold instead of vanishing under a hard cut:
  // residue cohorts fade a step darker then erase, oldest first, ~0.2-0.5s
  // at the same tick and cell budget as trace frames. Skipped whole on
  // interrupt (↵ fast-forward / cancel), on a capped drain, or mid-resize —
  // every one of those paths lands on a repainted hold anyway.
  if (!rippleAborted() && cappedFrames === 0 && sizeEpoch === epochSeen) {
    for (const p of paths) {
      for (const c of p.trail) {
        const key = c.x + ',' + c.y
        if (!masked(c.x, c.y) && !residueSet.has(key)) {
          residueSet.add(key)
          residue.push({ x: c.x, y: c.y })
        }
      }
    }
    if (residue.length > 0) {
      const F = Math.max(6, Math.min(20, Math.round(residue.length / 140)))
      const cohort = Math.ceil(residue.length / F)
      const FADE_TONE = mixc(RESIDUE_TONE, VOID, 0.6)
      const tFade = Date.now()
      for (let s = 0; s <= F; s++) {
        if (rippleAborted() || cappedFrames > 0 || sizeEpoch !== epochSeen) break
        let buf = '\x1b[?2026h'
        for (const c of residue.slice(s * cohort, (s + 1) * cohort)) {
          buf += at(c.x, c.y) + rgbFg(FADE_TONE) +
            CODE_GLYPHS[(c.x * 7 + c.y * 13) % CODE_GLYPHS.length] + R
        }
        if (s > 0) for (const c of residue.slice((s - 1) * cohort, s * cohort)) {
          buf += at(c.x, c.y) + ' '
        }
        await Promise.race([
          Promise.all([writeFrame(buf + '\x1b[?2026l'), sleep(Math.max(6, tickMs * (s + 1) - (Date.now() - tFade)))]),
          interrupt(),
        ])
      }
    }
  }
  // D3: the one exit funnel — restore, flush, drain, THEN exit. WI-1: after
  // a capped frame the terminal already proved it does not call back, so the
  // funnel's own drain wait shortens — total stall-to-exit stays ≤ ~2.5s.
  collapse(0, cappedFrames > 0 ? 400 : undefined)
}

const rippleEnabled = () =>
  TRUECOLOR &&
  process.env.MERCURY_LAUNCH_RIPPLE !== '0' &&
  process.env.MERCURY_REDUCED_MOTION !== '1'

// the one-line brand marker left in scrollback after continue. A CANCELLED
// boot (Ctrl-C / idle timeout) must not promise "starting"
// it will never do: the tail states the truth.
function brandLine() {
  return (
    accentFg() + '(>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY' + R +
    hexFg(FAINT, T256.faint) + (cancelled ? ' · launch cancelled' : ' · starting') + R
  )
}

// ── the boot menu (m) — rows baked from src/substrate/startupMenu.ts; the
//    save file is what Mercury's applyBootMenuEnv() applies at boot ─────────
// Mirror of Mercury's config-home resolution (src/utils/envUtils.ts):
// MERCURY_CONFIG_DIR, then MERCURY_HOME, else ~/.mercury. The splash must
// never create a home the runtime does not resolve.
const CONFIG_HOME = (() => {
  // NFC-normalized like the runtime's getMercuryHome — the receipt/beacon
  // WRITER and their runtime CONSUMERS must resolve the same bytes for a
  // non-ASCII env home on normalization-sensitive filesystems (the
  // NFC-seam class).
  const explicit = process.env.MERCURY_CONFIG_DIR
  if (explicit) return explicit.normalize('NFC')
  const homeEnv = process.env.MERCURY_HOME
  if (homeEnv) return homeEnv.normalize('NFC')
  return join(homedir(), '.mercury').normalize('NFC')
})()
const BOOT_ENV_PATH = join(CONFIG_HOME, 'boot-env.json')

// K3: a rendered FACT must not silently degrade to its
// absence-default on a FAILED read — absent (ENOENT) stays the clean
// default; every other failure is collected here and surfaced at teardown
// (stderr after the alt screen restores), and the account chip renders an
// honest 'unreadable' instead of claiming not-signed-in.
const chipReadFailures = []
const READ_FAILED = Symbol('chip-read-failed')
function noteChipFailure(chip, err) {
  if (err && err.code === 'ENOENT') return false
  chipReadFailures.push(chip + ': ' + ((err && (err.code || err.message)) || 'unknown'))
  return true
}
process.on('exit', () => {
  // Surfaced AFTER the alt screen has restored (synchronous exit path);
  // never in ONESHOT — captures/proofs must stay byte-stable. The whole body
  // sits in the try: an exit BEFORE the ONESHOT const initializes must not
  // throw out of an exit handler.
  try {
    if (ONESHOT || chipReadFailures.length === 0) return
    process.stderr.write(
      'mercury splash: chip read failure(s) — ' + chipReadFailures.join(' · ') + '\n',
    )
  } catch { /* pre-boot exit or stderr gone — nothing to say it to */ }
})

// Mirror of the runtime's global-config resolution (src/utils/env.ts
// getGlobalMercuryFile), READ-ONLY — the splash never adopts:
// `.config.json` honored first (the pre-rename legacy), then the canonical
// `.mercury.json`. There is no `.claude.json` rung —
// the splash reads Mercury homes only. The prod oauth suffix is '' (constants/oauth.ts
// fileSuffixForOauthConfig); non-prod suffixes never reach an operator home.
// Parity is pinned against the runtime by the splash proof estate.
function resolveConfigFile() {
  const dotConfig = join(CONFIG_HOME, '.config.json')
  if (existsSync(dotConfig)) return dotConfig
  return join(CONFIG_HOME, '.mercury.json')
}

function readSavedBootEnv() {
  try {
    const o = JSON.parse(readFileSync(BOOT_ENV_PATH, 'utf8'))
    if (o && o.version === 1 && o.env && typeof o.env === 'object' && !Array.isArray(o.env)) return o.env
  } catch { /* no file / malformed ⇒ pure defaults */ }
  return {}
}

let menuRow = 0 // selected row index into MENU
const menuChoice = new Map() // env → index into row.choices
for (const [env, v] of Object.entries(readSavedBootEnv())) {
  // canonical or retired spelling — pre-migration saves keep resolving; the
  // selection is ALWAYS keyed by the row's canonical env (choiceOf reads it)
  const row = MENU.find(r => r.env === env || (r.legacy && r.legacy === env))
  if (!row) continue
  const idx = row.choices.findIndex(c => c.v === v)
  if (idx > 0) menuChoice.set(row.env, idx)
}
const choiceOf = row => row.choices[menuChoice.get(row.env) || 0]

// The write-through SEMANTICS stay (the visible state IS the
// saved state — the dishonest-cue fix), but the DISK write is debounced
// ~120ms and flushed unconditionally on every exit path (collapse funnels
// them all). A held arrow key would otherwise issue one mkdirSync + full JSON write
// per key repeat, synchronously, on the render path — one file write per
// repeat on the audit machine's HDD with Defender inspecting each.
const BOOT_ENV_DEBOUNCE_MS = 120
let bootEnvTimer = null
let bootEnvDirty = false
function saveBootEnv() {
  bootEnvDirty = true
  clearTimeout(bootEnvTimer)
  bootEnvTimer = setTimeout(flushBootEnv, BOOT_ENV_DEBOUNCE_MS)
  bootEnvTimer.unref?.()
}
function flushBootEnv() {
  if (!bootEnvDirty) return
  bootEnvDirty = false
  clearTimeout(bootEnvTimer)
  const env = {}
  for (const row of MENU) {
    const ch = choiceOf(row)
    if (ch && ch.v !== null) env[row.env] = ch.v
  }
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(BOOT_ENV_PATH, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), env }, null, 2) + '\n')
  } catch { /* read-only home — launch anyway, nothing saved */ }
}

// ── the LAUNCHER CARD + STATUS STRIP (the enter-screen redesign) ──────
// Image-1 mockup: a 4-row action card under the lockup (Continue Last Session ·
// Boot Menu · Doctor / Health Check · Recent Project) + a Model/Theme/Dir/cert
// status strip. HONEST DATA ONLY — rows self-omit when their datum is absent
// (no sessions ⇒ no Continue row). Selection is ↑↓ + ↵; plain ↵ (nothing
// selected) still boots straight — zero added friction, and any other key
// keeps launching exactly as before.
//
// Actions cross to the RUNTIME through $CONFIG_HOME/splash-action.json
// ({version:1, ts, action, dir?, screen}) — the runtime's early-entry
// consumer (src/substrate/splashHandover.ts, armed by the launcher's
// MERCURY_SPLASH_HANDOFF=1) validates (fresh <120s, allow-listed action,
// existing dir), deletes the file, and adjusts its own argv/cwd
// (`--continue`, an initial `/doctor` prompt, or a chdir). A stale/absent/
// malformed file is a plain launch — never a refused boot. The LAUNCHERS
// consume only the splash's EXIT CODE (BM-30 — see collapse()).

// fmtAge rides the shared core (one age grammar for both hosts).

// Bounded head read: readFileSync('utf8').slice(0, 4096) read
// and DECODED the whole multi-megabyte session file to keep 4 KB — measured
// 11.6 MB synchronous pre-paint on the audit machine (HDD + Defender), and
// the cost grew with every session. openSync/readSync caps the disk work at
// the window itself. The head may end mid-multibyte-character; the "cwd"
// regex matches ASCII key names, so a trailing replacement char is harmless.
// SPLASH-READHEAD-START (unit-proven by scripts/splash/prove-splash-units.ts)
function readHead(file, n = 4096) {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(n)
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (r <= 0) break
      got += r
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
// SPLASH-READHEAD-END

// THE PROJECT ROW'S NAME (ruled): a row whose directory IS the project-config
// home dir (`.mercury`) wears its PARENT folder's name — never the dot-dir's
// own; the path column keeps the truth. Mirrors the runtime owner
// (src/utils/bootCardFacts.projectDisplayName) so the boot seam's rows stay
// byte-identical across the splash → face hand-off.
const projectDisplayName = dir => {
  const base = basename(dir)
  if (base === '.mercury') {
    const parent = basename(dirname(dir))
    if (parent && parent !== base) return parent
  }
  return base || dir
}

// Recent projects from the session store ($CONFIG_HOME/projects/*/​*.jsonl —
// the launcher pins MERCURY_CONFIG_DIR=$CONFIG_HOME, so this IS the config
// home). Newest session file per project dir, cwd parsed from the jsonl head;
// dead cwds skipped. Bounded + fail-soft: any error ⇒ [].
function scanRecentProjects() {
  try {
    const root = join(CONFIG_HOME, 'projects')
    const perDir = []
    for (const d of readdirSync(root)) {
      const dir = join(root, d)
      let names
      try {
        names = readdirSync(dir)
      } catch { continue }
      // THE PROJECT CARD (the folder-as-project law): a folder whose first
      // chat was born through the one birth door carries `project.json`
      // beside its transcripts — the catalog row. It lists the folder before
      // any words were sent (no jsonl yet) and names the cwd without a head
      // read. Mirrors the runtime owner (src/utils/bootCardFacts).
      let card = null
      if (names.includes('project.json')) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
          if (raw && raw.schema === 1 && typeof raw.dir === 'string' && raw.dir && typeof raw.firstChatAt === 'number') {
            card = { dir: raw.dir, firstChatAt: raw.firstChatAt }
          }
        } catch { /* an unreadable card is no card */ }
      }
      let newest = 0
      let newestFile = null
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue
        try {
          const st = statSync(join(dir, f))
          if (st.mtimeMs > newest) {
            newest = st.mtimeMs
            newestFile = join(dir, f)
          }
        } catch { /* racing delete */ }
      }
      if (!newestFile && !card) continue
      // A row's recency is its newest activity: the newest transcript, or
      // the first-chat stamp of a folder whose chat has no words yet.
      perDir.push({ file: newestFile, mtime: Math.max(newest, card ? card.firstChatAt : 0), card })
    }
    perDir.sort((a, b) => b.mtime - a.mtime)
    const seen = []
    for (const e of perDir.slice(0, 32)) {
      let cwd = e.card ? e.card.dir : null
      if (!cwd && e.file) {
        try {
          const head = readHead(e.file)
          const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
          if (m) cwd = JSON.parse('"' + m[1] + '"')
        } catch { /* unreadable head */ }
      }
      if (!cwd) continue
      // SCRATCH FILTER (product-study r1: 5 of 9 picker rows were tmp drill
      // dirs — proof/E2E debris masquerading as "repos Mercury has worked
      // in"). Anything under a temp root is test residue, never an operator
      // project; tmpdir() covers the macOS /var/folders form. DISABLED when
      // the config home ITSELF is hermetic (a tmp CONFIG_HOME = a proof
      // world where every fixture cwd is tmp by construction).
      // Both sides normalize before comparing — win32 paths are
      // case-insensitive and backslash-separated, so the raw startsWith let
      // a recorded `appdata\local\temp` cwd through the filter that
      // `AppData\Local\Temp` would catch. The tmpdir prefix also gains a
      // separator bound so a `Temp-sibling` dir can never false-match.
      const normPath = p => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/')
      const tmpN = tmpdir() ? normPath(tmpdir()).replace(/\/+$/, '') : ''
      const isTmpPath = p => {
        const n = normPath(p)
        return (
          n.startsWith('/tmp/') ||
          n.startsWith('/private/tmp/') ||
          n.startsWith('/private/var/folders/') ||
          (tmpN ? n === tmpN || n.startsWith(tmpN + '/') : false)
        )
      }
      if (!isTmpPath(CONFIG_HOME + '/') && isTmpPath(cwd)) continue
      try {
        if (!statSync(cwd).isDirectory()) continue
      } catch { continue }
      if (seen.some(s => s.dir === cwd)) continue
      seen.push({
        dir: cwd,
        // node:path basename via the ruled naming seam (kept:
        // the '/'-only split returned the ENTIRE backslash path on win32 —
        // every picker row rendered the full C:\… prefix and the rows
        // became visually indistinguishable).
        base: projectDisplayName(cwd),
        ageMs: Date.now() - e.mtime,
      })
      if (seen.length >= 10) break
    }
    return seen
  } catch {
    return []
  }
}
const recentSeen = scanRecentProjects()
const recentLast = recentSeen[0] || null
const recentProject =
  recentSeen.find(s => s.dir !== process.cwd() && (!recentLast || s.dir !== recentLast.dir)) || null
// The Projects picker list: every known repo EXCEPT where we already stand —
// "anywhere the terminal is launched, choose your repo" (the operator).
// K2: does the LAUNCHED cwd itself have session history? The
// Continue/Resume rows scope to it when it does — the launched dir wins;
// cross-project moves belong to the Projects row and the runtime picker's
// own explicit toggle (the runtime is already correctly scoped:
// logs.ts --continue is cwd-only, ResumeConversation defaults same-repo).
const cwdProject = recentSeen.find(s => s.dir === process.cwd()) || null

// Model label from the operator's settings pin; absent ⇒ the honest 'default'
// (the binary decides the real default at boot — never fabricate it here).
// Names resolve through the BAKED owner table below — the hand family-regex
// this replaced showed 'Opus 4.8' for the claude-opus-5 pin (the STALE-COPY
// class prove-model-truth.ts hunts, out of its reach in this standalone
// asset). An id the table doesn't know renders RAW, never a guessed family.
// The strip's four data reads (settings.json,
// .claude.json ×2, last-cert.json) ran per REPAINT — a full JSON parse per
// arrow keypress on the render path (the C6 I/O class, read side). None can
// change mid-splash; each caches its first answer for the process lifetime.
let modelLabelCached = null
function modelLabel() {
  if (modelLabelCached !== null) return modelLabelCached
  modelLabelCached = computeModelLabel()
  return modelLabelCached
}
function computeModelLabel() {
  try {
    const s = JSON.parse(readFileSync(join(CONFIG_HOME, 'settings.json'), 'utf8'))
    const m = typeof s.model === 'string' ? s.model.trim() : null
    if (!m) return 'default'
    const oneM = /\[1m\]$/i.test(m)
    const bare = m.replace(/\[1m\]$/i, '').trim()
    const key = bare.toLowerCase()
    // hasOwn: settings input must never reach the prototype chain — a value
    // like "constructor" renders RAW, same as any other unknown id.
    const known = Object.hasOwn(MODEL_NAMES, key) ? MODEL_NAMES[key] : undefined
    const base = known || (bare.length > 18 ? bare.slice(0, 17) + '…' : bare)
    return base + (oneM ? ' (1M)' : '')
  } catch {
    return 'default'
  }
}
// The critter FAMILY (the accent unpinned): same
// precedence as the REPL's resolveInitialKey (sessionAccent.ts): the
// explicit env pin, else the PERSISTED /critter default from the config
// home's monolith — resolveConfigFile, .mercury-first: the legacy-name
// read here served FROZEN-STALE facts on every adopted home (a field
// defect) — else the pool default, which is the CORE's baked
// DEFAULT_CRITTER (jellyfish since CR-3; the old hand-pinned 'octopus'
// fallback had gone stale against the app and a fresh home's strip
// disagreed with its booted session — exactly the desync the baked table
// exists to kill). accentFamilyKeyOf also resolves retired spellings to
// their successor ('mantis' / 'mantis shrimp' → 'clam') and keys with no
// successor ('dragon') to the default — the same creature sessionAccent
// resolves, so the splash can never wear a
// different family than the session it boots. (The old CRITTER_HUES hand
// mirror + the zero-caller critterHueSGR helper retire onto the baked
// ACCENT_FAMILIES table.)
function computeCritterKey() {
  let c = (process.env.MERCURY_CRITTER ?? '').trim()
  if (!c) {
    try {
      const cfg = JSON.parse(readFileSync(resolveConfigFile(), 'utf8'))
      if (typeof cfg.defaultCritter === 'string') c = cfg.defaultCritter.trim()
    } catch (err) { noteChipFailure('theme', err) /* absent ⇒ default */ }
  }
  return c ? accentFamilyKeyOf(c) : DEFAULT_CRITTER
}
const CRITTER_KEY = computeCritterKey()
function critterLabel() {
  return CRITTER_KEY.charAt(0).toUpperCase() + CRITTER_KEY.slice(1)
}

// ── THE APPEARANCE FAMILY (the launcher follows the persisted theme) ───────
// The persisted appearance selects the ground family for the WHOLE launcher
// estate — the OSC-11 ground, the plate fills, the park ink, every AA/
// residue mix — through the core's one VOID anchor (adoptGroundFamily,
// in-place, before any core exists). The ladder mirrors the runtime's
// initialThemeSetting: the MERCURY_THEME_PIN env wins, then the stored
// global-config theme, else the dark identity. K3 stance: this read is
// COSMETIC — any failure (absent file, corrupt JSON) keeps the dark ground
// silently, exactly the runtime's own concreteTheme() fallback; the boot
// must never stall or complain over a ground color.
function persistedThemeName() {
  const pin = process.env.MERCURY_THEME_PIN
  if (pin) return String(pin).toLowerCase().trim()
  try {
    const stored = JSON.parse(readFileSync(resolveConfigFile(), 'utf8')).theme
    return typeof stored === 'string' ? stored.toLowerCase().trim() : ''
  } catch {
    return '' // absent/corrupt config — the dark identity default
  }
}
adoptGroundFamily(persistedThemeName() === 'true-black' ? 'true-black' : 'dark')

// ── the shared compose core, bound to capability + the accent family ────────
const core = createSplashCore({ nocolor: NOCOLOR, truecolor: TRUECOLOR, accent: CRITTER_KEY })
const {
  R, DIM,
  rgbFg, rgbBg, hexFg,
  composeLockup, placeBlock,
  composeStrip: coreComposeStrip,
  composeBootMenu: coreComposeBootMenu,
  mixc,
  T256, VOID, FAINT, IVORY,
  ACCENT: FAM, ACCENT_HEX, accentFg,
} = core
// Active-account identity for the strip ("which credential am
// I on" was invisible until /accounts). NON-SECRET by the accountSnapshot
// contract: only the config monolith's oauthAccount fields are read
// (resolveConfigFile — .mercury-first; the legacy-name read served a
// frozen-stale account on adopted homes — a field defect);
// .credentials.json is NEVER opened here. Absent ⇒ null (the honest
// not-signed-in state); a FAILED read ⇒ READ_FAILED (K3 — the strip says
// 'unreadable' instead of lying not-signed-in).
let accountLabelCached = false // false = unread; null is a real answer
function accountLabel() {
  if (accountLabelCached !== false) return accountLabelCached
  accountLabelCached = computeAccountLabel()
  return accountLabelCached
}
function computeAccountLabel() {
  try {
    const o = JSON.parse(readFileSync(resolveConfigFile(), 'utf8'))
    const email =
      o && o.oauthAccount && typeof o.oauthAccount.emailAddress === 'string'
        ? o.oauthAccount.emailAddress.trim()
        : null
    if (!email) return null
    return email.length > 26 ? email.slice(0, 25) + '…' : email
  } catch (err) {
    return noteChipFailure('account', err) ? READ_FAILED : null
  }
}
// The repo's /doctor certificate (cwd-scoped .mercury/doctor/last-cert.json).
let certInfoCached = false // false = unread; null is a real answer
function certInfo() {
  if (certInfoCached !== false) return certInfoCached
  certInfoCached = computeCertInfo()
  return certInfoCached
}
function computeCertInfo() {
  // Mirror of the runtime's project path (src/utils/projectConfig.ts —
  // `.mercury`): the
  // doctor writes its certificate through that owner (doctorStateRoot).
  for (const projDir of ['.mercury']) {
    try {
      const o = JSON.parse(
        readFileSync(join(process.cwd(), projDir, 'doctor', 'last-cert.json'), 'utf8'),
      )
      if (o && typeof o.verdict === 'string') {
        const t = Date.parse(o.ranAt)
        return { verdict: o.verdict, age: Number.isFinite(t) ? fmtAge(Date.now() - t) : null }
      }
    } catch (err) { noteChipFailure('health(' + projDir + ')', err) /* try the sibling */ }
  }
  return null
}

let lastSplashAction = null
let lastSplashActionDir = null
// LH-01: the launch id — minted by the LAUNCHER (env-down only,
// never parsed back by any shell), embedded in every receipt this splash
// writes, and matched by the runtime consumer. Two interactive launches
// sharing one config home can never consume each other's choices: a
// foreign-id receipt is left untouched for its own runtime.
const LAUNCH_ID = process.env.MERCURY_LAUNCH_ID || null

function writeSplashAction(action, dir) {
  lastSplashAction = action
  lastSplashActionDir = dir || null
  // ONESHOT captures/proofs must never mutate the home (the same purity law
  // writeScreenReceipt and stampBootAttempt already carry — a SIGTERM'd
  // capture must not write a cancel receipt through this path).
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(
      join(CONFIG_HOME, 'splash-action.json'),
      JSON.stringify({ version: 1, ts: Date.now(), action, ...(dir ? { dir } : {}), ...(LAUNCH_ID ? { launchId: LAUNCH_ID } : {}) }) + '\n',
    )
    // NO plain-text twin is written. The
    // launchers parse NOTHING the splash writes — cmd's `set /p` swallows
    // an LF-only twin into a multi-line %VAR% whose first expansion is a
    // malformed `if`, aborting the batch before node ever starts (the
    // all-Windows interactive-boot strand class). The RUNTIME is the one
    // receipt consumer (validated JSON under MERCURY_SPLASH_HANDOFF); launchers
    // branch on this process's EXIT CODE alone — see collapse().
  } catch { /* read-only home — plain launch */ }
}

function writeScreenReceipt(screen) {
  // 3.6.2 (BM-20): the SETTLED screen fact — 'held' | 'restored' — rides the
  // JSON receipt for the RUNTIME consumer + field diagnostics. The launchers
  // read this process's EXIT CODE, never this file (no plain-text
  // twin — that is what cmd's `set /p` reader chokes on). A skipped
  // splash writes NOTHING (piped/off runs leave the home untouched — updater
  // purity law).
  // Env-read (not the ONESHOT const): the not-entered gate runs before
  // that declaration — a lexical read here would be a TDZ crash.
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    mkdirSync(CONFIG_HOME, { recursive: true })
    writeFileSync(
      join(CONFIG_HOME, 'splash-action.json'),
      JSON.stringify({
        version: 1,
        ts: Date.now(),
        ...(lastSplashAction ? { action: lastSplashAction } : {}),
        ...(lastSplashActionDir ? { dir: lastSplashActionDir } : {}),
        ...(LAUNCH_ID ? { launchId: LAUNCH_ID } : {}),
        screen,
      }) + '\n',
    )
  } catch { /* read-only home — plain launch */ }
}

// BM-30/REC-4: the boot-completion beacon's ATTEMPT half. Every
// interactive HANDOFF (never a cancel, never ONESHOT captures) stamps an
// attempt; the runtime's startup — the same numStartups increment the field
// audit used as its liveness oracle — clears the file. A boot that dies
// between the two leaves residue behind, and doctor + the update verb read it
// and name `mercury update --rollback`: a bricked interactive boot
// self-announces at the next verb instead of dying silent (the 1.5.4 field
// shape — batch abort, exit 0, zero product writes).
function stampBootAttempt() {
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return
  try {
    const p = join(CONFIG_HOME, 'boot-attempts.json')
    let attempts = []
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'))
      if (o && o.version === 1 && Array.isArray(o.attempts)) {
        attempts = o.attempts.filter(t => typeof t === 'number')
      }
    } catch { /* absent or torn — start fresh */ }
    attempts.push(Date.now())
    if (attempts.length > 20) attempts = attempts.slice(-20)
    writeFileSync(p, JSON.stringify({ version: 1, attempts }) + '\n')
  } catch { /* read-only home — the beacon is a lever, never a boot gate */ }
}

// Default-focused on the NEW-SESSION row (#179): ↵ on it = the same plain
// boot-in-cwd the old bare-↵ performed; esc still clears to -1.
let cardSel = 0
let lockupCardShown = false

// The ORIGINAL card, assembled by the ONE shared owner (
// row data assembly lives in splash-core assembleCardRows; this host binds
// its pre-boot scan facts). The concourse ctx is this host's truth: an
// exactly-once receipt action (SG-4e — the runtime applies it as the typed
// boot intent; an older runtime reads 'unknown-action' and boots plain).
function cardRows() {
  return assembleCardRows({
    // node:path basename: the '/'-only split rendered the
    // whole win32 path — the shared clamp owns the 24-col grammar.
    // THE FOLDER IS THE PROJECT, by its name, from boot: the card names the
    // launched folder through the ruled naming seam (a `.mercury` cwd wears
    // its parent's name) — the in-process face composes the same seam, so
    // the hero rows stay byte-equal across the hand-off.
    cwdBase: projectDisplayName(process.cwd()),
    continueTarget: cwdProject
      ? { base: cwdProject.base, ageMs: cwdProject.ageMs, cross: false }
      : recentLast
        ? { base: recentLast.base, ageMs: recentLast.ageMs, cross: true }
        : null,
    menuAvailable,
    // The launcher marks a `--chat` launch (MERCURY_SPLASH_CHAT=1): the
    // --chat card has no concourse row (L15 — New Session is the door), so
    // frame 0 matches the in-process face's six rows across the seam.
    concourse: process.env.MERCURY_SPLASH_CHAT === '1' ? null : { ctx: 'the multi-session board, once' },
  })
}

// ── the PROJECTS picker view RETIRED (the operator's merge:
// the Projects and Resume rows folded into ONE 'Sessions · Projects' row —
// the runtime's merged screen hosts the repos as its second container, so
// this host's in-splash picker died with its card row; the `project`
// action word stays CONSUMED runtime-side for a stale deployed splash).

// The strip's GRAMMAR lives in the shared core (the runtime face grew a
// live-truth strip; both hosts emit through
// coreComposeStrip). This binding keeps the launcher's scan facts + the K3
// honest-failure states exactly as before.
function composeStrip(w) {
  const cert = certInfo()
  const acct = accountLabel()
  return coreComposeStrip(
    {
      model: modelLabel(),
      critter: critterLabel(),
      critterHue: ACCENT_HEX,
      dir: projectDisplayName(process.cwd()), // through the ruled naming seam
      acct:
        acct === READ_FAILED
          ? { state: 'unreadable' }
          : acct
            ? { state: 'email', text: acct }
            : { state: 'none' },
      health: cert ? { verdict: cert.verdict, age: cert.age } : null,
    },
    w,
  )
}

function activateCardRow(r2) {
  if (r2.key === 'menu') {
    view = 'menu'
    paintView()
    return
  }
  leaving = true
  // 'new' = a plain boot in cwd — no ACTION is written (#179). Since 3.6.2
  // the settle still writes the RECEIPT-ONLY JSON (screen fact, no action
  // key) at restoreAndBrand — a field diagnosis
  // traced hours lost to this comment claiming "no file at all". The
  // runtime consumer treats a receipt without an action as a plain boot.
  // K2: continue hands a dir ONLY for the labeled cross-repo fallback
  // (cwd history ⇒ no dir ⇒ the launcher stays put); resume NEVER hands a
  // dir — the runtime picker opens cwd-scoped with its own cross-project
  // toggle.
  if (r2.key === 'continue')
    writeSplashAction('continue', cwdProject ? undefined : recentLast ? recentLast.dir : undefined)
  else if (r2.key === 'doctor') writeSplashAction('doctor')
  else if (r2.key === 'concourse') writeSplashAction('concourse')
  // The merged Sessions · Projects row: the WIRE WORD is
  // 'resume' BY DESIGN — an older runtime reading it opens its own resume
  // screen honestly; this runtime opens the merged screen (the degradation
  // law both directions, no new word needed).
  else if (r2.key === 'sessions') writeSplashAction('resume')
  // The MCPs & Skills row (L24(5)): the manager is RUNTIME-ONLY (this
  // host never renders it), so the row hands over with the `kit` action —
  // the runtime boots onto the Boot face with the manager open; an older
  // runtime reads 'unknown-action' and boots plain (the protocol's law).
  else if (r2.key === 'kit') writeSplashAction('kit')
  // The Saturn Scheduler row: the screen is RUNTIME-ONLY (this host never
  // renders it) — hand over with the `saturn` action; the runtime boots
  // onto the Boot face with the scheduler open (the kit door's law).
  else if (r2.key === 'saturn') writeSplashAction('saturn')
  // The Logins row: the sign-in layer is RUNTIME-ONLY —
  // hand over with the `logins` action; an older runtime reads
  // 'unknown-action' and boots plain (the protocol's law).
  else if (r2.key === 'logins') writeSplashAction('logins')
  // The Agents row (AGENTFACE C4): the agent studio's face layer is
  // RUNTIME-ONLY — hand over with the `agents` action; an older runtime
  // reads 'unknown-action' and boots plain (the protocol's law).
  else if (r2.key === 'agents') writeSplashAction('agents')
  launch()
}

// The boot-menu dispatcher: the COMPOSITION lives in the
// shared core (composeBootMenu — the ratified three-panel layout ≥110 cols,
// the classic single-column below), host data injected here. The KEY
// CONTRACT is identical in both tiers (↑↓/jk · ↵/space/→ cycle+save · ← ·
// s · esc) — only the rendering differs.
function menuData() {
  const entries = MENU.map(r2 => {
    const ch = choiceOf(r2)
    // WI-4: canonical-then-legacy — a legacy-pinned environment shows its
    // pin in BOTH layouts.
    const pinnedVal = process.env[r2.env] !== undefined
      ? process.env[r2.env]
      : r2.legacy
        ? process.env[r2.legacy]
        : undefined
    return {
      label: r2.label,
      group: r2.group,
      summary: r2.summary,
      valueLabel: ch.l,
      valueIsDefault: ch.v === null,
      pinnedVal: pinnedVal === undefined ? null : pinnedVal,
      detail: r2.detail || null,
    }
  })
  // WI-4: resolve by canonical OR retired spelling.
  const val = env => {
    const r2 = MENU.find(x => x.env === env || x.legacy === env)
    return r2 ? choiceOf(r2).v : null
  }
  const changed = MENU.filter(r2 => choiceOf(r2).v !== null).length
  const harness = [
    // Opt-in: the party is ON only when the saved choice says so.
    val('MERCURY_PARTY') === '1' ? 'party' : null,
    // The declutter: helm home + console LEFT the menu (default-ON,
    // no saved row exists any more) — the env kill is their only off-switch,
    // so the chip reads the live env pair directly (canonical wins; the
    // WI-4 constants class must not resurrect through a retired row read).
    process.env.MERCURY_HELM_HOME === '0' ? null : 'helm',
    process.env.MERCURY_HELM_CONSOLE === '0' ? null : 'console',
  ].filter(Boolean)
  return {
    entries,
    selIdx: menuRow,
    summary: {
      profile: changed > 0 ? `custom · ${changed} set` : 'default',
      harness: harness.join(' · ') || 'none',
      integrity: val('MERCURY_THEMIS') || 'off',
      integritySet: !!val('MERCURY_THEMIS'),
    },
    environment: {
      model: modelLabel(),
      critter: critterLabel(),
      critterHue: ACCENT_HEX,
      // node:path basename (the fourth '/'-only site once
      // lived in this panel).
      dirBase: projectDisplayName(process.cwd()),
      dirTail: gitEnvTail(),
    },
    statusRight: `${changed > 0 ? `${changed} choice${changed === 1 ? '' : 's'} saved to boot-env.json` : 'no blocking issues detected'} — you can launch Mercury.`,
    legend: '↑↓ move · ↵ change (saved) · s launch · esc back',
    legendClassic: '↵ change (saved) · ↑↓ move · s launch · esc back',
    // GLOW: the wide tier carries the pixel word — its greeting phase rides
    // the menu data (null once settled; the classic tier has no word).
    glowWord: glowWordPhase(),
  }
}
function composeMenu(cols) {
  return coreComposeBootMenu(cols, rowsAvail, menuData()).lines
}

// Git branch/state for the ENVIRONMENT panel — probed lazily ONCE, never in
// oneshot captures (determinism), always fail-soft.
let gitProbe = null
function gitEnvTail() {
  if (process.env.MERCURY_SPLASH_ONESHOT === '1') return ''
  if (gitProbe === null) {
    try {
      const b = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8', timeout: 800,
      })
      if (b.status === 0) {
        const st = spawnSync('git', ['status', '--porcelain', '-uno'], {
          encoding: 'utf8', timeout: 1500,
        })
        gitProbe = {
          branch: b.stdout.trim() || null,
          clean: st.status === 0 ? st.stdout.trim() === '' : null,
        }
      } else gitProbe = { branch: null, clean: null }
    } catch {
      gitProbe = { branch: null, clean: null }
    }
  }
  if (!gitProbe.branch) return ''
  return `  ⌥${gitProbe.branch}` + (gitProbe.clean === null ? '' : gitProbe.clean ? ' · clean' : ' · uncommitted')
}


// ── main ─────────────────────────────────────────────────────────────────────
// 3.6.2 note: the not-entered path writes NO receipt — a piped/scripted run
// must leave the home untouched (the updater's byte-purity law), and no real
// launcher pairing reads one here: launchers with the canonical guards skip
// the splash entirely when off, and pre-receipt launchers ignore receipts.
// `static` is the launchers' contract too: they never run this asset in
// that mode and keep their own one-line banner. Run directly (a source
// install), the asset used to play the full animation under `static` and
// strand the terminal (TASK-014 w1-f06-02) — it exits like `off`.
if (process.env.MERCURY_SPLASH === 'off' || process.env.MERCURY_SPLASH === 'static' || !out.isTTY) process.exit(0)

// LIVE geometry — re-read on every terminal resize (the whole point of the
// alt-screen lifetime: fullscreen → minimised recomposes the ladder instead
// of leaving a rewrapped corpse of the larger lockup).
let cols = Math.max(20, out.columns || 80)
let rowsAvail = Math.max(8, out.rows || 24)
// The classic menu is a WINDOWED viewport (the small-terminal tier):
// short windows scroll the list behind ↑/↓ more indicators instead of losing
// the menu entirely. 13 rows = header/blanks/summary/legend chrome (7) + a
// 5-line list window + one slack row; below that the lockup hint drops `m`.
const computeMenuAvailable = () => MENU.length > 0 && cols >= 64 && rowsAvail >= 13
let menuAvailable = computeMenuAvailable()

const ONESHOT = process.env.MERCURY_SPLASH_ONESHOT === '1'
let view = process.env.MERCURY_SPLASH_VIEW === 'menu' && menuAvailable ? 'menu' : 'lockup'

// ── the CINEMATIC gate (operator ruling: "typing 'mercury'
//    causes the animation splash first now to avoid the friction") ───────────
// The runtime's defined-falsy family (envUtils isEnvDefinedFalsy), mirrored
// inline — the standalone splash owns no registry import. Unset/'' holds
// (fullscreen default); any defined-falsy spelling releases to inline so
// the splash, launcher and runtime agree on every cell of the value matrix
// (2-2-2 catch: 'false'/'no'/'off' stranded an inline REPL in the alt buffer).
const _fsRaw = String(process.env.MERCURY_FULLSCREEN ?? '').toLowerCase().trim()
const HOLD_ALT_FOR_HANDOFF = _fsRaw === '' || !['0', 'false', 'no', 'off'].includes(_fsRaw)
// FULLSCREEN boots are ANIMATION-FIRST: paint the settled hero frame once,
// auto-run the code trace, hand over — no waiting state, no launcher menu
// stop; the ORIGINAL card lands in-process on the runtime Boot face. The
// INLINE path (MERCURY_FULLSCREEN defined-falsy) keeps the stop-and-choose
// splash whole — route surfaces have no frame there (CB-10), so the
// launcher card/menu/projects views remain the inline path's full menu.
// Forced capture views (MERCURY_SPLASH_VIEW) keep the waiting world too.
const CINEMATIC = HOLD_ALT_FOR_HANDOFF && !process.env.MERCURY_SPLASH_VIEW

// ── THE FLAT GROUND (operator ruling) ───────────────────
// The splash paints NO field background. Six rounds of vignette work (the
// OASIS canvas, the CA-48 full-grid explicit paint, the round-6 per-host
// SGR-49 edge arm) all managed the same structural liability: a painted
// field and the OSC-11 ground are two separate channels that can drift —
// and did. The forensic root cause of the operator's bottom band:
// the vignette painted its edge cells #070D12 while the
// RUNTIME re-asserts the OSC-11 ground to NIGHT #0D181B at the handoff
// (enterOasisBg via renderAndRun) — two of our own constants fighting at
// the padding ring. The main REPL never had the issue because it paints
// NOTHING: one OSC-11 ground, glyphs on it. The splash adopts exactly that
// model — the OSC-11 write below sets the SHARED mercuryPalette NIGHT
// ground (the same value oasisBg.ts sets at runtime boot, so the child's
// re-assert is a byte-identical no-op: one continuous surface from launcher
// through boot to the REPL) and every composed line rides it. Explicit
// CONTENT backgrounds (rasterHard art cells, the PLATE_TONE box plate, the
// held brand's maroon backing) live inside the composed line bytes and are
// untouched.
// The OSC-11 gate: colour-capable (TRUECOLOR — the 256/NOCOLOR tiers never
// recolour a terminal) + the MERCURY_OASIS_BG opt-out
// ("never recolour my terminal ground"), canonical spelling one rung above
// the legacy — the same alias law the runtime flag registry resolves for
// oasisBg.ts. The runtime's exit ground-heal mirrors THIS predicate
// (oasisBg.ts splashCouldHaveRecoloured).
const OSC11_GROUND =
  TRUECOLOR && process.env.MERCURY_OASIS_BG !== '0'
function frame(block) {
  // No trailing newline — a full-height block would scroll the
  // alternate screen by one row and lose its top line.
  return block.join('\n')
}

// Paint the current view from a clean slate. In the alt screen a full
// clear+home+write is rewrap-proof and imperceptible at these sizes — the
// old cursor-up in-place erase died the moment a resize rewrapped the block.
// The ONE placed brand row — set by paintView from the lockup's
// composed wordmark line, read by ripple() and holdFrame() so the brand and
// the gradient's bright band hold the SAME row through splash → ripple →
// hold. null = no lockup on screen (menu/projects view) ⇒ consumers fall
// back to true centre, today's behaviour.
let lockupWordRow = null // wordmark centre INDEX within the composed block
let lockupActionLines = [] // card action line indices within the composed block
let placedBrandRow = null // absolute row on the live grid

// ── the HERO FACTS (the one-scene law) ──────────────
// The cinematic boot is ONE continuous scene: the composed hero frame stays
// painted from arrival through the code trace into the handoff hold. These
// facts — the hero's glyph cells (inviolate ink) and its bounding box (a
// routing obstacle the trace rides around) — are captured at every cinematic
// paint and consumed by the trace, the reseat, and the hold.
let heroCells = new Set() // 'x,y' display cells the hero owns (with widths)
let heroBox = null // {x0,y0,x1,y1} glyph bounding box + 1-cell halo
// Per-row wall intervals: y → [x0,x1], each row's glyph hull ±1 with a
// 1-row vertical halo — the hero's stepped silhouette, not its rectangle.
let heroWalls = new Map()
const heroWallAt = (x, y) => {
  const iv = heroWalls.get(y)
  return iv !== undefined && x >= iv[0] && x <= iv[1]
}
const SGR_STRIP_RE = /\x1b\[[0-9;]*m/g
function captureHeroFacts(placed) {
  heroCells = new Set()
  heroBox = null
  heroWalls = new Map()
  const rowSpan = new Map() // y → [min,max] of the row's owned cells
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  placed.forEach((line, y) => {
    const t = line.replace(SGR_STRIP_RE, '')
    let x = 0
    for (const ch of t) {
      const w = MARK_RE.test(ch) ? 0 : cpWidth(ch.codePointAt(0))
      if (ch !== ' ' && w > 0) {
        for (let k = 0; k < w; k++) heroCells.add(x + k + ',' + y)
        const s = rowSpan.get(y)
        if (s === undefined) rowSpan.set(y, [x, x + w - 1])
        else {
          if (x < s[0]) s[0] = x
          if (x + w - 1 > s[1]) s[1] = x + w - 1
        }
        if (x < x0) x0 = x
        if (x + w - 1 > x1) x1 = x + w - 1
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      x += w
    }
  })
  if (x1 >= 0) {
    // THE STATUS POCKET: the block's last ink row is prose (the ready line;
    // the hold swaps it for the hint), and prose keeps a pocket of air the
    // art never needs — its wall interval widens by a margin so field
    // glyphs stop a readable distance short of the text at every geometry.
    // Flush-to-the-face stays the ART's law: every other row is untouched.
    const STATUS_MARGIN = 5
    let statusRow = -1
    for (const y of rowSpan.keys()) if (y > statusRow) statusRow = y
    const ssp = rowSpan.get(statusRow)
    if (ssp) {
      ssp[0] -= STATUS_MARGIN
      ssp[1] += STATUS_MARGIN
    }
    heroBox = { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 }
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      let lo = Infinity, hi = -1
      for (let yy = y - 1; yy <= y + 1; yy++) {
        const sp = rowSpan.get(yy)
        if (sp) {
          if (sp[0] < lo) lo = sp[0]
          if (sp[1] > hi) hi = sp[1]
        }
      }
      if (hi >= 0) heroWalls.set(y, [lo - 1, hi + 1])
    }
  }
}

// The cinematic hero at a live geometry: compose the FULL landing block (the
// one-placement seam law — hero rows byte-equal across the handoff), slice
// off the unpainted card slot, refresh the placed-brand row and hero facts.
// Shared by the trace's resize reseat and the handoff hold.
function composeCinematicHero(C, Rw) {
  const block = compose(C, Rw)
  const { placed: full, top } = placeBlock(block, Rw)
  let placed = full
  if (lockupActionLines.length > 0) {
    placed = full.slice(0, top + Math.min(...lockupActionLines) - 1)
  }
  placedBrandRow = lockupWordRow !== null ? top + lockupWordRow : null
  captureHeroFacts(placed)
  return placed
}

// ── the GREETING SHIMMER ──────────────────────────────────
// The identity ramp's bounded greeting on the two ramped surfaces of the
// waiting world: the pixel WORD (first paint of the lockup, and again on
// each entry into the wide menu — re-opening a surface is a fresh greeting)
// and the selected CARD row's label (fresh greeting per selection). The
// schedule is the core's mirrored law (glowPhaseAt — ~10 s, eased in/out,
// then settled forever). ONE unref'd interval runs only while a greeting is
// live and is DROPPED at settle (the subscriber-counted timer law); each
// tick recomposes the current view and rewrites ONLY the lines whose bytes
// changed — the band's few cells, never a full-frame repaint (the ripple's
// incremental-painter lesson). The settled frame is the plain composition
// byte-for-byte (boost 0 ⇒ the same sample), so the final tick paints
// today's exact static gradient and stops.
// Gate: inline waiting world only (CINEMATIC auto-advances; ONESHOT is the
// paint-once capture purity), truecolor (reduced colour collapses the ramp
// flat — nothing to sweep), and the reduced-motion pair suppresses it
// entirely (the ripple's own accessibility law).
const glowEnabled = () =>
  TRUECOLOR &&
  !ONESHOT &&
  !CINEMATIC &&
  process.env.MERCURY_REDUCED_MOTION !== '1'
let glowTimer = null
let glowWordStart = null // greeting t0 for the word (per surface entry)
let glowRowStart = null // greeting t0 for the selected card row
let glowViewArmed = null // which view the word greeting was armed for
let lastPlaced = null // the last painted frame's lines (the diff base)
let lastPlacedEpoch = -1 // sizeEpoch at the diff base's paint (resize guard)
// (declared HERE, above the first paintView call — the
// resize handler is a reader; a later declaration would TDZ the
// first paint's epoch stamp)
let sizeEpoch = 0

const glowWordPhase = () =>
  glowWordStart === null ? null : glowPhaseAt(Date.now() - glowWordStart, WORD_W)
const glowRowPhase = () =>
  glowRowStart === null || cardSel < 0
    ? null
    : glowPhaseAt(Date.now() - glowRowStart, CARD_LABEL_W)

function glowLive() {
  const now = Date.now()
  const wordLive =
    glowWordStart !== null &&
    !glowSettled(now - glowWordStart) &&
    (view === 'lockup' || view === 'menu')
  const rowLive =
    glowRowStart !== null &&
    !glowSettled(now - glowRowStart) &&
    view === 'lockup' &&
    cardSel >= 0 &&
    lockupCardShown
  return wordLive || rowLive
}
function ensureGlowTimer() {
  if (glowTimer !== null || !glowEnabled() || !glowLive()) return
  glowTimer = setInterval(glowTick, GLOW_TICK_MS)
  glowTimer.unref?.()
}
function stopGlowTimer() {
  if (glowTimer !== null) {
    clearInterval(glowTimer)
    glowTimer = null
  }
}
function armGlowWord() {
  if (!glowEnabled()) return
  glowWordStart = Date.now()
  ensureGlowTimer()
}
function armGlowRow() {
  if (!glowEnabled()) return
  glowRowStart = Date.now()
  ensureGlowTimer()
}
// One tick: recompose at the live phases, rewrite only the changed lines
// (same glyphs, colour-only deltas — an in-place overwrite is exact), inside
// the same DEC 2026 atomic brackets every splash paint rides.
function glowTick() {
  if (leaving || exiting || inRipple) {
    stopGlowTimer()
    return
  }
  const alive = glowLive()
  repaintChangedLines()
  if (!alive) stopGlowTimer() // the settled bytes just painted — done
}
function repaintChangedLines() {
  if (lastPlaced === null) return
  // A resize inside its 60ms debounce window: the diff base is the OLD
  // geometry — hold this tick and let the debounced paintView re-base.
  if (lastPlacedEpoch !== sizeEpoch) return
  const block = view === 'menu' ? composeMenu(cols) : compose(cols, rowsAvail)
  const { placed } = placeBlock(block, rowsAvail)
  let buf = ''
  const n = Math.max(placed.length, lastPlaced.length)
  for (let i = 0; i < n; i++) {
    const next = placed[i] ?? ''
    if (next !== (lastPlaced[i] ?? '')) buf += `\x1b[${i + 1};1H` + next
  }
  lastPlaced = placed
  if (buf) out.write('\x1b[?2026h' + buf + '\x1b[?2026l' )
}

function paintView() {
  // ONE immutable geometry snapshot per paint transaction: compose, place,
  // and paint all read THESE two values (the D7 double-read fix).
  const snapCols = Math.max(20, out.columns || 80)
  const snapRows = Math.max(8, out.rows || 24)
  cols = snapCols
  rowsAvail = snapRows
  const block = view === 'menu' ? composeMenu(snapCols) : compose(snapCols, snapRows)
  const { placed: placedFull, top } = placeBlock(block, snapRows)
  let placed = placedFull
  // The CINEMATIC frame: the full block placed the hero;
  // paint stops at the card slot — those cells stay canvas, and the runtime
  // landing raises the ORIGINAL card under the identical hero rows.
  if (CINEMATIC && view === 'lockup' && lockupActionLines.length > 0) {
    placed = placedFull.slice(0, top + Math.min(...lockupActionLines) - 1)
  }
  placedBrandRow = view === 'lockup' && lockupWordRow !== null ? top + lockupWordRow : null
  // The one-scene anchor: the cinematic hero's cells and box feed the trace.
  if (CINEMATIC && view === 'lockup') captureHeroFacts(placed)
  // GLOW: this full paint is the diff base the greeting ticks rewrite
  // against; entering a ramped surface (lockup or the menu — the wide tier
  // carries the word) arms a fresh word greeting, while a resize repaint of
  // the SAME view keeps the running one (re-open greets, reflow doesn't).
  lastPlaced = placed
  lastPlacedEpoch = sizeEpoch
  if (view !== glowViewArmed) {
    glowViewArmed = view
    if (view === 'lockup' || view === 'menu') armGlowWord()
    // Entering the lockup with a standing selection (the default-focused
    // New Session row on first paint, or a return from menu/projects)
    // greets that selection too — the reference moment.
    if (view === 'lockup' && cardSel >= 0) armGlowRow()
  }
  // DEC 2026 brackets: erase+repaint must commit ATOMICALLY — an
  // unsynchronized 2J gets its own visible frame under ConPTY and every
  // selection move flashed BLACK on Windows Terminal (first live Windows
  // run). Same idiom the intro animation already rides;
  // terminals without 2026 ignore the brackets.
  out.write('\x1b[?2026h\x1b[2J\x1b[H' + frame(placed) + '\x1b[?2026l')
}

// 1007 (alternateScroll) rides the WHOLE splash hold too (fable scroll audit,
// residual of the handoff fix): the pre-↵ window is the longest idle-wheel
// stretch of the boot — without it a trackpad tick while reading the splash
// slid Apple Terminal into saved lines. Wheel-as-arrows lands in our stdin,
// which the lockup view ignores.
out.write('\x1b[?1049h\x1b[?1007h\x1b[?25l')
// OSC 11: set the terminal's DEFAULT background — window padding included,
// which cells can never reach (the operator's "corners revert to old
// terminal" fringe). Round 7: the value is the SHARED ground — mercuryPalette
// NIGHT via the core's GROUND export — the same value oasisBg.ts sets at
// runtime boot, so launcher → boot → REPL is one continuous surface and the
// child's own set is a byte-identical no-op. Ignored harmlessly by terminals
// without OSC 11.
// OASIS_BG=0 is the operator's "never recolour my terminal ground" opt-out —
// the splash honors it for its OWN OSC 11 too, so the child's exit heal
// (gated on the same flag) never has an orphaned set to chase (the compositor
// verify wave, the flag-family collision). 3.6.1 (BM-19): the CANONICAL
// MERCURY_OASIS_BG wins one rung above the legacy spelling — the same
// alias law the runtime flag registry resolves for oasisBg.ts.
if (OSC11_GROUND)
  out.write('\x1b]11;#' + GROUND.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase() + '\x07')
paintView()
// The fullscreen boot AUTO-ADVANCES on the next tick — frame 0
// is a settled composition, never a stop. launch() runs the code trace
// (rippleEnabled) or collapses straight to the handoff (RIPPLE=0 / reduced
// motion / non-truecolor — the fastest path). ONESHOT keeps its paint-once
// purity; the inline path keeps the waiting deck below.
if (CINEMATIC && !ONESHOT) {
  setImmediate(() => {
    if (leaving || exiting) return
    leaving = true
    launch()
  })
}

// Leave the alt screen, print the one-line brand into real scrollback — then
// HAND THE ALT SCREEN OFF instead of leaving the operator on the main screen.
//
// THE HANDOFF GAP ("the lock is not persistent" root cause): this
// splash is a SEPARATE process from the REPL. The old exit restored the main
// screen and died; the launcher then booted the 13MB dist, which only
// re-enters the alt screen at Ink mount — a perceptible MAIN-SCREEN window
// (brand print + bash + node boot) with NO mouse tracking and NO alternate-
// scroll armed. A wheel tick in that window scrolled Apple Terminal into
// saved lines (the prior session's "Resume this session with:" hints — the
// operator's screenshot), and the freshly painted cockpit then sat BELOW the
// scrolled viewport: "the screen lock breaks when the chat starts".
//
// Fix by construction: ONE atomic write — exit alt, brand line to real
// scrollback, RE-ENTER alt with DECSET 1007 (wheel→arrows into the boot
// input buffer, never the emulator window) + a faint holding line. The main
// screen exists for zero interactive instants; the REPL's own alt entry +
// mode re-asserts take over idempotently. Inline mode (MERCURY_FULLSCREEN
// =0 — the REPL lives on the MAIN screen) keeps the plain restore: holding
// alt there would strand the session under a screen it never exits. Every
// exit path funnels through here; the launcher execs the REPL on ALL of them
// (the splash is a fire-and-forget banner), so the handoff hold is universal.
// (HOLD_ALT_FOR_HANDOFF is decoded beside the CINEMATIC gate above — the
// cinematic frame needs the fullscreen fact before the first paint.)
// The handoff HOLD FRAME (operator polish): the old hold was a
// bare black screen with one dim top-left line — a visibly scuffed beat
// between the splash and the cockpit for the whole node boot. The hold now
// CONTINUES the splash's scene: the same gradient canvas (or plain ground),
// the brand on the EXACT row the splash placed it and the ripple held it
// (one shared placedBrandRow across all three, zero jump at
// either transition), and the honest escape hatch centered beneath. The
// incoming app's first frame still replaces it atomically (MERCURY_ALT_HELD
// + armAltScreenTakeover), so splash → hold → cockpit reads as one shot.
function holdFrame(C, Rw) {
  const at2 = (x, y) => `\x1b[${y + 1};${x + 1}H`
  const HINT = 'starting…  (stuck? type: reset↵)'
  const hint = DIM + hexFg(FAINT, T256.faint) + HINT + R
  // THE ONE-SCENE HOLD: a cinematic boot's hold IS
  // the hero frame the trace just resolved into — recomposed at the LIVE
  // size (a mid-animation resize converges here), with the ready line
  // swapped for the honest escape hatch. Nothing jumps: the landing raises
  // the card beneath byte-identical hero rows (the one-placement seam law).
  // Flat ground: the caller's 2J already cleared to the terminal
  // ground — the hold paints only content cells.
  if (CINEMATIC && view === 'lockup') {
    const placed = composeCinematicHero(C, Rw)
    // Ink-aware content test: the composer centers blank rows into runs of
    // spaces, so `.length` alone mistakes a trailing blank for content.
    const hasInk = l => l.replace(SGR_STRIP_RE, '').trim().length > 0
    let lastContent = -1
    for (let i = 0; i < placed.length; i++) if (hasInk(placed[i])) lastContent = i
    let buf = ''
    placed.forEach((line, i) => {
      // The ready line yields to the hold hint (its ↵ promise is stale in
      // the launcher-exec window); the tiny one-line tier keeps its single
      // line and takes the hint beneath instead.
      if (i === lastContent && lastContent > 0) return
      if (hasInk(line)) buf += at2(0, i) + line
    })
    const hy =
      lastContent > 0
        ? lastContent
        : Math.min(Rw - 1, (placedBrandRow ?? Math.round((Rw - 1) / 2)) + 2)
    const hc = Math.max(0, Math.round((C - HINT.length) / 2))
    return buf + at2(hc, hy) + hint
  }
  // The hero-less hold (menu/projects capture launches): brand + hint on
  // the shared placed brand row — fallback + clamp keep it honest.
  const cxi2 = Math.round((C - 1) / 2)
  const cyi2 =
    placedBrandRow !== null && placedBrandRow >= 1 && placedBrandRow < Rw - 1
      ? placedBrandRow
      : Math.round((Rw - 1) / 2)
  const WORD = ' (>_) MERCURY '
  const wc = Math.max(0, Math.round(cxi2 - WORD.length / 2))
  let buf = ''
  const brand =
    accentFg() + ' (>_) ' + hexFg(IVORY, T256.cream) + 'MERCURY ' + R
  buf += at2(wc, cyi2) + brand
  const hy = Math.min(Rw - 1, cyi2 + 2)
  const hc = Math.max(0, Math.round(cxi2 - HINT.length / 2))
  buf += at2(hc, hy) + hint
  return buf
}
function restoreAndBrand() {
  // A cancelled boot takes the QUIT branch — no held alternate
  // buffer, no "starting…" hold frame (nothing is coming to take it);
  // the terminal gets its main screen and profile ground back.
  if (HOLD_ALT_FOR_HANDOFF && !cancelled) {
    // SGR-PARK (the leaked-'p' fix, task #6): setRawMode(false) below hands
    // the tty back to canonical mode for the launcher exec window — a key
    // typed in that gap ECHOES onto the hold screen (the operator's 'p'
    // flash). The terminal cannot be told not to echo from here once raw
    // drops, so PARK the SGR state instead: ink painted in the ground color
    // (fg == bg on the NIGHT ground; ANSI black-on-black + conceal
    // otherwise — Apple Terminal never implemented SGR 8, so conceal alone
    // leaked the echo there) + the cursor hidden — anything echoed lands
    // INVISIBLE, and the incoming app resets SGR on its first frame. The
    // visible hint text is written BEFORE the park, so the honest escape
    // hatch stays readable.
    const C = Math.max(24, out.columns || 80)
    const Rw = Math.max(8, out.rows || 24)
    const parkInk = TRUECOLOR
      ? `\x1b[38;2;${VOID.join(';')}m\x1b[48;2;${VOID.join(';')}m`
      : '\x1b[30;40m\x1b[8m'
    // The whole bounce — leave alt, brand into scrollback, re-enter, hold —
    // rides ONE DEC-2026 bracket (one-scene law): a supporting terminal
    // applies it atomically, so the trace's settled scene becomes the hold
    // with no intermediate beat; terminals without 2026 see today's single
    // write exactly as before.
    out.write(
      '\x1b[?2026h' +
      '\x1b[?1049l' + brandLine() + '\n' +
      '\x1b[?1049h\x1b[?1007h\x1b[?25l\x1b[2J' + holdFrame(C, Rw) +
      '\x1b[H' + parkInk + '\x1b[?25l' +
      '\x1b[?2026l',
    )
    screenAtExit = 'held'
    writeScreenReceipt('held')
    stampBootAttempt()
  } else {
    // Quit-without-launch: the splash set the terminal's default ground at
    // boot (OSC 11, the OSC11_GROUND predicate) and no child will ever
    // restore it — hand the user's own profile ground back (OSC 111) before
    // leaving. On a launch handoff the child owns the channel (its ground
    // lifecycle owner restores at exit), so the hold branch above stays
    // silent.
    if (OSC11_GROUND) out.write('\x1b]111\x07')
    // ?1007l on the cancel exit too: the hold armed alternate scroll for its
    // whole life and this was the one exit that skipped disarming it (the
    // launchers stand down on exit 130), leaving DECSET 1007 set in the
    // operator's shell (TASK-017 S2, splash-cancel-leaves-alternate-scroll-armed).
    out.write('\x1b[?1007l')
    out.write('\x1b[?1049l')
    out.write(brandLine() + '\n')
    out.write('\x1b[?25h')
    screenAtExit = 'restored'
    writeScreenReceipt('restored')
    // Inline mode (MERCURY_FULLSCREEN=0) still LAUNCHES — only a cancel
    // stands the boot down, so only a non-cancel handoff is an attempt.
    if (!cancelled) stampBootAttempt()
  }
  try { process.stdin.setRawMode(false) } catch { /* not raw */ }
}

// The ONE exit funnel: process.exit() does not wait for queued
// asynchronous stdout writes — on win32 (async TTY writes) the final hold
// frame, the OSC 111 reset, or the scrollback brand line could be partially
// written or dropped: a torn screen at exactly the hand-off moment. Every
// exit now flushes the pending boot-env write (C6), then drains stdout via a
// write callback before exiting; a 2s cap guarantees the process still
// leaves if the terminal never drains.
let exiting = false
let screenAtExit = null // set by restoreAndBrand: 'held' | 'restored'
function collapse(code, drainCapMs = 2000) {
  if (exiting) return
  exiting = true
  restoreAndBrand()
  flushBootEnv()
  // ── THE LAUNCHER EXIT-CODE CONTRACT (BM-30) ───────────────────
  // The exit code is the ONE machine-readable channel the launchers consume —
  // cmd compares NUMBERS only (string-parsing a product-written file is the
  // class that aborted every 1.5.4 Windows interactive boot):
  //   0    handoff, screen HELD   → launcher exports the alt-held marker
  //   20   handoff, screen RESTORED (inline mode) → boot without the marker
  //   130  cancel (Ctrl-C / SIGINT / SIGTERM / idle) → stand the boot down
  //   else the splash died abnormally → launcher heals the terminal, boots
  //        plain (a splash failure may cost hold cosmetics, never the boot).
  // The splash-action JSON carries action/dir/screen for the RUNTIME consumer
  // (src/substrate/splashHandover.ts) — the
  // contract; prove-splash.py pins all three codes live.
  let exitCode = code
  if (cancelled) exitCode = 130
  else if (code === 0 && screenAtExit === 'restored') exitCode = 20
  const bye = () => process.exit(exitCode)
  setTimeout(bye, drainCapMs)
  out.write('', bye)
}

// Cancel the BOOT, not just the splash. The splash swallows
// Ctrl-C in raw mode (no console signal ⇒ no cmd.exe "Terminate batch job"
// prompt) and signals the cancellation through its EXIT CODE — every cancel
// leaves through collapse() as 130 (BM-30), and the launchers stand down on
// that number without booting the app. The receipt still records
// action=cancel for diagnostics; the runtime consumer deliberately ignores
// it (a leftover cancel receipt must never kill a later boot).
let cancelled = false
function cancelExit() {
  // WI-1 (a field wedge): `leaving` would otherwise disarm EVERY rescue for
  // the whole animation — Ctrl-C, SIGINT/SIGTERM and the idle timer all
  // funneled into a bare `if (leaving) return` while a stalled frame write
  // held the loop, so only external kill ended the process. A cancel during
  // the ripple now aborts the in-flight frame await and leaves through the
  // funnel: exit 130 + the `cancel` action (the launchers stand down), with
  // a short drain cap so ^C stays responsive even on a dead drain.
  if (leaving && !inRipple) return
  cancelled = true
  writeSplashAction('cancel')
  if (leaving && inRipple) {
    fireRippleInterrupt()
    collapse(130, 1000)
    return
  }
  leaving = true
  collapse(130)
}

// (there is no repaint() — every interaction repaints through
// paintView, the ONE compose+place+paint transaction.)

// Terminal resize: recompose the CURRENT view at the live size (debounced —
// macOS window drags emit a stream of resize events). A menu that no longer
// fits falls back to the lockup honestly. During the ripple, the animation
// loop watches sizeEpoch (declared beside the glow diff base above): the
// cinematic HERO run RESEATS at the live geometry and continues (the
// first-class resize law); a legacy launch still bails to its exit path.
let inRipple = false
// WI-1: the ripple's interrupt plumbing — a bumped counter aborts the run
// (checked at the loop top) and the wake resolver unblocks the IN-FLIGHT
// frame await, so cancel and resize act mid-frame instead of waiting on a
// drain that may never complete.
let rippleAbort = 0
let rippleWake = null
function wakeRippleWaiters() {
  if (rippleWake) { rippleWake(); rippleWake = null }
}
function fireRippleInterrupt() {
  rippleAbort++
  wakeRippleWaiters()
}
let resizeTimer = null
out.on('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    cols = Math.max(20, out.columns || 80)
    rowsAvail = Math.max(8, out.rows || 24)
    menuAvailable = computeMenuAvailable()
    if (view === 'menu' && !menuAvailable) view = 'lockup'
    sizeEpoch++
    if (inRipple) wakeRippleWaiters() // WI-1: unblock a mid-frame await
    if (!inRipple && !leaving) paintView()
  }, 60)
})

if (ONESHOT) {
  // Captures/proofs: leave the painted alt screen ON SCREEN for the PTY
  // emulator to grid — restoring main here would blank the capture.
  // Drain before exit (the frame + this cursor restore are
  // queued async on win32); the 2s cap covers a never-draining pty.
  setTimeout(() => process.exit(0), 2000)
  out.write('\x1b[?25h', () => process.exit(0))
} else {
  // Staleness by construction, AGE-GATED by LH-01: a
  // splash-action pair still on disk at INTERACTIVE startup is a leftover
  // from a crashed boot — but a YOUNG receipt may belong to a LIVE sibling
  // launch sharing this home (its runtime consumes it id-gated seconds from
  // now), so only demonstrably stale files (>10 min) are swept. A crashed
  // leftover younger than that is INERT anyway: no other runtime's id
  // matches it, and the next handoff overwrites it. Never in ONESHOT
  // (captures/proofs must not mutate the home).
  for (const f of ['splash-action.json', 'splash-action.txt']) {
    try {
      const p = join(CONFIG_HOME, f)
      if (Date.now() - statSync(p).mtimeMs > 10 * 60 * 1000) unlinkSync(p)
    } catch { /* absent — the normal case */ }
  }
}

function launch() {
  if (rippleEnabled()) void ripple()
  else collapse(0)
}
function cycleChoice(d) {
  const row = MENU[menuRow]
  const n = row.choices.length
  menuChoice.set(row.env, (((menuChoice.get(row.env) || 0) + d) % n + n) % n)
  // WRITE-THROUGH: a cycled choice persists immediately. The old
  // grammar (only `s` saved; esc/launch silently discarded a row that still
  // READ as changed) was the dishonest-cue class live — the operator cycled
  // a row to on, left with esc+enter, and the session read UNSET
  // with no boot-env.json anywhere. The visible state IS the saved state now;
  // cycling the labeled row is the consent act (per-billed-call consent in
  // the harness is untouched).
  saveBootEnv()
  paintView()
}

try { process.stdin.setRawMode(true) } catch { /* non-tty stdin */ }
process.stdin.resume()
let leaving = false

// ── the stdin coalescer ────────────────────────────────────────
// The handler would otherwise treat every 'data' event as one complete key. Under
// ConPTY a key's bytes are not guaranteed to arrive together — `\x1b[A` can
// be delivered as `\x1b` then `[A`, and the first chunk matched the Escape
// branch: ONE arrow keypress dismissed the menu ("the menu sometimes closes
// on its own"). Chunks now coalesce: a bare ESC or a partial CSI/SS3 prefix
// waits ESC_TIMEOUT_MS for the rest; everything else dispatches immediately
// (paste-inertness preserved — an oversized chunk still fails the isEnter
// equality checks). C4 rides along: utf8 decode, not latin1 (every binding
// is ASCII, but pasted UTF-8 no longer mangles on its way to the inert path).
// SPLASH-COALESCE-START (unit-proven by scripts/splash/prove-splash-units.ts)
const ESC_TIMEOUT_MS = 15
const isPartialEscape = s => s === '\x1b' || /^\x1b(\[|O)[0-9;]*$/.test(s)
const coalesceStep = (pending, chunk) => {
  const merged = pending + chunk
  return isPartialEscape(merged) ? { dispatch: null, pending: merged } : { dispatch: merged, pending: '' }
}
// SPLASH-COALESCE-END
let pendingInput = ''
let pendingTimer = null
process.stdin.on('data', buf => {
  const step = coalesceStep(pendingInput, buf.toString('utf8'))
  pendingInput = step.pending
  clearTimeout(pendingTimer)
  if (step.dispatch !== null) {
    handleKey(step.dispatch)
    return
  }
  pendingTimer = setTimeout(() => {
    const s = pendingInput
    pendingInput = ''
    if (s) handleKey(s)
  }, ESC_TIMEOUT_MS)
  pendingTimer.unref?.()
})

function handleKey(s) {
  // WI-1: the cancel byte outranks the leaving gate — a mid-ripple ^C must
  // reach cancelExit (which owns the ripple-aware disarm rules). Every other
  // key stays dead once a launch is chosen.
  if (s === '\x03') { cancelExit(); return }
  // CINEMATIC input law: during the animation window ↵ is the
  // ONE skip key — it fast-forwards the trace to the handoff (own-event
  // CR/LF/CRLF only; a paste stays inert). Every other byte is inert and
  // can never cause a second launch: the auto-advance owns the single
  // launch() call, and the skip path only interrupts its ripple.
  if (CINEMATIC) {
    const isEnter = s === '\r' || s === '\n' || s === '\r\n'
    if (!isEnter) return
    if (inRipple) { fireRippleInterrupt(); return }
    if (!leaving) { leaving = true; launch() }
    return
  }
  if (leaving) return
  if (view === 'lockup') {
    if ((s === 'm' || s === 'M') && menuAvailable) { view = 'menu'; paintView(); return }
    // Wheel ticks arrive as arrow CSI sequences now that 1007 rides the hold
    // (the viewport-lock fix) — a scroll while READING the splash must not
    // count as "any key" and boot the deck. With the launcher card on screen
    // arrows MOVE the selection (navigation, never activation — a stray wheel
    // tick can highlight a row but only a deliberate ↵ acts); without it they
    // stay inert.
    const isUp = s === '\x1b[A' || s === '\x1bOA'
    const isDown = s === '\x1b[B' || s === '\x1bOB'
    if (isUp || isDown) {
      if (!lockupCardShown) return
      const n = cardRows().length
      if (n === 0) return
      cardSel = isDown ? (cardSel + 1) % n : cardSel <= 0 ? n - 1 : cardSel - 1
      armGlowRow() // a fresh selection is a fresh greeting (the settle law)
      paintView()
      return
    }
    // esc clears a card selection (back to the plain ↵-boots state).
    if (s === '\x1b' && cardSel >= 0) { cardSel = -1; paintView(); return }
    // ↵ is THE activation key. A bare CR / LF / CRLF **as its own data
    // event** is a press; a write that merely CONTAINS a newline is a paste
    // and stays inert (its first byte would otherwise boot the deck — the
    // WILDCARD-ACTIVATION class). The screen promises ↵ and m only, so
    // every unmatched byte returns inert: q, Tab, Space, digits, F-keys,
    // unmatched CSI, kitty CSI-u, stray mouse reports — none of them launch.
    const isEnter = s === '\r' || s === '\n' || s === '\r\n'
    if (isEnter && lockupCardShown && cardSel >= 0) {
      activateCardRow(cardRows()[cardSel])
      return
    }
    if (isEnter) {
      leaving = true
      launch()
      return
    }
    return
  }
  // menu view — nothing here launches by accident
  if (s === '\x1b') { view = 'lockup'; paintView(); return }
  if (s === '\x1b[A' || s === '\x1bOA' || s === 'k') { menuRow = (menuRow + MENU.length - 1) % MENU.length; paintView(); return }
  if (s === '\x1b[B' || s === '\x1bOB' || s === 'j') { menuRow = (menuRow + 1) % MENU.length; paintView(); return }
  if (s === '\x1b[D' || s === '\x1bOD') { cycleChoice(-1); return }
  if (s === '\r' || s === '\n' || s === '\r\n' || s === ' ' || s === '\x1b[C' || s === '\x1bOC') { cycleChoice(1); return }
  if (s === 's' || s === 'S') { saveBootEnv(); leaving = true; launch(); return }
}
// A delivered signal cancels the BOOT (exit 0 + the cancel
// action), mirroring the raw-mode ^C data path — the launchers stand down
// instead of booting the app after a termination request. SIGTERM joins
// deliberately: booting a 20 MB app after
// being told to terminate is the same unattended-launch class as C5.
process.on('SIGINT', cancelExit)
process.on('SIGTERM', cancelExit)
// The idle timer EXITS, never launches. collapse(0) here was
// the LAUNCH path — an enter screen left open half an hour booted a full
// session with nobody watching (worse under a saved MERCURY_SKIP_PERMISSIONS
// boot-env row). Idle now cancels through the same channel as Ctrl-C.
// MERCURY_SPLASH_IDLE_MS: proof/capture override (≥500ms), the
// MERCURY_SPLASH_ONESHOT class — a 30-minute PTY leg is not a proof.
const idleRaw = Number(process.env.MERCURY_SPLASH_IDLE_MS)
const IDLE_MS = Number.isFinite(idleRaw) && idleRaw >= 500 ? idleRaw : 30 * 60 * 1000
// Only a WAITING world can idle — the cinematic path auto-
// advances on its first tick and its boundedness is owned by the WI-1
// drain caps; arming the idle cancel there would race the handoff.
if (!CINEMATIC) setTimeout(cancelExit, IDLE_MS).unref?.()

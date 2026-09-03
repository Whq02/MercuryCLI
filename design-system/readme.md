# Mercury Design System

**The Mercury visual language** — terminal-native, for **Mercury**, a
private, source-built, multi-purpose software-development harness. This is
**not** a web dashboard: every token, component, and screen here translates
directly into an **Ink** terminal UI — panels, rows, dividers, gauges, status
glyphs, and compact tables.

> The core product question every surface answers:
> *When the operator looks at the terminal, can they instantly tell what the
> harness is doing, which agents are active, which model is running, how full
> the context window is, what the session costs, what gates are active, what
> failed, and what command to run next?*

---

## The visual source of truth is the built binary

The live visual target is **`live/manifest.json`**
— semantic cell grids (exact glyphs + fg/bg + bold/reverse) painted by the real
`dist/mercury.mjs` in a PTY, SHA-bound to the source commit and build tree that
painted them.

- Generate / refresh: `bun run scripts/ui/generate-visual-baseline.ts`
- Compare a change: `… --check` (reports the FIRST divergent cell, never a
  loose threshold)
- Gate: `scripts/ui/prove-visual-manifest.ts` (manifest ↔ grid self-consistency)

When any design reference and the manifest disagree, **the manifest wins**.

## Sources

- **Palette (single source of truth):** `src/components/mercuryPalette.ts` — every
  runtime hue is a named token.
- **Semantic layer:** `src/utils/mercuryTokens.ts` (`resolveMercuryTokens` /
  `useMercuryTokens`) — contrast-sensitive chrome consumes THESE roles; raw
  brand hues stay for logo/art.
- **Transcript restyle:** `src/utils/theme.ts` `mercuryWarmInkOverlay()`
  re-tints the base semantic theme.
- **Kit:** `src/components/mercury-ui/` (theme/glyphs/assets/components/
  sessionAccent) · statusbar `src/components/MercuryFrame.tsx` · cockpit
  `src/utils/helmGeometry.ts` + `FullscreenLayout.tsx`.

---

## Content fundamentals

How Mercury writes — match this voice in every label, hint, and panel.

- **Terminal-terse, lowercase keys.** Labels are compact, lowercased nouns:
  `model`, `ctx`, `cost`, `git`, `mcp`, `daemon`, `saturn`, `leases`, `gates`,
  `tasks`, `agents`. Never sentence-case a key, never add a colon unless it's a
  `key value` pair.
- **No prose inside the UI.** A surface is glyphs, numbers, and short fragments
  — never an explanatory paragraph. The longest acceptable strings are honest
  status lines ("no missions — no tasks grouped under a missionId") and enable
  hints ("enable with MERCURY_TRACE=1").
- **Honest state language.** Distinguish, explicitly and always: `on` · `off` ·
  `disabled` · `gated` · `unavailable` · `empty` · `blocked`. A dormant feature
  says exactly how to wake it — never pretends to be live. `configured` is
  never painted `ready`.
- **Roll-ups lead.** A panel opens with a one-line summary before detail:
  *"14 of 19 capabilities active"*, *"24 calls · 2 high-risk · 1 denied"*.
- **Imperatively name the next move.** Command hints are bare slash-commands
  with a short gloss: `❯ /team   background agents`.
- **Env flags are UPPER_SNAKE, verbatim.** `MERCURY_SUBSTRATE`,
  `MERCURY_FULLSCREEN` — exactly as the operator would type them.
- **Voice.** Operational, calm, second-person-implicit. No marketing, no
  exclamation, **no emoji** (glyphs come from `mercury-ui/glyphs.ts`).
- **Numbers, not adjectives.** `$0.12`, `62%`, `+318/-77`, `118ms`.

---

## Visual foundations

**Mood:** calm, tactical, terminal-native — a desert oasis at night. Deliberate
and dense without clutter. Not neon, not cyberpunk, not generic SaaS, not raw
debug output.

### Color

One brand palette (`mercuryPalette.ts`), on the
deep teal-navy **OASIS ground**:

- **Ground ladder:** Night `#0D181B` → Night-soft `#101D21` → Ash `#142327` →
  Ash-raised `#1A2C31`; hairlines Dune-faint `#233A40`; borders/selection Dune
  `#2F4B52`. The terminal ground itself is painted via OSC 11 (window padding
  included) and **follows the theme** — light families keep the profile ground.
- **Default appearance: True Black** — the same palette on the pure-black
  ground family: `#000000` → `#080F11` → `#0B1315` → `#0E181B`; hairlines
  `#132023`; borders/selection `#1A292D`. The oasis ladder above is the
  selectable `dark` appearance (`/appearance`, the first-run walk); ink, the
  identity accent and the status spine are byte-equal across the two, and a
  saved choice always wins over the default.
- **Identity accent:** **TERRA** `#DD4444` (Cute-Crab red — the Mercury
  identity; operator retint) with **CLAW** `#7B3232` in shadow and
  **BELLY** `#E58484` as the highlight. Never use terracotta
  `#E07A50` or lobster `#DE4A35` (the latter exists only as `FABLE_RED`).
- **Ink ramp:** IVORY `#EDE8DD` → SECOND (cool sage) `#A9B4AC` → FAINT
  `#71807B`.
- **Status spine (sacred, never re-tinted):** TEAL `#3FBFA0` (ok/active) ·
  AMBER `#DBA13D` (warn/≥80%) · CRIMSON `#E8556A` (blocked/denied/≥95%).
**OASIS blue** `#3F7E96` — the cool counter-accent. It carries the
  **informational/navigation channel** in the dark
  families (the `info` theme role — panel headers, labels, lane names, plan
  mode, the spinner's requesting phase); in art it stays the crab pupil and
  sigil center.
- **Zero new hex outside `mercuryPalette`/`sessionAccent`.** Import the token,
  never a literal. Contrast-sensitive chrome consumes `useMercuryTokens` roles
  (dark IS the brand mapping; light/daltonized/ansi map from their OWN
  palettes; the ANSI collapse is intentional — names carry meaning).
  `accentSoft` — the bloom tone for sparkles, glints, typed composer text and
  user nameplates — is DERIVED from the live accent (`deriveAccentSoft`; crab
  dark = the authored BELLY byte-equal;) — never re-derive
  it component-locally.

### Type & layout

One monospace family at terminal cell metrics. Hierarchy comes from weight,
color, and case — never a second typeface. Everything snaps to the character
cell; column alignment uses the shared display-width oracle
(`displayWidth`/`truncateToWidth`/`padTo` — `.length` is wrong for CJK/wide).

### Surfaces & chrome

Panels are round 1px frames — accent for the focused/identity surface, DUNE for
resting panels, DUNE_FAINT for inner hairlines. Structural shells (the
CommandCenter frame, inspector/detail panes, WorkCapsule) ride the
`borderStrong`/`borderSubtle` tokens rather than the full accent, and the
resting EMPTY composer border is the calm `promptBorderResting` role —
composing regains the accent. Terminals are flat: **no
shadows, no browser background washes — but bounded SPECTRAL DEPTH is
allowed** (visual depth sits between restrained bands and a smooth
gradient). What is permitted is narrow and named: a
ramp of **five discrete stops** from a family's own ground toward a role hue —
richer than three token bands, never a browser background wash. The ramps live
in `src/utils/mercuryTokens.ts` (`spectralRamp` / the `spectral` token group);
a local literal gradient is still forbidden. Every stop is contrast-floored
against its own ground (≥3.0, the graphical-object floor) and every ramp
collapses to a SINGLE stop on families that cannot host depth (16-color,
no-color), where the consuming surface falls back to its flat rendering —
which costs nothing, because colour is never the sole carrier of state.
Spectral depth is STATIC: computed once, painted once, no timers and no
continued writes. Use it selectively (progress and evidence traces, the
selected-row landing, an active phase, the mascot plinth) — never to fill a
panel, and at most one region carries ambient motion at a time. The
identity/focus ramp IS the session critter's ramp: Mercury's accent is your
companion's hue, so the cockpit's depth carries it by construction. The
cockpit (≥100 cols) speaks ONE bordered-panel
grammar (`RailPanel` cards, `railPlan()` geometry, center ≥78); below it the
deck-strip and inline tiers shed chrome by width AND height. The **SINGLE-BRAND
rule** (critter identity is continuous): the
product word "Mercury" appears exactly once on screen (the transcript
banner-header). **Session-identity slots** — the statusline anchor and the
exit farewell — render the SELECTED critter's authored one-line mark
(`<SessionMark/>`; every registered critter authors a 5-cell silhouette in
the crab lockup's deep/main/deep grammar, `critterData.ts mark`; a crab
session renders byte-identically to the old `<Crab/>`). **Product lockups**
(`<Crab/>` beside the wordmark or the word "Mercury" — CommandCenter shells,
setup/welcome frames, detail-pane headers, CLI output) stay the true crab:
the crab names the product, the session mark names your companion, and the
two are never interchangeable.

### Motion

One nested absolute-bucket clock family — 80 ⊂ 160 ⊂ 320 (FOCAL/TRUTH/DECOR
tiers, `use-animation-frame.ts` + `liveGlyphs.ts` §motion
hierarchy). The alive-glyph grammar (`MERCURY_LIVE_GLYPHS`): motion = work running (◐ rotation), pulse =
waiting-on-you, flash = value changed, spark ✶ = a mutation landed, breath =
ready-and-idle. Frame 0 IS the static glyph — reduced-motion and disabled
states render the exact static cell. No slides, no bounces, no decorative
loops.

### Interaction grammar (one, everywhere)

`InteractiveRow` select-then-activate on every row (pointer/↵ share one body;
`directActivate` for true single-purpose controls; unavailable rows expose no
affordance) · `NavigablePanes` master-detail boards (standing `sideInfo`
inspectors + list-level `rowActions`) · `InteractiveDisclosure` transcript
folds · hierarchical Esc (one layer per press) · hover rides the single
global owner and paints background only. The estate-wide inventory is closed
by `scripts/interaction/prove-interaction-coverage.ts`.

---

## Iconography

The icon system **is the glyph system** — Unicode terminal characters from
`mercury-ui/glyphs.ts` (`GLYPH`), never SVG, never an icon font, never emoji.
One glyph per operational state (● active · ◌ idle · ○ pending · ◐ running ·
▲ warn · ✕ denied · ✓ done · ◆ mission · ❯ prompt · ✶ sigil/spark). Gauges are
block elements `████░░`; frames are box-drawing. The brand mark is the Mercury
crab, one-line lockup via `CRAB_GLYPHS` (single-sourced in
`mercury-ui/assets`).

## Critters & session identity

The mascot is one of an authored **critter family** — cell-art sea creatures
that double as session identities. Each owns a hue; the session accent re-tints
**only identity chrome** (frame border, caret, accent panels) via
`useSessionAccent()` — the status spine never moves. `/critter` picks,
`/accent` overrides (explicit beats derived). The hero's pupils track the
pointer (`MERCURY_CRITTER_GAZE`); the opt-in session companion (`/companion`)
adds one voice beside one creature — one creature representation per layout
region, one voice owner globally.

---

## Index — what's in this directory

- `live/` — **the live baseline**: `manifest.json` + `grids/` (generated; see
  the header above). The only render target.
- `.render/` — design-reference goldens (PNG + palette/geometry notes) diffed
  against the Ink render by eye.

The implementable spec is the real Ink kit in `src/components/mercury-ui/` —
and the live baseline above is the proof of what actually renders.

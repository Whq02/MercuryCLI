---
name: aesthetic-direction
description: Give a web interface a deliberate visual identity — choose one direction, then derive type, colour, spacing, layout, and motion from it so the result does not read as a framework default. Use when designing or restyling pages, landing sites, dashboards, or components in HTML/CSS/React; not for terminal UIs, print, or brand-guideline documents.
when_to_use: The user asks for a design, a redesign, "make it look better", a landing page, or says a UI looks generic or templated.
argument-hint: "<what is being designed> [audience] [constraints]"
---

# Aesthetic direction

Generic interfaces come from skipping the decision. Make it first, write it
down in one line, and let every later choice answer to it.

## 1. Decide the direction before touching code

Write one sentence: who looks at this, what they should feel in the first
second, and the one reference world it borrows from (a print magazine, an
instrument panel, a paper form, a film title sequence). Pick one of these
families or name your own; never blend two:

- **Editorial** — large serif display, generous measure, restrained colour.
- **Instrument** — dense, monospaced or grotesque, data-first, thin rules.
- **Soft product** — rounded geometry, warm neutrals, gentle depth.
- **Brutal** — hard edges, raw black and white, oversized type, visible grid.
- **Luxury** — thin type at scale, wide tracking, deep ground, one metallic accent.

Everything below derives from that sentence. If a choice cannot be justified
by it, it is a default in disguise.

## 2. Typography carries the identity

- One display face with character and one text face that disappears; a third
  face only for code or data. Pair a serif with a grotesque, or one
  superfamily with itself.
- Build a scale from the body size (16–18px) with a fixed ratio (1.2 for
  dense, 1.333 for editorial) and use only its steps.
- Headlines: tighten tracking and line-height as size grows (1.05–1.15 at
  display sizes). Body: 1.5–1.65 line-height, 60–75 characters per line.
- Load fonts with `font-display: swap` and a metric-compatible fallback so the
  page never jumps.

## 3. Colour is a system of three, not a palette of ten

- A ground, an ink, and one accent. Derive the rest as tints and shades of
  those three; neutrals get a hint of the accent's hue so they belong.
- Decide light or dark first and design the other as a second theme, not an
  inversion.
- Text contrast: 4.5:1 for body, 3:1 for large text and UI edges. Check it
  with `python3 scripts/palette_check.py <fg> <bg> …` before committing a
  pair; the script prints the ratio and which level it meets.
- Accent is for the one action that matters on the screen. Two accents
  compete; three are noise.

## 4. Space and layout

- Pick a base unit (4 or 8px) and a spacing scale; never type an unscaled
  margin.
- Decide the grid (columns, gutter, max width) and break it on purpose for
  the one element that should feel different.
- Asymmetry, scale contrast, and whitespace read as intent; centred stacks of
  equal cards read as a template.
- Depth comes from one mechanism: shadow, border, or tonal layering. Mixing
  them looks undecided.

## 5. Motion and detail

- Motion explains change: 150–250ms for state, 300–500ms for layout, eased
  (`cubic-bezier(.2,.8,.2,1)`), never bouncing. Honour
  `prefers-reduced-motion`.
- Detail is where the direction shows: link underline thickness, focus ring
  colour, table rules, form field radii, empty states. Write them down once
  as tokens and reuse them.

## 6. Before calling it done

Look at the result at 360px, 768px, and 1440px. Then ask, for each section:
would a stranger know which direction it follows? If any section could be
swapped into another product unchanged, it has not been designed yet.

Read `references/anti-defaults.md` when a review says "it still looks
generic" — it lists the defaults that give a template away and what replaces
each.

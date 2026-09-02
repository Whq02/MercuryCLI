import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { claimHover, releaseHover, useHoverOwner } from './mercury-ui/useHoverOwned.js'
import { FLAT_ART_LINES, HERO_ART_COLS, HERO_ART_LINES, critterDefForKey } from '../utils/cockpit/critterData.js'
import { companionEngineSnapshot } from '../utils/cockpit/companionEngine.js'
import { companionQuietPreference, critterProfile, setCompanionQuiet } from '../utils/cockpit/critterProfile.js'
import { DUNE, FAINT, TEAL } from './mercuryPalette.js'
import { CommandCenter, SectionHeader } from './mercury-ui/components.js'
import { AnimatedCritterArt } from './mercury-ui/AnimatedCritterArt.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import {
  ALL_CRITTERS,
  getSessionAccent,
  setSessionCritter,
  persistSessionCritter,
} from './mercury-ui/sessionAccent.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'

// ============================================================================
//  CritterSelect — the LIVE critter session-theme picker (the design schema's
//  brand-critter-select). Each critter is a compact CARD ([N] name + launch); the
//  FOCUSED critter's full baked sprite renders in a LIVE PREVIEW pane beside the
//  grid (pane ≥66 — the baked art is too tall for the cards themselves: a 2×2
//  baked grid overflows the no-scroll modal at 44 rows). The FOCUSED card is boxed
//  in the critter's OWN accent (the highlighted-selected container); the others
//  sit in a faint DUNE frame. Picking one morphs + recolors every identity surface
//  (frame · deck · headers · this picker) live, no relaunch; the status spine
//  stays fixed. Keyboard AND mouse: ↑↓ / click a card to focus, ↵ / click "launch"
//  to commit — useInteractiveList.moveTo/activate give the click parity.
// ============================================================================

export function CritterSelect({ onClose }: { onClose: () => void }): React.ReactNode {
  // The cursor opens on the live-active critter so the first-focused card is the
  // current pick. Motion follows the RENDERED geometry (navSemantics law):
  // hero panes are a 2-column wrapped card grid (←→ linear, ↑↓ by row);
  // compact panes are a flat strip (←→ only). ↵ / click launch commits live.
  const activeIndex = Math.max(
    0,
    ALL_CRITTERS.findIndex(c => c.key === getSessionAccent().key),
  )
  const paneCols = useTerminalSize().columns
  const heroCards = paneCols >= 64

  const nav = useInteractiveList({
    rows: ALL_CRITTERS,
    rowId: c => c.key,
    idNamespace: 'critter',
    initialId: ALL_CRITTERS[activeIndex]?.key,
    orientation: heroCards ? { grid: { columns: 2 } } : 'horizontal',
    onClose,
    actions: [
      {
        // ↵ = switch AND persist (operator: "the critter always
        // defaults back to crab on boot" — the old ↵ was session-only with a
        // separate `s` persist nobody discovered; picking a theme should
        // simply stick). An explicit MERCURY_CRITTER env pin still outranks
        // the saved default at boot (resolveInitialKey precedence).
        key: 'return',
        run: picked => {
          if (picked) {
            setSessionCritter(picked.key)
            persistSessionCritter(picked.key)
          }
          return `switched to ${picked?.name ?? 'crab'} — yours across relaunches (env pin still wins)`
        },
        hint: 'pick',
      },
      {
        // `t` = TRY it this session only (the old ↵ semantics, kept for
        // low-commitment browsing).
        key: 't',
        run: picked => {
          if (picked) setSessionCritter(picked.key)
          return `trying ${picked?.name ?? 'crab'} — this session only (↵ to keep it)`
        },
        hint: 'try once',
      },
      {
        // `m` = quiet mode: the companion keeps pose/tone, drops prose.
        key: 'm',
        run: () => {
          const quiet = setCompanionQuiet(!companionQuietPreference())
          return quiet ? 'quiet mode ON — poses stay, speech off' : 'quiet mode OFF — the companion may speak again'
        },
        hint: 'quiet',
      },
    ],
  })

  // The card titles read '[1]…[4]' — the harness's digit-key convention
  // (CockpitView tabs) says on-screen numbers are pressable (round-3: the
  // affordance was dead). A digit moves the cursor to that card.
  useInput((input, _key) => {
    const n = Number(input)
    if (Number.isInteger(n) && n >= 1 && n <= ALL_CRITTERS.length) nav.moveTo(n - 1)
  })

  const sel = nav.selectedIndex
  const liveActive = getSessionAccent().key // re-read so the · ready flag follows commits
  // Layout (operator polish pass): the AUTHORED hero grids live ON the cards —
  // the art IS the preview, so the separate preview pane is retired. A 2×2
  // hero-card grid is 2×(9 art + 3 label/launch + 2 border) + margins ≈ 30
  // rows + panel chrome — fits the no-scroll modal at 44 rows. Width: two
  // 28-col cards + margin = 57 inner → hero cards need ≥64 pane cols
  // (CommandCenter/modal chrome included); narrower panes fall back to the
  // compact flat-grid cards so all 4 + footer always fit. (paneCols/heroCards
  // are hoisted above the nav hook — the orientation declaration reads them.)
  // Which card the pointer is over — derived from the single-owner hover
  // store (missed leaves self-heal; nothing lights mid-drag — the
  // chain-highlight hardening).
  const hoverBase = React.useId()
  const hoverOwner = useHoverOwner()
  const hovered =
    hoverOwner != null && hoverOwner.startsWith(`${hoverBase}:`)
      ? Number(hoverOwner.slice(hoverBase.length + 1))
      : -1

  return (
    <CommandCenter
      view="critter"
      onClose={onClose}
      captureInput={false}
      footer={(nav.hints ? nav.hints + ' · ' : '') + `${nav.motionHint} / click move`}
    >
      <SectionHeader>Session theme</SectionHeader>
      <Text color={FAINT}>
        pick a critter — it themes the whole harness (frame · deck · headers) · the status spine stays fixed
      </Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1} width={heroCards ? 60 : undefined}>
        {ALL_CRITTERS.map((c, i) => {
          const on = i === sel
          const active = c.key === liveActive
          const def = critterDefForKey(c.key)
          return (
            <Box
              key={c.key}
              borderStyle="round"
              // Hover speaks through the BORDER, never a fill: a slab behind
              // half-block art shows through the sprite's transparent holes
              // as a bg-color mismatch (operator, — same class as
              // the home hero's hover slab, both removed).
              borderColor={on || hovered === i ? c.accent : DUNE}
              marginRight={1}
              marginBottom={1}
              flexDirection="column"
              alignItems="center"
              width={heroCards ? HERO_ART_COLS + 4 : undefined}
              paddingX={heroCards ? 1 : 0}
              onClick={() => nav.moveTo(i)}
              onMouseEnter={() => claimHover(`${hoverBase}:${i}`)}
              onMouseLeave={() => releaseHover(`${hoverBase}:${i}`)}
            >
              {/* Hero cards carry the full authored grid (content-trimmed +
                  centered); narrow panes keep the compact flat grid.
                  The picker's cards are LIVE — they
                  blink and flow exactly like the hero and the berth. The
                  whole point of this surface is choosing a companion, and
                  four frozen sprites were a worse basis for that choice than
                  four moving ones. Cost is bounded by the same gates and the
                  same shared clock: CritterArt's memo bails on every tick
                  where the packed frame key did not change.
                  SPECIMEN (CR-3): the cards never wear the session sleep
                  verdict — under the agent-activity predicate a quiet
                  operator browsing this picker would otherwise be choosing
                  between four sleeping silhouettes. */}
              {/* The FIXED-HEIGHT art slot every critter mount keeps (the
                  hero's and the berth's HERO_ART_LINES / FLAT_ART_LINES
                  law): the authored grids differ in height (the clam's
                  compact shell is two lines shorter than the crab's), and
                  without the slot the shorter card stretched to its row's
                  height with the blank rows UNDER its label. Bottom-anchored
                  so every creature sits on the same baseline above its
                  name, the air above it — a swap moves pixels, never rows,
                  and the card grid's row arithmetic (9 art lines) holds. */}
              <Box
                height={heroCards ? HERO_ART_LINES : FLAT_ART_LINES}
                flexDirection="column"
                justifyContent="flex-end"
              >
                <AnimatedCritterArt def={def} hero={heroCards} specimen />
              </Box>
              <Box marginTop={heroCards ? 0 : 1}>
                <Text bold color={c.accent}>
                  [{i + 1}] {c.name}
                </Text>
              </Box>
              <Box onClick={(e) => { e.stopImmediatePropagation(); nav.activate(i) }}>
                <Text color={on ? c.accent : FAINT}>{GLYPH.prompt} launch </Text>
                {active ? <Text color={TEAL}>{GLYPH.done} ready</Text> : <Text color={FAINT}>{GLYPH.pending}</Text>}
              </Box>
            </Box>
          )
        })}
      </Box>
      {nav.note ? (
        <Box marginTop={1}>
          <Text color={TEAL}>{nav.note}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            ↵ / click launch switches live (morphs + recolors); the status spine (teal·amber·crimson) is fixed in every theme
          </Text>
        </Box>
      )}
      {(() => {
        // The FOCUSED critter's record: the live mood with its factual
        // reason + real milestones + quietness — the companion as a creature
        // with a record, not decoration.
        const focused = ALL_CRITTERS[sel]
        if (!focused) return null
        const profile = critterProfile()
        const snap = companionEngineSnapshot()
        const reason: Record<string, string> = {
          working: 'a turn is running',
          thinking: 'streaming a response',
          focused: 'deep in a long turn',
          blocked: 'waiting on you',
          done: 'just settled a turn',
          sad: 'the last turn failed',
          sleeping: 'long idle',
          idle: 'nothing in flight',
        }
        const quiet = companionQuietPreference()
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={focused.accent} bold>{focused.name}</Text>
            </Text>
            <Text color={FAINT}>
              mood {snap.mood} · {reason[snap.mood] ?? snap.mood}
              {' · '}settles {profile.milestones.settles}
              {profile.milestones.recoveries > 0 ? ` · recoveries ${profile.milestones.recoveries}` : ''}
              {profile.recoveredAt ? ' · profile recovered' : ''}
              {' · '}{quiet ? 'quiet' : 'speaking'}
            </Text>
          </Box>
        )
      })()}
    </CommandCenter>
  )
}

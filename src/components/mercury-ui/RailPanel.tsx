import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { InteractiveRow } from './InteractiveRow.js'
import { useMercuryTokens } from './useMercuryTokens.js'

// ============================================================================
//  RailPanel — the cockpit's bordered section card.
//
//  In the WIDE both-rails cockpit each rail section (SEAT · RECENT · NEXT ·
//  USAGE · TRACE · …) renders inside a rounded DUNE-bordered card whose first
//  interior row is the section's kit glyph + bold accent label (+ FAINT count
//  tail) — the mockup-ratified cockpit grammar. The border REPLACES the flat
//  layout's marginTop gap, so a boxed rail costs ≈ one extra row per section,
//  not two. The single-rail (<150 cols) tiers keep the flat SectionHeader
//  layout — a 20–24-col rail has no width to spend on border cells.
//
//  Width discipline: the panel is `width` cols OUTSIDE; content rows must be
//  built at `railPanelInnerWidth(width)` (border 2 + paddingX 2). Identity
//  chrome takes the live session accent (glyph + label re-tint on /critter);
//  the border stays DUNE (a panel border is furniture, not identity — the
//  design system's "default non-identity panel border" role).
// ============================================================================

/** Horizontal padding inside the border — only when the rail can afford it
 *  (a 24-col rail's rows need every cell; the wide 28–30-col rails breathe). */
export function railPanelPad(width: number): 0 | 1 {
  return width >= 28 ? 1 : 0
}

/** Interior content width for a panel `width` cols wide (border 2 + pad). */
export function railPanelInnerWidth(width: number): number {
  return Math.max(8, width - 2 - 2 * railPanelPad(width))
}

export function RailPanel({
  glyph,
  label,
  count,
  width,
  children,
  headerAction,
}: {
  glyph: string
  label: string
  /** Muted ` · count` tail after the label (e.g. `2 peers`, `24/31`). */
  count?: string
  width: number
  children?: React.ReactNode
  /**
   * Optional single-purpose header activation (interaction-finish;
   * hover-hierarchy): when present ONE click opens the
   * panel's owning surface — the same direct-activate grammar section tabs
   * use — and hover speaks through INK ONLY (the info heading brightens to
   * the theme's infoShimmer role; chrome never wears the body-row surface2
   * fill). Absent ⇒ NO pointer handlers and no hover paint (the
   * honest-affordance law); the border geometry is identical either way.
   */
  headerAction?: { id: string; run: () => void }
}): React.ReactNode {
  const tokens = useMercuryTokens()
  // Section headers are INFORMATIONAL headings, not identity:
  // the pre-AURORA bold-accent label put ~10 competing red headings in one wide
  // cockpit viewport, so the accent stopped meaning anything. Headers ride the
  // info channel (OASIS in dark); identity stays with the brand block, the
  // center SESSION band, the hero and the caret — the few, so they read again.
  const headerHue = tokens.info
  // Chrome hover is INK, not fill — the function child
  // suppresses InteractiveRow's surface2 slab (that fill is the BODY-ROW
  // selection grammar) and the heading brightens info → infoShimmer.
  // hover=false renders byte-identically to the old static form.
  const headerText = (hover: boolean): React.ReactNode => (
    <Text wrap="truncate-end">
      <Text color={hover ? 'infoShimmer' : headerHue}>{glyph} </Text>
      <Text color={hover ? 'infoShimmer' : headerHue} bold>
        {label}
      </Text>
      {count ? <Text color={tokens.textMuted}>{` · ${count}`}</Text> : null}
    </Text>
  )
  return (
    <Box
      width={width}
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={tokens.borderStrong}
      paddingX={railPanelPad(width)}
    >
      {headerAction ? (
        <InteractiveRow
          id={headerAction.id}
          directActivate
          onActivate={headerAction.run}
          width={railPanelInnerWidth(width)}
          height={1}
        >
          {headerText}
        </InteractiveRow>
      ) : (
        <Box width={railPanelInnerWidth(width)}>{headerText(false)}</Box>
      )}
      {children}
    </Box>
  )
}

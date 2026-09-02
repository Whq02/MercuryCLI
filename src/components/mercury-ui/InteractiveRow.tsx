import * as React from 'react'
import { Box, Text, type DOMElement } from '../../ink.js'
import { claimHover, releaseHover, useHoverOwned } from './useHoverOwned.js'
import { useMercuryTokens } from './useMercuryTokens.js'

// ============================================================================
//  InteractiveRow — the ONE pointer-interaction wrapper for selectable rows
// Every list row, section entry, tab, and
//  palette row speaks this grammar instead of hand-wiring Box mouse props:
//
//    · hover ownership rides the single-owner store (useHoverOwned) — at most
//      one row anywhere wears the hover fill, drags suppress it, and a missed
//      leave self-heals on the next claim;
//    · hover paints ONLY the background (tokens.surface2) or — for declared
//      chrome (hoverStyle='chrome-ink') — ink/border emphasis with zero bg
//      delta; either way geometry is identical across idle/hover/selected/
//      focused, so a pointer sweep can never reflow the list. The fill is
//      CONTAINER-owned (hoverStyle='row-fill' for function children): the
//      lit region always equals the hit region, never a nested substring;
//    · click follows the select-then-activate contract: a click on an
//      UNSELECTED row selects it (onSelect); a second click on the selected
//      row performs the SAME primary action as ↵ (onActivate). Single-purpose
//      controls (section entries, tabs, headers) pass directActivate to
//      collapse the two steps;
//    · an unavailable row exposes NO pointer handlers and NO hover paint —
//      the honest-affordance law (a dead row must not preview interactivity) —
//      and, when the caller supplies reasonUnavailable, it VISIBLY carries its
//      WHY as a dim inline annotation (MINI-TEMPER item 5: the explanation
//      channel is the row's own cells — an unreachable row must never promise
//      an activation-time explanation). The annotation is state-independent
//      (painted whenever the row is unavailable), so the no-reflow law holds;
//    · selection/focus stay the CALLER's paint (CursorCell + ink roles) — the
//      states are accepted so the click contract can distinguish them, not to
//      restyle the row.
//
//  The row's primary-action label is exposed through the same object callers
//  compose footers from (rowActionHint) — one predicate feeds the key, the
//  click, and the hint, never a second registry.
// ============================================================================

export type InteractiveRowProps = {
  /** Stable, surface-namespaced id (e.g. `panes:workflows:row:wf_1`). Owns
   *  the hover claim; parents previewing the hovered child match this. */
  id: string
  /** The caller's selection cursor sits on this row. */
  selected?: boolean
  /** The owning container holds keyboard focus (rails). A click into an
   *  UNFOCUSED container re-anchors (selects) — it never activates, so
   *  clicking to focus a pane can't fire an action. Default true. */
  focused?: boolean
  /** Dead row: no pointer handlers, no hover paint, no action hint. */
  unavailable?: boolean
  /** The dead row's visible WHY — painted dim, inline, after the children,
   *  only while `unavailable` (the ONE availability policy: explanation is
   *  paint, never an unreachable activation note). */
  reasonUnavailable?: string
  /** Move the selection cursor here (first click on an unselected row). */
  onSelect?: () => void
  /** The row's primary action — same meaning as ↵ (second click). */
  onActivate?: () => void
  /** Single-purpose control: ONE click activates (tabs, section entries,
   *  headers) instead of the two-step select-then-activate. */
  directActivate?: boolean
  /** LUSTRE L2 — the ACTIVE-cursor band (tokens.selectionBand) paints on
   *  `selected && focused` CURSOR rows by default. Opt out for a surface
   *  whose selected paint is deliberately its own (an always-boxed row, a
   *  sprite card). directActivate controls and function-children rows never
   *  band (their `selected` means persistent state / their paint rides ink
   *  or border by contract) — the band marks THE Enter target, exactly one
   *  row anywhere. */
  selectionBand?: boolean
  /** The primary-action label for footer composition (see rowActionHint). */
  actionLabel?: string
  /** Forwarded to the underlying Box so scroll-to-selection stays exact. */
  rowRef?: React.Ref<DOMElement>
  width?: number | string
  height?: number
  flexDirection?: 'row' | 'column'
  flexShrink?: number
  /** Forwarded to the underlying Box: a control whose VISIBLE region is the
   *  whole remaining run (the new-session strip) grows its hit region with
   *  it — a flexGrow spacer beside the row is dead pointer area
   * */
  flexGrow?: number
  /** The RATIFIED chrome-hover contract (visual-composition-06/07
   * — every function-children call site declares ONE of:
   *    · 'row-fill' — a row-like control: the CONTAINER owns the surface2
   *      hover fill across the FULL hit region (ink may brighten too, but a
   *      child must never paint its own backgroundColor — the nested-Text
   *      slab lit a substring of the hit region and split lit-from-hit);
   *    · 'chrome-ink' — compact chrome (crumbs, help segments, panel
   *      affordances): hover speaks through INK or BORDER emphasis ONLY,
   *      zero background delta anywhere (the surface2 slab is the body-row
   *      selection grammar — a slab-lit title reads as a selected row,
   *      hover-hierarchy). Requires function children —
   *      static children have no ink channel to speak hover through.
   *  Absent: the legacy default — static children keep the container fill;
   *  function children suppress it (ink/border surfaces predating the
   *  ratification: CritterSelect's border paint, SessionTabs' inner pill). */
  hoverStyle?: 'chrome-ink' | 'row-fill'
  /** Static children, or a render function receiving the row's live hover
   *  state for surfaces whose hover speaks through INK or BORDER rather than
   *  the background fill (SessionTabs' label brightening; CritterSelect's
   *  border paint — a bg slab shows through transparent sprite cells). A
   *  function child SUPPRESSES the default background hover paint unless the
   *  row declares hoverStyle='row-fill'; geometry must stay identical across
   *  hover states (the no-reflow law).
   *  CHROME (panel titles, header actions, footer hints — headings rather
   *  than selectable rows) MUST take this function path with
   *  hoverStyle='chrome-ink': the surface2 slab is the body-row selection
   *  grammar, and a slab-lit title reads as a selected row (the
   *  hover-hierarchy). */
  children: React.ReactNode | ((hover: boolean) => React.ReactNode)
}

/** The footer-hint face of a row: its action label only while the action is
 *  live. Compose footers from the same row model that armed the click. */
export function rowActionHint(row: {
  actionLabel?: string
  unavailable?: boolean
}): string | undefined {
  return row.unavailable ? undefined : row.actionLabel
}

export function InteractiveRow({
  id,
  selected = false,
  focused = true,
  unavailable = false,
  reasonUnavailable,
  onSelect,
  onActivate,
  directActivate = false,
  selectionBand = true,
  rowRef,
  width,
  height,
  flexDirection,
  flexShrink,
  flexGrow,
  hoverStyle,
  children,
}: InteractiveRowProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const hover = useHoverOwned(id)
  const interactive = !unavailable && (!!onSelect || !!onActivate)
  // LUSTRE L2 — the ONE decisive selection paint: the focused CURSOR row
  // wears the full-width accent-derived band (contrast resolved centrally in
  // mercuryTokens). Persistent-state controls (directActivate), ink/border-
  // carried surfaces (function children), unavailable rows, and unfocused
  // containers stay quiet — hover keeps its lighter surface2 raise, and the
  // band outranks hover on the same row. Colors only: geometry is identical
  // across idle/hover/selected (the no-reflow law).
  const bandPainted =
    selectionBand &&
    selected &&
    focused &&
    !unavailable &&
    !directActivate &&
    typeof children !== 'function'

  const handleClick = interactive
    ? (): void => {
        if (directActivate) {
          onActivate?.()
          return
        }
        if (selected && focused) onActivate?.()
        else if (onSelect) onSelect()
        else if (focused) onActivate?.()
      }
    : undefined

  const renderedChildren = typeof children === 'function' ? children(interactive && hover) : children

  // the ratified hover fill: 'row-fill' rows take the container-
  // owned surface2 across the FULL hit region (function children included);
  // 'chrome-ink' rows never fill (ink/border emphasis is the children's
  // job); undeclared rows keep the legacy static-fill / function-suppress
  // split. The band outranks hover on the same row.
  const hoverFillPainted =
    interactive &&
    hover &&
    (hoverStyle === 'row-fill' || (hoverStyle === undefined && typeof children !== 'function'))

  return (
    <Box
      ref={rowRef}
      width={width}
      height={height}
      flexDirection={flexDirection}
      flexShrink={flexShrink}
      flexGrow={flexGrow}
      overflow="hidden"
      backgroundColor={bandPainted ? tokens.selectionBand : hoverFillPainted ? tokens.surface2 : undefined}
      onClick={handleClick}
      onMouseEnter={interactive ? () => claimHover(id) : undefined}
      onMouseLeave={interactive ? () => releaseHover(id) : undefined}
    >
      {renderedChildren}
      {/* The dead row's visible WHY (one availability policy): dim, inline,
          state-independent — present whenever the row is unavailable, so the
          no-reflow law across idle/hover/selected holds. */}
      {unavailable && reasonUnavailable ? (
        <Text color={tokens.textMuted} wrap="truncate-end">{` — ${reasonUnavailable}`}</Text>
      ) : null}
    </Box>
  )
}

import * as React from 'react'
import { useEffect, useRef, useLayoutEffect } from 'react'
import { Box, Text, useInput, type DOMElement } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'
import { packFooter } from './footerHint.js'
import { innerWidth as innerPaneWidth, viewportRows } from './geometry.js'
import { truncateToWidth } from './glyphs.js'
import { EmptyState, ProductLockup } from './components.js'
import { InteractiveRow } from './InteractiveRow.js'
import { CursorCell } from './LiveGlyphs.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { useNavigablePanes } from './useNavigablePanes.js'

// ============================================================================
//  NavigablePanes<Row> — the reusable FULLSCREEN master-detail + expandable-nav
//  shell (Mercury's "/workflows monitor" equivalent). Built ON TOP of the
//  mercury-ui kit so the look is one system: AlternateScreen-wrapped true
//  temporary fullscreen (pops back to the inline REPL on unmount), an optional
//  LEFT section nav + a MAIN aligned-column list (fixed-width Box + columnGap,
//  NOT padded strings) + a drill-in detail pane + a footer hotkey rail that is
//  present in EVERY form and never dropped.
//
//  Responsive by useTerminalSize().columns (the column-count law):
//    >=140  WIDE  : LEFT nav + MAIN columns + RIGHT detail (all three at once)
//    120-139 MID  : LEFT nav + MAIN; detail FOLDS IN as the right pane on drill
//                   (nav collapses to a tab strip to make room)
//    100-119 FOLD : nav -> a one-row top tab strip; MAIN full width; drill =
//                   split (list stays on top, detail below)
//    <100   INLINE: single column (section as a header line); drill = split
//
//  HONESTY: any cell whose live datum does not exist renders STATE_STYLE
//  unavailable '—' (the CALLER supplies that via ColumnDef.cell — the framework
//  never fabricates). loading -> 'loading…'; emptyState -> an honest card; an
//  empty section -> its own emptyHint. No faked rows anywhere.
//
//  LAYOUT CONTRACT (render-verified): a local-jsx panel renders IN-FLOW below
//  the REPL transcript inside AlternateScreen's height={size.rows} box, so a
//  panel forced to height={size.rows} (or flexGrow:1 filling it) pushes its own
//  bottom border + footer BELOW the viewport and clips (the prior design's
//  blocker). Instead the bordered panel is CONTENT-SIZED — its bottom border +
//  footer rail always render right after the body — and the scrollable list /
//  detail regions get an EXPLICIT bounded height (the viewport minus a reserve
//  for the REPL chrome above + the panel's own header/footer/borders). The list
//  then SCROLLS within that bound; scrollToElement(rowRef) keeps the selection
//  in view.
//
//  CLOSE-AXIS INVARIANT: esc -> onClose fires in EVERY state (loading / empty /
//  no-rows), because useNavigablePanes owns esc on an always-on useInput that is
//  never gated on row count. Only the list/drill/expand axes are gated on
//  `active`. (This is the trap-bug the prior DESIGN-ONLY pass would have shipped.)
// ============================================================================

export type ColumnDef<Row> = {
  /** Stable id. */
  key: string
  /** Faint column header label. */
  header: string
  /** Fixed display-cells; omit -> flexGrow:1 (the elastic 'name' column). */
  width?: number
  /** Right-align the cell body (numbers/ages). Default left. */
  align?: 'left' | 'right'
  /** Render the cell. SINGLE-LINE contract: return one <Text>; the framework
   *  clips it to height:1 — a may-be-'—' (STATE_STYLE.unavailable) cell here is
   *  the honest-empty path, never a fabricated number. */
  cell: (row: Row) => React.ReactNode
}

/** A single-char row hotkey (mirrors useInteractiveList's ListAction shape). */
export type RowAction<Row> = {
  /** The single character that triggers it (e.g. 'x', 'R'). */
  key: string
  /** Short hint shown in the footer by the CALLER (not auto-composed here). */
  label: string
  /**
   * Footer spelling override. The rail renders `key label` by default, which
   * misreads for a non-letter key (`' '` would paint as a leading blank) —
   * `hint` names the key the operator-facing way (`space off`). Absent ⇒
   * the composed form, byte-identical for every existing caller.
   */
  hint?: string
  /** Gates whether this action applies to the given row. */
  when: (row: Row) => boolean
  /** The side effect. Runs against the CURRENTLY selected row. */
  run: (row: Row) => void
}

export type SectionDef<Row> = {
  id: string
  /** Shown in the LEFT nav + as the header line when nav is folded. */
  label: string
  /** Faint roll-up count in the section header. Defaults to rows.length. */
  count?: number
  /** Honest rows. [] -> the section renders its own emptyHint. */
  rows: Row[]
  /** Honest empty text when rows.length === 0 (no faked rows). */
  emptyHint?: string
}

export type NavigablePanesProps<Row> = {
  /** Title shown in the header (e.g. 'monitor'). */
  view: string
  /** Optional subtitle (e.g. the team name). */
  subtitle?: string
  /** Session-global honest facts (model · $cost · diff) — HEADER ONLY, never a
   *  per-row cell. */
  headerLine?: React.ReactNode
  /** >=1 section. A single section auto-omits the LEFT nav. */
  sections: SectionDef<Row>[]
  /** The aligned MAIN columns (fixed-width Box + columnGap). */
  columns: ColumnDef<Row>[]
  rowKey: (row: Row) => string
  /** The drill-in / RIGHT-pane content (a KeyValueGrid of the row's real fields). */
  renderDetail: (row: Row) => React.ReactNode
  onClose: () => void
  /** Extra list-level hotkeys (the framework always appends select/view/back). */
  footerHints?: string
  /** Extra DETAIL-level hotkeys (FC-131): verbs the caller keeps armed while
   *  drilled in (PromptsPanel's section-scoped `a new`). The armed ⇔
   *  advertised law is the caller's obligation for these — the framework
   *  cannot know which caller keys survive the drill. */
  detailFooterHints?: string
  /**
   * the ONE scoped-composer slot of the panes grammar — the
   * board dispatch composer today, peek-reply and comment composers on the
   * same seam later. While `active`, the slot owns printable input,
   * backspace and ↵ (forwarded to `onInput`); esc calls `onEscape` (the
   * surface deactivates, drafts preserved) instead of closing the board;
   * every nav axis is parked. `node` renders above the footer rail.
   */
  composerSlot?: {
    active: boolean
    node: React.ReactNode
    onInput: (input: string, key: Record<string, boolean>) => void
    onEscape: () => void
    /** Rendered rows the slot occupies (the viewport reserve grows by this;
     *  default 2). */
    rows?: number
  }
  /**
   * Type-to-compose: at the DETAIL level — where every
   * hotkey is deliberately dead — a printable character may open
   * the surface's scoped composer SEEDED with that exact character (the
   * first keystroke is never lost). List-level keys keep their meanings.
   */
  onTypeToCompose?: (row: Row, input: string) => void
  /** Enables ↓/+ grow · - shrink of the detail. Default true. */
  expandable?: boolean
  /** snapshot === null -> 'loading…'. */
  loading?: boolean
  /** Honest off/dormant card (snap.state !== 'live') — no faked rows. */
  emptyState?: { title: string; hint?: string }
  /** Passed to AlternateScreen. Default true. */
  mouseTracking?: boolean
  /**
   * When set, ↵/→ on a row calls `onActivate(row)` INSTEAD of drilling into
   * the inline detail pane (the /workflows board's board→run→agent full-view
   * replacement). Undefined (the default) preserves
   * every existing caller's inline-detail behavior byte-for-byte.
   */
  onActivate?: (row: Row) => void
  /**
   * Extra single-char row hotkeys (e.g. `x` kill, `R` resume-queue), each
   * gated by `when(selectedRow)`. Defaults to `[]` — no existing caller passes
   * this, so nothing changes for them.
   */
  rowActions?: RowAction<Row>[]
  /**
   * Mount-time cursor carry-back: seed the selection on the row with this
   * key. For onActivate boards whose activation REPLACES the pane with a full
   * view (workflows board→run→back), so returning doesn't dump the operator
   * at row 0 of a long list. Absent/unresolvable ⇒ row 0 (fresh-open
   * behavior unchanged).
   */
  initialRowKey?: string
  /**
   * Mount-time SECTION seed by section id — the deep-link/carry-back seam for
   * boards whose sections are addressable routes (`/extensions sources`) or
   * whose full-view return lands on a section with no remembered row (an
   * EMPTY section has no row for initialRowKey to find). A found
   * initialRowKey wins (it names both section and row); absent/unresolvable ⇒
   * section 0 (fresh-open behavior unchanged, the house additive pattern).
   */
  initialSectionId?: string
  /**
   * Fires AFTER the active section changes (tab / 1-9 / nav click / ↑↓ edge
   * crossing), with the section's id and index — the seam a caller needs to
   * MIRROR the section axis (per-section column sets, a per-section header
   * rollup) without owning it: the hook stays the one section owner.
   * Absent (the default) ⇒ never called — byte-identical for every caller.
   */
  onSectionChange?: (id: string, index: number) => void
  /**
   * The close key's footer word. A full-view replacement whose esc RETURNS
   * to its parent board (`esc back to sources`) must not advertise `close`
   * — the hint must say what the key does. Absent ⇒ `esc close`,
   * byte-identical for every existing caller.
   */
  closeHint?: string
  /**
   * Cap the MAIN list's content width in cells. On an ultra-wide terminal the
   * elastic name column otherwise absorbs ALL free width and shoves the fixed
   * columns to the far right edge — unscannable. Undefined (the default)
   * preserves every existing caller's full-width behavior.
   */
  maxContentWidth?: number
  /**
   * Right-aligned node in the header row (the /workflows board's LIVE rollup —
   * `◐ 1 running · 0/3 agents · 28s`). Rendered after a flexGrow spacer so it
   * pins to the shell's right edge. Undefined (the default) leaves the header
   * row byte-identical for every existing caller.
   */
  headerRight?: React.ReactNode
  /**
   * A STANDING right info pane for the selected row (wide/mid layouts only) —
   * the always-visible companion container an `onActivate` caller needs:
   * with onActivate set the inline drill (renderDetail) can never fire (↵/→
   * navigate away instead), so this is the one way such a board gets a
   * side-by-side detail. Rendered whenever a row is selected and no drilled
   * detail is showing; at mid width the left nav folds to the tab strip to
   * make room (the same trade the drilled detail makes). fold/inline layouts
   * omit it (no horizontal room — the list stays full width). Undefined (the
   * default) is byte-identical for every existing caller.
   */
  sideInfo?: (row: Row) => React.ReactNode
  /**
   * Titles the drilled detail pane after the SELECTED ROW (its id/name/
   * purpose) instead of the literal word 'detail' — a pane should name its
   * content (shell spec, product-study design-grammar report). Empty/absent
   * ⇒ the 'detail' fallback; every existing caller is byte-identical.
   */
  detailTitle?: (row: Row) => string
  /**
   *  (PATH A — the reference geometry through the ONE
   * chassis): region chrome for a multi-card canvas. When present the shell
   * SKIPS its own full-canvas border + brand row and renders `headerBlock`
   * instead; `aboveBody`/`belowBody` frame the workspace (the needs-you rail
   * · the new-session strip + status rail); the MAIN list and the standing
   * sideInfo paint as two SEPARATE borderSubtle round panes carrying
   * `mainTitle`/`sideTitle(row)` with a one-cell gutter, the side pane at
   * `sideWidthPct` of the interior. EVERY interaction path — the panes
   * hook, selection, windowing, rowActions, composer input, the footer
   * engine, gating — is the same code, untouched. Absent (the
   * default) ⇒ byte-identical for every existing caller (the house
   * pattern: sideInfo/onActivate/headerRight/initialRowKey landed exactly
   * this way).
   */
  regionChrome?: {
    headerBlock: React.ReactNode
    aboveBody?: React.ReactNode
    belowBody?: React.ReactNode
    mainTitle: React.ReactNode
    sideTitle: (row: Row) => React.ReactNode
    sideWidthPct: number
    /** Total rows the caller's chrome consumes (headerBlock + aboveBody +
     *  belowBody). Yoga can't measure children ahead of layout, so the body
     *  budget subtracts this DECLARED height instead of the classic-shell
     *  reserve — an overrun clips the bottom chrome off-canvas (the first
     *  concourse capture lost its status rail exactly this way). */
    chromeRows: number
  }
  /**
   * parks the LIST axes (arrows/drill/row hotkeys) while a
   * sibling region owns focus (the Concourse rail/peek/strip cycle). The
   * CLOSE-AXIS invariant is untouched — esc → onClose always works — and the
   * composer slot keeps its own claim. Default true ⇒ byte-identical.
   */
  inputActive?: boolean
}

const COL_GAP = 2
const NAV_WIDTH = 22
const DETAIL_WIDTH_WIDE = 40
const DETAIL_WIDTH_MID = 34
// Rows the panel's OWN chrome consumes before the scrollable region starts:
// header 1 + headerLine ≤2 + tab strip/section line 1 + column header 1 +
// footer 2 + borders 2 + margins 2 ≈ 11. (Friction hunt: this was
// 22 — a stale carry-over from when panels rendered BELOW the live REPL
// transcript. AlternateScreen has owned the whole canvas since the takeover
// move, so every board was capping its list at rows−22: a 3-row list over
// ~13 rows of void at 80×24 — the operator's "content packed into a corner"
// class, on every NavigablePanes surface.)
const VIEWPORT_RESERVE = 11
/** The composer slot renders two rows above the footer while present —
 *  the list's bounded height must give them back or the footer walks off
 *  the canvas (review finding on the reserve). */
const COMPOSER_SLOT_RESERVE = 2
// React-level windowing overscan. ScrollBox culls OUTPUT only (all
// fibers + Yoga nodes stay allocated), so with an unbounded active section
// (uncapped missions/health/leases) every row is a live fiber. We mount only a
// window of [listHeight + 2*OVERSCAN] rows around the selection; 12 ≫ a 1-step
// ↑↓ move so the selected row never lands outside the window between renders.
const ROW_OVERSCAN = 12

type Layout = 'wide' | 'mid' | 'fold' | 'inline'
function pickLayout(cols: number): Layout {
  if (cols >= 140) return 'wide'
  if (cols >= 120) return 'mid'
  if (cols >= 100) return 'fold'
  return 'inline'
}

//
// Cell + row + header rendering (aligned columns via fixed-width Box, not padTo)
//

function ColumnHeader<R>({
  columns,
  totalWidth,
  tokens,
}: {
  columns: ColumnDef<R>[]
  totalWidth: number
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <Box width={totalWidth} columnGap={COL_GAP} flexShrink={0}>
      {columns.map(c => (
        <Box
          key={c.key}
          width={c.width}
          flexGrow={c.width ? 0 : 1}
          flexShrink={c.width ? 0 : 1}
          justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          overflow="hidden"
        >
          <Text color={tokens.textMuted} wrap="truncate-end">
            {c.header}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function PaneRow<R>({
  row,
  rowId,
  columns,
  selected,
  totalWidth,
  rowRef,
  onSelect,
  onActivate,
  tokens,
}: {
  row: R
  /** Surface-namespaced stable id — hover ownership + selection identity. */
  rowId: string
  columns: ColumnDef<R>[]
  selected: boolean
  totalWidth: number
  rowRef?: React.Ref<DOMElement>
  onSelect: () => void
  onActivate: () => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <InteractiveRow
      id={rowId}
      selected={selected}
      onSelect={onSelect}
      onActivate={onActivate}
      rowRef={rowRef}
      width={totalWidth}
      height={1}
      flexShrink={0}
    >
      {/* selection cursor gutter — the CursorCell primitive (the alive-glyph
          list-cursor tier: ▸ lands with the IVORY-bold nudge; frame-0 static
          under MERCURY_LIVE_GLYPHS=0), not a hand-rolled ternary. */}
      <Box width={2} flexShrink={0}>
        <CursorCell focused={selected} color={tokens.accent} />
      </Box>
      <Box flexGrow={1} columnGap={COL_GAP} overflow="hidden">
        {columns.map(c => (
          <Box
            key={c.key}
            width={c.width}
            flexGrow={c.width ? 0 : 1}
            flexShrink={c.width ? 0 : 1}
            justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
            height={1}
            overflow="hidden"
          >
            {c.cell(row)}
          </Box>
        ))}
      </Box>
    </InteractiveRow>
  )
}

//
// LEFT nav (sections) + folded tab strip
//

function SectionNav<R>({
  sections,
  active,
  width,
  idBase,
  onSelectSection,
  tokens,
}: {
  sections: SectionDef<R>[]
  active: number
  width: number
  idBase: string
  onSelectSection: (i: number) => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  // A titled sub-card (Sol 5.6 WS6): the nav reads as its own labeled unit,
  // and each entry carries its DIGIT jump (1-9 selects the section directly).
  // Entries are single-purpose controls — ONE click selects the section and
  // restores its remembered row (the same move Tab/1-9 make).
  return (
    <Box flexDirection="column" width={width} flexShrink={0} marginRight={2}>
      <Box height={1} overflow="hidden">
        <Text color={tokens.textMuted}>sections</Text>
      </Box>
      {sections.map((s, i) => {
        const on = i === active
        const count = s.count ?? s.rows.length
        return (
          <InteractiveRow
            key={s.id}
            id={`${idBase}:sec:${s.id}`}
            selected={on}
            directActivate
            onActivate={() => onSelectSection(i)}
            height={1}
            // Hover-fill consistency: section rows fill the whole
            // sidebar like the board's main rows fill their row — the two
            // panes sit side by side, and a text-run-sized fill here read as
            // a different (broken) affordance. Chips/tabs stay content-hug
            // BY DESIGN (TabStrip below).
            width="100%"
          >
            <Text color={on ? tokens.accent : tokens.textMuted} wrap="truncate-end">
              {on ? '▸ ' : '  '}
              {i < 9 ? `${i + 1} ` : '  '}
              {s.label}
            </Text>
            <Text color={tokens.textMuted}> ({count})</Text>
          </InteractiveRow>
        )
      })}
    </Box>
  )
}

function TabStrip<R>({
  sections,
  active,
  idBase,
  onSelectSection,
  tokens,
}: {
  sections: SectionDef<R>[]
  active: number
  idBase: string
  onSelectSection: (i: number) => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <Box columnGap={2} flexShrink={0} height={1} overflow="hidden">
      {sections.map((s, i) => {
        const on = i === active
        const count = s.count ?? s.rows.length
        return (
          <InteractiveRow
            key={s.id}
            id={`${idBase}:tab:${s.id}`}
            selected={on}
            directActivate
            onActivate={() => onSelectSection(i)}
            height={1}
          >
            <Text color={on ? tokens.accent : tokens.textMuted} bold={on}>
              {s.label} ({count})
            </Text>
          </InteractiveRow>
        )
      })}
    </Box>
  )
}

//
// NavigablePanes
//

export function NavigablePanes<Row>({
  view,
  subtitle,
  headerLine,
  sections,
  columns,
  rowKey,
  renderDetail,
  onClose,
  footerHints,
  detailFooterHints,
  expandable = true,
  loading = false,
  emptyState,
  mouseTracking = true,
  onActivate,
  rowActions,
  initialRowKey,
  initialSectionId,
  onSectionChange,
  closeHint,
  maxContentWidth,
  headerRight,
  sideInfo,
  detailTitle,
  composerSlot,
  onTypeToCompose,
  regionChrome,
  inputActive = true,
}: NavigablePanesProps<Row>): React.ReactNode {
  const { columns: cols, rows: termRows } = useTerminalSize()
  const layout = pickLayout(cols)
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  // Surface-namespaced hover/selection id base — rows across two mounted
  // boards can never collide in the single-owner hover store.
  const idBase = `np:${view}`

  const safeSections = sections.length > 0 ? sections : []
  const showNav = safeSections.length > 1

  // The interaction layer. Even when there are no rows (loading / empty), the
  // hook stays mounted so esc -> onClose always fires (the un-trappable exit).
  // The hook clamps `sel` against `rowCount`, so it must receive the ACTIVE
  // section's row count (NOT section 0's — a longer section couldn't scroll past
  // section 0's length otherwise). The hook owns `section`, so we feed it last
  // render's active count via a ref: a one-frame lag is harmless because a
  // section switch resets sel→0 (always valid) and the count self-corrects next
  // frame.
  // Mount-time cursor seed (carry-back): resolve initialRowKey against the
  // sections available on the FIRST render — the caller component stays
  // mounted across the view flip (only this pane unmounts), so its row data
  // is already loaded on the way back. The section ref must seed too, or the
  // mount frame feeds the hook section 0's row count and the clamp effect
  // truncates a deeper seeded sel before the real count arrives.
  const seed = ((): { section: number; sel: number } => {
    if (initialRowKey !== undefined) {
      for (let s = 0; s < safeSections.length; s++) {
        const i = (safeSections[s]?.rows ?? []).findIndex(r => rowKey(r) === initialRowKey)
        if (i >= 0) return { section: s, sel: i }
      }
    }
    // The section seed: a row key names both coordinates, so it wins above;
    // the id form covers the deep link onto a section whose rows carry no
    // remembered key (an empty section included).
    if (initialSectionId !== undefined) {
      const s = safeSections.findIndex(sec => sec.id === initialSectionId)
      if (s >= 0) return { section: s, sel: 0 }
    }
    return { section: 0, sel: 0 }
  })()
  const sectionRef = useRef(seed.section)
  const liveSection = Math.min(sectionRef.current, Math.max(0, safeSections.length - 1))
  const liveRowCount = safeSections[liveSection]?.rows.length ?? 0
  const nav = useNavigablePanes({
    sectionCount: Math.max(1, safeSections.length),
    rowCount: liveRowCount,
    onClose,
    // The composer slot owns cancel while active — consumed BEFORE the
    // detail→list branch (the escOverride seam), so esc dismisses the
    // composer with drafts preserved and the peek level stays put.
    escOverride: () => {
      if (!composerSlot?.active) return false
      composerSlot.onEscape()
      return true
    },
    active: inputActive && !loading && !emptyState && safeSections.length > 0 && !composerSlot?.active,
    sectionIds: safeSections.map(s => s.id),
    expandable,
    initialSection: seed.section,
    initialSel: seed.sel,
    // Identity-first section memory: returning to a section
    // restores the SAME row by key, not the old position.
    sectionRowKeys: safeSections.map(s => s.rows.map(rowKey)),
    // The hook passes back its OWN already-resolved (section, sel) indices —
    // resolved against `safeSections` (derived straight from the `sections`
    // prop, available before this very call) rather than the hook's own
    // return value, which doesn't exist yet at this point in the render.
    onActivateRow: onActivate
      ? (sectionIdx, selIdx) => {
          const sec = safeSections[sectionIdx] ?? safeSections[0]
          const rows = sec?.rows ?? []
          const i = Math.min(selIdx, Math.max(0, rows.length - 1))
          const row = rows[i]
          if (row) onActivate(row)
        }
      : undefined,
  })
  sectionRef.current = nav.section

  // Section-mirror notification (additive; see the prop doc). Fired from an
  // effect AFTER the hook's state settles, id-guarded so a re-render with the
  // same active section stays silent and the mount never fires.
  const activeSectionId = safeSections[Math.min(nav.section, Math.max(0, safeSections.length - 1))]?.id
  const notifiedSectionIdRef = useRef(activeSectionId)
  const onSectionChangeRef = useRef(onSectionChange)
  onSectionChangeRef.current = onSectionChange
  useEffect(() => {
    if (activeSectionId === undefined || activeSectionId === notifiedSectionIdRef.current) return
    notifiedSectionIdRef.current = activeSectionId
    onSectionChangeRef.current?.(activeSectionId, sectionRef.current)
  }, [activeSectionId])

  const section = safeSections[nav.section] ?? safeSections[0]
  const sectionRows = section?.rows ?? []
  // Defensive clamp of the selected index against the ACTUAL active-section rows
  // (the hook also clamps internally, but the active section may differ from the
  // count it was constructed with on the first render after a section switch).
  let sel = Math.min(nav.sel, Math.max(0, sectionRows.length - 1))
  // ROW-KEY-STABLE selection: when the live data
  // reorders under a RESTING cursor, follow the selected row by its key
  // instead of holding the index (a snapshot refresh must not teleport the
  // selection onto a different row). A cursor the USER just moved (nav.sel
  // changed since last render) always wins — following the key then would
  // snap ↑↓ right back. Section switches change the whole row set; the old
  // key simply isn't found, so the clamped index (the remembered row) holds.
  const prevNavSelRef = useRef(nav.sel)
  const selKeyRef = useRef<string | null>(null)
  const selMoved = nav.sel !== prevNavSelRef.current
  if (!selMoved && selKeyRef.current !== null && sectionRows.length > 0) {
    const under = sectionRows[sel]
    if (!under || rowKey(under) !== selKeyRef.current) {
      const followed = sectionRows.findIndex(r => rowKey(r) === selKeyRef.current)
      if (followed >= 0) sel = followed
    }
  }
  prevNavSelRef.current = nav.sel
  const selectedRow = sectionRows[sel]
  selKeyRef.current = selectedRow ? rowKey(selectedRow) : null
  // Reconcile the hook's index with the followed key so the NEXT ↑↓ moves
  // from the row the operator sees selected (a one-frame follow, no jump).
  useEffect(() => {
    if (sel !== nav.sel) nav.selectRow(sel)
  })

  // Extra single-char row hotkeys (x/s/r/R-style). Gated the same way the
  // list/drill axis is (listNavLive, computed below) plus the hook's
  // timestamp-ref launch buffer so the launching keystroke never fires an
  // action. Undefined/empty rowActions ⇒ isActive false ⇒ byte-identical.
  // The composer slot's input: printable/backspace/↵ forward to the surface
  // while active (esc rides the wrapped onClose above — the always-on esc
  // hook already consumes it, so it is filtered here to avoid double acts).
  useInput(
    (input, key) => {
      if ((key as Record<string, boolean>).escape) return
      composerSlot?.onInput(input, key as unknown as Record<string, boolean>)
    },
    { isActive: !!composerSlot?.active },
  )

  // Type-to-compose: DETAIL level only — hotkeys are dead there by
  // the law, so a printable character is unclaimed and may open the
  // scoped composer carrying itself as the first keystroke.
  useInput(
    (input, key) => {
      const k = key as Record<string, boolean>
      if (!input || k.escape || k.return || k.ctrl || k.meta || k.tab) return
      if (!selectedRow) return
      onTypeToCompose?.(selectedRow, input)
    },
    {
      isActive:
        !!onTypeToCompose && !composerSlot?.active && !loading && nav.level === 'detail',
    },
  )

  useInput(
    (input, key) => {
      // Modifier chords never fire single-char actions (review finding:
      // ctrl+c — the interrupt — matched the 'c' change-next action).
      const k = key as Record<string, boolean>
      if (k.ctrl || k.meta) return
      if (!nav.pastBuffer() || !selectedRow || !rowActions) return
      for (const a of rowActions) {
        if (a.key.length === 1 && input === a.key && a.when(selectedRow)) {
          a.run(selectedRow)
          return
        }
      }
    },
    {
      isActive:
        inputActive &&
        !loading &&
        !emptyState &&
        safeSections.length > 0 &&
        !composerSlot?.active &&
        !!rowActions &&
        rowActions.length > 0 &&
        // LIST level only (product-study r2): the detail footer hides the
        // action hints, so the keys must be dead there too — the
        // rule's inverse (x on the old schedules board was a hidden DESTRUCTIVE key inside
        // the drilled-in view).
        nav.level !== 'detail',
    },
  )

  const scrollRef = useRef<ScrollBoxHandle>(null)
  useLayoutEffect(() => {
    if (nav.rowRef.current && scrollRef.current) {
      // scrollTop = anchorTop + offset: NEGATIVE keeps 2 context rows above
      // the selection. The prior +2 seeked the row 2 rows PAST the viewport
      // top — invisible on any list longer than the window (latent: short
      // lists clamp to maxScroll and mask it).
      scrollRef.current.scrollToElement(nav.rowRef.current, -2)
    }
  }, [sel, nav.section, nav.rowRef])

  // The total content width MAIN gets, by layout + drill state.
  const detailVisible = nav.drilled && !!selectedRow
  // Region chrome (PATH A): the side pane takes a PROPORTIONAL width of the
  // interior (the reference's ~40.5% split) instead of the fixed columns —
  // computed off the same innerWidth the rest of the math uses below.
  // Region shell geometry: paddingX=2 and NO outer border ⇒ interior =
  // cols − 4; the side pane's width INCLUDES its own border box.
  const regionInner = Math.max(0, cols - 4)
  const regionSideWidth = regionChrome
    ? Math.max(24, Math.round((regionInner * regionChrome.sideWidthPct) / 100))
    : null
  const detailWidth =
    regionSideWidth ?? (layout === 'wide' ? DETAIL_WIDTH_WIDE : DETAIL_WIDTH_MID)
  // Standing side info (sideInfo prop): visible whenever a row is selected and
  // no drilled detail claims the slot, wide/mid only. Mutually exclusive with
  // the drilled detail by construction (detailVisible wins), so the two right
  // panes can never stack.
  const infoVisible =
    !!sideInfo && !!selectedRow && !detailVisible && (layout === 'wide' || layout === 'mid')
  const navW =
    showNav && (layout === 'wide' || (layout === 'mid' && !detailVisible && !infoVisible))
      ? NAV_WIDTH + 2
      : 0
  const sideDetailW = (layout === 'wide' || layout === 'mid') && detailVisible ? detailWidth + 2 : 0
  const sideInfoW = infoVisible ? detailWidth + 2 : 0
  // Frame chrome (round border + paddingX=1) through the ONE geometry
  // contract. MINI-TEMPER item 4: the owner clamps at zero — the old
  // Math.max(20/16, …) floors could exceed the LIVE rectangle on an
  // ultra-narrow terminal and draw outside it (the wrapped-border class).
  // Side panes only exist ≥120 cols (pickLayout), so at the widths where
  // these floors ever bit, navW/side widths are already 0 — the quiet
  // compact fallback is simply the clamped width itself.
  const innerWidth = regionChrome ? regionInner : innerPaneWidth(cols, { border: true, paddingX: 1 })
  // Region chrome: the MAIN pane wears its own border+padding (4 cells) and
  // a one-cell gutter sits before the side pane — both come out of the
  // columns engine's budget or the last column clips.
  const mainWidth = Math.max(0, innerWidth - navW - sideDetailW - sideInfoW - (regionChrome ? 5 : 0))

  // Explicit bounded height for the scrollable list/detail regions (see the
  // LAYOUT CONTRACT above). The panel is content-sized; only these regions are
  // height-capped so the list scrolls instead of stretching the panel off-screen.
  // viewportBudget is the CAP; the actual list height is content-aware (the max
  // of the visible rows and the left-nav entries) so that with FEW rows the
  // panel shrinks to its content — leaving the footer + bottom border inside the
  // viewport even when the surface renders inline below REPL chrome (a local-jsx
  // surface is inline; the AlternateScreen wrap only takes the whole screen on a
  // true fullscreen root). With MANY rows it pins at the cap and the ScrollBox
  // scrolls (scrollToElement keeps the selection visible).
  // MINI-TEMPER item 4: through the ONE height owner — the 3-row minimum is
  // ASPIRATIONAL (viewportRows clamps it by the post-reserve availability),
  // so a sub-reserve transient (rows < 14) shrinks to what physically exists
  // instead of manufacturing rows into negative space.
  const viewportBudget = viewportRows(termRows, {
    reserve:
      (regionChrome ? regionChrome.chromeRows : VIEWPORT_RESERVE) +
      (composerSlot?.node ? (composerSlot.rows ?? COMPOSER_SLOT_RESERVE) : 0),
    min: 3,
  })
  // When the detail folds in as a split below the list (fold/inline), the budget
  // is shared: the list shrinks by the detail's rows so the whole panel fits.
  const detailBaseRows = nav.detailRows + 1
  const listCap =
    detailVisible && (layout === 'fold' || layout === 'inline')
      ? viewportRows(viewportBudget, { reserve: detailBaseRows + 1, min: 3 })
      : viewportBudget
  // Content-aware: never taller than needed for the rows + nav, never over the
  // cap — the 1-row aspiration is bounded by the cap (zero cap = zero rows).
  const contentRows = Math.max(sectionRows.length, showNav ? safeSections.length : 0, 1)
  const listHeight = Math.max(Math.min(1, listCap), Math.min(listCap, contentRows))
  // SLACK → DETAIL (Sol 5.6 WS6): the full-canvas shell would otherwise park leftover
  // height as a framed void above the footer. In the split layouts the drilled
  // detail absorbs it instead — short lists get a tall, useful detail pane;
  // long lists keep the shared-budget split unchanged.
  const slackRows =
    detailVisible && (layout === 'fold' || layout === 'inline')
      ? Math.max(0, viewportBudget - listHeight - detailBaseRows - 2)
      : 0
  const splitDetailHeight = detailBaseRows + slackRows
  // LIST-level slack (nothing drilled): a short list on the narrow layouts
  // would otherwise leave the same framed void — when a sideInfo renderer exists,
  // the slack becomes a bottom info card for the selected row instead.
  const idleSlack =
    !detailVisible && (layout === 'fold' || layout === 'inline') && !!sideInfo
      ? Math.max(0, viewportBudget - listHeight - 3)
      : 0

  // React-level windowing of the active section's rows (PaneRow is
  // fixed height={1}, so this is pure integer math — NOT useVirtualScroll, which
  // exists only for variable-height MessageRows). Mount only the rows inside
  // [winStart, winEnd); spacer Boxes carry the unmounted rows' height so the
  // scroll geometry stays honest (PaneRow is height-1 ⇒ each spacer's height ==
  // its row count, so the selected row's Yoga computedTop == its global index).
  // INVARIANT: `sel` is always inside [winStart, winEnd) — the clamp centers it
  // with overscan on both sides, so its rowRef stays mounted and scrollToElement
  // never no-ops. Common case N ≤ winSpan ⇒ winStart=0/winEnd=N ⇒ byte-identical.
  const N = sectionRows.length
  const winSpan = listHeight + 2 * ROW_OVERSCAN
  const winStart =
    N <= winSpan
      ? 0
      : Math.min(Math.max(0, sel - (listHeight >> 1) - ROW_OVERSCAN), N - winSpan)
  const winEnd = Math.min(N, winStart + winSpan)

  // ----- footer hotkey rail (always rendered) --------------------------------
  // the +/- resize axis only MEANS something in the split layouts
  // (fold/inline), where the detail shares vertical space with the list via
  // splitDetailHeight. In wide/mid the detail is a side column already pinned to
  // the full viewportBudget — there is nothing to grow, so '+'/'-' is a no-op
  // there. Only advertise "+/- size" where it actually works (and likewise the
  // "(expanded)" header), instead of showing a dead control.
  const resizeActive =
    expandable && (layout === 'fold' || layout === 'inline') && slackRows === 0
  // the hints must track the SAME gates
  // that arm the keys (useNavigablePanes arms ↑↓/↵/→ on active && rowCount>0;
  // tab/← on active && sectionCount>1) — a permanently-empty lane, the
  // loading state, and the empty state otherwise advertise dead keys. esc
  // stays: close always works.
  const listNavLive = !loading && !emptyState && safeSections.length > 0
  // While the composer slot owns input (a confirm, add, filter…) every list
  // axis and row action is PARKED — the rail must not advertise them (the
  // armed⇔advertised law; `↵/→ view` beside a confirm whose ↵ uninstalls was
  // the found violation). The slot's own line carries its exits; the rail
  // keeps only the tail's `esc composer`. Slot inactive ⇒ byte-identical.
  const composerOwnsInput = !!composerSlot?.active
  // Selection-tracked action hints (the one-interaction-grammar program):
  // advertise exactly the single-char actions ARMED for the selected row —
  // the SAME when() gates that arm the keys above, so a
  // hint can never sit on a row where its key is dead. Order contract:
  // nav → primary/actions → section → caller hints → close.
  // FC-131: the clickable rail gates row actions by nav LEVEL, but this
  // packed text line did not — drilled into a row, all eight row verbs
  // stayed advertised and every one was dead there. Row actions and the
  // list head are LIST-level facts.
  const actionHints =
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && selectedRow && rowActions
      ? rowActions
          .filter(a => a.when(selectedRow))
          .map(a => a.hint ?? `${a.key} ${a.label}`)
          .join(' · ')
      : undefined
  const footerHeadText = [
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↑↓ select' : undefined,
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↵/→ view' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  // Canonical order (the footer-order contract): nav → actions → section →
  // close. The full line feeds the packed fallback; the tail below excludes
  // the head + actions, which render separately on the clickable path.
  const footerFullParts = [
    footerHeadText || undefined,
    actionHints,
  ]
  const footerTailText =
    composerSlot?.active
      ? 'esc composer'
      : nav.level === 'detail'
        ? ['↑↓ select', resizeActive ? '+/- size' : undefined, detailFooterHints, '←/esc back']
            .filter(Boolean)
            .join(' · ')
        : [
          listNavLive && showNav ? 'tab/1-9 section' : undefined,
          footerHints,
          closeHint ?? 'esc close',
        ]
          .filter(Boolean)
          .join(' · ')

  // ----- body ----------------------------------------------------------------
  let body: React.ReactNode
  if (loading) {
    // Centered in the claimed frame (see minHeight below) — a transient state
    // floating mid-canvas reads designed; top-left over void read abandoned.
    body = (
      <Box marginTop={1} flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Text color={tokens.textMuted}>loading…</Text>
      </Box>
    )
  } else if (emptyState) {
    body = (
      <Box marginTop={1} flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <EmptyState title={emptyState.title} hint={emptyState.hint} />
      </Box>
    )
  } else {
    // The MAIN aligned-column list — a ScrollBox bounded to listHeight (so it
    // scrolls inside the content-sized panel). totalWidth = mainWidth so the
    // elastic column fills — capped by maxContentWidth when the caller set one.
    const totalWidth = maxContentWidth ? Math.min(mainWidth, maxContentWidth) : mainWidth
    const mainList = (
      <Box flexDirection="column" overflow="hidden">
        {/* folded-nav tab strip / single-section header line. At mid width a
            STANDING side info pane displaces the left nav (same trade the
            drilled detail makes) — the strip keeps the section axis visible. */}
        {(layout === 'fold' || layout === 'inline' || (layout === 'mid' && infoVisible)) &&
        showNav ? (
          <TabStrip
            sections={safeSections}
            active={nav.section}
            idBase={idBase}
            onSelectSection={nav.selectSection}
            tokens={tokens}
          />
        ) : null}
        {(layout === 'inline' || layout === 'fold') && !showNav ? (
          <Box height={1} overflow="hidden">
            <Text bold color={accent}>
              {section?.label ?? view}
            </Text>
            <Text color={tokens.textMuted}> ({section?.count ?? sectionRows.length})</Text>
          </Box>
        ) : null}
        <Box paddingLeft={2} flexShrink={0}>
          <ColumnHeader columns={columns} totalWidth={totalWidth - 2} tokens={tokens} />
        </Box>
        {sectionRows.length === 0 ? (
          <Box marginTop={1}>
            <Text color={tokens.textMuted}>{section?.emptyHint ?? 'nothing here'}</Text>
          </Box>
        ) : (
          <ScrollBox
            ref={scrollRef}
            height={listHeight}
            flexShrink={0}
            flexDirection="column"
          >
            {winStart > 0 ? <Box height={winStart} flexShrink={0} /> : null}
            {sectionRows.slice(winStart, winEnd).map((r, i) => {
              const gi = winStart + i
              return (
                <PaneRow
                  key={rowKey(r)}
                  row={r}
                  rowId={`${idBase}:row:${rowKey(r)}`}
                  columns={columns}
                  selected={gi === sel}
                  totalWidth={totalWidth}
                  rowRef={gi === sel ? (nav.rowRef as React.Ref<DOMElement>) : undefined}
                  onSelect={() => nav.selectRow(gi)}
                  onActivate={nav.activateCurrent}
                  tokens={tokens}
                />
              )
            })}
            {winEnd < N ? <Box height={N - winEnd} flexShrink={0} /> : null}
          </ScrollBox>
        )}
      </Box>
    )

    // Right-pane detail (wide/mid) — bounded to the same viewport budget.
    const rightDetail = selectedRow ? (
      <Box flexDirection="column" overflow="hidden">
        {/* No "(expanded)" here: the wide/mid detail is a side column already
            pinned to the full viewportBudget, so there is no expand state to
            show (the +/- axis is split-layout only — HB-0004). */}
        <Text bold color={accent} wrap="truncate-end">
          {(detailTitle?.(selectedRow) || '').trim() || 'detail'}
        </Text>
        <ScrollBox height={Math.max(1, viewportBudget - 3)} flexShrink={0} flexDirection="column">
          {renderDetail(selectedRow)}
        </ScrollBox>
      </Box>
    ) : null

    // Standing side info (wide/mid) — the caller owns the pane's content incl.
    // any heading; the framework only bounds it to the shared viewport budget.
    // Region chrome: the pane carries its sideTitle row and sits ONE gutter
    // cell off the main pane (the reference geometry).
    const infoPane =
      infoVisible && selectedRow && sideInfo ? (
        <Box width={detailWidth} flexShrink={0} marginLeft={regionChrome ? 1 : 2} overflow="hidden" flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1}>
          {regionChrome ? (
            <Box flexShrink={0} height={1} overflow="hidden">
              {regionChrome.sideTitle(selectedRow)}
            </Box>
          ) : null}
          <ScrollBox height={Math.max(1, viewportBudget - 2 - (regionChrome ? 1 : 0))} flexShrink={0} flexDirection="column">
            {sideInfo(selectedRow)}
          </ScrollBox>
        </Box>
      ) : null

    // Split detail (fold/inline) — bounded to detailRows so it grows/shrinks.
    const splitDetail = selectedRow ? (
      <Box flexDirection="column" height={splitDetailHeight + 1} flexShrink={0} marginTop={1} overflow="hidden">
        <Text bold color={accent} wrap="truncate-end">
          {(detailTitle?.(selectedRow) || '').trim() || 'detail'}
          {nav.expanded ? <Text color={tokens.textMuted}> (expanded)</Text> : null}
        </Text>
        <ScrollBox height={splitDetailHeight} flexShrink={0} flexDirection="column">
          {renderDetail(selectedRow)}
        </ScrollBox>
      </Box>
    ) : null

    if (layout === 'wide') {
      body = (
        <Box marginTop={regionChrome ? 0 : 1} overflow="hidden">
          {showNav ? (
            <SectionNav
              sections={safeSections}
              active={nav.section}
              width={NAV_WIDTH}
              idBase={idBase}
              onSelectSection={nav.selectSection}
              tokens={tokens}
            />
          ) : null}
          <Box
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            borderStyle={regionChrome ? 'round' : undefined}
            borderColor={regionChrome ? tokens.borderSubtle : undefined}
            paddingX={regionChrome ? 1 : 0}
          >
            {regionChrome ? (
              <Box flexShrink={0} height={1} overflow="hidden">
                {regionChrome.mainTitle}
              </Box>
            ) : null}
            {mainList}
          </Box>
          {detailVisible ? (
            <Box width={detailWidth} flexShrink={0} marginLeft={2} overflow="hidden" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} flexDirection="column">
              {rightDetail}
            </Box>
          ) : (
            infoPane
          )}
        </Box>
      )
    } else if (layout === 'mid') {
      body = (
        <Box marginTop={regionChrome ? 0 : 1} overflow="hidden">
          {showNav && !detailVisible && !infoVisible ? (
            <SectionNav
              sections={safeSections}
              active={nav.section}
              width={NAV_WIDTH}
              idBase={idBase}
              onSelectSection={nav.selectSection}
              tokens={tokens}
            />
          ) : null}
          <Box
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            borderStyle={regionChrome ? 'round' : undefined}
            borderColor={regionChrome ? tokens.borderSubtle : undefined}
            paddingX={regionChrome ? 1 : 0}
          >
            {regionChrome ? (
              <Box flexShrink={0} height={1} overflow="hidden">
                {regionChrome.mainTitle}
              </Box>
            ) : null}
            {mainList}
          </Box>
          {detailVisible ? (
            <Box width={detailWidth} flexShrink={0} marginLeft={2} overflow="hidden" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} flexDirection="column">
              {rightDetail}
            </Box>
          ) : (
            infoPane
          )}
        </Box>
      )
    } else {
      // fold + inline: drill = split (list stays on top, detail below). Both
      // regions are bounded so the content-sized panel always fits the viewport.
      body = (
        <Box flexDirection="column" marginTop={regionChrome ? 0 : 1} overflow="hidden">
          <Box flexDirection="column" overflow="hidden">
            {mainList}
          </Box>
          {detailVisible ? splitDetail : null}
          {!detailVisible && idleSlack >= 6 && sideInfo && selectedRow ? (
            <Box
              flexDirection="column"
              marginTop={1}
              height={idleSlack}
              overflow="hidden"
              borderStyle="round"
              borderColor={tokens.borderSubtle}
              paddingX={1}
            >
              <ScrollBox height={Math.max(1, idleSlack - 2)} flexShrink={0} flexDirection="column">
                {sideInfo(selectedRow)}
              </ScrollBox>
            </Box>
          ) : null}
        </Box>
      )
    }
  }

  return (
    <AlternateScreen mouseTracking={mouseTracking}>
      {/* CONTENT-SIZED bordered panel: its bottom border + footer rail render
          right after the body, so they are always inside the viewport even when
          the panel sits below REPL chrome in the alt-screen flow. The scrollable
          list/detail regions inside carry the explicit height bound. */}
      <Box
        flexDirection="column"
        // Region chrome (PATH A): the multi-card canvas paints its own region
        // frames — the shell's full-canvas border + brand row stand down and
        // headerBlock renders in their place. Absent ⇒ the classic shell,
        // byte-identical.
        borderStyle={regionChrome ? undefined : 'round'}
        borderColor={regionChrome ? undefined : accent}
        paddingX={regionChrome ? 2 : 1}
        width="100%"
        flexShrink={0}
        // Claim the WHOLE alt-screen:
        // a 5-row board would otherwise float over 70-85% dead black void. The shell
        // now spans the takeover it already owns — the border frames the full
        // canvas and the footer pins to its bottom via the spacer below.
        // (minHeight only grows; over-tall content keeps the bounded scrolls.)
        minHeight={Math.max(0, termRows - 1)}
      >
        {regionChrome ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.headerBlock}
          </Box>
        ) : (
          /* header (headerRight pins to the shell's right edge via the spacer;
             the row is height-bounded so a long rollup TRUNCATES at fold/inline
             widths instead of wrapping the brand row — review) */
          <Box flexShrink={0} height={1} overflow="hidden">
            {/* THE shared lockup (UN-23; ramped main-header title since the
                ruling) — this file's hand-composed copy was the
                imitation class the lockup census exists to shrink. */}
            <ProductLockup view={view} {...(subtitle !== undefined ? { subtitle } : {})} />
            {headerRight ? (
              <>
                <Box flexGrow={1} />
                <Box flexShrink={0} marginLeft={2}>
                  {headerRight}
                </Box>
              </>
            ) : null}
          </Box>
        )}
        {headerLine ? <Box flexShrink={0}>{headerLine}</Box> : null}
        {regionChrome?.aboveBody ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.aboveBody}
          </Box>
        ) : null}

        {/* body */}
        {body}

        {/* spacer — pushes the footer to the panel's bottom edge so the
            full-height shell reads as one solid container, not content + void */}
        <Box flexGrow={1} />

        {regionChrome?.belowBody ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.belowBody}
          </Box>
        ) : null}

        {/* the scoped-composer slot — above the footer rail */}
        {composerSlot?.node ? (
          <Box flexShrink={0} flexDirection="column">
            {composerSlot.node}
          </Box>
        ) : null}

        {/* footer hotkey rail — always rendered, never dropped. The rowAction
            hints are CLICKABLE ONLY when the whole rail FITS with
            'esc close' reserved — the shedding law is ABSOLUTE (review
            blocker: unshed hint rows pushed the reserved close off-canvas).
            When tight, or while the composer slot owns input, the rail
            falls back to ONE packed text line (hints included as text). */}
        <Box marginTop={regionChrome ? 0 : 1} flexShrink={0} height={regionChrome ? 0 : 1} overflow="hidden" columnGap={0}>
          {(() => {
            // CANONICAL ORDER (the footer-order contract): nav → actions →
            // section → close, in BOTH paths. Clickable hints exist only
            // when the ENTIRE canonical line fits unshed (strict gate) — the
            // head and tail render as plain text around the hint rows;
            // otherwise ONE packed line with the hints in their canonical
            // slot (shedding, close reserved).
            const hintable =
              nav.level !== 'detail' &&
              listNavLive &&
              !composerSlot?.active &&
              !!selectedRow &&
              !!rowActions
            const hints = hintable
              ? rowActions!.filter(a => a.when(selectedRow!))
              : []
            const headText = footerHeadText
            const fullText = [...footerFullParts, footerTailText]
              .filter(Boolean)
              .join(' · ')
            const hintsWidth = hints.reduce(
              (w, a) => w + (a.hint ?? `${a.key} ${a.label}`).length + 3,
              0,
            )
            const budget = Math.max(0, cols - 4)
            const clickable =
              hints.length > 0 &&
              headText.length + 3 + hintsWidth + footerTailText.length <= budget
            if (!clickable) {
              return (
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {packFooter(fullText, budget)}
                </Text>
              )
            }
            return (
              <>
                {headText ? <Text color={tokens.textMuted}>{headText} · </Text> : null}
                {hints.map(a => (
                  <Box key={a.key} flexShrink={0} columnGap={0}>
                    <InteractiveRow
                      id={`${idBase}:hint:${a.key}`}
                      selected={false}
                      directActivate
                      onActivate={() => a.run(selectedRow!)}
                      height={1}
                    >
                      <Text color={tokens.textMuted}>
                        {a.hint ?? `${a.key} ${a.label}`}
                      </Text>
                    </InteractiveRow>
                    <Text color={tokens.textMuted}> · </Text>
                  </Box>
                ))}
                <Text color={tokens.textMuted}>{footerTailText}</Text>
              </>
            )
          })()}
        </Box>
      </Box>
    </AlternateScreen>
  )
}

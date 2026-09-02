import { useEffect, useRef, useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import type { DOMElement } from '../../ink.js'
import { useInput } from '../../ink.js'
import { decodeNavKey } from './navSemantics.js'
import { useOpenEventGate } from './useOpenEventGate.js'

// ============================================================================
//  useNavigablePanes — the interaction layer for NavigablePanes, extending the
//  useInteractiveList idiom (no useFocus, clamp-not-wrap; an open-event-gate
//  launch buffer on ACTION keys only — arrows/tab/esc are instant). It adds
//  three axes on top of the base ↑↓-select:
//
//    - SECTION axis  (Tab forward / shift+Tab or ← back): cycle the left-nav
//      sections; selection resets to row 0 of the new section.
//    - DRILL axis    (↵ or →): open renderDetail(selectedRow) — level: list→detail.
//    - In DETAIL: ↑↓ keep moving the row SELECTION (detail follows); '+'/'-'
//      resize the detail pane; ← or '-'-at-floor backs out to the list.
//    - esc: back ONE level (detail→list, list→onClose). ← also backs out a detail.
//
//  CLOSE-AXIS INVARIANT (the bug the prior design shipped): esc→onClose MUST
//  fire in EVERY state, including loading / honest-empty / no-rows, or a
//  fullscreen local-jsx surface traps the user (Ctrl+C only). So this hook runs
//  TWO useInput hooks: an always-on one that owns ONLY esc (and is never gated
//  on row count), and the navigation one that owns ↑↓/Tab/↵/→/+/- and is gated
//  on `active && (rowCount > 0 || sectionCount > 1)` — rows to move through OR
//  a section rail to walk (↑↓ cross section edges, landing on empty sections
//  too; ↵ no-ops there). ink-component-patterns: two useInput is fine as
//  long as their key sets are disjoint — esc lives in exactly one of them.
// ============================================================================

export type NavLevel = 'list' | 'detail'

export type UseNavigablePanesArgs = {
  /** checked FIRST on the cancel axis, BEFORE the detail→list
   *  branch — a surface-owned layer (the composer slot) consumes esc/← and
   *  the nav never sees it. Returns true = consumed. */
  escOverride?: () => boolean
  /** stable section identities. When provided, the ACTIVE
   *  section and the per-section remembered rows follow the section's ID
   *  across list rebuilds — sections that elide/appear (the attention
   *  buckets) can never re-aim the cursor by reindexing. */
  sectionIds?: string[]
  /** Number of sections (left-nav entries). >=1. */
  sectionCount: number
  /** Row count of the CURRENTLY-active section (drives clamp). */
  rowCount: number
  /** Close the whole surface (alt-screen pops on unmount). */
  onClose: () => void
  /** Whether the LIST/DRILL/EXPAND axes are live. esc is ALWAYS live, regardless
   *  of this flag — see the close-axis invariant above. Default true. */
  active?: boolean
  /** Enables the ↓/+ grow / - shrink axis on a drilled detail. Default true. */
  expandable?: boolean
  /** Detail height (in rows) at the un-expanded floor and the grow ceiling. */
  detailFloor?: number
  detailCeil?: number
  /**
   * When set, ↵/→ calls this with the (section, sel) indices INSTEAD of
   * flipping level to 'detail' (NavigablePanes' `onActivate` prop — the
   * /workflows board's board→run→agent drill-through, where each level fully
   * replaces the previous view rather than nesting a second interactive tree
   * inside this one's inline detail pane). Indices, not a row — this hook has
   * no row context; NavigablePanes resolves the row from its own `sections`
   * prop, which is available independently of this hook's return value.
   * undefined (the default) preserves the existing inline-detail drill
   * behavior byte-for-byte for every other caller.
   */
  onActivateRow?: (section: number, sel: number) => void
  /**
   * Mount-time cursor seed (both default 0). The carry-back seam for boards
   * whose activation REPLACES this pane with another view (workflows
   * board→run): on the way back the caller re-mounts this hook and seeds the
   * cursor with the row it left from, instead of dumping the operator at row
   * 0 of a long list. Read once (useState initializers); the clamp effect
   * already guards out-of-range seeds against shrunken data.
   */
  initialSection?: number
  initialSel?: number
  /**
   * Per-section stable row keys. When provided, the
   * per-section REMEMBERED cursor is stored by row IDENTITY: returning to a
   * section whose rows reordered/refreshed meanwhile restores the SAME row,
   * not whatever now sits at the old position. Absent ⇒ positional memory
   * NavigablePanes derives this from its
   * `sections` + `rowKey` props.
   */
  sectionRowKeys?: readonly (readonly string[])[]
}

export type UseNavigablePanesResult = {
  /** Active section index (clamped). */
  section: number
  /** Selected row index within the active section (clamped). */
  sel: number
  /** 'list' = browsing the column list · 'detail' = a row is drilled in. */
  level: NavLevel
  /** True when a row is drilled in (level === 'detail'). */
  drilled: boolean
  /** Current detail height in rows (>= detailFloor). Fed to the detail pane. */
  detailRows: number
  /** True when detailRows is above the floor (an expand is in effect). */
  expanded: boolean
  /** Call INSIDE a key handler: true once the launch keystroke's own event has
   *  elapsed. EVENT-IDENTITY via useOpenEventGate (the seq current at mount is
   *  the opener's; anything after it passes) — never a setTimeout→setState
   *  flag (idle-parked-commits arm of STALE-PAINT) and never a wall-clock
   *  mount comparator (which swallowed a legitimate fast first key). */
  pastBuffer: () => boolean
  /** Attach to the selected row so the caller can scrollToElement(rowRef). */
  rowRef: React.RefObject<DOMElement | null>
  /** Move to a section directly (left-nav click parity / programmatic). */
  setSection: (i: number) => void
  /** Typed selection ops. selectSection restores
   *  that section's REMEMBERED row (a tab click returns you where you were,
   *  matching the keyboard section axis); selectRow moves the cursor, clamped
   *  against the live row count. Both are pointer-parity entry points — the
   *  key handlers above route through the same state. */
  selectSection: (i: number) => void
  selectRow: (i: number) => void
  /** Perform the selected row's PRIMARY action — the exact ↵ body (buffer-
   *  gated, onActivateRow-aware). The pointer path calls this so a click on
   *  the selected row can never mean something ↵ doesn't. */
  activateCurrent: () => void
}

/**
 * List-level EDGE CROSSING — the pure brain of the "↑↓ walk the whole board"
 * grammar: ↑ on a section's FIRST row (or in an empty section) steps to the
 * PREVIOUS section, landing on its last row; ↓ on the LAST row steps to the
 * NEXT section's first row. The step is ONE section at a time and lands on
 * EMPTY sections too (an empty section shows its honest empty state — the
 * left rail is a vertical list, and ↑↓ must reach everything it shows;
 * skipping empties re-created the /workflows dead-arrows class on
 * Active(0)·Recent(1)·Past(0), where NO populated neighbor existed and ↑↓
 * stayed dead while ← walked the rail). Returns null when the cursor is
 * mid-list (within-section motion owns it) or at the board's extremes
 * (clamp-not-wrap — hard stops, unlike the ← wrap).
 */
export function crossSectionAtEdge(
  counts: readonly number[],
  section: number,
  sel: number,
  dir: -1 | 1,
): { section: number; sel: number } | null {
  const count = counts[section] ?? 0
  const atEdge = dir === -1 ? sel <= 0 : sel >= count - 1
  if (!atEdge) return null
  const t = section + dir
  if (t < 0 || t >= counts.length) return null
  const n = counts[t] ?? 0
  return { section: t, sel: dir === -1 ? Math.max(0, n - 1) : 0 }
}

export function useNavigablePanes({
  sectionCount,
  rowCount,
  onClose,
  active = true,
  escOverride,
  sectionIds,
  expandable = true,
  detailFloor = 3,
  detailCeil = 18,
  onActivateRow,
  initialSection = 0,
  initialSel = 0,
  sectionRowKeys,
}: UseNavigablePanesArgs): UseNavigablePanesResult {
  const [section, setSectionState] = useState(initialSection)
  const [sel, setSel] = useState(initialSel)
  const [level, setLevel] = useState<NavLevel>('list')
  const [detailRows, setDetailRows] = useState(detailFloor)
  const rowRef = useRef<DOMElement | null>(null)

  // The launch-keystroke gate — event identity, not wall-clock (see the
  // pastBuffer doc above). Arrows / tab / esc are NOT buffered at all — cursor
  // and close must feel instant, and none of them can be the '\r' that
  // launched the surface. Only the drill/action keys (↵ → and row-action
  // chars) consult the buffer.
  const pastBuffer = useOpenEventGate()

  // Clamp section + sel if the underlying data shrinks (e.g. a snapshot refresh
  // drops rows out from under the cursor). Never points past the live data.
  // COUNT TRUTH: prefer the active section's key count (same-render data from
  // the caller's `sections` prop) over the rowCount prop, which lags one
  // render behind a section switch (NavigablePanes derives it from a ref
  // written at the END of its render) — the lag mis-clamped cross-section
  // landings and any remembered row deeper than the section being LEFT.
  const maxSection = Math.max(0, sectionCount - 1)
  // IDENTITY-FIRST active section (review finding: bucket elision reindexed
  // every section): when ids are provided and the previously-active id still
  // exists, its CURRENT index wins over the stored numeric state.
  const activeSectionIdRef = useRef<string | null>(null)
  const idResolved =
    activeSectionIdRef.current !== null && sectionIds
      ? sectionIds.indexOf(activeSectionIdRef.current)
      : -1
  const clampedSection = idResolved >= 0 ? idResolved : Math.min(section, maxSection)
  const keyedCount = sectionRowKeys?.[clampedSection]?.length
  const maxSel = Math.max(0, (keyedCount ?? rowCount) - 1)
  const clampedSel = Math.min(sel, maxSel)
  useEffect(() => {
    if (section !== clampedSection) setSectionState(clampedSection)
    if (sel !== clampedSel) setSel(clampedSel)
  }, [section, clampedSection, sel, clampedSel])

  // Per-section remembered row (interaction-finish
  // made it IDENTITY-FIRST): leaving a section stores its cursor as the row's
  // stable KEY (when sectionRowKeys is provided) plus the position fallback;
  // returning restores the SAME ROW even if the section's data reordered
  // meanwhile — a positional restore lands on whatever now sits at the old
  // index only when the remembered row vanished (or no keys were provided).
  // Tab, digit jump, and section/tab CLICKS all pass through here, so
  // keyboard and pointer agree.
  const rememberedSel = useRef(new Map<string, { key: string | null; index: number }>())
  const sectionMemoKey = (i: number): string => sectionIds?.[i] ?? String(i)
  const keysRef = useRef(sectionRowKeys)
  keysRef.current = sectionRowKeys
  const setSection = (i: number): void => {
    const next = Math.min(Math.max(0, i), maxSection)
    const keys = keysRef.current
    rememberedSel.current.set(sectionMemoKey(clampedSection), {
      key: keys?.[clampedSection]?.[clampedSel] ?? null,
      index: clampedSel,
    })
    setSectionState(next)
    activeSectionIdRef.current = sectionIds?.[next] ?? null
    const remembered = rememberedSel.current.get(sectionMemoKey(next))
    const byKey =
      remembered?.key != null ? (keys?.[next]?.indexOf(remembered.key) ?? -1) : -1
    setSel(byKey >= 0 ? byKey : (remembered?.index ?? 0))
    setLevel('list')
    setDetailRows(detailFloor)
  }

  const selectRow = (i: number): void => {
    setSel(Math.min(Math.max(0, i), maxSel))
  }

  // The exact ↵ body — shared by the key handler below and the pointer path.
  // No-op on an EMPTY section (the nav axis is live there so ↑↓ can walk the
  // rail; there is no row to activate — flipping to 'detail' would show
  // nothing and demand an esc back out).
  const activateCurrent = (): void => {
    if (!pastBuffer()) return
    if ((keyedCount ?? rowCount) === 0) return
    if (onActivateRow) {
      onActivateRow(clampedSection, clampedSel)
    } else {
      setLevel('detail')
      setDetailRows(detailFloor)
    }
  }

  // --- close axis: ALWAYS live (the un-trappable exit). Owns esc (and ← as a
  // close hatch only when there's no section axis to claim it). esc backs out
  // one level when drilled; at the list level it closes the surface. ← mirrors
  // esc at the list level ONLY when sectionCount<=1 — a single-section list has
  // no `← = previous section` binding (that lives in the nav axis, gated on
  // sectionCount>1), so otherwise ← is a dead key against the ←-closes
  // convention every sibling surface teaches. The two key-sets stay disjoint:
  // the nav axis claims ← only when sectionCount>1 (list) or when drilled.
  // NOT buffered (esc can never be the launching '\r') and NEVER gated on
  // `active`/rowCount — that was the trap bug.
  // Overlay-stack membership: a board is a LAYER — Escape
  // closes exactly one interaction layer, so a surface stacked on top of the
  // board owns esc until it pops (the stacked-esc class: two unregistered
  // surfaces both closing on one Escape). Registration is unconditional —
  // the close axis below must stay the un-trappable exit.
  const overlayToken = useRegisterOverlay('board', true)
  useInput(
    (input, key, event) => {
      // Semantic decode (navSemantics): esc → cancel everywhere; ← decodes
      // cancel here ONLY via the advertised ←-close convention — at the list
      // level of a single-section board, where no section axis claims it.
      // Acting consumes.
      const action = decodeNavKey(input, key, {
        orientation: 'vertical',
        leftCloses: level === 'list' && sectionCount <= 1,
      })
      if (action === 'cancel') {
        // NOT the top layer: decline — the stacked overlay owns esc.
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        // A surface-owned layer (the composer slot) consumes cancel BEFORE
        // the level branch — review finding: esc at the peek level collapsed
        // the detail instead of dismissing the composer.
        if (escOverride?.()) {
          event.stopImmediatePropagation()
          return
        }
        event.stopImmediatePropagation()
        if (level === 'detail') {
          setLevel('list')
          setDetailRows(detailFloor)
        } else {
          onClose()
        }
      }
    },
    { isActive: true },
  )

  // --- section switch: gated on active + >1 section, NOT on rowCount ----------
  // Tab steps FORWARD; shift+Tab and ← (at list level) step BACK. Kept SEPARATE
  // from the nav axis (below) and deliberately NOT gated on rowCount>0, so you
  // can always Tab AWAY from an EMPTY active section to a populated one — the
  // prior bug folded this into the rowCount-gated nav useInput, so an
  // empty active section trapped Tab/shift+Tab/← with no way out but esc.
  useInput(
    (input, key, event) => {
      // The section strip is a HORIZONTAL control (navSemantics): Tab/⇧Tab
      // walk it as the focus order; ← steps back at the list level. → is
      // deliberately NOT claimed here — it belongs to the drill axis below
      // (enterChild), so this hook ignores moveRight; the key sets of the
      // three axes stay disjoint. Acting consumes.
      const action = decodeNavKey(input, key, {
        orientation: 'horizontal',
        tabFocus: true,
      })
      if (
        action === 'focusNext' ||
        action === 'focusPrevious' ||
        (action === 'moveLeft' && level === 'list')
      ) {
        event.stopImmediatePropagation()
        const dir = action === 'focusNext' ? 1 : -1
        const next = (clampedSection + dir + sectionCount) % sectionCount
        setSection(next)
        return
      }
      // DIGIT jump (Sol 5.6 WS6): 1-9 selects the section directly at the
      // LIST level (the nav card labels each entry with its digit). Detail
      // level keeps digits free; single-char row actions are letters by
      // convention, so the key sets stay disjoint.
      if (level === 'list' && input >= '1' && input <= '9') {
        const target = Number(input) - 1
        if (target < sectionCount) {
          event.stopImmediatePropagation()
          setSection(target)
        }
      }
    },
    { isActive: active && sectionCount > 1 },
  )

  // --- navigation axis: gated on active + having somewhere to GO — rows to
  // move through, or (multi-section) a rail to walk. An empty ACTIVE section
  // must not kill ↑↓ on a board whose other sections exist (the crossing
  // above can land here; the keys that landed must be able to leave). The
  // single-section empty board keeps the axis dead exactly as before.
  const navActive = active && (rowCount > 0 || sectionCount > 1)
  useInput(
    (input, key, event) => {
      // The row/drill axis decodes under the VERTICAL + HIERARCHY grammar
      // (navSemantics): ↑↓ move rows, → enters the child (drill), ← leaves it
      // — a taught parent/child axis, never a disguised ↑↓. Acting consumes
      // (typed one-consumption); declined keys propagate untouched.
      const action = decodeNavKey(input, key, {
        orientation: 'vertical',
        hierarchy: true,
      })
      const act = (fn: () => void): void => {
        event.stopImmediatePropagation()
        fn()
      }
      if (level === 'detail') {
        // ↑↓ MOVE THE ROW SELECTION in place — the detail pane re-renders for the
        // newly-selected row (renderDetail(sel)), so you can browse rows without
        // collapsing back to the list and re-drilling. (#12 — was: ↑↓ resized.)
        if (action === 'movePrevious') return act(() => setSel(s => Math.max(0, s - 1)))
        if (action === 'moveNext') return act(() => setSel(s => Math.min(maxSel, s + 1)))
        if (action === 'first') return act(() => setSel(0))
        if (action === 'last') return act(() => setSel(maxSel))
        // +/- resize the detail pane (selection-independent, surface keys).
        if (expandable && input === '+') {
          return act(() => setDetailRows(r => Math.min(detailCeil, r + 1)))
        }
        if (expandable && input === '-' && detailRows > detailFloor) {
          return act(() => setDetailRows(r => Math.max(detailFloor, r - 1)))
        }
        // ← (leaveChild — or '-' at the floor) backs out one level to the list.
        if (action === 'leaveChild' || input === '-') {
          return act(() => {
            setLevel('list')
            setDetailRows(detailFloor)
          })
        }
        return
      }

      // LIST level. (← at this level belongs to the section/close axes above;
      // leaveChild is deliberately unclaimed here — disjoint key sets.)
      // ↑↓ walk the WHOLE board: at a section's row edge they cross into the
      // adjacent non-empty section (crossSectionAtEdge, pure above) instead
      // of dying — the crossing stores the departed section's remembered row
      // exactly like the Tab axis, then overrides the landing (last row when
      // entering upward, first row downward).
      if (action === 'movePrevious' || action === 'moveNext') {
        const dir = action === 'movePrevious' ? -1 : 1
        const keys = keysRef.current
        const cross = keys
          ? crossSectionAtEdge(keys.map(k => k.length), clampedSection, clampedSel, dir)
          : null
        if (cross) {
          return act(() => {
            rememberedSel.current.set(sectionMemoKey(clampedSection), {
              key: keys?.[clampedSection]?.[clampedSel] ?? null,
              index: clampedSel,
            })
            setSectionState(cross.section)
            activeSectionIdRef.current = sectionIds?.[cross.section] ?? null
            setSel(cross.sel)
          })
        }
        return act(() =>
          dir === -1 ? setSel(s => Math.max(0, s - 1)) : setSel(s => Math.min(maxSel, s + 1)),
        )
      }
      if (action === 'first') return act(() => setSel(0))
      if (action === 'last') return act(() => setSel(maxSel))
      // DRILL IN — ↵ (activate) or → (enterChild). The ONLY buffered list
      // keys: the '\r' that launched the surface must never auto-drill row 0.
      // onActivateRow (when set) short-circuits the inline detail flip
      // entirely — the caller owns what "activating" a row means. Passed
      // (clampedSection, clampedSel): both are already-resolved locals in THIS
      // closure, so NavigablePanes' caller-side callback never needs to reach
      // back into this hook's own return value.
      if (action === 'activate' || action === 'enterChild') {
        return act(() => activateCurrent())
      }
    },
    { isActive: navActive },
  )

  return {
    section: clampedSection,
    sel: clampedSel,
    level,
    drilled: level === 'detail',
    detailRows,
    expanded: detailRows > detailFloor,
    pastBuffer,
    rowRef,
    setSection,
    selectSection: setSection,
    selectRow,
    activateCurrent,
  }
}

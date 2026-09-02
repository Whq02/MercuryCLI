import { useRef, useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useInput } from '../../ink.js'
import {
  applyNavMotion,
  decodeNavKey,
  skipDisabled,
  type NavOrientation,
} from './navSemantics.js'
import { useOpenEventGate } from './useOpenEventGate.js'
import { useStableSelection } from './useStableSelection.js'

// ============================================================================
//  useInteractiveList — the ONE small-list owner (replaces
//  useSpecimenNav). A single-pane keyboard+pointer list with:
//
//    · STABLE-ID selection: the cursor follows a row id, never an array index
//      — reorder/insert/remove under a resting cursor keeps the same object
//      selected (the NavigablePanes selKey idiom, applied to flat lists);
//    · SEMANTIC keys: motion decodes through the ONE
//      vocabulary (navSemantics.ts) under the surface's declared orientation —
//      a vertical list moves on ↑↓/Home/End (+ctrl+p/n) and ←→ decode NOTHING
//      (never a disguised ↑↓); a grid ALSO moves ←→ linearly and ↑↓ by row;
//      navigation SKIPS unavailable rows (clamp-don't-wrap, never loops);
//    · select-then-activate pointer parity: rowProps(row, i) feeds
//      InteractiveRow so a first click selects and the second click runs the
//      EXACT ↵ body — pointer and keyboard share one action path;
//    · row-typed actions: run(row) receives the ROW (the hidden-index class
//      is structurally impossible); `when(row)` gates availability and the
//      composed footer hint truthfully per selected row;
//    · unavailable rows — THE ONE AVAILABILITY POLICY (MINI-TEMPER item 5,
//      resolved deliberately): an unavailable row is NON-INTERACTIVE on every
//      channel and VISIBLY carries its explanation. Keyboard motion skips it,
//      select()/moveTo heal past it (the cursor can never REST on one by any
//      path), InteractiveRow strips its pointer handlers and hover paint,
//      rowActionHint contributes nothing — and the WHY is PAINT, not a dead
//      activation note: rowProps hands the row its reasonUnavailable and
//      InteractiveRow renders it as a dim inline annotation. (The pre-fix
//      contract promised an explanation on activation that no channel could
//      ever reach — keyboard skipped, pointer stripped.)
//    · the open-event gate: the launching keystroke's own event id is
//      filtered exactly once — the very next key acts (arrows/esc instant);
//    · overlay-stack esc: closes only as the TOP layer (one Esc = one layer).
//
//  ink-component-patterns: one useInput over shared state, no useFocus,
//  clamp-don't-wrap, gated with isActive so it never fights the REPL.
// ============================================================================

/** a probe-shaped action result: the pending note paints on the
 *  keypress and the probe returns through the event loop (a disk/process
 *  probe may never run synchronously in a keypress handler); only the LATEST
 *  action's resolution can land its note. */
export type AsyncListNote = { pending: string; result: Promise<string | null | undefined> }

export type ListAction<Row> = {
  /** The key that triggers it ('return' for ↵, 'backspace' for ⌫, or a char). */
  key: string
  /** Runs with the selected ROW — or null when the list is EMPTY, so a view's
   *  honest empty-state notes ("no realms yet — n starts trusting a folder")
   *  keep working. Returns a note to show (or null), or an AsyncListNote when
   *  the note depends on a probe. */
  run: (row: Row | null) => string | null | undefined | AsyncListNote
  /** Footer hint label (composed only while `when(selectedRow)` holds). */
  hint: string
  /** Per-row availability — absent means always available. */
  when?: (row: Row) => boolean
}

export type InteractiveListRowProps = {
  id: string
  selected: boolean
  unavailable: boolean
  /** The dead row's WHY — painted by InteractiveRow as a dim inline
   *  annotation (the ONE availability policy: explanation is visible paint,
   *  never an unreachable activation note). */
  reasonUnavailable?: string
  onSelect: () => void
  onActivate: () => void
}

export function useInteractiveList<Row>({
  rows,
  rowId,
  onClose,
  actions = [],
  active = true,
  initialId,
  unavailable,
  reasonUnavailable,
  idNamespace = 'list',
  orientation = 'vertical',
}: {
  rows: readonly Row[]
  /** Stable, data-derived id per row (never the index). */
  rowId: (row: Row) => string
  onClose: () => void
  actions?: ListAction<Row>[]
  active?: boolean
  /** Where the cursor starts (falls back to row 0 when absent/not found). */
  initialId?: string
  /** Marks a row inert (the ONE availability policy): every channel agrees —
   *  keyboard motion skips it, select()/moveTo heal past it, the pointer is
   *  stripped, no action hint — and the row VISIBLY carries its reason. */
  unavailable?: (row: Row) => boolean
  /** The visible WHY for an unavailable row — delivered through rowProps and
   *  PAINTED on the row (never an activation note nobody can reach). */
  reasonUnavailable?: (row: Row) => string
  /** Namespaces the InteractiveRow hover ids (`<ns>:row:<id>`). */
  idNamespace?: string
  /** The visible layout axis (navSemantics law). Default 'vertical' — ←→
   *  decode nothing. A wrapped card grid declares { grid: { columns } } so
   *  ←→ move linearly and ↑↓ move by row; 'horizontal' strips move on ←→. */
  orientation?: NavOrientation
}): {
  selectedIndex: number
  selectedRow: Row | null
  note: string | null
  ready: boolean
  hints: string | undefined
  /** The orientation-truthful motion glyphs ('↑↓' vertical · '←→' horizontal
   *  · '←→ ↑↓' grid) — footers project THIS, never a handwritten axis. */
  motionHint: string
  moveTo: (i: number) => void
  activate: (i: number) => void
  rowProps: (row: Row, i: number) => InteractiveListRowProps
} {
  const clampIndex = (i: number): number => Math.min(Math.max(0, i), Math.max(0, rows.length - 1))
  // Where the cursor OPENS: the seeded row — but never an unavailable one
  // heal to the first
  // available row. select() below heals every OTHER landing channel the same
  // way (one policy).
  const initialIndex = ((): number => {
    if (rows.length === 0) return 0
    let idx = initialId != null ? rows.findIndex(r => rowId(r) === initialId) : 0
    if (idx < 0) idx = 0
    if (unavailable && unavailable(rows[idx]!)) {
      const firstAvailable = rows.findIndex(r => !unavailable(r))
      if (firstAvailable >= 0) idx = firstAvailable
    }
    return idx
  })()
  // The identity-stable cursor core (useStableSelection): selection follows
  // the row's KEY across reorder/insert/remove; a vanished row falls to the
  // same clamped position.
  const stable = useStableSelection(rows, rowId, { initialIndex })
  const selectedIndex = stable.index
  const selectedRow = stable.selected
  // BATCH-SAFE motion (the stale-closure batch class): a burst of
  // motion keys inside ONE input batch must step once PER PRESS. The
  // handler's closure sees the same selectedIndex for every press of the
  // batch, so motion computes from this synchronously-updated ref instead —
  // select() advances it immediately and the render-derived value re-syncs
  // it each commit.
  const liveIndexRef = useRef(selectedIndex)
  liveIndexRef.current = selectedIndex
  const [note, setNote] = useState<string | null>(null)
  // Latest-action fence for AsyncListNote resolutions: any newer action or
  // selection move supersedes an in-flight probe's note.
  const noteSeqRef = useRef(0)
  // THE DOOR-IN-SWING GUARD (the ↵↵ double-fire class): while an
  // AsyncListNote's promise is unresolved, a repeated primary press is
  // DECLINED — an async door (a hop, a birth) swings once per gesture, never
  // once per queued ↵. The note's supersede (a selection move) never
  // releases the guard: only the swinging door's own resolution does, and
  // resolution releases either way — the ruled row-re-pressable RETRY (a
  // refused/failed door pressed again) stays exactly as it was.
  const pendingActionSeqRef = useRef<number | null>(null)
  const applyActionResult = (res: string | null | undefined | AsyncListNote): void => {
    const seq = ++noteSeqRef.current
    if (res != null && typeof res === 'object') {
      pendingActionSeqRef.current = seq
      setNote(res.pending)
      void res.result.then(
        resolved => {
          if (pendingActionSeqRef.current === seq) pendingActionSeqRef.current = null
          if (noteSeqRef.current === seq) setNote(resolved ?? null)
        },
        () => {
          if (pendingActionSeqRef.current === seq) pendingActionSeqRef.current = null
          if (noteSeqRef.current === seq) setNote(null)
        },
      )
      return
    }
    setNote(res ?? null)
  }

  const pastBuffer = useOpenEventGate()
  const ready = pastBuffer()
  const overlayToken = useRegisterOverlay('list', active)

  const isUnavailable = (row: Row): boolean => unavailable?.(row) ?? false

  const select = (i: number): void => {
    if (!active || rows.length === 0) return
    let idx = clampIndex(i)
    if (isUnavailable(rows[idx]!)) {
      // ONE availability policy: the cursor can never REST on an unavailable
      // row by ANY channel (keyboard already skips; this heals moveTo and
      // any programmatic landing the same way, or refuses when no available
      // row exists in that direction).
      const healed = skipDisabled(liveIndexRef.current, idx, rows.length, k => isUnavailable(rows[k]!))
      if (healed === idx || isUnavailable(rows[healed]!)) return
      idx = healed
    }
    stable.select(idx)
    liveIndexRef.current = idx
    noteSeqRef.current++
    setNote(null)
  }

  // The exact ↵ body — keyboard and pointer both land here. An unavailable
  // row never performs OR explains here: the cursor structurally cannot rest
  // on one (the guard is defense-in-depth, not a reachable channel — the row
  // wears its reason as PAINT via rowProps instead).
  const runPrimary = (row: Row | null): void => {
    if (pendingActionSeqRef.current !== null) return
    if (row != null && isUnavailable(row)) return
    const primary = actions.find(a => a.key === 'return' && (row == null || (a.when?.(row) ?? true)))
    if (primary) applyActionResult(primary.run(row))
  }

  const activate = (i: number): void => {
    if (!active || rows.length === 0) return
    const idx = clampIndex(i)
    select(idx)
    runPrimary(rows[idx])
  }

  useInput(
    (input, key, event) => {
      if (!active) return
      // The semantic decode under this surface's declared orientation — one
      // key, at most one meaning (navSemantics law). A key this surface ACTS
      // on is CONSUMED; a declined
      // key propagates untouched so lower-priority owners can see it.
      const action = decodeNavKey(input, key, { orientation })
      // esc + motion respond IMMEDIATELY — no ready-buffer wait.
      if (action === 'cancel') {
        // NOT the top layer: decline (never consume) — the top overlay owns esc.
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action !== null && action !== 'activate') {
        const target = applyNavMotion(action, liveIndexRef.current, rows.length, { orientation })
        if (target !== null) {
          event.stopImmediatePropagation()
          select(
            skipDisabled(liveIndexRef.current, target, rows.length, i =>
              isUnavailable(rows[i]),
            ),
          )
        }
        return
      }
      // Action keys wait out the launch gate so the opening keystroke is inert.
      // They fire even on an EMPTY list (row=null) — views surface honest
      // empty-state notes through their existing null-guards.
      if (!pastBuffer()) return
      // R7 C-MED-5 (the batch law): motion already steps through
      // liveIndexRef; the ACTION reads must ride the same synchronous cursor
      // or ↓↵ in one stdin chunk activates the pre-batch row (e.g. switching
      // the coordinator to the wrong model in the picker).
      const liveRow = rows[liveIndexRef.current] ?? selectedRow
      if (action === 'activate') {
        event.stopImmediatePropagation()
        runPrimary(liveRow)
        return
      }
      for (const a of actions) {
        if (
          (a.key === 'backspace' && (key.backspace || key.delete)) ||
          (a.key.length === 1 && input === a.key)
        ) {
          event.stopImmediatePropagation()
          // Defense-in-depth (one policy): the cursor cannot rest on an
          // unavailable row, and if it somehow did, the row acts on nothing.
          if (liveRow != null && isUnavailable(liveRow)) return
          if (liveRow != null && a.when && !a.when(liveRow)) return
          applyActionResult(a.run(liveRow))
          return
        }
      }
    },
    { isActive: active },
  )

  // Footer hints from the live action set, truthful for the SELECTED row —
  // an action gated off by when(row) contributes no hint. On an EMPTY list
  // every action still hints (they run with row=null and speak the honest
  // empty note). CommandCenter owns and appends the ` · esc close` tail;
  // undefined ⇒ its default footer.
  const hints =
    actions.length > 0
      ? actions
          .filter(a => selectedRow == null || (a.when?.(selectedRow) ?? true))
          .map(a => `${a.key === 'return' ? '↵' : a.key === 'backspace' ? '⌫' : a.key} ${a.hint}`)
          .join(' · ') || undefined
      : undefined

  const rowProps = (row: Row, i: number): InteractiveListRowProps => ({
    id: `${idNamespace}:row:${rowId(row)}`,
    selected: i === selectedIndex,
    unavailable: isUnavailable(row),
    // The visible WHY (one policy): InteractiveRow paints this dim inline —
    // the explanation channel is the row's own cells, reachable by looking.
    reasonUnavailable: isUnavailable(row) ? reasonUnavailable?.(row) : undefined,
    onSelect: () => select(i),
    onActivate: () => activate(i),
  })

  return {
    selectedIndex,
    selectedRow,
    note,
    ready,
    hints,
    motionHint:
      orientation === 'vertical' ? '↑↓' : orientation === 'horizontal' ? '←→' : '←→ ↑↓',
    moveTo: select,
    activate,
    rowProps,
  }
}

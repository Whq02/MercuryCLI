// MercuryModelPicker — dedicated /model surface (real Ink, interactive).
// Renders 1:1 with the prototype: round terracotta panel, single-column
// SelectRow-boxed rows, session-accent identity, honest current/gated. Model IDs
// are real, never themed. Read-only except ↵ switch → onSelect (wire to setMainLoopModel).
import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput } from '../ink.js'
import { fitMeasuredWindow, packLines, paneWindow, panelWidth as panelWidthFor, type PaneWindow } from './mercury-ui/geometry.js'
import { useModalOrTerminalSize } from '../context/modalContext.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
// modelPickerLayout retired: the picker is single-column now (SelectRow boxed-selected).
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { focusedOptionSupports1m, isProviderActionRow, stripContext1m, withContext1m } from '../utils/model/modelOptions.js'
import { has1mContext } from '../utils/context.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../utils/model/model.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { markTransitionEnd } from '../utils/observability/frictionStopwatch.js'
import { getContextWindowForModel } from '../utils/context.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { ProductLockup } from './mercury-ui/components.js'
import { GLYPH, padTo } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { modelPickerFooter, type ModelPickerFooterDoor } from '../utils/model/modelPickerFooter.js'
import { catalogueDoorFocus, catalogueDoorHeaderParts, composeCatalogueRows, type CatalogueDoorFacet } from '../utils/model/catalogueDoor.js'
import {
  parseGptModelId,
  gptDisplayPin,
  hasGptServedWindowSuffix,
  liveGptContextWindow,
  liveGptContextCeiling,
  stripGptServedWindowSuffix,
  withGptServedWindowSuffix,
} from '../services/providers/openai/openaiCatalogue.js'

/** Compact context-window label: 272_000 → '272k', 1_050_000 → '1.05M'.
 *  The ONE formatter for the picker's context column and its c-press notice
 *  (the /model wrapper bakes the column through it) — one quantity, one
 *  spelling, so the column and the answer line can never disagree. */
export const fmtCtx = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
    : `${Math.round(n / 1000)}k`
// Status spine fixed; identity (TERRA) is the live critter hue, read at render.
function bar(pct: number, width = 10): string {
  const f = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(f) + '░'.repeat(width - f)
}

/** One picker row. `ctx` is the baked column every row shows (the window ↵
 *  delivers untouched); `ctxBase`/`ctx1m` are the two window states a
 *  toggle-capable row carries so the focused row's column can follow the live
 *  `c` toggle — the column is the ONE per-row context display (an Anthropic
 *  1M pair AND a GPT served↔declared pair both ride it). `gatedReason` marks
 *  a visible-but-unavailable row (the owning resolver's answer): ↵ is
 *  refused and the reason rides the row copy instead of a flag hint.
 *  `expand` marks a CATALOGUE DOOR (an action row too): ↵ expands its
 *  group in place to the full live list behind a filter line; the open
 *  group's header row carries the same facet with `open` set. */
export type ModelChoice = { id: string; name: string; tag: string; ctx: string; ctxBase?: string; ctx1m?: string; group: string; gated?: boolean; enableFlag?: string; gatedReason?: string; /** A connect/attach ACTION row — never a model, never counted as one. */ action?: boolean; expand?: CatalogueDoorFacet }

type Props = {
  models: ModelChoice[]
  current?: string
  /** The context fill of the session-effective model; null = unknown (an
   *  em dash, never a fabricated 0%). */
  ctxPct?: number | null
  efforts?: string[]
  effort?: string
  onEffort?: (e: string) => void
  onSelect?: (id: string) => void
  onClose?: () => void
  /** One-line outcome/notice from the wrapper (catalogue refresh outcomes). */
  notice?: string
  /** a queued foreground switch: the NEXT model id (applies when
   *  the running turn settles). Renders the current→next header + the AMBER
   *  'next' row state. */
  pendingNext?: string
  /** Per-provider group heading detail: the
   *  signed-in state under each group heading, keyed by the group string —
   *  assembled by the wrapper from the owning auth/availability resolvers. */
  groupDetails?: Record<string, string>
  /** The account-slot switch: `s` on a row whose GROUP has
   *  a switchable two-slot pair flips the ACTIVE slot through the wrapper
   *  (the one switch owner writes the stores). Returns the receipt words
   *  for the notice line, or null where the move does not exist (the group
   *  detail only advertises `s` where it does — no dead-key answer owed). */
  onSlotSwitch?: (group: string) => string | null
  /** The catalogue door's full list: every live row of `group` as picker
   *  rows (the wrapper maps the owning catalogue's unbounded accessor
   *  through the same row mapping as the listed rows). Read once per
   *  expansion and per catalogue re-hand — never per keystroke. */
  expandRows?: (group: string) => ModelChoice[]
}

// (: the illustrative DEFAULT_MODELS fallback is DELETED —
// it advertised a speculative "Mythos" mode + stale tiers, one propless
// mount away from rendering. The one live mount (/model) passes the REAL
// model list from getModelOptions.)

export function MercuryModelPicker({ models: listed, current = 'opus-4-8', ctxPct = 62, efforts, effort, onEffort, onSelect, onClose, notice, pendingNext, groupDetails, onSlotSwitch, expandRows }: Props): React.ReactNode {
  // Friction stopwatch: the picker mounting lands the picker-open
  // transition (the /model dispatch marked the start).
  React.useEffect(() => {
    markTransitionEnd('picker-open')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Identity accent at render → a live /critter pick re-tints this panel.
  // (the accent paints the SELECTED row + identity lockup; the panel
  // border itself is structure.)
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  // ── THE CATALOGUE DOOR: two facts (which group is open, the filter text);
  // the visible rows DERIVE (catalogueDoor.ts): the listed rows with the
  // open group's top-N and door swapped for a header row + the filtered
  // full list. The full list is read from the wrapper once per expansion
  // (and again only when the catalogue re-hands the rows); a keystroke
  // re-filters that array — the snapshot is the source, nothing re-fetches.
  // The persisted GPT window choice rides the id as `[served]` dressing
  // row identity matching strips it so the
  // CURRENT dot lands on the row and the toggle re-opens showing its truth.
  const currentRow = stripGptServedWindowSuffix(current)
  const [expanded, setExpanded] = useState<string | null>(() => {
    // A current model that lives BEHIND a door (picked through it, or typed)
    // opens that door at mount, so the CURRENT dot lands on its row instead
    // of on nothing — the collapsed top-N cannot show it. Esc collapses.
    if (listed.some(m => m.id === currentRow)) return null
    for (const door of listed) {
      if (door.expand && (expandRows?.(door.expand.group) ?? []).some(m => m.id === currentRow)) return door.expand.group
    }
    return null
  })
  const [filter, setFilter] = useState('')
  const expandRowsRef = React.useRef(expandRows)
  expandRowsRef.current = expandRows
  const fullRows = React.useMemo(
    () => (expanded === null ? [] : (expandRowsRef.current?.(expanded) ?? [])),
    // `listed` is the re-hand signal: a catalogue epoch re-maps the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded, listed],
  )
  const models = React.useMemo(
    () => composeCatalogueRows(listed, expanded, filter, fullRows),
    [listed, expanded, filter, fullRows],
  )
  // Single-column panel, width clamped to the terminal (min(cols-2, 62)). The old
  // rail(50)+detail(52) side-by-side layout is retired — a flexDirection="row" pair
  // flex-shrank below its content width and wrapped raggedly on a narrow terminal
  // ("switch"/"esc close" orphaned on continuation lines). Now nothing wraps: the
  // panel clamps and the footer hint sheds its optional segments on a narrow width
  // (modelPickerFooter above; proved in prove-model-picker-layout.ts).
  const { columns: cols, rows: termRows } = useTerminalSize()
  // The panel width through the ONE geometry contract (cap 62 · edge reserve 2).
  const panelWidth = panelWidthFor(cols, { cap: 62, reserve: 2, min: 20 })
  // final-333 F2 (no clipped content beside free space): the name column
  // derives from the panel — the fixed 15 truncated 'Default (recom…' while
  // ~15 interior columns sat unused right of the ctx column.
  const nameW = Math.max(15, Math.min(30, panelWidth - 32))
  const totalRows = models.length
  // the picker rendered EVERY model row unwindowed — on a
  // short terminal the clipping modal slot cut rows/footer off screen. The
  // palette's cursor-following window (paneWindow) over the ONE combined
  // index space; reserve covers panel chrome (header · selected-row
  // expansion · group headers · context/effort/footer). Every row stays
  // reachable; the cut is NAMED by the ↑/↓ counters.
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: cols }).rows
  // COMPACT tier: below
  // ~20 rows the full chrome (banner · group headings · selected-row
  // expansion · blank margins) cannot fit a viewport, so it sheds IN THE
  // DEGRADATION ORDER — decoration and metadata go, the choose-a-model rows,
  // status truth, and the (shortened) footer stay.
  const compact = availRows < 20
  // ULTRA-compact (the 12-row class, degradation order: decoration
  // and METADATA go before choose-a-model rows or the closing border): a
  // grown catalogue paints BOTH window counters mid-list, and with the dock
  // rule + margins above the card the context METER row is the one row
  // between the card and its ╰ — shed it; the interactive effort row and
  // the (shortened) footer stay.
  const shedMeters = availRows < 13
  const startI = Math.max(0, models.findIndex(m => m.id === currentRow))
  const [cursor, setI] = useState(startI)
  // The cursor clamps to the composed rows: a catalogue re-hand or a filter
  // change can shrink the list under the remembered index, and every read
  // below (the focused row, the window, the footer) must land on a row.
  const i = Math.min(cursor, Math.max(0, totalRows - 1))
  const focusedModel = i < models.length ? models[i] : undefined
  const hasEffort = !!(efforts && efforts.length)
  const ei = hasEffort ? Math.max(0, efforts!.indexOf(effort ?? '')) : 0
  // 1M-context toggle (the `c` keybind): per-focused-model, only offered when the
  // focused row can carry a [1m] variant (family + per-tier access). Reset to the
  // focused row's own context state as the cursor moves so `c` toggles the truth.
  // The Default/current row carries the alias id 'default', which does NOT
  // canonicalize to a real model — resolve it to the concrete configured default
  // so the 1M-context toggle works on the current row too (Opus 4.8 1M ⇄ 200k).
  const probe = (m?: ModelChoice): string | null => m ? (m.id === 'default' ? getDefaultMainLoopModel() : m.id) : null
  // DEFAULT-1M (operator directive: "all models get 1m, fallback
  // only if not supported"): any row whose family carries a [1m] variant
  // defaults to it — `c` toggles DOWN to 200k instead of up.
  // Rows with no 1M variant (or natively-1M catalog models) show no toggle.
  // GPT rows carry the same DEFAULT-big polarity: a bare id budgets the
  // source-declared ceiling, so the toggle seeds BIG
  // unless the session's persisted id is THIS row opted down via `[served]`
  // — then it re-opens showing the served truth (persistence parity).
  const ctxStateOf = (p: string | null): boolean => {
    if (p !== null && parseGptModelId(p)) {
      return !(hasGptServedWindowSuffix(current) && stripGptServedWindowSuffix(current) === p)
    }
    return has1mContext(p ?? '') || focusedOptionSupports1m(p)
  }
  const focusedSupports1m = focusedOptionSupports1m(probe(focusedModel))
  const [context1m, setContext1m] = useState(ctxStateOf(probe(models[startI])))
  // GPT rows: `served` = the active
  // source's DEFAULT window; `ceiling` = the larger max the SAME source
  // declares, when it declares one. Where BOTH exist the row is a real
  // toggle — `c` cycles served ↔ declared max exactly like the Anthropic 1M
  // toggle, persisted on the id (`[served]` = the opt-down; bare = the item C
  // ceiling default) and honored by the one context-window resolver. Where
  // only one window exists there is nothing to toggle and `c` answers with
  // the source-truth law instead of dying silent.
  //
  // the row would otherwise compare `served` against the static display
  // pin and, when the pin was bigger, tell the operator an api-key source
  // would serve that larger window (pointing at the /router sign-in verb).
  // That was fabricated twice over: the pin is an API MODEL-PAGE fact, not an
  // observation of the api-key source (that catalogue is id-only, so Mercury
  // has never measured its window), and the named verb signs in the ChatGPT
  // SUBSCRIPTION — the very source being complained about. A live probe of a
  // ChatGPT Plus subscription confirms 272,000 is genuinely what the Codex
  // backend serves for Sol (it matches OpenAI's own Codex CLI, and equals
  // their published >272K long-context pricing boundary), so the row reports
  // only what the ACTIVE source states about itself.
  // Ratchet: scripts/model-routing/prove-gpt-context-window.ts fails on any
  // reintroduction of the retired copy — do not quote it verbatim here.
  const focusedGptWindow = ((): { served: number; ceiling?: number; observed?: string } | null => {
    const p = probe(focusedModel)
    if (!p || !parseGptModelId(p)) return null
    const live = liveGptContextWindow(p)
    const pin = gptDisplayPin(p)
    const served = live ?? pin?.contextWindow
    if (served === undefined) return null
    const ceiling = liveGptContextCeiling(p)
    return {
      served,
      ...(ceiling !== undefined && ceiling > served ? { ceiling } : {}),
      // Pin-derived (live truth absent): the figure is a dated observation,
      // and the notice below says so instead of wearing it as account truth.
      ...(live === undefined && pin?.observedAt !== undefined ? { observed: pin.observedAt } : {}),
    }
  })()
  // The in-place window toggle exists exactly when the source offers BOTH.
  const focusedGptToggle = focusedGptWindow?.ceiling !== undefined
  // ONE transient answer line for c-presses that cannot toggle (GPT
  // source-fixed / natively-1M rows) — renders in the notice slot below;
  // cleared on cursor move.
  const [ctxNotice, setCtxNotice] = useState<string | null>(null)
  // Natively-1M Anthropic rows (Opus 5, Sonnet 5 — the catalog serves 1M on
  // the bare id): no toggle EXISTS, but `c` must answer with that law
  // instead of dying silent.
  const focusedNative1m = ((): boolean => {
    const p = probe(focusedModel)
    if (!p || focusedSupports1m || focusedGptWindow) return false
    try {
      return getContextWindowForModel(parseUserSpecifiedModel(stripContext1m(p)) as never) >= 1_000_000
    } catch {
      return false
    }
  })()
  // Move the cursor to a row — shared by ↑↓ AND mouse click on a row. Reset the
  // 1M-context toggle to that row's own truth so `c` toggles from the honest state.
  const selectRow = (n: number): void => {
    setI(n)
    setCtxNotice(null)
    if (n < models.length) setContext1m(ctxStateOf(probe(models[n])))
  }
  // THE DOOR's three moves. Each recomposes the rows the way the render
  // will and lands the cursor from that composition (catalogueDoorFocus:
  // the first matching row, else the header line), so the focus and the
  // paint never disagree for a frame.
  const openDoor = (group: string): void => {
    const rows = composeCatalogueRows(listed, group, '', expandRowsRef.current?.(group) ?? [])
    setExpanded(group)
    setFilter('')
    setCtxNotice(null)
    setI(Math.max(0, catalogueDoorFocus(rows, group)))
  }
  const closeDoor = (): void => {
    if (expanded === null) return
    const group = expanded
    setExpanded(null)
    setFilter('')
    setCtxNotice(null)
    // Back on the door row it came from (the collapsed rows are the listed rows).
    setI(Math.max(0, listed.findIndex(m => m.expand?.group === group)))
  }
  const setDoorFilter = (text: string): void => {
    if (expanded === null) return
    const rows = composeCatalogueRows(listed, expanded, text, fullRows)
    setFilter(text)
    setI(Math.max(0, catalogueDoorFocus(rows, expanded)))
  }
  // The ONE ↵ body — keyboard return and a second pointer click both land
  // here (select-then-activate; InteractiveRow routes the activation).
  const commitCurrent = (): void => {
    const m = models[i]; if (!m) return
    // A catalogue door: ↵ opens it; ↵ on the open header collapses it.
    // Never a selection — the sentinel is never handed to onSelect.
    if (m.expand) {
      if (m.expand.open) closeDoor()
      else openDoor(m.expand.group)
      return
    }
    if (!onSelect) return
    if (m.gated) {
      // An unavailable row answers ↵ with the resolver's reason
      // and never selects; flag-gated rows keep the footer as their answer.
      if (m.gatedReason) setCtxNotice(`${m.gatedReason} — not selectable`)
      return
    }
    const p = probe(m)
    if (p && focusedOptionSupports1m(p)) {
      const base = stripContext1m(p)
      // Unchanged from the row's natural context → keep the row id (so 'default'
      // stays no-preference); else pin the explicit base model ± [1m].
      onSelect(context1m === has1mContext(p) ? m.id : (context1m ? withContext1m(base) : base))
    } else if (p && parseGptModelId(p) && focusedGptToggle) {
      // A toggle-capable GPT row commits its window choice ON the id — the
      // same id-borne persistence the [1m] rows ride: bare = the source-
      // declared max (the item C default), `[served]` = the explicit opt-down
      // onto the served default. The resolver honors it product-wide.
      onSelect(context1m ? m.id : withGptServedWindowSuffix(m.id))
    } else {
      onSelect(m.id)
    }
  }
  // ACTION keys (↵ select, `c` context flip) only past the
  // mount buffer: the picker opens off a typed "/model↵" — that submitting ↵
  // (or its terminal repeat) must never instantly act (idle-parked-commits /
  // STALE-PAINT arm). Arrows/esc stay immediate per the useOpenEventGate doctrine.
  const pastOpenEvent = useOpenEventGate()
  // Overlay-stack membership: esc closes ONE layer — a
  // surface stacked on the picker owns esc until it pops. TWO visible axes
  // decode separately (navSemantics): the rows are VERTICAL; the effort
  // slider is a HORIZONTAL control (←→ cycle it — never a row alias).
  const overlayToken = useRegisterOverlay('model-picker', true)
  useInput((input, key, event) => {
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical' })
    const effortAxis = decodeNavKey(input, key, { orientation: 'horizontal' })
    // THE FILTER LINE (a catalogue group open): letters narrow the group,
    // backspace widens it, esc clears a non-empty filter and otherwise
    // collapses the group — the picker's own close is one esc further, only
    // once nothing is open. This arm sits ahead of the letter-bound
    // actions (`c` context, `s` slot): while the door is open, a letter is
    // filter text (the footer says so). Arrows and ↵ fall through.
    if (expanded !== null) {
      if (key.backspace || key.delete) {
        event.stopImmediatePropagation()
        if (filter.length > 0) setDoorFilter(filter.slice(0, -1))
        return
      }
      if (rowAxis === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        if (filter.length > 0) setDoorFilter('')
        else closeDoor()
        return
      }
      if (rowAxis === null && effortAxis === null && input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
        event.stopImmediatePropagation()
        setDoorFilter(filter + input)
        return
      }
    }
    if (rowAxis === 'moveNext') { event.stopImmediatePropagation(); selectRow(Math.min(totalRows - 1, i + 1)) }
    else if (rowAxis === 'movePrevious') { event.stopImmediatePropagation(); selectRow(Math.max(0, i - 1)) }
    else if (rowAxis === 'first') { event.stopImmediatePropagation(); selectRow(0) }
    else if (rowAxis === 'last') { event.stopImmediatePropagation(); selectRow(totalRows - 1) }
    else if (effortAxis === 'moveLeft' && hasEffort) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei - 1 + efforts!.length) % efforts!.length]) }
    else if (effortAxis === 'moveRight' && hasEffort) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei + 1) % efforts!.length]) }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedOptionSupports1m(probe(focusedModel))) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setContext1m(v => !v)
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedGptWindow && focusedGptWindow.ceiling !== undefined) {
      // The GPT window TOGGLE: both windows
      // genuinely exist for the account, so `c` cycles served ↔ declared max
      // — same grammar as the Anthropic 1M toggle. The notice states which
      // window is active AND what the other is (honest in both states); ↵
      // persists the choice on the id through the one selection owner.
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      const big = !context1m
      setContext1m(big)
      setCtxNotice(
        big
          ? `${fmtCtx(focusedGptWindow.ceiling)} ctx active · the source-declared max (served default ${fmtCtx(focusedGptWindow.served)}) · c toggles`
          : `${fmtCtx(focusedGptWindow.served)} ctx active · the source's served default (declared max ${fmtCtx(focusedGptWindow.ceiling)}) · c toggles`,
      )
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedGptWindow) {
      // ONE window only — the account source states nothing larger, so there
      // is genuinely nothing to toggle; answer the press with the law (the
      // notice line) instead of silence. A pin-derived figure names
      // its observation date — it is a cached model-page fact, not the
      // account's live word.
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(
        focusedGptWindow.observed !== undefined
          ? `${fmtCtx(focusedGptWindow.served)} ctx · model-page figure as observed ${focusedGptWindow.observed} — the live account catalogue decides at dispatch · not a toggle`
          : `${fmtCtx(focusedGptWindow.served)} ctx · set by the GPT account source · not a toggle`,
      )
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedNative1m) {
      // A natively-1M row serves 1M on its bare id — nothing to toggle; the
      // notice line answers the press (never a silent dead key).
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice('1M ctx · native to this model · not a toggle')
    }
    else if (input === 's' && !key.ctrl && !key.meta && onSlotSwitch && focusedModel) {
      // The account-slot switch: the wrapper owns the flip and the words;
      // a group with no switchable pair answers null and the press stays
      // unclaimed (the affordance is only advertised where the pair is).
      if (!pastOpenEvent()) return
      const receipt = onSlotSwitch(focusedModel.group)
      if (receipt !== null) {
        event.stopImmediatePropagation()
        setCtxNotice(receipt)
      }
    }
    else if (rowAxis === 'activate') {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      commitCurrent()
    }
    else if (rowAxis === 'cancel') {
      if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
      event.stopImmediatePropagation()
      onClose?.()
    }
  })
  // ── THE MEASURED WINDOW (the tail-clip law: the focused row is FULLY
  // visible at every list position, expansion included). Rows PAINT
  // variable heights — the focused card expands by its border and detail
  // lines, every group boundary paints a heading block — so an index-span
  // window could fit by COUNT while its paint overflowed the modal slot,
  // which bottom-clipped exactly the focused card at the tail. The window now
  // shrinks (fitMeasuredWindow, one row per step) until its measured paint
  // fits the real budget. The measure below IS the render's paint law,
  // kept beside it — a row added to the render grows here too.
  const rowPaint = (idx: number): number => {
    if (compact) return 1
    // The open door's header row is the cursor's anchor only — its paint is
    // the sticky filter line in the group's heading block (headingPaint).
    if (models[idx]?.expand?.open) return 0
    // Focused model card: border 2 + row 1 (+ tag 1 when the row has one —
    // model rows carry no tag under the neutrality ruling; action/Default
    // rows still do).
    return idx === i ? (models[idx]?.tag ? 4 : 3) : 1
  }
  // A group's detail line wraps by WHOLE ' · ' segments to the panel's inner
  // width (border 2 + paddingX 2): a provider's frontier fact, its date and
  // its sign-in state each read complete, where one truncate-end row cut the
  // last unit mid-phrase ("no OpenAI account — …"). The row budget below
  // pays exactly the lines this map holds.
  const detailLines = new Map<string, string[]>()
  for (const [g, detail] of Object.entries(groupDetails ?? {})) {
    detailLines.set(g, packLines(detail.split(' · '), panelWidth - 4))
  }
  const headingPaint = (w: PaneWindow): number => {
    let lines = 0
    // The first visible model row always re-paints its group heading
    // (lastGroup resets each render); later rows only on boundaries. The
    // open door's filter line rides the heading block (one line, compact
    // included); the title + detail lines are full-mode paint.
    let prev: string | undefined
    for (let idx = w.start; idx < Math.min(w.end, models.length); idx++) {
      const g = models[idx]!.group
      if (g !== prev) {
        if (!compact) lines += 2 + (detailLines.get(g)?.length ?? 0)
        if (expanded === g) lines += 1
      }
      prev = g
    }
    return lines
  }
  // The TRUE fixed chrome (the render outside the windowed rows): border 2
  // + lockup 1 + [CHOOSE 1] + [meter block] + effort 1 + [id block 2] +
  // footer 1, plus the dynamic pendingNext line and the notice slot.
  const basePaint =
    (compact ? (shedMeters ? 5 : 6) : 10) +
    (pendingNext ? 1 : 0) +
    (!compact && ctxNotice ? 2 : !compact && notice ? 1 : 0)
  const paintBudget = Math.max(3, availRows - basePaint)
  const win = fitMeasuredWindow(
    totalRows,
    paintBudget,
    span => paneWindow(totalRows, i, span),
    w => {
      let lines = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0) + headingPaint(w)
      for (let idx = w.start; idx < w.end; idx++) lines += rowPaint(idx)
      return lines
    },
  )
  let lastGroup: string | null = null
  // THE OPEN DOOR's header, resolved once per render: the header row's index
  // (the cursor's anchor) and the sentence parts the sticky filter line
  // paints around the live filter text.
  const doorHeaderIndex = expanded === null ? -1 : models.findIndex(m => m.expand?.open === true)
  const doorHeader = doorHeaderIndex === -1 ? undefined : { index: doorHeaderIndex, id: models[doorHeaderIndex]!.id, parts: catalogueDoorHeaderParts(models[doorHeaderIndex]!.expand!) }
  const footerDoor: ModelPickerFooterDoor | undefined =
    expanded !== null
      ? { open: true, onHeader: focusedModel?.expand?.open === true, filtering: filter.length > 0 }
      : focusedModel?.expand
        ? { open: false }
        : undefined
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={panelWidth} flexShrink={0}>
      {/* the shared product lockup — the same classified
          owner /manager renders; the old hand-composed flat-accent line was
          the D4 imitation. */}
      <ProductLockup view="model" />
      {/* The banner's AVAILABLE count is the SELECTABLE model rows — gated
          rows and connect/attach action rows are never counted as available
          (the count once read every row). */}
      {compact ? null : <Text color={FAINT}>CHOOSE A MODEL · {models.filter(m => !m.gated && !m.action).length} AVAILABLE · {models.filter(m => m.gated).length} GATED</Text>}
      {pendingNext ? (
        <Text>
          <Text color={FAINT}>current </Text>
          <Text color={TEAL}>{models.find(m => m.id === currentRow)?.name ?? current}</Text>
          <Text color={AMBER}>{` ${GLYPH.pending} next `}</Text>
          <Text color={AMBER}>{models.find(m => m.id === pendingNext)?.name ?? pendingNext}</Text>
          <Text color={FAINT}> · applies when the turn settles</Text>
        </Text>
      ) : null}
      {win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} more</Text> : null}
      {models.map((m, idx) => {
        if (idx < win.start || idx >= win.end) return null
        const head = m.group !== lastGroup; lastGroup = m.group
        const on = idx === i; const cur = m.id === currentRow
        const isNext = pendingNext !== undefined && m.id === pendingNext
        // 'unavail' = the resolver refuses this row for THIS account (the
        // reason rides the row copy); 'gated' keeps its flag-gate meaning;
        // 'expand' is the catalogue door's own word (↵ opens, never switches).
        const [sg, sw, sc] = cur ? [GLYPH.done, 'current', TEAL] as const : isNext ? [GLYPH.pending, 'next', AMBER] as const : m.expand ? [GLYPH.pending, 'expand', FAINT] as const : m.gated ? [GLYPH.fisheye, m.gatedReason ? 'unavail' : 'gated', AMBER] as const : [GLYPH.pending, 'switch', FAINT] as const
        // THE OPEN DOOR's filter line is STICKY: it rides the group's heading
        // block, so it paints wherever the open group's first visible row is
        // — a walk deep into 400 rows never scrolls it out of view, and a
        // filter that matches nothing keeps it (the header row alone remains
        // in the group). Family · live count · the filter text with the
        // caret · the way out; the header row is its focus anchor, so the
        // line shows the pointer + accent when the cursor sits there, and a
        // click or ↵ on it lands on that row (collapse). Compact keeps this
        // line (it is functional) and sheds the title + detail (decoration).
        const doorLine = head && doorHeader !== undefined && expanded === m.group ? ((): React.ReactNode => {
          const onHeader = i === doorHeader.index
          return (
            <InteractiveRow id={`model:row:${doorHeader.id}`} selected={onHeader} onSelect={() => selectRow(doorHeader.index)} onActivate={commitCurrent} flexDirection="column" selectionBand={compact}>
              <Text wrap="truncate-end">
                <Text color={onHeader ? TERRA : FAINT}>{onHeader ? `${figures.pointer} ` : '  '}</Text>
                <Text color={tokens.info}>{doorHeader.parts.lead}</Text>
                <Text bold color={IVORY}>{filter}</Text>
                <Text color={onHeader ? TERRA : FAINT}>{GLYPH.caretBlock}</Text>
                <Text color={FAINT}>{doorHeader.parts.tail}</Text>
              </Text>
            </InteractiveRow>
          )
        })() : null
        // Group headings are informational: the info channel — the CURRENT
        // card + selected row keep the accent/state paint. The provider's
        // signed-in state (wrapper-resolved) rides a faint detail line under
        // its heading — one grammar, each provider's account truth visible
        // in place. The open door's filter line closes the block.
        const heading = head && (!compact || doorLine !== null) ? <Box marginTop={compact ? 0 : 1} flexDirection="column">
          {compact ? null : <Text bold color={tokens.info}>{m.group.toUpperCase()}</Text>}
          {compact ? null : detailLines.get(m.group)?.map((line, k) => (
            <Text key={k} color={FAINT} wrap="truncate-end">{line}</Text>
          ))}
          {doorLine}
        </Box> : null
        if (m.expand?.open) {
          // The header row paints nothing of its own (rowPaint 0): the
          // sticky line above IS its paint, wherever the window starts.
          return <React.Fragment key={m.id}>{heading}</React.Fragment>
        }
        return (
          <React.Fragment key={m.id}>
            {heading}
            <InteractiveRow
              id={`model:row:${m.id}`}
              selected={on}
              unavailable={m.gated}
              onSelect={() => selectRow(idx)}
              onActivate={commitCurrent}
              flexDirection="column"
              // ONE RECTANGLE (supplement class 2): in full mode the TERRA-
              // bordered card IS the selection speech — the row's band fill
              // painted a SECOND competing rectangle past the card's rounded
              // corners (the operator's /model capture). The band speaks
              // only in compact, where the row fills exactly its interior.
              selectionBand={compact}
            >
            <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
              {/* truncate-end (CN-14 law 7): a wide ctx tail ('200k ctx') on a
                  narrow panel truncates with … — it must never WRAP the row
                  and push the card's border past the viewport (the hosted
                  grid at 45×12 caught exactly that: gate run 30678717139). */}
              <Text wrap="truncate-end">
                {/* Compact (CN-14 law 6): the selected border simplifies to
                    the caret — decoration sheds, the selected STATE stays. */}
                {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
                <Text bold color={m.gated ? SAND : IVORY}>{padTo(m.name, nameW)}</Text>
                <Text color={sc}>{' ' + padTo(`${sg} ${sw}`, 11)}</Text>
                {/* The ONE per-row context display: the focused toggle-capable
                  * row (Anthropic 1M OR GPT served↔declared) follows the live
                  * `c` state (the c affordance lives in the footer); every
                  * other row shows the baked window ↵ delivers. */}
                <Text color={FAINT}>{on && (focusedSupports1m || focusedGptToggle) ? (context1m ? (m.ctx1m ?? m.ctx) : (m.ctxBase ?? m.ctx)) : m.ctx}</Text>
              </Text>
              {on && !compact && m.tag !== '' ? <Text color={SAND}>{m.tag}</Text> : null}
            </Box>
            </InteractiveRow>
          </React.Fragment>
        )
      })}
      {win.below > 0 ? <Text color={FAINT}>  ↓ {win.below} more</Text> : null}
      {shedMeters ? null : <Box marginTop={compact ? 0 : 1}>
        {/* Tier law: the tier words come from the ONE active-source owner
            (activeSourceUsage — real plan/tier/billing facts, absent only
            when nothing is logged in); this row never invents a tier. */}
        <Text wrap="truncate-end"><Text color={FAINT}>context </Text>{ctxPct === null ? <Text color={FAINT}>—</Text> : <><Text color={gaugeColor(ctxPct)}>{bar(ctxPct, 12)}</Text><Text color={SAND}> {ctxPct}%</Text></>}{((): React.ReactNode => {
          if (compact) return null
          const tier = activeSourceUsage().tier
          return tier ? <Text><Text color={FAINT}>  · tier </Text><Text color={IVORY}>{tier}</Text></Text> : null
        })()}</Text>
      </Box>}
      {hasEffort ? (
        compact ? (
          // Compact (CN-14 law 5): the full ladder is optional metadata on a
          // tiny viewport — the ACTIVE effort + the cycle keys stay.
          <Text wrap="truncate-end">
            <Text color={FAINT}>effort  </Text>
            <Text bold color={TERRA}>[{effort}]</Text>
            <Text color={FAINT}> ←→ cycle</Text>
          </Text>
        ) : (
          <Text>
            <Text color={FAINT}>effort  </Text>
            {efforts!.map(e => (
              <Text key={e} bold={e === effort} color={e === effort ? TERRA : FAINT}>
                {e === effort ? `[${e}] ` : `${e} `}
              </Text>
            ))}
          </Text>
        )
      ) : null}
      {/* The c-press answer outranks the last wrapper notice until the cursor
          moves; it WRAPS (the panel caps at 62 wide and the ceiling variant
          runs long) so 'not a toggle' is never truncated away. */}
      {ctxNotice && !compact ? (
        <Text color={tokens.info} wrap="wrap">{ctxNotice}</Text>
      ) : notice && !compact ? (
        <Text color={tokens.info} wrap="truncate-end">{notice}</Text>
      ) : null}
      {/* ↵ is a no-op on a gated row (handler returns early), so the footer
          only advertises "↵ switch" when the focused row is selectable. */}
      <Box marginTop={compact ? 0 : 1} display={compact ? 'none' : 'flex'}>
        <Text color={FAINT} wrap="truncate-end">
          {/* FC-128: connect/attach rows are ACTIONS whose value is an
              internal sentinel — printing it as a model id put
              __mercury_anthropic_connect__ beside the ids-are-real
              promise. The catalogue door speaks its own action first:
              closed, what ↵ opens; open, how many rows the filter left. */}
          {focusedModel!.expand
            ? focusedModel!.expand.open
              ? `${models.filter(m => m.group === expanded && !m.action).length} of ${focusedModel!.expand.total} live rows${filter.length > 0 ? ` match "${filter}"` : ''} · ↵ here collapses; not a model`
              : `catalogue door — ↵ expands the group to all ${focusedModel!.expand.total} live rows; not a model`
            : isProviderActionRow(focusedModel!.id)
            ? 'connect action — ↵ starts the sign-in; not a model'
            : focusedModel!.gated
              ? focusedModel!.gatedReason
                ? `${focusedModel!.id} · ${focusedModel!.gatedReason} — not selectable`
                : `gated — set ${focusedModel!.enableFlag ?? focusedModel!.ctx} to enable. Never shown as live.`
              : `${focusedModel!.id} · model IDs are real, never themed`}
        </Text>
      </Box>
      {/* `supports1m` here means "the focused row has an in-place c context
        * toggle" — the Anthropic 1M pair and the GPT served↔declared pair
        * share the one affordance word. `door` states the catalogue door's
        * keys: ↵ expand on a closed door; type to filter · esc clear /
        * collapse while a group is open. */}
      <Text color={FAINT} wrap="truncate-end">{modelPickerFooter({ hasEffort, supports1m: focusedSupports1m || focusedGptToggle, gated: !!focusedModel?.gated, enableFlag: focusedModel?.enableFlag, ...(footerDoor !== undefined ? { door: footerDoor } : {}) }, panelWidth - 4)}</Text>
    </Box>
  )
}

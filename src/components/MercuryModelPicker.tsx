// MercuryModelPicker — dedicated /model surface (real Ink, interactive).
// Renders 1:1 with the prototype: round terracotta panel, single-column
// SelectRow-boxed rows, session-accent identity, honest current/gated. Model IDs
// are real, never themed. Read-only except ↵ switch → onSelect (wire to setMainLoopModel).
//
// an optional ROLES section — the role-seat slots (scribe ·
// implementer · party seats). Role rows share the ONE vertical selection space;
// their edit grammar mirrors the /party board (m cycles model · +/− steps
// effort), applied by the WRAPPER through the ONE reslot seam
// (applyOperatorReslot → seatSlots). Cells show DISPLAY TRUTH (running/live vs
// next-engage resolution) with a queued retarget as the AMBER pending arrow;
// env-pinned axes render LOCKED with the pinning var NAMED (the env-pin
// override-origin lesson).
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
import { SCRIBE_ROUTER_OPTION_VALUE } from '../utils/scribeMode.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { ProductLockup } from './mercury-ui/components.js'
import { GLYPH, padTo } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { modelPickerFooter } from '../utils/model/modelPickerFooter.js'
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
 *  refused and the reason rides the row copy instead of a flag hint. */
export type ModelChoice = { id: string; name: string; tag: string; ctx: string; ctxBase?: string; ctx1m?: string; group: string; gated?: boolean; enableFlag?: string; gatedReason?: string; /** A connect/attach ACTION row — never a model, never counted as one. */ action?: boolean }

/** One ROLES row — display truth assembled by the wrapper (live seat truth
 *  when engaged; the resolver's next-engage resolution otherwise). */
export type RoleChoice = {
  role: string
  /** e.g. 'scribe · front' */
  label: string
  model: string
  effort: string
  /** The SELECTED model's own effort ladder (effort.ts truth) — an empty
   *  ladder means the model has no effort dial and the row shows none;
   *  absent = unknown (legacy wrappers), display unchanged. */
  efforts?: string[]
  /** Queued retarget (running ≠ requested) — the AMBER pending arrow. */
  pendingModel?: string
  pendingEffort?: string
  /** Env var pinning the axis this session (LOCKED — named, not editable). */
  modelLockedBy?: string
  effortLockedBy?: string
  /** 'live' (a running/engaged seat) vs 'next engage' (resolution only). */
  live: boolean
  /** Origin detail for the selected row's tag line (provenance honesty). */
  originDetail: string
  /** GPT seat state line: honest per-seat availability —
   *  "gpt: disabled — <reason>" / the qualified ids / the active slot.
   *  Absent on orchestration seats (tank/healer — the false-title class). */
  gptDetail?: string
  /** True when `g` slots a qualified gpt id on this seat (the wrapper routes
   *  it through setOperatorSeatSlot — never part of the m-cycle). */
  gptEligible?: boolean
}

export type RoleAction = 'model' | 'effort-up' | 'effort-down' | 'hint' | 'gpt'

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
  /** ROLES section. */
  roles?: RoleChoice[]
  onRoleAction?: (role: string, action: RoleAction) => void
  /** One-line outcome/notice from the last role action (wrapper-owned). */
  roleNotice?: string
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
}

// (: the illustrative DEFAULT_MODELS fallback is DELETED —
// it advertised a speculative "Mythos" mode + stale tiers, one propless
// mount away from rendering. The one live mount (/model) passes the REAL
// model list from getModelOptions.)

export function MercuryModelPicker({ models, current = 'opus-4-8', ctxPct = 62, efforts, effort, onEffort, onSelect, onClose, roles, onRoleAction, roleNotice, pendingNext, groupDetails, onSlotSwitch }: Props): React.ReactNode {
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
  // ONE vertical selection space: model rows first, then role rows.
  const roleRows = roles ?? []
  const totalRows = models.length + roleRows.length
  // the picker rendered EVERY model + role row unwindowed — on a
  // short terminal the clipping modal slot cut roles/footer off screen. The
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
  // The persisted GPT window choice rides the id as `[served]` dressing
  // row identity matching strips it so the
  // CURRENT dot lands on the row and the toggle re-opens showing its truth.
  const currentRow = stripGptServedWindowSuffix(current)
  const startI = Math.max(0, models.findIndex(m => m.id === currentRow))
  const [i, setI] = useState(startI)
  const focusedModel = i < models.length ? models[i] : undefined
  const focusedRole = i >= models.length ? roleRows[i - models.length] : undefined
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
  // only if not supported"): the router sentinel defaults 1M (scribe pin is
  // opus[1m]), and any row whose family carries a
  // [1m] variant defaults to it — `c` toggles DOWN to 200k instead of up.
  // Rows with no 1M variant (or natively-1M catalog models) show no toggle.
  // GPT rows carry the same DEFAULT-big polarity: a bare id budgets the
  // source-declared ceiling, so the toggle seeds BIG
  // unless the session's persisted id is THIS row opted down via `[served]`
  // — then it re-opens showing the served truth (persistence parity).
  const ctxStateOf = (p: string | null): boolean => {
    if (p === SCRIBE_ROUTER_OPTION_VALUE) return true
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
  // source-fixed / natively-1M rows) — renders in the roleNotice slot below;
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
  // The ONE ↵ body — keyboard return and a second pointer click both land
  // here (select-then-activate; InteractiveRow routes the activation).
  const commitCurrent = (): void => {
    if (focusedRole) {
      // Role rows don't "switch" — ↵ answers with the edit grammar (never a
      // silent dead key; the rule).
      onRoleAction?.(focusedRole.role, 'hint')
      return
    }
    const m = models[i]; if (!m || !onSelect) return
    if (m.gated) {
      // An unavailable row answers ↵ with the resolver's reason
      // and never selects; flag-gated rows keep the footer as their answer.
      if (m.gatedReason) setCtxNotice(`${m.gatedReason} — not selectable`)
      return
    }
    const p = probe(m)
    if (p === SCRIBE_ROUTER_OPTION_VALUE) {
      // The router engages scribe (handleScribeRouterSelect); ride the 1M toggle:
      // [1m] ⇒ 1M (default), bare ⇒ 200k.
      onSelect(context1m ? withContext1m(SCRIBE_ROUTER_OPTION_VALUE) : SCRIBE_ROUTER_OPTION_VALUE)
    } else if (p && focusedOptionSupports1m(p)) {
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
  // ACTION keys (↵ select, `c` context flip, the role edit keys) only past the
  // mount buffer: the picker opens off a typed "/model↵" — that submitting ↵
  // (or its terminal repeat) must never instantly act (idle-parked-commits /
  // STALE-PAINT arm). Arrows/esc stay immediate per the useOpenEventGate doctrine.
  const pastOpenEvent = useOpenEventGate()
  // Overlay-stack membership: esc closes ONE layer — a
  // surface stacked on the picker owns esc until it pops. TWO visible axes
  // decode separately (navSemantics): the rows are VERTICAL; the effort
  // slider is a HORIZONTAL control (←→ cycle it — never a row alias). On a
  // focused ROLE row ←→ is DECLINED (the role's effort steps ride +/− per the
  // footer) so the global slider can't masquerade as a per-seat edit.
  const overlayToken = useRegisterOverlay('model-picker', true)
  useInput((input, key, event) => {
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical' })
    const effortAxis = decodeNavKey(input, key, { orientation: 'horizontal' })
    if (rowAxis === 'moveNext') { event.stopImmediatePropagation(); selectRow(Math.min(totalRows - 1, i + 1)) }
    else if (rowAxis === 'movePrevious') { event.stopImmediatePropagation(); selectRow(Math.max(0, i - 1)) }
    else if (rowAxis === 'first') { event.stopImmediatePropagation(); selectRow(0) }
    else if (rowAxis === 'last') { event.stopImmediatePropagation(); selectRow(totalRows - 1) }
    else if (effortAxis === 'moveLeft' && hasEffort && !focusedRole) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei - 1 + efforts!.length) % efforts!.length]) }
    else if (effortAxis === 'moveRight' && hasEffort && !focusedRole) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei + 1) % efforts!.length]) }
    else if (input === 'c' && !key.ctrl && !key.meta && !focusedRole && focusedOptionSupports1m(probe(focusedModel))) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setContext1m(v => !v)
    }
    else if (input === 'c' && !key.ctrl && !key.meta && !focusedRole && focusedGptWindow && focusedGptWindow.ceiling !== undefined) {
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
    else if (input === 'c' && !key.ctrl && !key.meta && !focusedRole && focusedGptWindow) {
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
    else if (input === 'c' && !key.ctrl && !key.meta && !focusedRole && focusedNative1m) {
      // A natively-1M row serves 1M on its bare id — nothing to toggle; the
      // notice line answers the press (never a silent dead key).
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice('1M ctx · native to this model · not a toggle')
    }
    else if (focusedRole && (input === 'm' || input === '+' || input === '=' || input === '-')) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      onRoleAction?.(
        focusedRole.role,
        input === 'm' ? 'model' : input === '-' ? 'effort-down' : 'effort-up',
      )
    }
    else if (input === 's' && !key.ctrl && !key.meta && !focusedRole && onSlotSwitch && focusedModel) {
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
    else if (focusedRole && input === 'g') {
      // GPT slotting is its OWN explicit keypress: never part of
      // the m-cycle. The wrapper answers every press — an ineligible or
      // disabled seat gets the honest reason, an eligible
      // one slots the next qualified id through setOperatorSeatSlot.
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      onRoleAction?.(focusedRole.role, 'gpt')
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
  // lines, every group boundary paints a heading block, and the ROLES
  // section brings its own — so an index-span window could fit by COUNT
  // while its paint overflowed the modal slot, which bottom-clipped exactly
  // the focused card at the tail (the seat-slot rows). The window now
  // shrinks (fitMeasuredWindow, one row per step) until its measured paint
  // fits the real budget. The measure below IS the render's paint law,
  // kept beside it — a row added to the render grows here too.
  const rowPaint = (idx: number): number => {
    const on = idx === i
    if (idx >= models.length) {
      const r = roleRows[idx - models.length]
      if (!r) return 1
      const queued = on && (r.pendingModel !== undefined || r.pendingEffort !== undefined) ? 1 : 0
      if (compact) return 1 + queued
      // Focused role card: border 2 + row 1 + origin line 1 (+ gpt detail).
      return on ? 4 + (r.gptDetail ? 1 : 0) + queued : 1
    }
    if (compact) return 1
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
    if (!compact) {
      // The first visible model row always re-paints its group heading
      // (lastGroup resets each render); later rows only on boundaries.
      let prev: string | undefined
      for (let idx = w.start; idx < Math.min(w.end, models.length); idx++) {
        const g = models[idx]!.group
        if (g !== prev) lines += 2 + (detailLines.get(g)?.length ?? 0)
        prev = g
      }
    }
    if (w.end > models.length && roleRows.length > 0) lines += compact ? 1 : 2
    return lines
  }
  // The TRUE fixed chrome (the render outside the windowed rows): border 2
  // + lockup 1 + [CHOOSE 1] + [meter block] + effort 1 + [id block 2] +
  // footer 1, plus the dynamic pendingNext line and the notice slot.
  const basePaint =
    (compact ? (shedMeters ? 5 : 6) : 10) +
    (pendingNext ? 1 : 0) +
    (!compact && ctxNotice ? 2 : !compact && roleNotice ? 1 : 0)
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={panelWidth} flexShrink={0}>
      {/* the shared product lockup — the same classified
          owner /manager renders; the old hand-composed flat-accent line was
          the D4 imitation. */}
      <ProductLockup view="model" />
      {/* The banner's AVAILABLE count is the SELECTABLE model rows — gated
          rows and connect/attach action rows are never counted as available
          (the count once read every row). */}
      {compact ? null : <Text color={FAINT}>CHOOSE A MODEL · {models.filter(m => !m.gated && !m.action).length} AVAILABLE · {models.filter(m => m.gated).length} GATED{roleRows.length ? ` · ${roleRows.length} ROLE SEATS` : ''}</Text>}
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
        // reason rides the row copy); 'gated' keeps its flag-gate meaning.
        const [sg, sw, sc] = cur ? [GLYPH.done, 'current', TEAL] as const : isNext ? [GLYPH.pending, 'next', AMBER] as const : m.gated ? [GLYPH.fisheye, m.gatedReason ? 'unavail' : 'gated', AMBER] as const : [GLYPH.pending, 'switch', FAINT] as const
        return (
          <React.Fragment key={m.id}>
            {/* Group headings are informational: the info channel —
                the CURRENT card + selected row keep the accent/state paint.
                The provider's signed-in state (wrapper-resolved) rides a
                faint detail line under its heading — one grammar, each
                provider's account truth visible in place. */}
            {head && !compact ? <Box marginTop={1} flexDirection="column">
              <Text bold color={tokens.info}>{m.group.toUpperCase()}</Text>
              {detailLines.get(m.group)?.map((line, k) => (
                <Text key={k} color={FAINT} wrap="truncate-end">{line}</Text>
              ))}
            </Box> : null}
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
      {roleRows.length > 0 && win.end > models.length ? (
        <Box marginTop={compact ? 0 : 1}><Text bold color={tokens.info}>ROLES — SEAT SLOTS</Text></Box>
      ) : null}
      {roleRows.map((r, ri) => {
        const idx = models.length + ri
        if (idx < win.start || idx >= win.end) return null
        const on = idx === i
        const lockedNames = [...new Set([r.modelLockedBy, r.effortLockedBy].filter(Boolean))] as string[]
        return (
          <InteractiveRow
            key={`role:${r.role}`}
            id={`model:role:${r.role}`}
            selected={on}
            onSelect={() => selectRow(idx)}
            onActivate={commitCurrent}
            flexDirection="column"
            // ONE RECTANGLE (class 2): border-card selection in full mode,
            // band-in-interior in compact — see the model rows above.
            selectionBand={compact}
          >
            <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
              <Text wrap="truncate-end">
                {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
                <Text bold color={IVORY}>{padTo(r.label, nameW)}</Text>
                <Text color={SAND}> {r.model}</Text>
                {r.pendingModel ? <Text color={AMBER}>{` →${r.pendingModel}`}</Text> : null}
                {r.efforts === undefined || r.efforts.length > 0 ? (
                  <Text color={FAINT}> @{r.effort}</Text>
                ) : (
                  <Text color={FAINT}> · no effort dial</Text>
                )}
                {r.pendingEffort ? <Text color={AMBER}>{` →@${r.pendingEffort}`}</Text> : null}
                <Text color={r.live ? TEAL : FAINT}>{`  ${r.live ? 'live' : 'next engage'}`}</Text>
              </Text>
              {on && !compact ? (
                <Text wrap="truncate-end">
                  <Text color={SAND}>{r.originDetail}</Text>
                  {lockedNames.length ? (
                    <Text color={AMBER}>{` · locked · ${lockedNames.join(' + ')}`}</Text>
                  ) : null}
                </Text>
              ) : null}
              {on && !compact && r.gptDetail ? (
                <Text color={FAINT} wrap="truncate-end">{r.gptDetail}</Text>
              ) : null}
              {on && (r.pendingModel || r.pendingEffort) ? (
                <Text color={AMBER}>queued — applies at turn end</Text>
              ) : null}
            </Box>
          </InteractiveRow>
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
      {/* The c-press answer outranks the last role notice until the cursor
          moves; it WRAPS (the panel caps at 62 wide and the ceiling variant
          runs long) so 'not a toggle' is never truncated away. */}
      {ctxNotice && !compact ? (
        <Text color={tokens.info} wrap="wrap">{ctxNotice}</Text>
      ) : roleNotice && !compact ? (
        <Text color={tokens.info} wrap="truncate-end">{roleNotice}</Text>
      ) : null}
      {/* ↵ is a no-op on a gated row (handler returns early), so the footer
          only advertises "↵ switch" when the focused row is selectable. */}
      <Box marginTop={compact ? 0 : 1} display={compact ? 'none' : 'flex'}>
        <Text color={FAINT} wrap="truncate-end">
          {focusedRole
            ? `${focusedRole.role} seat slot · precedence: env pin > saved slot > ratified default`
            : /* FC-128: connect/attach rows are ACTIONS whose value is an
                 internal sentinel — printing it as a model id put
                 __mercury_anthropic_connect__ beside the ids-are-real
                 promise. */
              isProviderActionRow(focusedModel!.id)
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
        * share the one affordance word. */}
      <Text color={FAINT} wrap="truncate-end">{modelPickerFooter({ hasEffort, supports1m: focusedSupports1m || focusedGptToggle, gated: !!focusedModel?.gated, enableFlag: focusedModel?.enableFlag, roleFocused: !!focusedRole }, panelWidth - 4)}</Text>
    </Box>
  )
}

import { execFile } from 'child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { buildRunCapsuleLine } from '../commands/run/runInspectorModel.js'
import { formatSessionCost } from '../utils/spendSpelling.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { getRunSnapshot, subscribeRuns } from '../services/run/runCoordinator.js'
import { countOperatorTurns } from '../utils/messages/operatorTurns.js'
import { Box, Text } from '../ink.js'
import { contextFillView, contextPercentLabel } from '../utils/contextFill.js'
import { needsYouCount } from '../utils/needsYouCount.js'
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js'
import { describeTurnOverride } from '../utils/autopilot/tierState.js'
import { getDisplayedEffortLabel, type EffortValue } from '../utils/effort.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { type ModelName, renderModelChip, renderModelName } from '../utils/model/model.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { publishContextUsage } from '../utils/cockpit/contextUsageLive.js'
import { LAYOUT_BREAKPOINTS, useLayoutTier } from '../hooks/useLayoutTier.js'
import { cachedAttentionView, subscribeAttentionView } from '../services/attention/viewModel.js'
import { bucketItems } from '../services/attention/contracts.js'
import { FLAG_ICON } from '../constants/figures.js'
import { chatOnlyBoot } from '../context/surfaceRoute.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { needsYouJump } from './mercury-ui/needsYouJump.js'
// The needs-you badge's owner families register their gatherers at module
// scope — the badge's consumer imports them (the store stays dormant until
// a subscriber arms; without these imports the view was blind to
// obligations and run manifests — the WORK-panel retirement orphaned them).
import '../services/crew/obligationsBridge.js'
import '../services/workbench/attentionBridge.js'
import { isDeckPaneActive } from '../utils/fullscreen.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
// Warm-ink brand palette — single source of truth (see mercuryPalette.ts). The
// identity accent (TERRA-or-critter) comes from getSessionAccent so a live
// /critter pick re-tints the frame; the status spine stays fixed here.
import inkInstances from '../ink/instances.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import {
  subscribeVerification,
  verificationSummary,
  verifyEvidenceEnabled,
} from '../utils/verification/verificationState.js'
import {
  getModeColor,
  isDefaultMode,
  type PermissionMode,
  permissionModeSymbol,
  permissionModeTitle,
} from '../utils/permissions/PermissionMode.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { useFocusedTranscript } from '../hooks/useFocusedTranscript.js'
import { useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { formatQuietAge, workflowPulse } from '../tools/WorkflowTool/livePulse.js'
import type { WorkflowProgressEvent } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { getScribeModeVersion, isScribeModeOn, subscribeScribeMode } from '../utils/scribeMode.js'
// Shared mercury-ui kit: the session mark/Sep + the auto-toned gauge, so the
// frame, /deck, and every command surface render from one definition.
import { SessionMark } from './mercury-ui/assets.js'
import { Sep, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { EffortChip } from './mercury-ui/EffortChip.js'
import { TrimChip } from './mercury-ui/TrimChip.js'
import { HarnessChip } from './mercury-ui/HarnessChip.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { ValueGlow } from './mercury-ui/LiveGlyphs.js'
import { SessionTabs } from './mercury-ui/SessionTabs.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'

// ============================================================================
//  MercuryFrame — the persistent Mercury chrome above the prompt.
//  A one-row statusbar rendered with the vendored Ink, pinned at the top of
//  the REPL's bottom slot (always on screen, never scrolls). The layout
//  and warm-ink palette:
//    ▖▟▆▙▗ Mercury │ <model> │ <dir> ⌥<branch> │ ⤳N │ $0.04 │ 5h ██░░
//  The context fill (computed + published for the deck's ctx bar + the Scribe ctx%, NOT
//  rendered as a frame gauge) reuses the session's own usage math (getCurrentUsage →
//  getContextWindowForModel → calculateContextPercentages) — never a
//  status-hook side channel. The crab is the Mercury mascot
//  (mercury-ui/CritterArt.tsx + utils/cockpit/critterData.ts),
//  distilled to a single-line glyph
//  in the same terracotta/claw palette. The palette hex lives in mercuryPalette.ts so the
//  frame and the /deck snapshot share one definition.
// ============================================================================

type Props = {
  // `messages` intentionally NOT a prop: the frame subscribes to the transcript
  // store directly (reactive-substrate Phase 3a — leaf components subscribe;
  // nothing threads the transcript through layout).
  model: ModelName
  /** RB-01/RB-03 (route-aware projection,): the band composed
   *  beneath a ROUTE SURFACE projects from the VISIBLE composition, not the
   *  covered cockpit's env-globals — deck/cockpit fact-shedding gates are
   *  forced off (nothing else on screen owns model/usage there), and the
   *  SessionTabs strip is suppressed (it names the covered ROOT session as
   *  '▣ this session' and advertises chords the standdown fences — wrong
   *  and dead truth on a worker surface). */
  routeSurface?: boolean
}

// Read the current branch SYNCHRONOUSLY from .git/HEAD (a tiny file) so the branch
// chip is populated on the FIRST paint — no waiting for the async git probe to spawn
// + return (the "top bar takes a second to load" report). The async execFile below
// still runs as the authoritative refine (detached HEAD; worktrees where .git is a
// file, which this sync read skips → null → the probe fills it).
function readBranchSync(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m && m[1] ? m[1] : null
  } catch {
    return null
  }
}

// React.memo boundary (perf audit): the frame is ALWAYS-mounted
// chrome — without this, every REPL commit (keystrokes, streaming deltas)
// re-ran its ~10 store reads + row build. Internal subscriptions
// (transcript store, app state, session accent, scribe) still drive their own
// re-renders; the memo only blocks PARENT-driven ones. Shallow-compare is
// exact: `model` is the sole prop (the DeckPane no-props idiom, one prop in).
export const MercuryFrame = React.memo(MercuryFrameImpl)

// The focused chat's session-pin feed (a primitive snapshot, so the store
// comparison stays stable between emits).
const subscribeFocusedModelFacts = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedSessionPin = (): string | null => getFocusedSessionConnector().modelFacts().sessionPin
// The focused chat's permission-mode feed for the standing badge.
const subscribeFocusedPermissionMode = subscribeThroughFocused((connector, listener) => connector.subscribePermissionMode(listener))
const getFocusedPermissionMode = (): string => getFocusedSessionConnector().permissionMode()
// The focused chat's folder feed lives at its one owner
// (hooks/useFocusedWorkspaceCwd): the workspace door on BOTH beats — the
// ground beat and the focused-slot signal — shared with the export dialog.
// Without a feed this memo'd strip named the boot folder after a repo pick
// until an unrelated re-render (census A1, the exemplar).

function MercuryFrameImpl({ model, routeSurface = false }: Props): React.ReactNode {
  fluxMark('render:frame')
  const tok = useMercuryTokens()
  // Subscribe to the transcript store (was a prop drilled from REPL). Same
  // render cadence — the frame re-rendered on every messages change before too.
  const messages = useFocusedTranscript()
  const cwd = useFocusedWorkspaceCwd()
  const [branch, setBranch] = useState<string | null>(() => readBranchSync(cwd))

  // Git branch probe — RE-PROBES when cwd changes (an in-place session switch
  // swaps cwd; a []-dep one-shot froze the chip showing branch-of-projectA under
  // dir-of-projectB). Clear first so switching INTO a non-git dir drops the stale
  // branch instead of keeping the old one.
  useEffect(() => {
    let alive = true
    setBranch(readBranchSync(cwd))
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { windowsHide: true, cwd, timeout: 500 },
      (err, stdout) => {
        if (!alive || err) return
        const b = stdout.trim()
        if (b && b !== 'HEAD') setBranch(b)
      },
    )
    return () => {
      alive = false
    }
  }, [cwd])

  // Named layout tiers (reactive-substrate Phase 3d) — drives the responsive
  // shed below. Context-aware width: in cockpit mode this IS the center column,
  // which is exactly the space the frame lays out in.
  const tier = useLayoutTier()
  const cols = tier.columns

  const dir = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
  // Compact chip form (task #11): "Fable 5 [1m]", never the raw id.
  // Scribe-aware chip: the strip names the foreground scribe
  // stream while the router is engaged; the model PROP keeps owning the
  // context-window math below (wire-side accounting, not display).
  const modelName = useDisplayedSessionModel().compact
  // The static behavior chips (wrapper/fable/substrate) are the most expendable
  // segment — they read true/false and rarely change, and they render LAST in
  // the row (after the live vitals). Drop them entirely below ~90 cols so the
  // live ctx/cost/usage keep their cells outright instead of relying on
  // truncate-end. (At 90 the dir+branch+model prefix already eats most of the
  // row; the behavior chips are ~36 cells the live data needs back.)
  const showBehavior = tier.showBehaviorChips
  // Very narrow → elide a long branch name so it can't push the live vitals off
  // the right edge before truncate-end even reaches them.
  const branchMax = tier.branchMax
  // Identity accent: subscribe to the session critter so the WHOLE frame
  // re-tints the instant a /critter pick lands — the Crab already subscribes
  // via assets.tsx; this covers the rest.
  useSessionAccent()
  // Subscribe to the scribe store (module state, not React state) so the
  // scribe band/glow repaints the instant the mode flips.
  useSyncExternalStore(subscribeScribeMode, getScribeModeVersion, getScribeModeVersion)
  // Vital ownership across the three homes (deck strip / Helm cockpit / inline):
  //  - The Helm cockpit (default >=100 cols) REPLACES the deck strip, so the deck is
  //    NOT rendered there even though isDeckPaneActive() is still true. Its rails own
  //    only usage + ctx; model/cost/branch/scribe have NO other owner → the frame must
  //    KEEP them (else pure data loss vs the deck-strip home — the A2.2 audit M1 bug).
  //  - The deck strip (narrow + substrate) owns ALL the vitals → shed them all.
  //  - Inline (no deck, no cockpit) keeps everything.
  // Read the cockpit-active signal from CONTEXT, not `cols >= HELM_HOME_MIN_COLS`:
  // the frame renders inside the cockpit's center column, so its useTerminalSize()
  // cols is the OVERRIDDEN center width (~70), which would read as "narrow" and defeat
  // the gate. CockpitActiveContext is true exactly when the rails are showing.
  const helmActive = useContext(CockpitActiveContext) && !routeSurface
  // The deck strip is ACTUALLY on screen only when the cockpit didn't supersede it.
  // RB-01: beneath a route surface NEITHER the deck nor the cockpit is
  // visible — the band keeps every fact instead of shedding to invisible
  // owners.
  const deckPresent = !routeSurface && isDeckPaneActive() && !helmActive
  // WIDTH-AWARE ownership: the deck home is settings-on at every width, but
  // below the cockpit threshold the strip renders no vitals — a shed there
  // hands model/cost/ctx to a surface that is not painting them (the same
  // invisible-owner class RB-01 fixed for route surfaces, at the width
  // axis). The deck OWNS vitals only when it is wide enough to show them.
  const deckOwnsVitals = deckPresent && cols >= LAYOUT_BREAKPOINTS.cockpitMin
  // usage/ctx are shown elsewhere by EITHER the deck strip OR the cockpit telemetry
  // rail — shed them in both so the frame never doubles the gauge.
  const usageOwnedElsewhere = !routeSurface && (deckOwnsVitals || helmActive)

  // Live session-activity segment: count of real user turns this session
  // (the cheapest signal already in props — no extra state/plumbing). Meta
  // messages, slash-command echoes and tool results are excluded so the
  // number tracks what the user actually thinks of as "messages sent". One
  // row, additive.
  const turns = countOperatorTurns(messages)
  const turnsNode =
    turns > 0 ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>{GLYPH.turns}</Text>
        {/* change-flash on each landed turn — live telemetry acknowledges movement */}
        <ValueGlow value={turns} color={tok.textSecondary}>{turns}</ValueGlow>
      </Text>
    ) : null

 // The needs-you badge (the ruled shape): the operator-
  // blocking count from the ONE attention view-model — the same facts the
  // board lists and the ping engine taps on. Waiting-on-YOU reads in the
  // warning role (the status spine's amber, same as tickets/helm-away), and
  // the badge renders ONLY while something actually waits — restraint, like
  // every state chip in this frame. Beside it, the advertised jump key —
  // the resolver's OWN display for app:openSurfaceSwitcher (a rebind can
  // never leave the advert stale), acting exactly where that Global binding
  // already acts; the badge advertises, it claims no key of its own. In THE
  // PLAIN WORLD (a `--chat` boot, the concourse switched off) there is no
  // board to jump to: the badge stays — a need is a need — and its jump
  // names the honest destination (needsYouJump): the chat itself when every
  // ask is the focused chat's own, else the estate's resume door.
  const attentionView = useSyncExternalStore(
    subscribeAttentionView,
    cachedAttentionView,
    cachedAttentionView,
  )
  const boardChord = useShortcutDisplay('app:openSurfaceSwitcher', 'Global', 'ctrl+x c')
  const needsJump = needsYouJump({
    plain: chatOnlyBoot(),
    ownOnly: bucketItems(attentionView.attention, 'needs-you').every(item => item.owner === 'command-queue'),
    boardChord,
  })
  const needsNode =
    attentionView.needsYou > 0 ? (
      <Text>
        <Sep />
        <Text color={tok.warning}>{FLAG_ICON} {needsYouCount(attentionView.needsYou)}</Text>
        <Text color={tok.textMuted}> · {needsJump}</Text>
      </Text>
    ) : null

  // Mouse-capture state chip (task #79): /mouse off hands the pointer to the
  // terminal — TUI clicks (tool cards, rails, tabs) go dead BY DESIGN, but
  // the state was invisible and read as a click regression ("not interactive
  // anymore"). Surface it only when OFF; read per-render (the state flips
  // only via the /mouse command, which lands a fresh render with its result).
  let mouseOff = false
  try {
    const ink = inkInstances.get(process.stdout)
    mouseOff = !!ink && typeof ink.isMouseTrackingEnabled === 'function' && !ink.isMouseTrackingEnabled()
  } catch {
    mouseOff = false
  }
  // The chip carries the CONSEQUENCE, not just the state (the operator:
  // native selection in the 3-pane cockpit sweeps the rails into every copy —
  // "it copies everything outside the repl" — and the app cannot scope the
  // terminal's own selection; the honest move is to say so where they look).
  const mouseNode = mouseOff ? (
    <Text>
      <Sep />
      <Text color={tok.warning}>mouse off — native copy sweeps rails</Text>
      <Text color={tok.textMuted}> · /mouse on = clean drag-copy</Text>
    </Text>
  ) : null

  // Context-fill gauge — the session's own usage math (same source as the API request).
  // The window DENOMINATOR follows the session-effective model: the API
  // resolves mainLoopModelForSession FIRST (the /model wrapper's own note),
  // so a scribe/session pin with a different window must drive the published
  // gauge — labels keep the useDisplayedSessionModel law untouched. A route
  // surface renders a WORKER's model prop; the foreground pin never leaks there.
  const sessionPinnedModel = useSyncExternalStore(
    subscribeFocusedModelFacts,
    getFocusedSessionPin,
    getFocusedSessionPin,
  )
  const windowModel = routeSurface ? model : (sessionPinnedModel ?? model)
  // The window's sources land asynchronously (catalogues, local discovery);
  // subscribing to the epoch re-derives the fill the instant one lands, so
  // the gauge never keeps painting the fallback window after the truth is in.
  useCatalogueEpoch()
  const fill = contextFillView(messages, windowModel)
  const used = fill.usedPct
  const windowSize = fill.window
  // Publish the live context fill so the pinned DeckPane can show a ctx bar
  // without threading `messages` through the React-Compiler FullscreenLayout.
  // The autocompact threshold rides along as a PERCENT of the same window
  // (P7 ctx-forecast target; null when autocompact is off), with the token
  // figure and the two provenance words the rails label from.
  useEffect(() => {
    publishContextUsage(used ?? null, windowSize, fill.compactAtPct, undefined, {
      usedTokens: fill.usedTokens,
      fillSource: fill.fillSource,
      windowSource: fill.windowSource,
    })
  }, [used, windowSize, fill.compactAtPct, fill.usedTokens, fill.fillSource, fill.windowSource])

  // Context fill is still COMPUTED + PUBLISHED above (publishContextUsage) for the
  // DECK's ctx bar + the Amanuensis Scribe ctx% — the frame stays gaugeless
  // while a WIDER surface (rail/deck) is actually painting the vital. Below
  // those widths the band keeps a compact live pulse: narrow terminals never
  // lose ctx% (spend rides costNode to its right, so truncate-end drops
  // spend before ctx — the ordered elision).
  const ctxNode = !usageOwnedElsewhere ? (
    <Text>
      <Sep />
      <Text color={tok.textMuted}>ctx </Text>
      <Text
        color={
          used !== null && used >= 90
            ? tok.failure
            : used !== null && used >= 75
              ? tok.warning
              : tok.textSecondary
        }
      >
        {contextPercentLabel(used, fill.fillSource)}
      </Text>
    </Text>
  ) : null

  const usageFacts = getFocusedSessionConnector().usage()
  const cost = usageFacts.totalCostUSD
  // The session's unpriced turns (the runner's own count; absent from an
  // older runner) ride beside the figure — a session that priced nothing
  // reads "unpriced", never a $0.00 that reads as free.
  const unpricedTurns = usageFacts.unpricedTurns ?? 0
  // HB-0209: only show a dollar cost when the account actually has per-token console
  // billing — a Max/subscription session isn't billed per call, so a "$X.XX" reads
  // as a fabricated charge. Re-read live so a session that flips is honest.
  const costNode =
    (cost > 0 || unpricedTurns > 0) && getFocusedSessionConnector().identity().consoleBilling ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>{unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`}</Text>
      </Text>
    ) : null

  // ── Max-subscription usage chips (5h + 7d rolling windows) ────────────────
  // A vital like ctx/cost: the ACTIVE source's own window meters from the ONE
  // usage owner (providerUsage.activeSourceUsage — the same stores the
  // dispatch throttles read; populated per API response, no extra call).
  // The shape follows the source: Anthropic serves 5h/7d (absent header ⇒
  // honest `5h —`, NEVER a fake 0%), OpenAI serves what it stated (the
  // observed weekly band), and an api-key / logged-out session carries NO
  // meter chips — a subscription bar there would be another family's shape.
  // The countdown recomputes on this render poll.
  //
  // 80-col collapse is an ORDERED shed, not just truncate-end:
  //   ≥100  both chips · first + second window full
  //   ≥80   hide the LONGER window FIRST · first full (mini-gauge + number)
  //   ≥64   compact first window · number only (drop the mini-gauge)
  //   <64   omit usage entirely (ctx/cost stay; usage is decoration)
  let usageNode: React.ReactNode = null
  if (tier.showFrameQuota) {
    // The quota lane follows the MAIN resolution (no session pin) — the
    // one model fact this meter has always keyed on.
    const usage = activeSourceUsage({ model: getFocusedSessionConnector().modelFacts().main })
    const numberOnly = tier.numberOnlyGauges
    const showSecond = tier.show7dGauge
    const first = usage.windows[0]
    const second = usage.windows[1]
    // A reached limit on the active source lights one neutral chip — real
    // observations only, whatever the family (never a fabricated %).
    const limited = usage.limited
    usageNode =
      first !== undefined || limited !== undefined ? (
        <Text>
          <Sep />
          {first !== undefined ? (
            <UsageMeter
              compact
              numberOnly={numberOnly}
              window={first.label}
              state={first.state}
              value={first.usedPct ?? undefined}
            />
          ) : null}
          {second !== undefined && showSecond ? (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <UsageMeter
                compact
                window={second.label}
                state={second.state}
                value={second.usedPct ?? undefined}
              />
            </Text>
          ) : null}
          {limited !== undefined ? (
            <Text>
              {first !== undefined ? <Text color={tok.textMuted}> {GLYPH.dot} </Text> : null}
              <Text color={tok.warning}>limit · resets {formatCountdown(limited.resetsAtMs - Date.now())}</Text>
            </Text>
          ) : null}
        </Text>
      ) : null
  }

  // Behavioral MODES you flip per session — Scribe Mode.
  // Restraint: show a chip ONLY when its mode is ON (●) — an off mode is the
  // default and doesn't need persistent announcing (the same "non-default only"
  // rule the permission modeBand above uses). This declutters the common both-off
  // frame AND fixes the 100–120-col overflow: the two always-on ○ chips used to
  // push the row past the width (truncating `fable-he…` / `scri…`) once the 7d
  // meter + turn counter were also present. fable-on also has its own band above;
  // the more set-and-forget profile flags (wrapper/substrate) live on the deck.
  const scribeOn = isScribeModeOn()
  const behaviorNode = scribeOn ? (
    <Text>
      <Sep />
      <Text color={tok.textMuted}>scribe </Text>
      <Text color={tok.success}>●</Text>
    </Text>
  ) : null

  // Inline-chrome HEALTH glyph (trust-cockpit): the /health verdict
  // for the frames the cockpit rail doesn't cover (<100 cols, fullscreen off).
  // Restraint mirrors the behavior chips: rendered ONLY when there is
  // something to say — a certified-and-fresh cert AND no alert stays silent
  // (healthy is the default), `no cert` renders nothing (no nagging), while
  // caution/stale reads tok.warning and a fault or newer-red-evidence reads tok.failure.
  // Sheds when the cockpit is active (the rail owns the health chip there).
  const healthSnap = !helmActive ? healthCertSnapshot() : null
  const healthChip = healthSnap && healthSnap.state === 'live' ? healthSnap.data : null
  const healthAlarm =
    healthChip !== null &&
    (healthChip.verdict === 'fault' || healthChip.alert?.tone === 'fault')
  const healthWarn =
    healthChip !== null &&
    !healthAlarm &&
    (healthChip.verdict === 'caution' || healthChip.stale)
  // ONE chip grammar across every surface (product-study r2): `health <glyph>
  // <verdict> · <age>` — the strip, the Helm rail, the splash strip, and the
  // resume recap all speak it, so the same datum never wears four spellings.
  const healthAge =
    healthChip?.ageLabel && healthChip.ageLabel !== 'never'
      ? healthChip.ageLabel.replace(' ago', '')
      : null
  const healthNode =
    healthChip && (healthAlarm || healthWarn) ? (
      <Text>
        <Sep />
        <Text color={tok.textMuted}>health </Text>
        {healthAlarm ? (
          <Text bold color={tok.failure}>
            {GLYPH.fail} fault
          </Text>
        ) : (
          <Text color={tok.warning}>
            {GLYPH.warn} {healthChip.stale ? 'stale' : 'caution'}
          </Text>
        )}
        {healthAge ? <Text color={tok.textMuted}>{` · ${healthAge}`}</Text> : null}
      </Text>
    ) : null

  // Mutation→verification evidence chip (Sol 5.6 WS5) — same restraint as
  // the health chip: SILENT while verified/unverified-idle; speaks only when
  // the tree has unverified mutations (tok.warning `vfy stale`) or the newest
  // evidence failed (tok.failure `vfy failed`). /health carries the drill-down.
  const vfySnap = useSyncExternalStore(
    subscribeVerification,
    () => {
      if (!verifyEvidenceEnabled()) return null
      const s = verificationSummary(getFocusedSessionConnector().workspace().cwd, { skipDigest: true })
      return s.state === 'stale' || s.state === 'failed' ? s.state : null
    },
    () => null,
  )
  const vfyNode =
    vfySnap !== null ? (
      <Text>
        <Sep />
        {vfySnap === 'failed' ? (
          <Text bold color={tok.failure}>
            vfy {GLYPH.fail} failed
          </Text>
        ) : (
          <Text color={tok.warning}>vfy {GLYPH.warn} stale</Text>
        )}
      </Text>
    ) : null

  // Active-run capsule (Sol 5.6 slice 6): ONE bounded chip while a
  // substantive run is live — lifecycle · phase · done/total · next action
  // or blocker. Subscription-driven off the run coordinator (no polling
  // timer); geometry stays stable via truncation; lightweight conversational
  // turns show NOTHING (buildRunCapsuleLine returns null for them and for
  // completed/cancelled receipts). /run carries the drill-down.
  const runCapsule = useSyncExternalStore(
    subscribeRuns,
    () => buildRunCapsuleLine(getRunSnapshot(processMainOwner()), Date.now()),
    () => null,
  )
  const runNode = runCapsule ? (
    <Text>
      <Sep />
      <Text color={tok.textMuted}>{GLYPH.done} </Text>
      <Text color={tok.textSecondary}>{runCapsule}</Text>
    </Text>
  ) : null

  // Loud standing danger badge whenever sovereign mode is active
  // (full-* footer rule). Read reactively from the connector; never faint.
  const permMode = useSyncExternalStore(
    subscribeFocusedPermissionMode,
    getFocusedPermissionMode,
    getFocusedPermissionMode,
  )
  // Active permission-mode badge — lives at the TOP (above the statusbar) so the
  // prompt box can sit at the bottom; the duplicate footer badge is fork-suppressed
  // (PromptInputFooterLeftSide). Every active mode (strategy / implement / sovereign)
  // shows here on its OWN full-width flexShrink={0} band, never sharing the
  // truncate-end budget with the chips. Sovereign — the single most dangerous mode —
  // stays the loud tok.failure alarm with the "all tool calls auto-approved" tail;
  // other modes render with their own mode color (the shared permissionMode*
  // helpers) + a cycle hint.
  // AUTOPILOT live tier readout — the mode chip carries the CURRENT tier so a
  // self-switch is never silent (spec: `⌖ Autopilot · opus @high`). Session
  // tier rides the model prop + effortValue (both reactive); an active
  // turn-scoped override is a module read (tierState) — the SetTier result
  // message re-renders the frame the moment one lands.
  const autopilotEffort = useAppStateMaybeOutsideOfProvider(
    (s: { effortValue?: string | number } | undefined) => s?.effortValue,
  ) as EffortValue | undefined
  // Background-workflow heartbeat chip (AVS friction): "is it
  // stuck?" needs a STANDING one-glance answer — the transcript launch line
  // scrolls away and the RUNS lane needs the wide cockpit. Same pulse
  // projector as the /tasks probe row; the 10s coarse tick runs ONLY while a
  // run is live (null parks the interval); tok.warning once quiet ≥2m (a look-cue,
  // never a death verdict). A LIVE vital — never shed with
  // the behavior chips. Multiple runs show the WORST (quietest) pulse: an
  // active run must not mask a stuck one.
  type WfTaskLite = {
    type?: string
    status?: string
    startTime?: number
    workflowProgress?: WorkflowProgressEvent[]
  }
  const allTasks = useAppStateMaybeOutsideOfProvider(
    (s: { tasks?: Record<string, WfTaskLite> } | undefined) => s?.tasks,
  ) as Record<string, WfTaskLite> | undefined
  const wfLive = Object.values(allTasks ?? {}).filter(
    t =>
      t.type === 'local_workflow' &&
      (t.status === 'running' || t.status === 'pending'),
  )
  const wfNow = useNowTick(wfLive.length > 0 ? 10_000 : null)
  let wfNode: React.ReactNode = null
  if (wfLive.length > 0) {
    const worst = wfLive
      .map(w => workflowPulse(w.workflowProgress ?? [], w.startTime ?? wfNow, wfNow))
      .reduce((a, b) => (a.quietMs >= b.quietMs ? a : b))
    const label = wfLive.length === 1 ? 'wf' : `wf×${wfLive.length}`
    const phase =
      wfLive.length === 1 && worst.phaseTitle
        ? ` ${truncateToWidth(worst.phaseTitle, 14)}`
        : ''
    wfNode = (
      <Text>
        <Sep />
        <Text color={worst.moving ? tok.success : tok.warning}>
          {GLYPH.inProgress} {label}
          {phase} {formatQuietAge(worst.quietMs)}
        </Text>
      </Text>
    )
  }
  const autopilotTurnTier =
    permMode === 'autopilot' ? describeTurnOverride(undefined) : null
  const modeBand = !isDefaultMode(permMode as PermissionMode | undefined) ? (
    <Box width="100%" paddingX={1} flexShrink={0}>
      {permMode === 'sovereign' ? (
        // Title from the ONE config — the honest "all tool calls
        // auto-approved" tail is band-owned copy and stays verbatim.
        <Text bold color={tok.failure} wrap="truncate-end">
          {permissionModeSymbol('sovereign')} {permissionModeTitle('sovereign').toLowerCase()} on — all tool calls auto-approved
        </Text>
      ) : permMode === 'autopilot' ? (
        // Bypass-family tok.failure (autopilot IS bypass posture) + the live tier.
        <Text bold color={tok.failure} wrap="truncate-end">
          {permissionModeSymbol('autopilot')} {permissionModeTitle('autopilot').toLowerCase()} on — permissions bypassed · self-tier armed
          <Text color={tok.textMuted}>
            {/* Resolved effort, always (review): the band used to
                print the RAW effortValue while the adjacent chip printed the
                resolved level — two standing trust surfaces disagreeing on
                one fact (env override / model clamps / numeric ant values). */}
            {/* RB-10 (one owner per fact): the statusRow directly beneath
                owns the model+effort slot — the band keeps only its
                autopilot-specific tier fact. */}
            {autopilotTurnTier ? ` · ⇅ ${autopilotTurnTier}` : ''}
          </Text>
        </Text>
      ) : (
        <Text color={getModeColor(permMode as PermissionMode)} wrap="truncate-end">
          {/* HB-0211: per-mode symbol (the shared helper the footer + TeamsDialog use)
              not a generic cursor — the modeBand is the hoisted footer mode badge. */}
          {permissionModeSymbol(permMode as PermissionMode)}{' '}
          {permissionModeTitle(permMode as PermissionMode).toLowerCase()} on
          <Text color={tok.textMuted}> (shift+tab to cycle)</Text>
        </Text>
      )}
    </Box>
  ) : null

  // The one statusline row — shared by both frame variants below. Inside the
  // cockpit's bordered SESSIONS panel the panel provides the horizontal pad.
  // Single-brand pass (operator directive): the product word
  // lives ONCE, in the transcript's banner-header — the statusline keeps the
  // SESSION critter as its identity anchor and spends the cells on data.
 //: the anchor is the SELECTED
  // critter's authored one-line mark — a non-crab session must never read as
  // crab here; a crab session renders byte-identically to the old <Crab/>.
  const statusRow = (
    // Stretch, not width="100%": percent resolves against the
    // bordered SESSIONS card's BORDER box (+4 over content), inflating the
    // truncate-end budget past the card's right border. Stretch = content box.
    <Box paddingX={helmActive ? 0 : 1}>
      <Text wrap="truncate-end">
        <SessionMark />
        {!deckOwnsVitals ? (
          <Text>
            <Sep />
            <Text color={tok.textSecondary}>{modelName}</Text>
            <EffortChip model={model} />
            <HarnessChip model={model} show={showBehavior} />
          </Text>
        ) : null}
        <Sep />
        <Text color={tok.textPrimary}>{dir}</Text>
        {!deckOwnsVitals && branch ? (
          <Text color={tok.textMuted}> {GLYPH.branch}{truncateToWidth(branch, branchMax)}</Text>
        ) : null}
        {turnsNode}
        {needsNode}
        {/* When the deck is present it OWNS the vitals (model/cost/usage/branch/scribe);
            the frame sheds them here to one owner. Inline (no deck) keeps them. The 2×
            route badge stays — it's frame-only, not a deck dup. */}
        {wfNode}
        {ctxNode}
        {!deckOwnsVitals ? costNode : null}
        {!usageOwnedElsewhere ? usageNode : null}
        {!deckOwnsVitals && showBehavior ? behaviorNode : null}
        {/* The mouse-consequence hint rides AFTER the vitals:
            truncate-end eats from the RIGHT, and at 120 the full sentence was
            starving the 5h/7d meters out of the row — a HINT must never
            outrank a live vital under pressure. Full copy when it fits (the
            operator-ratified consequence wording), tail truncates first —
            and it rides OUTSIDE (right of) even the health chip: a hint is
            the one thing allowed to die before any signal. */}
        {healthNode}
        {vfyNode}
        {runNode}
        {/* THE TRIM NOTICE is a hint too (SSR-01): parked fourth in the row
            its 64-cell sentence evicted the folder, the branch, ⤳, ctx%, $
            and the meters at every cockpit width — for the whole session.
            It rides with the hints, right of every vital, where truncate-end
            cuts it first; the deck paints its own when it owns the vitals. */}
        {!deckOwnsVitals ? <TrimChip /> : null}
        {mouseNode}
      </Text>
    </Box>
  )

  return (
    <Box flexShrink={0} width="100%" flexDirection="column">
      {helmActive ? (
        /* COCKPIT variant (panel pass, mockup-ratified): the session
           tab-strip + statusline share one rounded SESSIONS card above the
           full-width prompt — the frame speaks the same panel grammar as the
           rails. Alarm bands stay full-width ABOVE the card (an alarm never
           lives inside furniture). */
        <>
          {modeBand}
          <Box
            width="100%"
            flexDirection="column"
            borderStyle="round"
            borderColor={tok.borderStrong}
            paddingX={1}
          >
            {routeSurface ? null : <SessionTabs cols={cols} framed />}
            {statusRow}
          </Box>
        </>
      ) : (
        <>
          {/* Thin session tab-strip, above the statusbar — the at-a-glance
              companion to the /sessions list switcher. Self-omits when there
              are no other sessions to tab between (or the row is narrow).
              Band order preserved from the pre-panel frame: tabs · bands ·
              statusline. */}
          {routeSurface ? null : <SessionTabs cols={cols} />}
          {modeBand}
          {statusRow}
        </>
      )}
    </Box>
  )
}

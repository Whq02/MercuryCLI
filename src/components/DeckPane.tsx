import * as React from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { contextWindowLabel } from '../utils/contextFill.js'
import {
  formatSessionCost,
  getTotalCost,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalUnpricedTurns,
} from '../cost-tracker.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { LAYOUT_BREAKPOINTS } from '../hooks/useLayoutTier.js'
import { getGitState, type GitRepoState } from '../utils/git.js'
import { hasConsoleBillingAccess } from '../utils/billing.js'
import { renderModelChip, renderModelName } from '../utils/model/model.js'
import { listCapabilityKills } from '../utils/permissions/capabilityGate.js'
import { getTaskListId, listTasks, type Task } from '../utils/tasks.js'
import {
  getDisplayedEffortLabel,
  modelSupportsEffort,
  type EffortValue,
} from '../utils/effort.js'
import { isScribeModeOn } from '../utils/scribeMode.js'
import { buildScribeLedger, buildScribeBatchLedger, isDispatchUnacked, scribeReasoningFeed } from './mercury-ui/scribeChatTabs.js'
import { scribeBusQueueDepth } from '../utils/scribe/scribeBus.js'
import {
  agentStateSnapshot,
  daemonSnapshot,
  daemonRosterSnapshot,
  type RosterSnapshot,
  getLiveContextUsage,
  getLiveContextUsageVersion,
  getLivePresence,
  getPresenceVersion,
  subscribeLiveContextUsage,
  subscribePresence,
  traceSnapshot,
  type SnapshotState,
} from '../utils/cockpit/index.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { CompanionSpeechLine, DeckCompanion, DeckCompanionChip } from './mercury-ui/DeckCompanion.js'
import { EffortChip } from './mercury-ui/EffortChip.js'
import { TrimChip } from './mercury-ui/TrimChip.js'
import { MiniCritter } from './mercury-ui/MiniCritter.js'
import { Crab } from './mercury-ui/assets.js'
import { useCompanionEnabled } from './mercury-ui/useCompanion.js'
import { ProgressBar, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { AttentionPulse, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { STATE_STYLE } from './mercury-ui/theme.js'

/** The retired client queue mirror's stand-in (steer-removal): stable
 *  identity, always empty — nothing is ever held client-side. */
const EMPTY_QUEUED: readonly { value: unknown }[] = Object.freeze([])

// ============================================================================
//  DeckPane — the PERSISTENT fullscreen deck pane (Session 3, phase 2).
//  A compact, pinned strip of the /deck command's content (session · git ·
//  tasks) that lives at the TOP of the fullscreen transcript region, always
//  visible, complementing the one-shot inline /deck command. Same data
//  sources as Deck.tsx (git, tasks, cost-tracker) — no external harness.
//
//  Gating lives in FullscreenLayout (fullscreen active + MERCURY_DECK_PANE=1 +
//  the retired stamp gate); this component is only mounted when all hold, so it
//  carries no env checks itself. flexShrink:0 so it never steals transcript
//  height; one bordered block, light polling for git/tasks freshness.
//
//  Persistent (not modal): no useInput / onClose — it must not capture keys
//  away from the prompt. Refreshes off the shared telemetryBus signal since,
//  unlike the inline snapshot, it stays on screen across turns.
// ============================================================================

const MAX_TASKS = 4

// React.memo (no props) so the deck re-renders ONLY on its own state — the telemetryBus
// signal (500ms-debounced transcript/task trigger + 15s heartbeat fallback, Phase 3c) + the
// published-ctx read — NOT on every parent (FullscreenLayout) re-render. Without
// this, typing a keystroke or each streaming/spinner frame re-invoked the body and recomputed
// every sync snapshot (substrate/permissions/scheduling/mcp/agent-state) + the
// full JSX, dozens of times per turn. Far less per-turn work — but NOT free of lag: cost / +/-
// lines / ctx are read at render, so on a debounce/heartbeat edge they can briefly trail
// MercuryFrame's per-message read (the two pinned surfaces momentarily disagree; they
// reconcile on the next signal). The ACCENT is the exception: it is SUBSCRIBED
// (useSessionAccent pierces the memo via useSyncExternalStore) so /critter ·
// /accent · the Scribe glow repaint this persistent pane in the same commit —
// a stale identity hue on standing chrome reads as a broken theme.
export const DeckPane = React.memo(function DeckPane(): React.ReactNode {
  const tok = useMercuryTokens()
  // Identity accent/claw, live-subscribed → a /critter pick re-tints this pane.
  const { accent: TERRA, accentDeep: CLAW } = useSessionAccent()
  // Live terminal width — drives the quota row's ordered shed (the 7d window goes
  // first under ~100 cols, mirroring MercuryFrame), so it never clips mid-token at
  // narrow widths where truncate-end alone would cut the 7d reset tail.
  const cols = useTerminalSize().columns
  // COMPACT deck: one
  // dense identity row + the live ops row; the sparse per-datum rows (quota,
  // tasks, ledger, standalone ctx) yield their lines to the conversation.
  const compact = cols < 100
  // The companion gate, epoch-subscribed so a /companion flip repaints the
  // strip instantly (no relaunch). When armed at compact, the strip becomes
  // the COMPANION DOCK: the mini creature lives HERE (operator direction
  // — riding the live region, so it moves down with the REPL in
  // inline mode and stays pinned in fullscreen.
  const companionOn = useCompanionEnabled()
  const rawModel = useMainLoopModel()
  // The COMPACT chip form (task #11): "Fable 5 [1m]", never the raw id —
  // scribe-aware: the chip names the foreground scribe stream
  // while the router is engaged; rawModel keeps feeding the effort chips.
  const model = useDisplayedSessionModel().compact
  const cost = getTotalCost()
  // Unpriced turns ride beside the figure (the usage-neutrality law); the
  // two-decimal spelling stands when there are none.
  const unpricedTurns = getTotalUnpricedTurns()
  const costFigure = unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()

  // Cockpit vitals via the SHARED telemetry bus (reactive-substrate Phase 3c):
  // one event-driven refresh (transcript turns + task signals + 15s heartbeat)
  // feeds every vitals surface, so frame and deck can never disagree for a
  // poll interval. The bus's raw trace snapshot is projected to the deck's shape.
  const vitals = useTelemetry()
  const git = vitals.git
  const tasks: Task[] | null = vitals.version === 0 ? null : vitals.tasks
  const fleet = {
    state: vitals.fleet.state as SnapshotState,
    team: vitals.fleet.team ?? null,
    conflicts: vitals.fleet.conflicts,
    drifting: vitals.fleet.drifting,
  }
  const trace =
    vitals.trace && vitals.trace.state === 'live'
      ? {
          state: 'live' as SnapshotState,
          total: vitals.trace.data.total,
          highRisk: vitals.trace.data.highRisk,
          killed: vitals.trace.data.killed,
        }
      : { state: (vitals.trace?.state ?? 'off') as SnapshotState, total: 0, highRisk: 0, killed: 0 }
  const implRoster = vitals.implRoster

  // Delivery-liveness: the Implementer inbox's
  // UNDELIVERED envelope count — a pure mailbox read that works with NO
  // daemon, because a deaf bus (dispatches piling up unread while the ledger
  // says "in flight") is exactly the failure it exposes. Refreshed on the
  // shared bus cadence; null = unknown (unreadable inbox), never a fake 0.
  const [busQueue, setBusQueue] = React.useState<{
    queued: number
    oldestMs: number | null
  } | null>(null)
  React.useEffect(() => {
    if (!isScribeModeOn()) return
    let alive = true
    void scribeBusQueueDepth().then(q => {
      if (alive) setBusQueue(q)
    })
    return () => {
      alive = false
    }
  }, [vitals.version])

  // substrate/policy/scheduling posture snapshots: removed —
  // the full /deck snapshot is the single owner of the set-and-forget chips.
  // Daemon LIVENESS (the scheduler PROCESS), not just the scheduling gate — sync,
  // never-throws snapshot. Uptime is parsed from the reason ("… (up Ns)") the
  // wired-live daemonSnapshot emits; absent ⇒ just the glyph.
  const daemon = daemonSnapshot()
  const daemonUpSec = daemon.state === 'live' ? Number(daemon.reason?.match(/up (\d+)s/)?.[1]) : NaN
  // (permMode read removed — the frame's always-present modeBand owns permission mode; datum-dedup)
  // Effort level (e.g. xhigh) shown ALONGSIDE the context on the deck, mirroring
  // the prompt footer's '◍ xhigh · /effort'. null when the model has no effort axis.
  const effortValue = useAppStateMaybeOutsideOfProvider(
    (s: { effortValue?: EffortValue } | undefined) => s?.effortValue,
  ) as EffortValue | undefined
  const effortLevel = modelSupportsEffort(rawModel)
    ? getDisplayedEffortLabel(rawModel, effortValue)
    : null
  // Scribe Mode "Amanuensis": the live transcript mirror, derived into the deck's
  // prompt ledger + reasoning feed (only consumed when scribe mode is on, below).
  const chatMessages = (useAppStateMaybeOutsideOfProvider(
    (s: { scribeTranscript?: unknown[] } | undefined) => s?.scribeTranscript,
  ) ?? []) as readonly unknown[]
  // The Scribe's REASONING FEED — only its operator-facing prose (no raw command
  // XML, no tool rows, no bus envelopes; the full transcript lives in the REPL).
  // Computed at TOP level (not inside the scribe IIFE below) so the flash hooks obey
  // the rules-of-hooks. Empty (and skipped) when scribe mode is off.
  const scribeFeed = isScribeModeOn() ? scribeReasoningFeed(chatMessages, 3) : []
  // #47 the deck BATCH ledger fed from the retired client queue mirror: the
  // steer-removal ruling removed operator-facing holding whole, so the
  // batch source is the honest empty — a sent message is delivered, never
  // piled up client-side.
  const queuedCommands = EMPTY_QUEUED
  // Flash-green pulse: the feed header glows tok.success for ~1.4s whenever a new Scribe
  // turn lands ("the feed flashes when chat is happening"). Keyed on the joined feed
  // text; the initial mount is skipped (no flash on first paint, only on a change).
  const feedKey = scribeFeed.join('\x01')
  const [feedFlash, setFeedFlash] = useState(false)
  const lastFeedKey = useRef<string | null>(null)
  useEffect(() => {
    if (lastFeedKey.current === null) {
      lastFeedKey.current = feedKey
      return
    }
    if (feedKey === lastFeedKey.current) return
    lastFeedKey.current = feedKey
    setFeedFlash(true)
    const t = setTimeout(() => setFeedFlash(false), 1400)
    return () => clearTimeout(t)
  }, [feedKey])
  // Capability kills in force (MERCURY_KILL) — a real exposure signal; 0 ⇒ omitted.
  const killCount = Object.values(listCapabilityKills()).reduce((n, arr) => n + arr.length, 0)
  // The ACTIVE source's window meters from the ONE usage owner — the shape
  // follows the source (Anthropic 5h/7d · OpenAI observed bands · api-key /
  // logged-out: no meters); absent facts render nothing, never a fake bar.
  const sourceUsage = activeSourceUsage()
  // A slow 30s tick keeps the reset countdowns moving between bus refreshes
  // (Date.now() at render froze them) — and doubles as a convergence tick for
  // the render-read vitals (cost / +/- lines / ctx) the memo boundary let
  // briefly trail MercuryFrame between telemetry signals.
  const now = useNowTick(30_000)
  const resetIn = (w: { resetsAtMs: number | null }): string | undefined =>
    w.resetsAtMs != null ? formatCountdown(w.resetsAtMs - now) : undefined
  // ENV fold (mcp · skills · extensions): removed from the strip (declutter
  // — set-and-forget environment facts; /deck owns them.
  // CTX fold: live context-window fill, published by MercuryFrame (which has
  // `messages`) so the pinned pane needn't thread it through the _c FullscreenLayout.
  // Null until the frame renders once / fresh session ⇒ row omitted.
  // Subscribed to the publish version, so a window landing from a catalogue
  // or a usage arriving repaints the row at once (not on the 30s tick).
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  // The published token figure, never a back-computation from the rounded
  // percent (28% of 1049k would paint 293k for a 290k count).
  const ctxUsedK =
    ctx.usedTokens != null
      ? Math.round(ctx.usedTokens / 1000)
      : ctx.usedPct != null
        ? Math.round((ctx.window * ctx.usedPct) / 100 / 1000)
        : 0
  const ctxWinLabel = contextWindowLabel(ctx.window, ctx.windowSource)
  // Content-derived agent state (per-turn classifier). Only surfaced when a
  // verdict exists this session; a 'blocked'/'failed' last turn raises a
  // prominent needs-attention marker the process-state signals can't see.
  const agent = agentStateSnapshot()
  // A1 multiplayer presence — the "watch your friend work" seats row. Subscribe so
  // the row repaints the instant a peer publishes/leaves (the heartbeat in
  // useManageMCPConnections tails every ~2s + bumps the version). getLivePresence()
  // returns a FRESH array each call, so it can't be the getSnapshot (useSyncExternalStore
  // would loop on Object.is); the monotonic version counter is the snapshot, and the
  // peer set is read separately at render. Already self-excluded + stale-dropped by the
  // tailer; empty ⇒ the whole row is omitted below (solo case → byte-identical).
  useSyncExternalStore(subscribePresence, getPresenceVersion, getPresenceVersion)
  const seats = getLivePresence()

  const all = tasks ?? []
  const open = all.filter(t => t.status !== 'completed')
  const completed = all.filter(t => t.status === 'completed')
  const inProg = open.filter(t => t.status === 'in_progress')
  // Operator ask: completed tasks PERSIST on the deck until the WHOLE ledger is
  // done (a ticked task would otherwise vanish). Order: in-progress (glow) → completed
  // (ticked, persisting) → pending; capped at MAX_TASKS.
  const allDone = all.length > 0 && open.length === 0
  const ordered = [
    ...inProg,
    ...completed,
    ...open.filter(t => t.status !== 'in_progress'),
  ]
  const shown = ordered.slice(0, MAX_TASKS)
  // Blocked = open tasks with a blocker that is itself still open (derived from the
  // already-fetched list, no extra IO). A real attention signal vs a bare count.
  const openIds = new Set(open.map(t => t.id))
  const blockedCount = open.filter(
    t => t.blockedBy.length > 0 && t.blockedBy.some(id => openIds.has(id)),
  ).length
  // Ledger-tracker: group tasks into "ledgers" — an explicit metadata.ledger tag,
  // else a LaunchFleet mission (metadata.missionId, the real grouping that exists
  // today), else one implicit 'session' group. Each group → done/total, so
  // completed ledger groups + in-progress ones are labeled at a glance. The row
  // is shown ONLY when there's more than one real group (otherwise it would just
  // restate the row-4 task count — see the guard below).
  const ledger = new Map<string, { done: number; total: number }>()
  for (const t of all) {
    const meta = t.metadata as { ledger?: unknown; missionId?: unknown } | undefined
    const lk =
      (typeof meta?.ledger === 'string' && meta.ledger.trim()) ||
      (typeof meta?.missionId === 'string' && meta.missionId.trim()) ||
      'session'
    const g = ledger.get(lk) ?? { done: 0, total: 0 }
    g.total++
    if (t.status === 'completed') g.done++
    ledger.set(lk, g)
  }
  const ledgerGroups = [...ledger.entries()]

  // The LIVE ops rail (daemon · fleet · trace) — ONE definition; placed
  // standalone (classic) or inside the compact companion dock's right column.
  const opsRow = (
    <Text wrap="truncate-end">
      {agent.state === 'live' && agent.data.needsAttention ? (
        <Text color={tok.failure} bold>
          {agent.data.verdict?.state === 'failed' ? `${GLYPH.fail} agent failed` : `${GLYPH.warn} agent needs you`}
          {agent.data.verdict?.needs || agent.data.verdict?.detail
            ? ` · ${truncateToWidth(agent.data.verdict.needs || agent.data.verdict.detail, 48)}`
            : ''}
          {' · '}
        </Text>
      ) : null}
      {/* daemon LIVENESS (process), distinct from the scheduling gate */}
      <Text color={tok.textMuted}>daemon </Text>
      <Text color={STATE_STYLE[daemon.state].color}>{STATE_STYLE[daemon.state].glyph}</Text>
      {Number.isFinite(daemonUpSec) && daemonUpSec > 0 ? (
        <Text color={tok.textSecondary}>{` up ${daemonUpSec < 60 ? `${daemonUpSec}s` : formatCountdown(daemonUpSec * 1000)}`}</Text>
      ) : null}
      <Text color={tok.textMuted}> · fleet </Text>
      <Text color={STATE_STYLE[fleet.state].color}>{STATE_STYLE[fleet.state].glyph}</Text>
      <Text color={tok.textSecondary}>{fleet.team ? ` ${fleet.team}` : ''}</Text>
      {fleet.conflicts > 0 ? <Text color={tok.failure}>{` ${GLYPH.conflict}${fleet.conflicts}`}</Text> : null}
      {fleet.drifting > 0 ? <Text color={tok.warning}>{` ${GLYPH.drifting}${fleet.drifting}`}</Text> : null}
      <Text color={tok.textMuted}> · trace </Text>
      {trace.state === 'live' ? (
        <Text color={tok.textPrimary}>{trace.total}</Text>
      ) : trace.state === 'unavailable' ? (
        <Text color={tok.textMuted}>0</Text>
      ) : (
        <Text color={STATE_STYLE[trace.state].color}>{STATE_STYLE[trace.state].glyph}</Text>
      )}
      {/* Honesty retune (product-study r2): `▲94 ×40` branded routine work as
          warnings/denials — highRisk is a risk-CLASS tally (every Bash) and the
          old `denied` counted any failed call (a no-match grep). The strip now
          carries only the scoped total (`· repo` — the sidecar spans the repo's
          history, not this session) plus tok.failure ✕ for REAL kills; the full
          class/killed/errored split lives on /deck + /trace. */}
      {trace.state === 'live' ? <Text color={tok.textMuted}>{' · repo'}</Text> : null}
      {trace.killed > 0 ? <Text color={tok.failure}>{` ${GLYPH.fail}${trace.killed}`}</Text> : null}
      {/* permission mode: removed — the frame's always-present modeBand is its single owner (datum-dedup) */}
      {killCount > 0 ? <Text color={tok.failure}>{` · ${GLYPH.fail}kill ${killCount}`}</Text> : null}
    </Text>
  )

  return (
    <Box
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={tok.borderStrong}
      paddingX={1}
      width="100%"
    >
      {/* row 1 — TWO FORMS (the minimized-REPL refresh, operator
          mockup): COMPACT (<100 cols) folds identity · model · companion chip
          · git · ±lines · ctx into ONE dense row so a small window spends its
          rows on the conversation; STANDARD keeps the classic pair. The
          product word still lives once (the banner-header) — the crab glyph
          anchors both forms. */}
      {compact ? (
        (() => {
          const denseRow = (
            <Text wrap="truncate-end">
              {/* the live-accent Crab primitive — the hand-drawn
                  static-palette copy could not follow a /critter re-tint. */}
              <Crab />
              <Text color={tok.textMuted}> · </Text>
              <Text color={tok.textSecondary}>{model}</Text>
              <EffortChip model={rawModel} />
              <TrimChip />
              {companionOn ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <DeckCompanionChip />
                </>
              ) : null}
              {git !== null ? (
                <>
                  <Text color={tok.textMuted}>{' · ' + GLYPH.branch}</Text>
                  <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 14)}</Text>
                  {git.isClean ? null : <Text color={tok.warning}>*</Text>}
                </>
              ) : null}
              {/* No ± pair here: the turn rollup two
                  rows below the prompt is the ONE owner of session work
                  stats at compact widths; the ≥100-col row keeps its pair
                  because the frame sheds there. */}
              {ctx.window > 0 && ctx.usedPct != null ? (
                <>
                  <Text color={tok.textMuted}> · ctx </Text>
                  <Text color={tok.textSecondary}>{`${ctx.fillSource === 'estimate' ? '≈' : ''}${Math.round(ctx.usedPct)}%`}</Text>
                  <Text color={tok.textMuted}>{` · ${ctxUsedK}k/${ctxWinLabel}`}</Text>
                </>
              ) : null}
            </Text>
          )
          if (!companionOn) return denseRow
          // The COMPANION DOCK: the mini creature LIVES in the strip
          // art column left, the three data/voice
          // lines beside it. The strip is part of the live region, so the
          // creature moves down with the REPL inline and pins in fullscreen.
          return (
            <Box flexDirection="row">
              <Box flexShrink={0} marginRight={1}>
                <MiniCritter cols={cols} bare />
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {denseRow}
                {opsRow}
                <CompanionSpeechLine />
              </Box>
            </Box>
          )
        })()
      ) : (
        <Text wrap="truncate-end">
          <Crab />
          <Text color={tok.textMuted}> · </Text>
          <Text color={tok.textSecondary}>{model}</Text>
          <EffortChip model={rawModel} />
          <TrimChip />
          <Text color={tok.textMuted}> · {hasConsoleBillingAccess() ? `${costFigure} · ` : ''}</Text>
          <Text color={tok.success}>+{added}</Text>
          <Text color={tok.textMuted}>/</Text>
          <Text color={tok.warning}>-{removed}</Text>
        </Text>
      )}

      {/* companion row: the LIVING critter (the buddy→critter merge) — the session
          creature + its per-session soul, posed by real turn signals, speaking
          deterministic quips on mood transitions. Own component so its (rare)
          repaints stay local; opt-in (boot-menu "Session companion") ⇒ never
          mounted unless armed. COMPACT folds it into the row-1 chip instead —
          one surface per datum. */}
      {!compact && companionOn ? <DeckCompanion /> : null}

      {/* seats row (A1 multiplayer): the "watch your friend work" headline — OTHER
          live seats in this room (self-excluded + stale-dropped by the tailer).
          Each: <seat> (tok.success) · <verb> · ⌥<branch> · <last-line>. Sparse fields
          (the heartbeat may publish only seat+verb) self-omit their segment, so a
          bare-presence peer still reads cleanly. The WHOLE block is omitted when no
          peers are live (solo case → byte-identical to a single-player deck). One
          line per seat; the `seats` label leads the first, the rest align under it. */}
      {seats.length > 0 ? (
        <Box flexDirection="column">
          {seats.map((s, i) => (
            <Text key={s.seat} wrap="truncate-end">
              <Text color={tok.textMuted}>{i === 0 ? 'seats  ' : '       '}</Text>
              <Text color={tok.success}>{s.seat}</Text>
              {s.verb ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <Text color={tok.textPrimary}>{s.verb}</Text>
                </>
              ) : null}
              {s.branch ? (
                <>
                  <Text color={tok.textMuted}>{' · ' + GLYPH.branch}</Text>
                  <Text color={tok.textPrimary}>{truncateToWidth(s.branch, 20)}</Text>
                </>
              ) : null}
              {s.lastLine ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <Text color={tok.textMuted}>{truncateToWidth(s.lastLine, 40)}</Text>
                </>
              ) : null}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* row 2: git + limits — ONE glance row (declutter: the strip is
          for LIVE vitals, and two sparse rows read as clutter; the operator's
          "cluttered and nonsensical" pass). Git leads (identity), the 5h/7d quota
          follows so truncate-end sheds the decoration before the repo state.
          UsageMeter stays honest (em-dash when a window header is absent).
          COMPACT folds git into row 1 and cedes quota to the frame/rail. */}
      {!compact ? (
      <Text wrap="truncate-end">
        {git === null ? (
          <Text color={tok.textMuted}>git: not a repository</Text>
        ) : (
          <>
            <Text color={tok.textMuted}>{GLYPH.branch}</Text>
            <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 24)}</Text>
            <Text color={tok.textMuted}> · </Text>
            {git.isClean ? (
              <Text color={tok.success}>clean</Text>
            ) : (
              <Text color={tok.warning}>uncommitted</Text>
            )}
            {/* real unpushed-commit count (↑N) when known; a bare ↑ when not in sync
                but the count is unavailable (no/diverged upstream) — never a
                count-implying word. unpushedCount is folded into getGitState's batch. */}
            {git.unpushedCount > 0 ? (
              <Text color={tok.textSecondary}>{` · ↑${git.unpushedCount}`}</Text>
            ) : !git.isHeadOnRemote ? (
              <Text color={tok.textSecondary}> · ↑</Text>
            ) : null}
            {git.worktreeCount > 1 ? <Text color={tok.textSecondary}>{` · ⌂${git.worktreeCount}`}</Text> : null}
          </>
        )}
        {sourceUsage.windows.length > 0 ? <Text color={tok.textMuted}>{'   ·   '}</Text> : null}
        {sourceUsage.windows[0] !== undefined ? (
          <UsageMeter compact window={sourceUsage.windows[0].label} state={sourceUsage.windows[0].state} value={sourceUsage.windows[0].usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: sourceUsage.windows[0].resetsAtMs ?? null })} />
        ) : null}
        {sourceUsage.windows[1] !== undefined && cols >= LAYOUT_BREAKPOINTS.cockpitMin ? (
          <>
            <Text color={tok.textMuted}> {GLYPH.dot} </Text>
            <UsageMeter compact window={sourceUsage.windows[1].label} state={sourceUsage.windows[1].state} value={sourceUsage.windows[1].usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: sourceUsage.windows[1].resetsAtMs ?? null })} />
          </>
        ) : null}
        {((): React.ReactNode => {
          // A reached limit on the ACTIVE source — one neutral chip from the
          // owner's observed fact, whatever the family (never a fabricated %).
          if (sourceUsage.limited === undefined) return null
          return (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <Text color={tok.warning}>{`limit · resets ${formatCountdown(sourceUsage.limited.resetsAtMs - now)}`}</Text>
            </Text>
          )
        })()}
      </Text>
      ) : null}

      {/* row 4: tasks — progress (done/total); the in-progress task GLOWS the
          session accent (bold = the terminal glow idiom; under scribe mode the
          accent itself glows a brightened version of the active critter — the crab
          ember, or a glowing teal/violet for other critters), completed tasks
          PERSIST as ticked rows until the whole ledger is done, then collapse to a
          ✓ summary. COMPACT cedes the row (the board/rail own the ledger). */}
      {!compact ? (
      <Text wrap="truncate-end">
        <Text color={tok.textMuted}>{`tasks (${completed.length}/${all.length}) `}</Text>
        {tasks === null ? (
          <Text color={tok.textMuted}>…</Text>
        ) : all.length === 0 ? (
          <Text color={tok.textMuted}>none</Text>
        ) : allDone ? (
          <Text color={tok.success}>{`${GLYPH.done} ${all.length}/${all.length} complete`}</Text>
        ) : (
          shown.map((t, i) => {
            const isActive = t.status === 'in_progress'
            const isDone = t.status === 'completed'
            const label = truncateToWidth(
              isActive ? t.activeForm || t.subject : t.subject,
              32,
            )
            const glyph = isDone ? GLYPH.done : '○'
            const glyphCol = isActive ? TERRA : isDone ? tok.success : tok.textMuted
            const labelCol = isActive ? tok.textPrimary : isDone ? tok.textMuted : tok.textSecondary
            return (
              <Text key={i}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                {isActive ? (
                  // the in-progress marker ROTATES while its task runs —
                  // degraded states render the same static ◐ as before
                  <WorkingGlyph color={glyphCol} />
                ) : (
                  <Text color={glyphCol}>{glyph}</Text>
                )}
                <Text bold={isActive} color={glyphCol}>
                  {' '}
                </Text>
                <Text bold={isActive} color={labelCol}>
                  {label}
                </Text>
              </Text>
            )
          })
        )}
        {!allDone && ordered.length > shown.length ? (
          <Text color={tok.textMuted}>{` +${ordered.length - shown.length}`}</Text>
        ) : null}
        {blockedCount > 0 ? (
          <Text color={tok.warning}>{` · ${GLYPH.conflict}${blockedCount} blocked`}</Text>
        ) : null}
      </Text>
      ) : null}

      {/* row 4b: ledger-tracker — per-group done/total. Completed groups tick tok.success,
          in-progress groups glow the accent. Shown only with >1 real group — a
          single implicit 'session' group would just restate row 4's task count. */}
      {!compact && ledgerGroups.length > 1 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>ledger  </Text>
          {ledgerGroups.map(([label, g], i) => {
            const groupDone = g.done === g.total
            return (
              <Text key={label}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                <Text bold={!groupDone} color={groupDone ? tok.success : TERRA}>
                  {groupDone ? GLYPH.done : GLYPH.inProgress}{' '}
                </Text>
                <Text color={groupDone ? tok.textMuted : tok.textPrimary}>{truncateToWidth(label, 18)}</Text>
                <Text color={tok.textMuted}>{` ${g.done}/${g.total}`}</Text>
              </Text>
            )
          })}
        </Text>
      ) : null}

      {/* row 4: ctx — the LIVE context vital, alone. The env counts (mcp · skills
          · extensions) moved OFF the strip (declutter): they're
          set-and-forget environment facts, and the full /deck snapshot is their
          single owner now. Honest faint empty bar + window size before the first
          usage-bearing turn. COMPACT folds ctx into row 1. */}
      {!compact && ctx.window > 0 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{'ctx '}</Text>
          {ctx.usedPct != null ? (
            <Text>
              <ProgressBar value={ctx.usedPct} max={100} width={5} showPct />
              <Text color={tok.textMuted}>{` · ${ctx.fillSource === 'estimate' ? '≈' : ''}${ctxUsedK}k/${ctxWinLabel}`}</Text>
            </Text>
          ) : (
            <Text>
              <ProgressBar value={0} max={100} width={5} tone={tok.textMuted} />
              <Text color={tok.textMuted}>{` · ${ctxWinLabel} window`}</Text>
            </Text>
          )}
          {/* effort: removed — the PromptInput footer (EffortCallout) is its single owner (datum-dedup) */}
        </Text>
      ) : null}

      {/* row 5: LIVE ops rail (daemon · fleet · trace), severity-forward. The agent
          needs-attention alarm + its actionable verdict text are FRONT-positioned so
          truncate-end clips the calm tail before the alarm at 80 cols.
          The declutter: the set-and-forget posture chips moved to their
          single owner, the full /deck snapshot — `subs N/M` (substrate count),
          `mcp ≤ceiling` (policy posture), the scheduling gate, and the whole
          wrapper/substrate profile row. The strip keeps only what CHANGES
          mid-session; the capability-KILL alarm stays (a real exposure signal).
          ONE definition (opsRow above) — rendered here standalone, or inside
          the compact companion dock's right column when the dock is up. */}
      {compact && companionOn ? null : opsRow}

      {/* row 7+ (scribe-only): the Scribe's WORKSPACE — honest dual-agent status,
          the prompt ledger, and a compact reasoning feed (from the live transcript
          mirror + the W5 daemon roster). The retired 3-way view + WoW chat tabs are
          gone; the REPL is the conversation now. Omitted when scribe mode is off. */}
      {isScribeModeOn()
        ? (() => {
            const impl = implRoster?.entry ?? null
            const scribeCtx = getLiveContextUsage().usedPct
            const ledger = buildScribeLedger(chatMessages)
            const ledgerColor = (s: string): string =>
              s === 'done'
                ? tok.success
                : s === 'failed' || s === 'blocked' || s === 'escalated'
                  ? tok.failure
                  : tok.textSecondary
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={tok.info}>
                  Amanuensis
                </Text>
                {/* dual-agent status: Scribe (foreground) + Implementer (daemon) */}
                <Text wrap="truncate-end">
                  <Text color={tok.success}>{GLYPH.busy} </Text>
                  <Text color={tok.textPrimary}>Scribe</Text>
                  <Text color={tok.textMuted}>{` · ${model}${effortLevel ? ` @${effortLevel}` : ''} · `}</Text>
                  {scribeCtx != null ? (
                    <ProgressBar value={scribeCtx} max={100} width={6} showPct />
                  ) : (
                    <Text color={tok.textMuted}>—</Text>
                  )}
                </Text>
                <Text wrap="truncate-end">
                  {/* #25 true-idle: busy ⇒ ◐ tok.success ROTATING (mid-task — the honest
                      work signal from the roster); genuinely idle ⇒ · tok.textSecondary
                      (drained, nothing in flight); absent ⇒ tok.textMuted offline.
                      OUTCOME FIRST (product-study r3): a settled worker — DEGRADED
                      after the respawn budget, killed, crashed — must never wear
                      the working/idle costume; the roster keeps settled entries
                      until reap, so this row is the operator's only ambient tell. */}
                  {impl?.outcome ? (
                    <Text color={impl.outcome === 'degraded' ? tok.failure : tok.textMuted}>{GLYPH.fail}</Text>
                  ) : impl?.busy ? (
                    <WorkingGlyph color={tok.success} />
                  ) : (
                    <Text color={impl ? tok.textSecondary : tok.textMuted}>{GLYPH.idle}</Text>
                  )}
                  <Text> </Text>
                  <Text color={tok.textPrimary}>Implementer</Text>
                  {impl ? (
                    <Text>
                      <Text color={tok.textMuted}>{` · ${renderModelName(impl.model ?? '?')}${impl.effort ? ` @${impl.effort}` : ''}`}</Text>
                      {impl.outcome === 'degraded' ? (
                        <Text color={tok.failure}> · DEGRADED — not coming back (see /daemon)</Text>
                      ) : impl.outcome ? (
                        <Text color={tok.textMuted}>{` · dead (${impl.outcome})`}</Text>
                      ) : impl.busy === true ? (
                        <Text color={tok.success}> · working</Text>
                      ) : impl.busy === false ? (
                        <Text color={tok.textSecondary}> · idle</Text>
                      ) : null}
                      <Text color={tok.textMuted}>{' · '}</Text>
                      {impl.contextPct != null ? (
                        <ProgressBar value={impl.contextPct} max={100} width={6} showPct />
                      ) : (
                        <Text color={tok.textMuted}>—</Text>
                      )}
                      {impl.respawns ? <Text color={tok.textMuted}>{` · ↻${impl.respawns}`}</Text> : null}
                    </Text>
                  ) : (
                    // deck-estarting: a BOOTING daemon
                    // (ESTARTING — the ~1-2s pipe bind, crewClient's own
                    // vocabulary) says so instead of reading 'offline'; an
                    // unrecognised wire code paints a human word with the
                    // code in parens, never the bare code.
                    <Text color={tok.textMuted}>{` · ${implRoster ? (implRoster.reason === 'ESTARTING' ? 'daemon starting…' : implRoster.reason === 'ENOCONN' || implRoster.reason === 'ETIMEOUT' ? 'offline (no daemon)' : implRoster.reason === 'not in roster' ? 'not spawned' : `unreachable (${implRoster.reason})`) : 'probing…'}`}</Text>
                  )}
                  {/* queued = written to the inbox, not yet drained by the daemon.
                      tok.warning once the oldest has sat >30s — the deaf-bus signature. */}
                  {busQueue && busQueue.queued > 0 ? (
                    <Text
                      color={
                        busQueue.oldestMs !== null && busQueue.oldestMs > 30_000 ? tok.warning : tok.textMuted
                      }
                    >
                      {` · ${busQueue.queued} queued${
                        busQueue.oldestMs !== null
                          ? ` ${Math.round(busQueue.oldestMs / 1000)}s`
                          : ''
                      }`}
                    </Text>
                  ) : null}
                </Text>
                {/* #47 the operator's THREE ledgers, all from REAL data (never fabricated):
                    · in flight — dispatched work not yet done (tok.success ●)
                    · completed — done dispatches persist here (the "completed list")
                    · batches   — queued prompts grouped into category batches (the phase-out
                      queue), sourced from the command QUEUE, not the transcript. */}
                {(() => {
                  const inFlight = ledger.filter(e => e.status !== 'done')
                  const completed = ledger.filter(e => e.status === 'done')
                  const batches = buildScribeBatchLedger(queuedCommands)
                  return (
                    <>
                      {inFlight.length > 0 ? (
                        <Box flexDirection="column">
                          <Text>
                            <Text color={tok.success}>{GLYPH.busy} </Text>
                            <Text color={tok.textMuted}>in flight</Text>
                          </Text>
                          {inFlight.slice(-4).map((e, i) => {
                            // Age from the envelope stamps (delivery honesty):
                            // unstamped entries render no age — never fabricated.
                            // 'dispatched' with no ack past the threshold reads
                            // tok.warning 'undelivered?' (a long 'working' is fine).
                            const now = Date.now()
                            const unacked = isDispatchUnacked(e, now)
                            const ageBase = e.lastUpdateTs ?? e.dispatchedTs
                            const ageS =
                              ageBase !== undefined
                                ? Math.max(0, Math.round((now - ageBase) / 1000))
                                : null
                            return (
                              <Text key={i} wrap="truncate-end">
                                <Text color={unacked ? tok.warning : ledgerColor(e.status)}>{` ${e.status}`}</Text>
                                {unacked ? (
                                  // waiting-on-attention BREATHES — the deaf-bus
                                  // signature must catch the eye, not sit flat
                                  <AttentionPulse> undelivered?</AttentionPulse>
                                ) : null}
                                {ageS !== null ? (
                                  <Text color={unacked ? tok.warning : tok.textMuted}>
                                    {` ${ageS < 60 ? `${ageS}s` : `${Math.round(ageS / 60)}m`}`}
                                  </Text>
                                ) : null}
                                <Text color={tok.textMuted}>{` · ${e.title}`}</Text>
                              </Text>
                            )
                          })}
                        </Box>
                      ) : null}
                      {completed.length > 0 ? (
                        <Box flexDirection="column">
                          <Text color={tok.textMuted}>{`${GLYPH.done} completed (${completed.length})`}</Text>
                          {completed.slice(-3).map((e, i) => (
                            <Text key={i} wrap="truncate-end" color={tok.textMuted}>
                              <Text color={tok.success}>{` ${GLYPH.done}`}</Text>
                              <Text>{` ${e.title}`}</Text>
                            </Text>
                          ))}
                        </Box>
                      ) : null}
                      {batches.length > 0 ? (
                        <Box flexDirection="column">
                          <Text>
                            <Text color={tok.textMuted}>{GLYPH.idle} </Text>
                            <Text color={tok.textMuted}>{`batches (${batches.reduce((n, b) => n + b.items.length, 0)} queued)`}</Text>
                          </Text>
                          {batches.slice(0, 4).map((b, i) => (
                            <Text key={i} wrap="truncate-end">
                              <Text color={tok.textSecondary}>{` ${b.category}`}</Text>
                              <Text color={tok.textMuted}>{` ·${b.items.length}· ${b.items[0]}`}</Text>
                            </Text>
                          ))}
                        </Box>
                      ) : null}
                    </>
                  )
                })()}
                {/* reasoning feed: the Scribe's recent operator-facing PROSE only
                    (no command XML / tool rows / envelopes). The header flashes tok.success
                    when a new turn lands — "the feed flashes when chat is happening." */}
                {scribeFeed.length > 0 ? (
                  <Box flexDirection="column">
                    <Text bold={feedFlash} color={feedFlash ? tok.success : tok.textMuted}>
                      {'feed'}
                      {feedFlash ? (
                        <>
                          {' '}
                          <WorkingGlyph color={tok.success} />
                        </>
                      ) : null}
                    </Text>
                    {scribeFeed.map((line, i) => (
                      <Text key={i} wrap="truncate-end" color={tok.textMuted}>
                        {` ${line}`}
                      </Text>
                    ))}
                  </Box>
                ) : null}
              </Box>
            )
          })()
        : null}
    </Box>
  )
})

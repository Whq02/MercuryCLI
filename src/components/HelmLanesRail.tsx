import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getOriginalCwd, getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { formatSessionCost } from '../cost-tracker.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import { workRowRuns } from '../services/engine-connector/workCounts.js'
import { promptRows } from './prompts-panel/rows.js'
import { filterResumableSessions } from '../commands/resume/resume.js'
import { Box, Text } from '../ink.js'
import { TERRA } from './mercuryPalette.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { isTerminalTaskStatus, type TaskStatus } from '../Task.js'
import { useAppState } from '../state/AppState.js'
import { getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask, isPanelAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { useFocusedWorkRoster } from '../tasks/useFocusedWork.js'
import { MAIN_CONVERSATION_ID } from '../services/crew/conversations.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import type { TaskState } from '../tasks/types.js'
import type { LogOption } from '../types/logs.js'
import { saturnWakeGlanceOf } from '../daemon/saturn.js'
import { readSessionWorkers } from '../daemon/concourseSupervisor.js'

/** Minute-grained elapsed/until spans for rail rows (re-homed from the old
 *  scheduler board when that estate retired — the rail was its last
 *  consumer). */
function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${Math.round(h / 24)}d`
}
import { getActiveMission } from '../utils/hooks/missionHook.js'
import { isTabulaEnabled, tabulaProjectDir } from '../utils/tabula/tabulaGates.js'
import { readNotesAsync, type TabulaNote } from '../utils/tabula/tabulaStore.js'
import {
  getMinervaBuffer,
  getMinervaCursor,
  getMinervaLastExchange,
  getMinervaPending,
  getMinervaReplVersion,
  isMinervaComposing,
  minervaReplEnabled,
  subscribeMinervaRepl,
} from '../utils/cockpit/minervaRepl.js'
import { isProjectSession, isSubstantiveSession } from '../utils/sessionFilter.js'
import { isSessionCleared } from '../utils/sessionStorage/clearedSessions.js'
import { isCrewSession } from '../utils/sessionClass.js'
import { boardHomedSessionIds } from '../daemon/concourseSupervisor.js'
import { getSessionIdFromLog, loadAllProjectsMessageLogs } from '../utils/sessionStorage.js'
import { getHelmCursor, getHelmFocus, getHelmLanesVersion, getHelmRows, helmRowSig, publishHelmRows, requestCommandDispatch, requestHelmRowActivation, requestHelmRowActivationBySig, setHelmCursor, setHelmCursorBySig, subscribeHelmFocus, type HelmRow } from '../utils/cockpit/helmFocus.js'
import {
  getLivePresence,
  getOperatorName,
  getPresenceVersion,
  subscribePresence,
  type PresenceSeat,
} from '../utils/cockpit/presenceLive.js'
import { getScribeEngagedAtMs, getScribeModeVersion, isScribeModeOn, subscribeScribeMode } from '../utils/scribeMode.js'

// The stale-CHAT epoch floor for role-env launches (setScribeMode never runs
// there): anything in the inbox files from before this module loaded belongs
// to an earlier session, not this one.
const RAIL_BOOT_MS = Date.now()
import { scribeBusLiveEnabled } from '../utils/scribe/scribeGates.js'
import { getMailboxStore, type TeammateMessage } from '../utils/teammateMailbox.js'
import {
  CREW_CHAT_ROWS,
  crewChatRowsFromMailbox,
  type CrewChatRow,
  type CrewChatTone,
} from '../utils/cockpit/crewChatRows.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import {
  getLiveContextUsage,
  getLiveContextUsageVersion,
  subscribeLiveContextUsage,
} from '../utils/cockpit/contextUsageLive.js'
import { contextPercentLabel, contextWindowLabel } from '../utils/contextFill.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import { useNowTick } from './mercury-ui/components.js'
import { GLYPH, displayWidth, truncateToWidth } from './mercury-ui/glyphs.js'
import { ValueGlow, CURSOR_NUDGE_MS, AttentionPulse, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { RailPanel, railPanelInnerWidth } from './mercury-ui/RailPanel.js'
import { densityPlan, hintBudget, HELM_DENSITY_FLOOR } from '../utils/helmDensity.js'
import { useCockpitActivity } from '../utils/cockpit/cockpitActivity.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { MercuryThemeTokens } from '../utils/mercuryTokens.js'
import { tabLabel } from './mercury-ui/SessionTabs.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js'
import { basename } from 'node:path'
import { getRunSnapshot, subscribeRuns } from '../services/run/runCoordinator.js'
import { isTerminalLifecycle } from '../services/run/runKernel.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { flagEnv } from '../substrate/flagRegistry.js'

// ============================================================================
//  HelmLanesRail — the LEFT rail of the A2.2 three-pane cockpit. A narrow
//  (~24-col) vertical lane-board: SEAT (human presence) · CREW (live agent
//  tasks from the app-store) · TASKS (the mission ledger) · RUNS (live
//  background processes — shells/monitors/workflows; ↵ drills to the task's
//  own card via `/tasks <id>`).
//
//  INTERACTIVE (A2.2 Phase-3): Tab from an empty prompt focuses this rail —
//  a focus banner appears, ↑↓ move the ❯ cursor, ↵ opens the row (CREW →
//  enterTeammateView center-swap; everything else → its owning surface), esc
//  returns to the prompt. The KEYS live in PromptInput (the one input owner);
//  this rail renders the ring/caret and PUBLISHES its selectable row model to
//  the helmFocus store so input and display can never disagree. It also still
//  MARKS the CREW row whose `.id` is the currently-viewed agent (the existing
//  agent-nav path, which stays available). CREW is capped (CREW_ROWS) with a
//  `+N more` (↵ → the owning surface); the SEAT peer list is capped
//  (PEER_ROWS) and display-only — presence paints, nothing opens, until the
//  new multiplayer owns it.
//
//  SOLO EMPTY-STATE: when there are no peers, no crew, and no open tasks, the
//  dead "no X" buckets give way to useful glanceables — RECENT resumable
//  sessions (the tab-strip's exact source), the active MISSION when set, and 2-3
//  FAINT next-action hints. They disappear the moment real rows exist.
//  (Quota/reset times stay in the telemetry rail — one datum, one owner.)
//
//  HONESTY: no lane ever fabricates a row (a stub lane is never mounted;
// a parked gets no standing empty section).
//  Every colour binds to a mercuryPalette token or a semantic tokens role.
// ============================================================================

// A CREW row sourced from the app-store tasks (NOT fleetGauge — that yields
// no drill-in id). `.id` is the drill-in key (enterTeammateView).
// `hosted`: a row of the focused session's runner (its roster over the
// connector) — it opens its work card; its transcript lives with the runner.
type CrewRow = { id: string; label: string; status: TaskStatus; hosted?: boolean }

// A CREW lane entry is an app-store task (drill-in teammate) or a DAEMON-CREW
// teammate (/teammates' named long-lived workers, ↵ → /teammates). The union
// keeps the render paths honest — only a task row has a drillable teammate
// id.
type CrewEntry =
  | { kind: 'task'; row: CrewRow }
  | { kind: 'daemon'; name: string; online: boolean; unread: number; model?: string }

// Word-wrap a WORK-lane fact into at most `maxRows` rail rows (the digest
// must be READABLE at a glance — every other rail row truncates, which is
// right for lists but ellipsizes the one fact the operator came to read).
// Overflow past the cap ellipsizes the final row.
export function wrapRailRows(text: string, width: number, maxRows: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const rows: string[] = []
  let line = ''
  const push = (row: string): boolean => {
    rows.push(row)
    if (rows.length === maxRows) {
      rows[maxRows - 1] = truncateToWidth(`${rows[maxRows - 1]!}…`, width)
      return true
    }
    return false
  }
  for (const w of words) {
    const candidate = line === '' ? w : `${line} ${w}`
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line !== '' && push(line)) return rows
    if (displayWidth(w) <= width) {
      line = w
      continue
    }
    // C11 (SSR-03): an over-wide token gets its own TRUNCATED
    // row. The old flush set `line = ''` for any token wider than the rail
    // — the token was deleted whole, and a Windows path simply vanished
    // from the WORK digest and the WORKBENCH card. Truncation is honest;
    // deletion is silent.
    if (push(truncateToWidth(w, width))) return rows
    line = ''
  }
  if (line !== '') rows.push(line)
  return rows.slice(0, maxRows)
}

// A live background PROCESS for the RUNS lane: a shell, monitor, workflow,
// cloud (remote-agent) run, or dream — every open app-store task that is
// neither a crew agent nor a plan item. `kind` derives from the task SHAPE
// (a Monitor is a local_bash with kind:'monitor' — Mercury's Monitor tool
// rides the shell substrate; monitor_mcp itself is DCE'd off), never from
// the label text.
type RunKind = 'shell' | 'monitor' | 'workflow' | 'cloud' | 'dream' | 'run'
type RunRow = { id: string; title: string; status: TaskStatus; kind: RunKind; startedAtMs: number }

function runKindOf(t: TaskState): RunKind {
  if (isLocalShellTask(t)) return t.kind === 'monitor' ? 'monitor' : 'shell'
  switch (t.type) {
    case 'local_workflow':
      return 'workflow'
    case 'remote_agent':
      return 'cloud'
    case 'monitor_mcp':
      return 'monitor'
    case 'dream':
      return 'dream'
    default:
      return 'run'
  }
}

// A status verb + its tone for a CREW/TASK row.
function statusTone(status: TaskStatus, tok: MercuryThemeTokens): { label: string; tone: string } {
  switch (status) {
    case 'running':
      return { label: 'running', tone: tok.success }
    case 'pending':
      return { label: 'pending', tone: tok.textSecondary }
    case 'completed':
      return { label: 'done', tone: tok.textMuted }
    case 'failed':
      return { label: 'failed', tone: tok.failure }
    case 'killed':
      return { label: 'killed', tone: tok.failure }
    default:
      return { label: status, tone: tok.textMuted }
  }
}

// --- a single rendered row -------------------------------------------------
//  caret(2: ❯+space when the rail cursor sits here, else indent) + dot(2:
//  glyph + space) + name + ' · ' + verb, fitted to `width`. The width math
//  reserves the verb first (the status is load-bearing on a narrow rail) then
//  gives the name the remainder; the wrapping Box+truncate is the hard cap.
function RailRow({
  width,
  glyph,
  glyphColor,
  glyphLive = false,
  name,
  nameColor,
  verb,
  verbColor,
  verbPulse = false,
  selected = false,
  rowIndex,
  rowSig,
}: {
  width: number
  glyph: string
  glyphColor: string
  /** Genuinely-running rows ROTATE their state glyph (WorkingGlyph — the
   *  standing-liveness grammar: motion = work running). Frame 0 is the same
   *  ◐ the static row painted, so degraded states render identically. */
  glyphLive?: boolean
  name: string
  nameColor: string
  verb?: string
  verbColor?: string
  /** Waiting-on-you verbs BREATHE (AttentionPulse — the standing-liveness
   *  grammar: pulse = needs-you). Only the verb animates, never the name. */
  verbPulse?: boolean
  selected?: boolean
  // The row's index in the published model — enables CLICK parity (the same
  // activation the keyboard ↵ performs) + a hover highlight so clickability
  // is visible (operator polish pass). Rows without an index stay inert.
  rowIndex?: number
  /** Stable interaction identity: the row's helmRowSig — pointer verbs + hover claim ride
   *  identity when present (index stays the legacy fallback). */
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const indentW = 2
  const dotW = 2
  const sep = ' · '
  const sepW = verb ? displayWidth(sep) : 0
  const verbBudget = verb
    ? Math.min(12, Math.max(0, width - indentW - dotW - sepW - 4))
    : 0
  const verbT = verb ? truncateToWidth(verb, verbBudget) : ''
  const nameBudget = Math.max(
    3,
    width - indentW - dotW - (verbT ? sepW + displayWidth(verbT) : 0),
  )
  const nameT = truncateToWidth(name, nameBudget)

  const clickable = rowIndex != null
  // the ONE kernel row — first click selects (moves the rail
  // cursor), second click activates, matching TelemetryRow + the grammar.
  return (
    <InteractiveRow
      id={`helm:lanes:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
        {glyphLive ? (
          <WorkingGlyph color={glyphColor} active />
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
        <Text> </Text>
        <Text color={nameColor}>{nameT}</Text>
        {verbT ? (
          <Text>
            <Text color={tok.textMuted}>{sep}</Text>
            {verbPulse ? (
              <AttentionPulse>{verbT}</AttentionPulse>
            ) : (
              <Text color={verbColor ?? tok.textMuted}>{verbT}</Text>
            )}
          </Text>
        ) : null}
      </Text>
    </InteractiveRow>
  )
}


// One call site shape for selectable rows: registers the row, marks the caret,
// and hands RailRow its index for click/hover parity.
function railRowProps(
  isOn: (i: number) => boolean,
  sel: (r: HelmRow) => number,
  row: HelmRow,
): { selected: boolean; rowIndex: number; rowSig: string } {
  const i = sel(row)
  // Stable interaction identity: the row's travels with it — the pointer verbs and
  // the hover claim ride identity, never the position (a live-store publish
  // between render and click would otherwise retarget both).
  return { selected: isOn(i), rowIndex: i, rowSig: helmRowSig(row) }
}

// Last-known async-glance snapshots:
// a rail remount paints the previous answer SYNCHRONOUSLY instead of a
// skeleton that grows when the async scan lands. RECENT is keyed by
// (project, session) scope — another project's rows can never flash here;
// the wake glance is config-home-global (schedules are daemon-wide).
// Process-lifetime, bounded by scopes visited. Errors are never cached.
const lastKnownRecent = new Map<string, LogOption[]>()
let lastKnownWakeGlance: { count: number; nextFireMs: number | null } | null = null
// the last-known open-notes fold — the rail paints this while
// the async journal refresh is in flight (same idiom as the wake glance).
// Scope-keyed by project dir (closing verify-wave note: a module-global
// cache showed the PREVIOUS project's notes for one async beat after a
// cross-project switch).
const lastKnownTabulaOpenByDir = new Map<string, TabulaNote[]>()
// The M2 brief's execution-shape answers, keyed by objective (bounded).
const lastKnownWorkShape = new Map<string, string>()

// The WORKBENCH card's live feed: the focused chat's records through the ONE
// connector slot (the door re-attaches across concourse hops, and the
// subscribe function is module-stable for useSyncExternalStore).
const subscribeFocusedRecords = subscribeThroughFocused((c, l) => c.subscribeRecords(l))

// CHAT tones → theme tokens (the derive is React-free and returns semantics;
// the color binding lives here, beside the other rail tone maps — resolved
// through the ADAPTIVE layer since HZ2, so light/daltonized/ansi
// families read their own inks instead of dark-brand leftovers).
function chatTone(tone: CrewChatTone, tok: MercuryThemeTokens): string {
  switch (tone) {
    case 'ok':
    case 'work':
      return tok.success
    case 'warn':
      return tok.warning
    case 'block':
      return tok.failure
    default:
      return tok.textSecondary
  }
}

// A mini-chat feed line (#71): caret + tone glyph + SECOND route + IVORY gist.
// RailRow's shape reserves a ≤12-col verb FIRST — wrong budget split for a
// feed whose payload IS the long gist — so this is its own hand-rolled row
// (the sanctioned command-center idiom), with the same click/hover parity.
function ChatRow({
  width,
  row,
  selected = false,
  rowIndex,
  rowSig,
}: {
  width: number
  row: CrewChatRow
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  // TWO-LINE row (visual audit: the one-line form left the gist
  // ~8-13 chars at rail width — the flagship feed was illegible on day one).
  // Line 1: caret + tone glyph + full route. Line 2: the gist, indented, with
  // the WHOLE remaining width. One logical row for selection/click.
  const routeT = truncateToWidth(row.route, Math.max(6, width - 4))
  const gistT = truncateToWidth(row.gist, Math.max(3, width - 4))
  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:chat:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
      flexDirection="column"
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={chatTone(row.tone, tok)}>{row.glyph} </Text>
        <Text color={tok.textSecondary}>{routeT}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={tok.textPrimary}>{'    '}{gistT}</Text>
      </Text>
    </InteractiveRow>
  )
}

// The WORKBENCH card's one row (the ruled card under Minerva): the last sent
// prompt wrapped to the card's budget — the payload IS the long text, so this
// is the ChatRow shape (a hand-rolled multi-line InteractiveRow with the same
// click/hover parity), never RailRow's verb-first budget split.
function WorkbenchCardRow({
  width,
  lines,
  selected = false,
  rowIndex,
  rowSig,
}: {
  width: number
  /** The wrapped prompt rows; null = no prompt sent yet (the placeholder). */
  lines: string[] | null
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:workbench:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
      flexDirection="column"
    >
      {lines === null ? (
        <Text wrap="truncate-end">
          <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
          <Text color={tok.textMuted}>no prompts sent yet</Text>
        </Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            <Text color={accent}>{i === 0 && selected ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={tok.textPrimary}>{l}</Text>
          </Text>
        ))
      )}
    </InteractiveRow>
  )
}

// A FAINT '+N more' overflow row — shown when a capped lane (CREW / peers /
// RUNS) has more rows than it renders, so the lane stays bounded without
// hiding the count. Selectable: ↵ opens the owning surface — and CLICK does
// the same (every call site already passes railRowProps' rowIndex; the row
// would otherwise silently ignore it, leaving the one keyboard-only row in the rail).
function MoreRow({
  n,
  width,
  selected = false,
  rowIndex,
  rowSig,
}: {
  n: number
  width: number
  selected?: boolean
  rowIndex?: number
  rowSig?: string
}): React.ReactNode {
  const { accent } = useSessionAccent()
  const tok = useMercuryTokens()
  const clickable = rowIndex != null
  return (
    <InteractiveRow
      id={`helm:lanes:more:${rowSig ?? rowIndex ?? 'static'}`}
      selected={selected}
      unavailable={!clickable}
      onSelect={
        clickable
          ? () => (rowSig ? setHelmCursorBySig('lanes', rowSig) : setHelmCursor('lanes', rowIndex))
          : undefined
      }
      onActivate={
        clickable
          ? () =>
              rowSig
                ? requestHelmRowActivationBySig('lanes', rowSig)
                : requestHelmRowActivation('lanes', rowIndex)
          : undefined
      }
      width={width}
    >
      <Text wrap="truncate-end">
        <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={tok.textMuted}>{`+${n} more`}</Text>
      </Text>
    </InteractiveRow>
  )
}

// A FAINT section header (display-only chrome, never selectable).
function SectionHeader({ label, width }: { label: string; width: number }): React.ReactNode {
  // Lane names are INFORMATIONAL headings: they ride the
  // info channel (OASIS in dark), keeping the ` · <count>` tail FAINT. The
  // pre-AURORA bold-accent name put up to 13 competing red headings in one
  // viewport — identity now lives with the brand block, hero and caret only.
  // Status tones (TEAL/AMBER/CRIMSON) stay fixed.
  const { info, textMuted } = useMercuryTokens()
  const sep = label.indexOf(' · ')
  const name = sep >= 0 ? label.slice(0, sep) : label
  const tail = sep >= 0 ? label.slice(sep) : ''
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={info} bold>
          {name}
        </Text>
        {tail ? <Text color={textMuted}>{tail}</Text> : null}
      </Text>
    </Box>
  )
}

// Per-lane row caps so a long CREW (or peer list) can never push TASKS off
// the bottom of the rail (the lane has no scroll). Overflow shows a FAINT '+N more'.
const CREW_ROWS = 6
const PEER_ROWS = 4
const RUNS_ROWS = 4

// React.memo boundary: always-mounted cockpit chrome —
// parent commits (keystrokes/streaming) no longer re-run the rail's snapshot
// reads; its own subscriptions (pane-scoped helm version, presence) still
// drive updates. `width` is the sole prop.
export const HelmLanesRail = React.memo(HelmLanesRailImpl)

function HelmLanesRailImpl({ width, mergedTelemetry = false, availRows }: { width: number; mergedTelemetry?: boolean; availRows?: number }): React.ReactNode {
  fluxMark('render:rail-lanes')
  const tok = useMercuryTokens()
  // What the session is DOING — published once by the REPL, subscribed here
  // (HZ5). Drives the density plan below; nothing else in the rail re-derives
  // an activity threshold.
  const activity = useCockpitActivity()
  // SEAT lane sync store — subscribe so the rail repaints the instant a peer
  // publishes/leaves. getLivePresence() returns a FRESH array each call, so it
  // can NEVER be the getSnapshot (useSyncExternalStore would loop on Object.is);
  // the monotonic version counter IS the snapshot, the peer set is read
  // separately at render. (Same pattern as DeckPane.tsx.)
  const presenceVersion = useSyncExternalStore(subscribePresence, getPresenceVersion, getPresenceVersion)
  // The published context fill (MercuryFrame → contextUsageLive): a window
  // landing from a catalogue or a usage arriving repaints the ctx glance at
  // once instead of waiting on the next message-driven render.
  const ctxUsageVersion = useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const peers: PresenceSeat[] = getLivePresence()
  // A2.2 Phase-3 focus model — same version-snapshot pattern; the focus pane +
  // cursor are read separately. The rail renders the ring/caret only; the KEYS
  // live in PromptInput (the one input owner), reading the same store.
  const lanesVersion = useSyncExternalStore(subscribeHelmFocus, getHelmLanesVersion, getHelmLanesVersion)
  // The TABULA ask line (minervaRepl store) — compose keystrokes, pending
  // state, and the settle receipt all repaint through this subscription.
  const minervaVersion = useSyncExternalStore(subscribeMinervaRepl, getMinervaReplVersion, getMinervaReplVersion)
  const focused = getHelmFocus() === 'lanes'
  const cur = getHelmCursor('lanes')
  const { accent } = useSessionAccent()

  // WORKBENCH card feed — the focused chat's sent prompts through the
  // panel's OWN derive (promptRows), so the card and /workbench can never
  // disagree about what was sent. records() is the connector's stable
  // painted snapshot (safe as getSnapshot); the memo re-derives only when a
  // record actually lands.
  const focusedRecords = useSyncExternalStore(
    subscribeFocusedRecords,
    () => getFocusedSessionConnector().records(),
    () => getFocusedSessionConnector().records(),
  )
  const lastSentPrompt = React.useMemo(() => {
    const rows = promptRows(focusedRecords)
    return rows.length > 0 ? rows[rows.length - 1]! : null
  }, [focusedRecords])

  // WORK lane feed: the run kernel's own snapshot through the
  // coordinator's existing subscription — event-driven, no timer, and the
  // snapshot reference is stable between events (safe for the sync store).
  const workRunSnap = useSyncExternalStore(
    subscribeRuns,
    () => getRunSnapshot(processMainOwner()),
    () => null,
  )
  // The BRIEF window: a formed multi-item plan with
  // nothing landed yet — the pre-broad-mutation moment. The execution shape
  // comes from the H3 mission-policy owner (async, probe-shaped, last-known
  // cached by objective — the wake-glance idiom); everything else the brief
  // needs (model/effort chip, outcome, items) is already on screen.
  const planningObjective =
    workRunSnap &&
    workRunSnap.substantive &&
    !isTerminalLifecycle(workRunSnap.lifecycle) &&
    workRunSnap.deliverables.length >= 2 &&
    workRunSnap.deliverables.every(d => d.state !== 'done')
      ? workRunSnap.objective
      : null
  const [workShape, setWorkShape] = useState<string | null>(() =>
    planningObjective ? (lastKnownWorkShape.get(planningObjective) ?? null) : null,
  )
  useEffect(() => {
    if (!planningObjective) return
    let alive = true
    void import('../services/mission/projection.js')
      .then(async m => {
        const d = await m.gatherPolicyDecision(planningObjective, 0)
        if (alive && d) {
          if (lastKnownWorkShape.size > 8) lastKnownWorkShape.clear()
          lastKnownWorkShape.set(planningObjective, d.profile.id)
          setWorkShape(d.profile.id)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [planningObjective])

  // BOXED tier: in the WIDE both-rails cockpit every
  // section wears the RailPanel card (rounded DUNE border + glyph header).
  // The single-rail tiers (mergedTelemetry — 100–149 cols, rail 20–24 wide)
  // keep the flat SectionHeader layout: a slim rail has no cells to spend on
  // border chrome. Rows are built at the interior width in boxed mode.
  const boxed = !mergedTelemetry
  const rowW = boxed ? railPanelInnerWidth(width) : width

  // CHAT feed (#71) — router-agent activity as compact nameplated lines:
  // the team-'scribe' inbox tails (implementer + team-lead), live via the
  // mailbox kernel stores. Not engaged ⇒ zero rows ⇒ the section renders
  // NOTHING (byte-identical for plain sessions).
  // Version-subscribed so a MID-SESSION scribe engage re-renders this rail —
  // isScribeModeOn() is module state React can't see (the keybinding-gotchas
  // class; useSyncExternalStore is the sanctioned bridge).
  const scribeVersion = useSyncExternalStore(subscribeScribeMode, getScribeModeVersion, getScribeModeVersion)
  const scribeChatOn = isScribeModeOn() && scribeBusLiveEnabled()
  const [scribeInboxes, setScribeInboxes] = useState<
    Array<{ inbox: string; messages: TeammateMessage[] }>
  >([])
  useEffect(() => {
    if (!scribeChatOn) {
      setScribeInboxes(prev => (prev.length > 0 ? [] : prev))
      return
    }
    const unsubs = ['implementer', 'team-lead'].map(name =>
      getMailboxStore(name, 'scribe').subscribe(
        msgs => {
          setScribeInboxes(prev => {
            const rest = prev.filter(p => p.inbox !== name)
            return [...rest, { inbox: name, messages: msgs }]
          })
        },
        { immediate: true },
      ),
    )
    return () => {
      for (const u of unsubs) u()
    }
  }, [scribeChatOn])
  const chatRows: CrewChatRow[] = scribeChatOn
    ? // Engagement-epoch scoped: inbox
      // files outlive sessions, so only traffic since THIS engage renders.
      // A role-env launch (MERCURY_SCRIBE=1) never calls setScribeMode, so
      // fall back to the rail module's load time — old mail predates boot.
      crewChatRowsFromMailbox(scribeInboxes, CREW_CHAT_ROWS, getScribeEngagedAtMs() ?? RAIL_BOOT_MS)
    : []

  // CREW lane — sourced from the app-store tasks (NOT fleetGauge): the
  // in-process teammates + the local-agent tasks, deduped by `.id`.
  const tasks = useAppState(s => s.tasks)
  // Reflect (read-only) which agent's transcript is currently drilled into the
  // center — set by the EXISTING agent-nav (enterTeammateView → viewingAgentTaskId,
  // Shift+↑/↓ + Enter). The cockpit reuses that tested nav; this just marks the row.
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // The focused session's OWN agents — its runner's roster over the
  // connector, the same rows the /tasks board and the concourse chip count
  // (workCounts). A hosted session runs the model's tools in its runner, so
  // an agent it spawns never enters this screen's task store; the roster is
  // how it reaches the rail. One owner: useFocusedWorkRoster.
  const roster = useFocusedWorkRoster()

  const ipRows: CrewRow[] = getAllInProcessTeammateTasks(tasks).map(t => ({
    id: t.id,
    label: t.identity.agentName,
    status: t.status,
  }))
  // isPanelAgentTask, NOT isLocalAgentTask — the latter includes the backgrounded
  // MAIN session (agentType 'main-session'), which would leak in as a mislabeled,
  // undrillable CREW row (audit S8). Panel agents exclude it.
  const laRows: CrewRow[] = Object.values(tasks)
    .filter(isPanelAgentTask)
    .map(t => ({ id: t.id, label: t.description || t.agentType, status: t.status }))
  // The runner's running/pending agent + teammate rows; a row this screen
  // also holds locally keeps its local (drillable) identity.
  const hostedRows: CrewRow[] = roster.rows
    .filter(r => (r.kind === 'agent' || r.kind === 'teammate') && workRowRuns(r))
    .map(r => ({ id: r.id, label: r.name, status: r.status === 'pending' ? 'pending' : 'running', hosted: true }))
  const crewById = new Map<string, CrewRow>()
  for (const r of [...ipRows, ...laRows, ...hostedRows]) {
    if (!crewById.has(r.id)) crewById.set(r.id, r)
  }
  // Order so the cap keeps the most relevant rows: running first, then the one you're
  // viewing, then the rest. CREW is otherwise unbounded and would clip TASKS
  // off the bottom of the scroll-less rail (audit M4).
  const crewAll = [...crewById.values()].sort((a, b) => {
    const score = (c: CrewRow) =>
      (c.status === 'running' ? 0 : 2) + (c.id === viewingAgentTaskId ? -1 : 0)
    return score(a) - score(b)
  })
  // Shared cockpit vitals (ONE bus subscription serves crew + the mission
  // ledger below — never two).
  const telemetry = useTelemetry()
  // The render-reason probe (MERCURY_FLUX_PROBE only; off ⇒ one boolean
  // check): which store version, prop or snapshot moved this rail render —
  // the region-invalidation matrix's reader names the feed that re-rendered
  // the rail while another region was the one being driven.
  const railWhyRef = React.useRef<Record<string, unknown> | null>(null)
  fluxWhy('rail-lanes', railWhyRef, () => ({
    width,
    mergedTelemetry,
    availRows,
    tok,
    activity,
    presenceVersion,
    ctxUsageVersion,
    lanesVersion,
    minervaVersion,
    scribeVersion,
    accent,
    focusedRecords,
    workRunSnap,
    workShape,
    scribeInboxes,
    tasks,
    roster,
    viewingAgentTaskId,
    telemetry,
  }))

  // DAEMON-CREW teammates (/teammates' named long-lived workers) — the shared
  // telemetry bus carries the glance (team file + control-socket liveness +
  // unread scan, refreshed on the bus cadence). Unread-first so a waiting
  // reply is never the row the cap hides; null/empty ⇒ zero rows (byte-
  // identical for crew-less sessions).
  const daemonCrewRaw = telemetry.crew ?? []
  const daemonCrew = [...daemonCrewRaw].sort(
    (a, b) =>
      b.unread - a.unread ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
  )

  // Daemon-crew teammates follow the task crew. The shared CREW_ROWS cap +
  // '+N more' still bound the scroll-less lane.
  const crewEntries: CrewEntry[] = [
    ...crewAll.map(row => ({ kind: 'task' as const, row })),
    ...daemonCrew.map(m => ({ kind: 'daemon' as const, ...m })),
  ]
  const crewShown = crewEntries.slice(0, CREW_ROWS)
  const crewMore = crewEntries.length - crewShown.length

  // RUNS lane — the live background PROCESSES (the agent ones live in CREW):
  // shells, monitors, workflows, cloud runs. Running first (a rotating ◐ is
  // the row you glance for), then pending; within a band the OLDEST leads —
  // a process table's stability, and the run you most likely forgot about.
  const runsAll: RunRow[] = Object.values(tasks)
    .filter(t => !isLocalAgentTask(t) && !isInProcessTeammateTask(t))
    .filter(t => !isTerminalTaskStatus(t.status))
    .map(t => ({
      id: t.id,
      title: t.description || (isLocalShellTask(t) ? t.command : t.type),
      status: t.status,
      kind: runKindOf(t),
      startedAtMs: t.startTime,
    }))
    .sort(
      (a, b) =>
        (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) ||
        a.startedAtMs - b.startedAtMs,
    )
  const runsShown = runsAll.slice(0, RUNS_ROWS)
  const runsMore = runsAll.length - runsShown.length
  const runsLive = runsAll.reduce((n, r) => n + (r.status === 'running' ? 1 : 0), 0)

  // MISSION ledger (TaskCreate/TaskUpdate — the operator-facing plan) via the
  // shared bus. In the cockpit this board is the ONE owner of the ledger:
  // the transcript's expanded ctrl+t tree defers here (Spinner.tsx), so a
  // running plan lives in the rail instead of cluttering the REPL flow.
  const ledger = telemetry.tasks
  const ledgerActive = ledger.filter(t => t.status === 'in_progress')
  const ledgerPending = ledger.filter(t => t.status === 'pending')
  const ledgerDone = ledger.filter(t => t.status === 'completed').length
  const ledgerOpen = ledgerActive.length + ledgerPending.length

  // ── WORK — the current-work digest ─────────────────────
  // Rendered ONLY while a substantive run exists (chat/idle sessions pay
  // nothing); while it renders, TASKS yields (the digest and the list never
  // duplicate — the full ledger stays one ↵ away on the owning board). Facts
  // come from the run kernel + the ledger's dependency edges; wrapped rows
  // keep the outcome/active/next READABLE, never ellipsized mid-fact.
  const work = (() => {
    if (isEnvDefinedFalsy(flagEnv('MERCURY_WORK_LANE'))) return null
    const snap = workRunSnap
    if (!snap || !snap.substantive) return null
    if (snap.lifecycle === 'cancelled') return null
    const w = Math.max(8, rowW - 2)
    const cont = Math.max(6, w - 2)
    const rows: Array<{ text: string; color: string }> = []
    const pushWrapped = (prefix: string, text: string, color: string, maxRows: number): void => {
      const parts = wrapRailRows(text, cont, maxRows)
      parts.forEach((p, i) =>
        rows.push({ text: i === 0 ? `${prefix}${p}` : `  ${p}`, color }),
      )
    }
    // 3 rows: the outcome is the headline fact — a real ask rarely fits two
    // slim-rail rows and an ellipsized outcome defeats the lane's point.
    pushWrapped('', snap.objective, tok.textPrimary, 3)
    const doneCount = snap.deliverables.filter(d => d.state === 'done').length
    const terminal = snap.lifecycle === 'completed'
    const statusBits = [terminal ? 'done' : snap.phase]
    if (snap.deliverables.length > 0) statusBits.push(`${doneCount}/${snap.deliverables.length}`)
    if (snap.unresolvedBadEffects > 0) statusBits.push(`${snap.unresolvedBadEffects}!`)
    rows.push({ text: truncateToWidth(statusBits.join(' · '), w), color: tok.textSecondary })
    // The M2 brief rows — ONLY inside the planning window (a formed plan,
    // nothing landed): the intended execution shape + the one edit/steer
    // teaching line. Gone the moment the first item completes; never shown
    // for direct tasks (no ceremony on small work).
    if (planningObjective !== null && snap.objective === planningObjective) {
      if (workShape) rows.push({ text: truncateToWidth(`via ${workShape}`, w), color: tok.textSecondary })
      pushWrapped('', 'plan: edit /tasks · steer by typing', tok.textMuted, 2)
    }
    const active = snap.deliverables.find(d => d.state === 'in-progress')
    if (active && !terminal) pushWrapped(`${GLYPH.busy} `, active.title || active.id, tok.success, 2)
    if (snap.blocker) {
      pushWrapped(`${GLYPH.circledBullet} `, `${snap.blocker.ownedBy}: ${snap.blocker.description}`, tok.warning, 2)
    } else if (snap.nextAction) {
      // 3 rows: the kernel's reconcile phrasing ("continue the open
      // deliverable: <title>") loses its meaning at a 2-row cap on the slim
      // rail. A terminal run keeps its next action too — the M4 delivery
      // mint names the review route there.
      pushWrapped('→ ', snap.nextAction, tok.success, 3)
    }
    const vState = snap.verification.state
    const vColor = vState === 'verified' ? tok.success : vState === 'failed' ? tok.failure : tok.warning
    if (snap.changedPaths.length > 0) {
      // node:path basename — platform-correct (a raw '/'-split is the win32
      // seam ratchet's exact tell class).
      const first = basename(snap.changedPaths[0]!)
      const extra = snap.totalChangedPaths - 1
      // Two rows, never one truncated one: the changed-file name and the
      // check verdict are BOTH facts the operator came to read.
      rows.push({ text: truncateToWidth(`± ${first}${extra > 0 ? ` +${extra}` : ''}`, w), color: tok.textSecondary })
      rows.push({ text: truncateToWidth(`checks: ${vState}`, w), color: vColor })
    } else if (terminal || snap.verification.state !== 'unverified') {
      rows.push({ text: truncateToWidth(`checks: ${vState}`, w), color: vColor })
    }
    const ledgerById = new Map(ledger.map(t => [t.id, t]))
    const openIds = new Set(ledger.filter(t => t.status !== 'completed').map(t => t.id))
    const isDepBlocked = (id: string): boolean =>
      (ledgerById.get(id)?.blockedBy ?? []).some(b => openIds.has(b))
    if (!terminal) {
      const queued = snap.deliverables.find(d => d.state === 'open' && !isDepBlocked(d.id))
      if (queued) pushWrapped(`${GLYPH.pending} `, queued.title || queued.id, tok.textSecondary, 2)
      const depBlocked = snap.deliverables.find(
        d => (d.state === 'open' || d.state === 'in-progress') && d.id !== active?.id && isDepBlocked(d.id),
      )
      if (depBlocked) pushWrapped(`${GLYPH.circledBullet} `, depBlocked.title || depBlocked.id, tok.warning, 2)
    }
    if (terminal && !snap.nextAction) {
      rows.push({ text: truncateToWidth('review: /diff', w), color: tok.success })
    }
    return { rows, doneCount, total: snap.deliverables.length, terminal }
  })()

  // ── WORKBENCH — the ruled rail card UNDER the Minerva (TABULA) card: it
  // ALWAYS carries the operator's LAST SENT PROMPT, wrapped to the card's
  // budget (an honest placeholder before any prompt exists); activating it
  // opens the full panel (/workbench). Computed here, before the shed
  // decision, so the intent formula below mirrors the builder's row math.
  const workbenchRows: string[] | null = lastSentPrompt
    ? wrapRailRows(lastSentPrompt.text.replace(/\s+/g, ' ').trim(), Math.max(6, rowW - 2), 2)
    : null

  // SOLO empty-state gate: no peers, no crew (at all — not just after the cap),
  // no daemon-crew teammates, no live runs. The dead buckets give way to
  // RECENT/MISSION/NEXT glanceables. (Any crew counts — a standing daemon
  // crew is never "solo"; so is a running shell.)
  const solo =
    peers.length === 0 &&
    crewAll.length === 0 &&
    daemonCrew.length === 0 &&
    runsAll.length === 0 &&
    // A session with a live task LEDGER (an active plan) is never "solo" —
    // the mission board must render (a completed-only ledger can stay solo).
    ledgerOpen === 0

  // RECENT resumable sessions for the solo state — the tab-strip's exact source
  // (loadAllProjectsMessageLogs → filterResumableSessions → substantive), loaded
  // only when solo so the busy cockpit never pays the scan. Seeded from the
  // scope-keyed last-known snapshot so a remount paints
  // the previous answer synchronously and a project/session switch swaps
  // scopes in the same render — never another project's rows.
  const recentScopeKey = `${getProjectRoot() || ''}::${getSessionId()}`
  const [recentSnap, setRecentSnap] = useState<{ key: string; rows: LogOption[] | null }>(
    () => ({ key: recentScopeKey, rows: lastKnownRecent.get(recentScopeKey) ?? null }),
  )
  if (recentSnap.key !== recentScopeKey) {
    setRecentSnap({ key: recentScopeKey, rows: lastKnownRecent.get(recentScopeKey) ?? null })
  }
  const recent = recentSnap.key === recentScopeKey ? recentSnap.rows : lastKnownRecent.get(recentScopeKey) ?? null
  useEffect(() => {
    if (!solo) return
    let alive = true
    void (async () => {
      try {
        const all = await loadAllProjectsMessageLogs()
        // board-homed sessions stay off the RECENT lane —
        // the concourse board is their home while their record stands.
        const boardHomed = boardHomedSessionIds()
        const resumable = filterResumableSessions(all, getSessionId())
          .filter(isSubstantiveSession)
          .filter(l => !boardHomed.has(getSessionIdFromLog(l) ?? ''))
          // Crew transcripts never masquerade as the operator's recents (#73/#75).
          .filter(l => !isCrewSession(l))
          // PROJECT SCOPE: the cockpit RECENT lane
          // shows THIS project's sessions only, minus /clear'ed ones.
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
          .filter(l => !isSessionCleared(getSessionIdFromLog(l)))
        resumable.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        if (alive) {
          const rows = resumable.slice(0, 3)
          lastKnownRecent.set(recentScopeKey, rows)
          setRecentSnap({ key: recentScopeKey, rows })
        }
      } catch {
        // Not cached — a transient failure must not pin as the known state.
        if (alive) setRecentSnap({ key: recentScopeKey, rows: [] })
      }
    })()
    return () => {
      alive = false
    }
    // scope key in deps: an in-place session switch (/sessions resume) keeps
    // `solo` true but must re-exclude the NEW current session and re-rank
    // (audit U0 — the list stayed stale until a solo flip).
  }, [solo, recentScopeKey])
  const mission = getActiveMission()

  // WAKES — the Saturn schedules glance: `◐ N scheduled ·
  // next in 4m · /saturn`, rendered ONLY when schedules exist (restraint — an
  // empty system shows nothing). Non-selectable pure glance (no row-model
  // entry, so the cursor invariant between selectable sections is untouched);
  // a self-owned 15s probe (one records-file read — SATURN's schedules ride
  // the session records) keeps the countdown honest without a subscription.
  const [wakeGlance, setWakeGlance] = useState<{ count: number; nextFireMs: number | null } | null>(
    // Seeded from the last-known snapshot (config-home-global — schedules are
    // daemon-wide) so a rail remount paints the glance synchronously instead
    // of growing the panel a section when the 15s probe lands (audit #10).
    () => lastKnownWakeGlance,
  )
  useEffect(() => {
    let alive = true
    const probe = () => {
      try {
        const records = Object.values(readSessionWorkers()).filter(r => r.endedAt === undefined)
        const s = saturnWakeGlanceOf(records, Date.now())
        const next = s.count > 0 ? s : null
        lastKnownWakeGlance = next
        if (alive) setWakeGlance(next)
      } catch {
        if (alive) setWakeGlance(null)
      }
    }
    probe()
    const t = setInterval(probe, 15_000)
    t.unref?.()
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // the journal read+fold ran SYNCHRONOUSLY inside a render memo
  // on this always-mounted rail (append-only journal — cost grows with the
  // project). Same idiom as the wake glance above: refresh through the async
  // reader on rail version ticks, paint from the last-known fold, alive-
  // fenced so a late result can't land on an unmounted rail.
  const tabulaVersion = getHelmLanesVersion()
  const tabulaDir = tabulaProjectDir(getOriginalCwd())
  const [tabulaOpen, setTabulaOpen] = React.useState<TabulaNote[]>(() => lastKnownTabulaOpenByDir.get(tabulaDir) ?? [])
  React.useEffect(() => {
    if (!isTabulaEnabled()) return
    let alive = true
    setTabulaOpen(lastKnownTabulaOpenByDir.get(tabulaDir) ?? [])
    void readNotesAsync(tabulaDir)
      .then(r => {
        if (!alive) return
        const open = r.notes.filter(n => !n.done)
        lastKnownTabulaOpenByDir.set(tabulaDir, open)
        setTabulaOpen(open)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [tabulaVersion, tabulaDir])
  const selfName = getOperatorName()
  const peersShown = peers.slice(0, PEER_ROWS)
  const peersMore = peers.length - peersShown.length
  const minervaPendingEarly = getMinervaPending()
  const minervaComposingEarly = isMinervaComposing()
  const minervaLastExEarly = getMinervaLastExchange()

  // ── HEIGHT-AWARE SHEDDING (the HelmTelemetryRail
  // doctrine). At short heights the atomic sections overflow the rail's measured
  // box, clipping whole TRAILING sections while their selectable rows stayed
  // published — the ❯ cursor could walk rows that were not on screen. Sections
  // now shed as WHOLE units against the measured ceiling, decided BEFORE any
  // builder runs: a shed section's builder never executes, so it paints
  // nothing AND registers no rows — the published model is exactly the
  // painted rows. INTENT FORMULAS below mirror each builder's row math (the
  // telemetry-rail precedent; the lanes parity proof catches drift). Shed
  // order (first→last): NEXT hints → TABULA → PARTY → RECENT → CHAT → CREW.
  // NEVER shed: SEAT (identity), TASKS+RUNS (the mission board), MISSION when
  // armed, the merged-telemetry glance, and any section holding the CURRENT
  // cursor (published-label lookup — focus raises priority, and the cursor
  // can never point at a hidden row).
  // The shed estimate bills the chrome the mode RENDERS: boxed = RailPanel
  // border+header+border (3); flat = SectionHeader+marginTop (2, and the
  // first section's zero margin stays as slack). The old flat-billed-3 put
  // 5-6 phantom rows on a merged-telemetry rail, so the WORKBENCH card —
  // first in every shed order — was evicted from a 120x40 the glass
  // afforded (blank rows under the shed pointer; the F3 phantom-row class).
  const SECTION_CHROME = boxed ? 3 : 2
  const shedCeiling = availRows ?? Infinity
  // ADAPTIVE DENSITY (HZ5): the shed ORDER, the never-shed additions and the
  // secondary-row budget come from the ONE plan (utils/helmDensity) keyed on
  // what the session is doing. The mechanism below is unchanged — panels still
  // shed as whole units against the measured ceiling, and the floor still
  // holds identity + the mission board. What changes is which lane yields
  // first: while a turn runs the NEXT hints are the operator's next action and
  // stop being the first thing dropped; while a decision is pending everything
  // ambient gets out of the way.
  const density = densityPlan(activity, availRows ?? Infinity)
  const hintCap = hintBudget(density)
  const intentTabula = !isTabulaEnabled()
    ? 0
    : (tabulaOpen.length === 0 ? 1 : Math.min(3, tabulaOpen.length) + (tabulaOpen.length > 3 ? 1 : 0)) +
      // The ask line renders in EVERY state (idle ❯ · composing · ◐ pending)
      // — one row, always; billing 0 at idle under-billed the section while
      // the phantom chrome hid it.
      1 +
      (minervaLastExEarly && !minervaPendingEarly ? 1 : 0)
  const tasksIntent =
    Math.min(2, ledgerActive.length) + (ledgerActive.length > 2 ? 1 : 0) +
    Math.min(3, ledgerPending.length) + (ledgerPending.length > 3 ? 1 : 0)
  // The SEAT glance is display-only (no selectable rows) until the new
  // multiplayer owns presence; its rows are billed below with the other
  // display-only glances, never as intents.
  const seatGlanceRows = 1 + peersShown.length + (peersMore > 0 ? 1 : 0)
  const intents: Record<string, number> = {
    seat: 0,
    // busy branch renders CREW always (a 1-row empty state when none run).
    // +1 = the permanent CREW root row.
    crew: solo ? 0 : Math.max(1, 1 + crewShown.length + (crewMore > 0 ? 1 : 0)),
    chat: chatRows.length,
    // The WORK digest (M3) — while it renders, TASKS yields (no duplication).
    work: work ? work.rows.length : 0,
    // solo renders TASKS only when the ledger has rows; busy always (1-row empty state).
    tasks: work ? 0 : solo ? (ledger.length > 0 ? tasksIntent : 0) : Math.max(1, tasksIntent),
    runs: solo ? 0 : runsShown.length + (runsMore > 0 ? 1 : 0),
    // Settled-empty renders NOTHING (the empty-state law at the render gate)
    // — billing it a row was a phantom section; only the in-flight scan's
    // placeholder row is real.
    recent: solo ? (recent == null ? 1 : recent.length) : 0,
    mission: solo && mission ? 1 : 0,
    tabula: intentTabula,
    // The workbench card is ONE selectable unit: the wrapped last-prompt
    // rows, or the single placeholder line (mirrors the builder exactly).
    workbench: workbenchRows ? workbenchRows.length : 1,
    next: solo ? Math.min(5 + (mission ? 0 : 1), hintCap) : 0,
    saturn: 0, // set below once the wake glance resolves (display-only section)
  }
  const sectionCost = (key: string): number => (intents[key] ?? 0) > 0 ? (intents[key] ?? 0) + SECTION_CHROME : 0
  // The section the cursor currently sits in — from the PUBLISHED model (the
  // previous render's rows; stable across this decision).
  const publishedRows = getHelmRows('lanes')
  const cursorLabel = publishedRows[getHelmCursor('lanes')]?.label ?? ''
  const cursorSection =
    cursorLabel.startsWith('crew') ? 'crew'
    : cursorLabel.startsWith('chat') ? 'chat'
    : cursorLabel.startsWith('recent') ? 'recent'
    : cursorLabel.startsWith('tabula') ? 'tabula'
    : cursorLabel.startsWith('workbench') ? 'workbench'
    : cursorLabel.startsWith('hint') ? 'next'
    : null
  const shedSet = new Set<string>()
  {
    const mustKeep = new Set<string>([...HELM_DENSITY_FLOOR, ...density.keep])
    if (cursorSection) mustKeep.add(cursorSection)
    let spent =
      1 + // the reserved focus-banner row
      (['seat', 'crew', 'chat', 'work', 'tasks', 'runs', 'recent', 'mission', 'tabula', 'workbench', 'next'] as const)
        .reduce((n, k) => n + sectionCost(k), 0) +
      (seatGlanceRows + SECTION_CHROME) + // the SEAT glance (display-only; always painted)
      (mergedTelemetry ? 4 + SECTION_CHROME : 0) + // the merged TELEMETRY glance (display-only)
      (wakeGlance ? 1 + SECTION_CHROME : 0) // the SATURN glance (display-only)
    for (const k of density.shedOrder) {
      if (spent <= shedCeiling) break
      if (mustKeep.has(k) || sectionCost(k) === 0) continue
      shedSet.add(k)
      spent -= sectionCost(k)
    }
  }

  // ---- The selectable-row MODEL, built in the SAME pass as the nodes so the
  // cursor index and the visual row can never disagree. sel() registers a row
  // and returns its index; isOn() marks the caret.
  const rowsModel: HelmRow[] = []
  const sel = (row: HelmRow): number => {
    rowsModel.push(row)
    return rowsModel.length - 1
  }
  const isOn = (i: number): boolean => focused && cur === i

  // SEAT rows: a synthesized SELF row PREPENDED (presence excludes self), then the
  // live peers (capped — see PEER_ROWS). DISPLAY-ONLY:
  // the rows once opened the old session-room
  // board on ↵; that board retired with the multiplayer estate, and a rail row
  // whose ↵ lands on a retirement sentence is a dead affordance — so no seat
  // row registers in the selectable model and the section carries no open
  // door. Presence itself stays painted (living information from the local
  // channel bus). THE FUTURE OWNER: the new multiplayer designed in the
  // operator's spec chat wires these rows to its own presence surface.

  const seatNodes: React.ReactNode[] = []
  // self row — YOUR seat, IVORY (not dimmed). (A dead cursor path here
  // leaves self permanently FAINT while peers are bright.)
  seatNodes.push(
    <RailRow
      key="seat:self"
      width={rowW}
      glyph={GLYPH.done}
      glyphColor={tok.success}
      name={`${selfName} (you)`}
      nameColor={tok.textPrimary}
      verb="active"
      verbColor={tok.textSecondary}
    />,
  )
  for (const p of peersShown) {
    seatNodes.push(
      <RailRow
        key={`seat:${p.seat}`}
        width={rowW}
        glyph={GLYPH.done}
        glyphColor={tok.success}
        name={p.seat}
        nameColor={tok.textPrimary}
        verb={p.verb || undefined}
        verbColor={tok.textPrimary}
      />,
    )
  }
  if (peersMore > 0)
    seatNodes.push(
      <MoreRow
        key="seat:more"
        n={peersMore}
        width={rowW}
      />,
    )

  // the permanent CREW ROOT — the main Mercury conversation,
  // projected from identity/session truth (cv-main), never a task row and
  // never counted in the crew tally. ↵/click returns to main without
  // stopping child work; while a child is viewed the verb is the accented
  // return affordance. Distinct by GLYPH (the identity spark), not colour
  // alone.
  const viewingChild = viewingAgentTaskId != null
  const crewShed = shedSet.has('crew')
  // railRowProps REGISTERS the row with the helm cursor at call time, so a
  // shed lane must not construct these elements at all (index alignment).
  const rootNode: React.ReactNode = crewShed ? null : (
    <RailRow
      key={`crewroot:${MAIN_CONVERSATION_ID}`}
      width={rowW}
      glyph={GLYPH.spark}
      glyphColor={viewingChild ? tok.textMuted : accent}
      name="Mercury"
      nameColor={viewingChild ? tok.textPrimary : accent}
      verb={viewingChild ? '‹ main' : 'lead'}
      verbColor={viewingChild ? accent : tok.textMuted}
      {...railRowProps(isOn, sel, { kind: 'main', label: 'crew:root' })}
    />
  )
  const crewChildNodes: React.ReactNode[] = crewShed ? [] : crewShown.map(entry => {
    if (entry.kind === 'daemon') {
      // A daemon-crew teammate (/teammates): liveness dot + unread-first verb.
      // An unread reply BREATHES (pulse = needs-you); ↵ opens the chats board.
      const unreadVerb = entry.unread > 0 ? `${entry.unread} new` : entry.online ? 'online' : 'offline'
      return (
        <RailRow
          key={`crewd:${entry.name}`}
          width={rowW}
          glyph={entry.online ? GLYPH.busy : GLYPH.idle}
          glyphColor={entry.online ? tok.success : tok.textMuted}
          name={`@${entry.name}`}
          nameColor={tok.textPrimary}
          verb={unreadVerb}
          verbColor={entry.unread > 0 ? tok.warning : entry.online ? tok.textSecondary : tok.textMuted}
          verbPulse={entry.unread > 0}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/teammates', label: `crew:d:${entry.name}` })}
        />
      )
    }
    const c = entry.row
    const isViewing = viewingAgentTaskId != null && c.id === viewingAgentTaskId
    const base = statusTone(c.status, tok)
    // When this agent's transcript is the one drilled into the center, mark it
    // (accent verb) so the cockpit shows what you're viewing. A hosted row
    // opens its work card on the /tasks board instead (the RUNS rows' door).
    const verbLabel = isViewing ? 'viewing' : base.label
    const tone = isViewing ? accent : base.tone
    const g = c.status === 'running' ? GLYPH.busy : GLYPH.idle
    const gColor = isViewing ? accent : c.status === 'running' ? tok.success : tok.textMuted
    return (
      <RailRow
        key={`crew:${c.id}`}
        width={rowW}
        glyph={g}
        glyphColor={gColor}
        glyphLive={c.status === 'running'}
        name={c.label}
        nameColor={isViewing ? accent : tok.textPrimary}
        verb={verbLabel}
        verbColor={tone}
        {...railRowProps(
          isOn,
          sel,
          c.hosted
            ? { kind: 'command', command: `/tasks ${c.id}`, label: `crew:h:${c.id}` }
            : { kind: 'teammate', id: c.id, label: c.label },
        )}
      />
    )
  })
  const crewNodes: React.ReactNode[] = crewShed ? [] : [rootNode, ...crewChildNodes]
  if (crewMore > 0 && !crewShed)
    crewNodes.push(
      <MoreRow
        key="crew:more"
        n={crewMore}
        width={rowW}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/fleet', label: 'crew:more' })}
      />,
    )

  // CHAT nodes — built HERE (after CREW, before TASKS) so sel() registration
  // matches visual order in BOTH branches: busy renders CHAT under CREW; the
  // scribe-solo layout renders it under SEAT, where crew contributed zero
  // rows, so the indices still line up. ↵ opens the owning surface (/daemon
  // for the scribe bus).
  const chatCommand = '/daemon'
  // Stable interaction identity: the chat row's key IS its published label (route+ts, with an
  // ordinal only for genuine same-ms duplicates) — an index key handed a
  // row's subtree state to a different message whenever the feed shifted.
  const chatLabelSeen = new Map<string, number>()
  const chatNodes: React.ReactNode[] = shedSet.has('chat') ? [] : chatRows.map(r => {
    const baseLabel = `chat:${r.route}:${r.ts}`
    const dupes = chatLabelSeen.get(baseLabel) ?? 0
    chatLabelSeen.set(baseLabel, dupes + 1)
    const label = dupes === 0 ? baseLabel : `${baseLabel}:${dupes}`
    return (
      <ChatRow
        key={label}
        width={rowW}
        row={r}
        {...railRowProps(isOn, sel, { kind: 'command', command: chatCommand, label })}
      />
    )
  })

  // WORK rows — display-only digest rows; the section header's
  // open target (/workbench) is the ONE route into the detail board, so the
  // digest never grows its own selectable sub-rows (glance, not a board).
  const workNodes: React.ReactNode[] = work
    ? work.rows.map((r, i) => (
        <Box key={`work:${i}`} width={rowW}>
          <Text color={r.color} wrap="truncate-end">
            {`  ${r.text}`}
          </Text>
        </Box>
      ))
    : []

  // MISSION rows — the task-ledger board (built HERE, between CHAT
  // and the bg TASKS rows, so sel() registration order matches the eye):
  //   · in-progress: a ROTATING ◐ (motion=work, the liveness grammar) + the
  //     activeForm — the same line the spinner narrates, now standing;
  //   · queued: ○ + subject, bounded, each ↵ → /tasks;
  //   · overflow: an honest FAINT `+N queued`.
  const MISSION_ACTIVE_ROWS = 2
  const MISSION_QUEUE_ROWS = 3
  const missionNodes: React.ReactNode[] = []
  // EVERY mission row participates in the rail's selectable model (
  // action-honesty pass — active rows and the +N overflows rendered as plain
  // boxes beside selectable queued rows: same-looking rows, dead to ↵/click).
  // All drill to /tasks, the owning board — ledger rows are display-only
  // there BY DESIGN (no process card to open), so the board is the honest
  // exact-detail surface.
  for (const t of ledgerActive.slice(0, MISSION_ACTIVE_ROWS)) {
    missionNodes.push(
      <RailRow
        key={`mission:a:${t.id}`}
        width={rowW}
        glyph={GLYPH.busy}
        glyphColor={tok.success}
        glyphLive
        name={t.activeForm ?? t.subject}
        nameColor={tok.textPrimary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: `mission:a:${t.id}` })}
      />,
    )
  }
  if (ledgerActive.length > MISSION_ACTIVE_ROWS) {
    missionNodes.push(
      <RailRow
        key="mission:a:more"
        width={rowW}
        glyph={GLYPH.dot}
        glyphColor={tok.textMuted}
        name={`+${ledgerActive.length - MISSION_ACTIVE_ROWS} also in progress`}
        nameColor={tok.textMuted}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'mission:a:more' })}
      />,
    )
  }
  for (const t of ledgerPending.slice(0, MISSION_QUEUE_ROWS)) {
    missionNodes.push(
      <RailRow
        key={`mission:q:${t.id}`}
        width={rowW}
        glyph={GLYPH.pending}
        glyphColor={tok.textMuted}
        name={t.subject}
        nameColor={tok.textSecondary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: `mission:q:${t.id}` })}
      />,
    )
  }
  if (ledgerPending.length > MISSION_QUEUE_ROWS) {
    missionNodes.push(
      <RailRow
        key="mission:q:more"
        width={rowW}
        glyph={GLYPH.dot}
        glyphColor={tok.textMuted}
        name={`+${ledgerPending.length - MISSION_QUEUE_ROWS} queued`}
        nameColor={tok.textMuted}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'mission:q:more' })}
      />,
    )
  }

  // RUNS rows — glyph carries STATE (rotating ◐ while genuinely running — the
  // liveness grammar; ○ pending), the verb carries KIND + live elapsed
  // (`shell 4m` · `monitor 1.5h`), so a glance answers "what is my machine
  // doing, and for how long". ↵/click → /tasks (the process board).
  const runNodes: React.ReactNode[] = runsShown.map(r => {
    const live = r.status === 'running'
    // Elapsed floors on a stamped start (display-side):
    // an unstamped startTime must read as just the kind, never `20641d`.
    const verb = live && r.startedAtMs > 0 ? `${r.kind} ${formatSpan(Date.now() - r.startedAtMs)}` : r.kind
    return (
      <RailRow
        key={`run:${r.id}`}
        width={rowW}
        glyph={live ? GLYPH.busy : GLYPH.pending}
        glyphColor={live ? tok.success : tok.textMuted}
        glyphLive={live}
        name={r.title}
        nameColor={live ? tok.textPrimary : tok.textSecondary}
        verb={verb}
        verbColor={live ? tok.textSecondary : tok.textMuted}
        {...railRowProps(isOn, sel, {
          kind: 'command',
          // ↵/click opens THIS process's card (`/tasks <id>` drills straight
          // to the detail); the +N overflow row keeps the bare list.
          command: `/tasks ${r.id}`,
          label: `run:${r.id}`,
        })}
      />
    )
  })
  if (runsMore > 0)
    runNodes.push(
      <MoreRow
        key="runs:more"
        n={runsMore}
        width={rowW}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/tasks', label: 'runs:more' })}
      />,
    )

  // Solo glanceables (built only when solo — sel() order must match render order).
  const soloNodes: React.ReactNode[] = []
  if (solo && !shedSet.has('recent')) {
    for (const log of recent ?? []) {
      const label = tabLabel(log)
      soloNodes.push(
        <RailRow
          key={`recent:${log.value}`}
          width={rowW}
          glyph={GLYPH.pending}
          glyphColor={tok.textMuted}
          name={label}
          nameColor={tok.textSecondary}
          selected={isOn(sel({ kind: 'command', command: '/sessions', label: `recent:${label}` }))}
        />,
      )
    }
    // an empty RECENT lane simply stays quiet — a fresh cockpit
    // already carries the hints table; a standing empty-history row
    // reads as incompleteness, not information (empty-state law: disappear
    // when there is no current value).
    // While the scan is in flight, hold ONE placeholder row so the section
    // doesn't reshape twice in two ticks (header-only → +3 rows) — the
    // double-reflow was the trigger surface for the vendored-ink partial-diff
    // artifact.
    if (recent == null) {
      soloNodes.push(
        <Box key="recent:scanning" width={rowW}>
          <Text color={tok.textMuted} wrap="truncate-end">
            {'  scanning…'}
          </Text>
        </Box>,
      )
    }
  }
  // MISSION node built HERE (not inline in the JSX below) so its sel() registers
  // between RECENT and NEXT — the row model's order must match the visual order
  // or the cursor walks out of step.
  const missionNode: React.ReactNode =
    solo && mission ? (
      <RailRow
        key="mission"
        width={rowW}
        glyph={GLYPH.mission}
        glyphColor={tok.success}
        name={mission ? mission.condition : ''}
        nameColor={tok.textPrimary}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/mission', label: 'mission' })}
      />
    ) : null
  // TABULA glance — the notepad's cockpit face (the "side-chat ledger"): top
  // open notes + the MINERVA ask line, ↵ → /tabula. Parent-pass nodes (solo:
  // between MISSION and NEXT · busy: after RUNS — both match this
  // build position, the cursor-walk rule). BOTH branches since
  // (operator: the REPL persists across the router UI) — the journal fold is
  // a small per-project read, re-run only on rail version ticks.
  const tabulaNodes: React.ReactNode[] = []
  if (isTabulaEnabled() && !shedSet.has('tabula')) {
    if (tabulaOpen.length === 0) {
      // Clean-slate invitation: the pad's cockpit face
      // stays present so /note is discoverable BEFORE the first capture —
      // an empty section is a teaching row, not an absent one.
      tabulaNodes.push(
        <RailRow
          key="tabula:empty"
          width={rowW}
          glyph={GLYPH.sparkFaint}
          glyphColor={tok.textMuted}
          name="no notes — /note"
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: 'tabula:empty' })}
        />,
      )
    }
    for (const n of tabulaOpen.slice(0, 3)) {
      tabulaNodes.push(
        <RailRow
          key={`tabula:${n.id}`}
          width={rowW}
          glyph={n.firedAt ? GLYPH.busy : n.pri === 'now' ? GLYPH.spark : GLYPH.sparkFaint}
          glyphColor={n.firedAt ? tok.success : n.pri === 'now' ? tok.warning : tok.textMuted}
          name={n.refinedText ?? n.text}
          nameColor={tok.textPrimary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: `tabula:${n.id}` })}
        />,
      )
    }
    if (tabulaOpen.length > 3) {
      tabulaNodes.push(
        <RailRow
          key="tabula:more"
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={`+${tabulaOpen.length - 3} more`}
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/tabula', label: 'tabula:more' })}
        />,
      )
    }
    // ── The MINERVA ask line — the card's mini-REPL (the console grammar,
    // one pane over; operator goal). idle → compose-in-place →
    // ◐ asking → receipt. ↵ is the only spender; the store is usage-honest.
    const minervaPending = minervaPendingEarly
    if (minervaPending) {
      tabulaNodes.push(
        <RailRow
          key="tabula:ask"
          width={rowW}
          glyph={GLYPH.busy}
          glyphColor={tok.success}
          glyphLive
          name={`minerva · ${Math.max(1, Math.round((Date.now() - minervaPending.startedAt) / 1000))}s`}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'minerva', label: 'tabula:ask' })}
        />,
      )
    } else if (minervaComposingEarly) {
      const askIdx = sel({ kind: 'minerva', label: 'tabula:ask' })
      const buf = getMinervaBuffer()
      const at = getMinervaCursor()
      tabulaNodes.push(
        <Box key="tabula:ask" width={rowW}>
          {/* truncate-START: while a long message types, the CURSOR end stays visible */}
          <Text wrap="truncate-start">
            <Text color={accent}>{isOn(askIdx) ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={tok.textPrimary}>{buf.slice(0, at)}</Text>
            <Text color={accent}>{GLYPH.caretBlock}</Text>
            <Text color={tok.textPrimary}>{buf.slice(at)}</Text>
          </Text>
        </Box>,
      )
    } else {
      tabulaNodes.push(
        <RailRow
          key="tabula:ask"
          width={rowW}
          glyph={GLYPH.prompt}
          // The resting ❯ prompt sigil wears the BRAND accent family
          // (the REPL quality floor: the TERRA brand red) —
          // the idle ask row is Mercury's own composer invitation, so its
          // sigil carries the brand identity red regardless of the session
          // critter; only the LABEL stays muted at rest. Once composing,
          // the sigil follows the live session accent (it is YOUR line).
          // (No hex literal here — UI-093 keeps the accent byte at the
          // token owners only.)
          glyphColor={TERRA}
          name="ask minerva"
          nameColor={tok.textMuted}
          {...railRowProps(isOn, sel, { kind: 'minerva', label: 'tabula:ask' })}
        />,
      )
    }
    // The settle receipt — the last exchange's reply (or its honest error),
    // one FAINT line under the ask row; the board's chip shows the same truth.
    const lastEx = minervaLastExEarly
    if (lastEx && !minervaPending) {
      tabulaNodes.push(
        <Box key="tabula:receipt" width={rowW}>
          <Text wrap="truncate-end">
            <Text>{'  '}</Text>
            {lastEx.error ? (
              <Text color={tok.failure}>{`${GLYPH.fail} ${lastEx.error}`}</Text>
            ) : (
              <>
                <Text color={tok.textSecondary}>{`${GLYPH.sparkBright} ${lastEx.reply ?? ''}`}</Text>
                {(lastEx.counts?.refined ?? 0) > 0 ? (
                  // A landed refine advertises its home truthfully (the
                  // printed-key law: no key claimed here — the rail has no s;
                  // the workbench MINERVA tab and the room's s do the send).
                  <Text color={tok.accent}>{' · /workbench MINERVA sends it'}</Text>
                ) : null}
              </>
            )}
          </Text>
        </Box>,
      )
    }
  }
  // WORKBENCH — the ruled card UNDER the Minerva card (build order: directly
  // after tabulaNodes, matching both render slots — the cursor-walk rule).
  // One selectable unit: the last sent prompt or the honest placeholder;
  // ↵/click opens the full panel.
  const workbenchNodes: React.ReactNode[] = []
  if (!shedSet.has('workbench')) {
    workbenchNodes.push(
      <WorkbenchCardRow
        key="workbench:last"
        width={rowW}
        lines={workbenchRows}
        {...railRowProps(isOn, sel, { kind: 'command', command: '/workbench', label: 'workbench:last' })}
      />,
    )
  }
  const hintNodes: React.ReactNode[] = []
  if (solo && !shedSet.has('next')) {
    // Flagship surfaces lead (workflows/health were absent from every
    // discovery hint — the nav audit's top finding).
    const hints: Array<{ command: string; label: string }> = [
      { command: '/workflows', label: '/workflows — agent runs' },
      { command: '/health', label: '/health — health cert' },
      { command: '/cards', label: '/cards — memory' },
    ]
    if (!mission) hints.push({ command: '/mission', label: '/mission — set a mission' })
    // The budget the plan affords. Calm keeps the whole authored list (so the
    // committed baseline grids are byte-identical); a busier session spends
    // fewer rows here — but never zero, because a rail that offers no next
    // action has stopped teaching.
    for (const h of hints.slice(0, hintCap)) {
      hintNodes.push(
        <RailRow
          key={`hint:${h.command}`}
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={h.label}
          nameColor={tok.textMuted}
          selected={isOn(sel({ kind: 'command', command: h.command, label: `hint:${h.command}` }))}
        />,
      )
    }
  }

  // No gamedev lane — there is no mission store for one, and a standing
  // empty-stub row makes every fresh cockpit read unfinished (empty-state
  // law: a section with no current value disappears).

  // SATURN wake glance — SELECTABLE since action-honesty pass
  // (the old body printed "/saturn" as inert text — a visible pointer the
  // keyboard/pointer couldn't follow). Built HERE, before the
  // TELEMETRY glance, so its sel() registration matches its render slot (the
  // cursor-walk rule). ↵/click opens /saturn, the owning board.
  const wakeBody = wakeGlance ? (
    <RailRow
      width={rowW}
      glyph={GLYPH.inProgress}
      glyphColor={tok.success}
      name={`${wakeGlance.count} scheduled`}
      nameColor={tok.textSecondary}
      verb={
        wakeGlance.nextFireMs === null
          ? 'no next fire'
          : wakeGlance.nextFireMs <= Date.now()
            ? 'due now'
            : `in ${formatSpan(wakeGlance.nextFireMs - Date.now())}`
      }
      verbColor={tok.textMuted}
      {...railRowProps(isOn, sel, { kind: 'command', command: '/saturn', label: 'wake:glance' })}
    />
  ) : null

  // TELEMETRY glance (merged single-rail tier) — LAST section in both
  // branches; built here (after every other section's sel calls) so the row
  // model's order can never disagree with the visual order.
  // Liveness: the glance reads plain snapshot fns —
  // without a tick it would show a STALE ctx%/usage/health-age until some
  // unrelated store nudged a re-render (the full telemetry rail has its own
  // subscriptions). A coarse 15s tick is the honest cap on glance staleness;
  // zero cost when the rail isn't folded. The SAME tick keeps the RUNS lane's
  // elapsed spans honest while a process runs (formatSpan is minute-grained
  // past 60s, so 15s is well inside one display step).
  // 1s while a MINERVA ask is in flight (the elapsed `Ns` counter is honest),
  // else the coarse 15s glance tick, else no tick at all.
  useNowTick(
    getMinervaPending() ? 1_000 : mergedTelemetry || runsLive > 0 ? 15_000 : null,
  )
  let glanceSection: React.ReactNode = null
  if (mergedTelemetry) {
    // The ACTIVE source's leading window from the ONE usage owner — the
    // glance shows whatever the source itself states (5h on Anthropic, the
    // weekly band on OpenAI); spend-shaped lanes glance their session spend.
    const glanceUsage = activeSourceUsage()
    const lead = glanceUsage.windows.find(w => w.state === 'live' && w.usedPct != null)
    // The SPEND number is the FOCUSED SESSION's own (line 4 of the seat
    // sheet: a hopped-into session shows its own numbers) — the same one
    // owner the frame band and /cost read. Un-hopped this IS the terminal's
    // session cost, so nothing changes for the boot session. The ctx glance
    // below still reads the in-process engine's live-context owner — a
    // per-session context door does not exist on the connector yet (named
    // in the seat verify receipt), while the live card and the model picker
    // already show the focused session's own ctx.
    const focusedUsage = getFocusedSessionConnector().usage()
    const focusedSpendUSD = focusedUsage.totalCostUSD
    // The session's unpriced turns ride beside the glance figure — a spend
    // the ledger could not price reads "unpriced", never a bare dash or $0.
    const focusedUnpriced = focusedUsage.unpricedTurns ?? 0
    const usageLabel =
      lead !== undefined
        ? `${lead.label} ${Math.round(lead.usedPct!)}%${
            lead.resetsAtMs != null ? ` · ${formatCountdown(lead.resetsAtMs - Date.now())}` : ''
          }`
        : glanceUsage.shape === 'api-spend'
          ? `spend ${
              focusedUnpriced > 0
                ? formatSessionCost(focusedSpendUSD, focusedUnpriced)
                : focusedSpendUSD > 0
                  ? `$${focusedSpendUSD.toFixed(2)}`
                  : '—'
            }`
          : 'usage — after first reply' // say WHEN it appears, not "no X yet"
    // ≈ marks a character estimate (no wire usage yet); ~ marks the labelled
    // conservative default window (no source has stated one).
    const ctxLive = getLiveContextUsage()
    const ctxLabel = `ctx ${contextPercentLabel(ctxLive.usedPct, ctxLive.fillSource)} · ${contextWindowLabel(ctxLive.window, ctxLive.windowSource)}`
    const chip = healthCertSnapshot().data
    const verdictUp = chip.verdict != null ? String(chip.verdict).toUpperCase() : null
    const healthLabel =
      chip.verdict != null
        ? `${String(chip.verdict).toLowerCase()}${chip.ageMs != null ? ` · ${formatCountdown(chip.ageMs)} old` : ''}`
        : 'health — run /health' // one truthful next action
    const healthTone =
      verdictUp === 'FAULT' ? tok.failure : verdictUp === 'CAUTION' ? tok.warning : tok.textSecondary
    glanceSection = (
      // Atomic like section()'s flat tier — the merged glance is a raw
      // fragment, so it needs its own shrink pin (same 26-30-row class).
      <Box flexDirection="column" flexShrink={0}>
        <Box marginTop={1}>
          <SectionHeader label="TELEMETRY" width={rowW} />
        </Box>
        <RailRow
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={usageLabel}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/deck', label: 'tel:usage' })}
        />
        <RailRow
          width={rowW}
          glyph={GLYPH.dot}
          glyphColor={tok.textMuted}
          name={ctxLabel}
          nameColor={tok.textSecondary}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/deck', label: 'tel:ctx' })}
        />
        <RailRow
          width={rowW}
          glyph={verdictUp === 'FAULT' ? GLYPH.fail : verdictUp === 'CAUTION' ? GLYPH.warn : GLYPH.dot}
          glyphColor={healthTone === tok.textSecondary ? tok.textMuted : healthTone}
          name={healthLabel}
          nameColor={healthTone}
          {...railRowProps(isOn, sel, { kind: 'command', command: '/health', label: 'tel:health' })}
        />
      </Box>
    )
  }

  const totalPeers = peers.length
  const peerWord = totalPeers === 1 ? 'peer' : 'peers'
  // Count the UNCAPPED roster (friction hunt: the header used the
  // display-capped list and said "6 agents" directly above its own "+3 more").
  const crewWord = crewEntries.length === 1 ? 'agent' : 'agents'

  // Publish the selectable model (signature-compared in the store, so an
  // unchanged model is a no-op — no publish→notify→render loop).
  const rowsSig = rowsModel.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('lanes', rowsModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  // ONE section shell for both tiers: the wide boxed
  // cockpit wraps a section in the RailPanel card; the single-rail tiers keep
  // the flat SectionHeader + marginTop layout. The BODY nodes are identical —
  // only the shell differs, so sel()-registration order can't change.
  // Hover-hierarchy: boxed lane headers ride
  // RailPanel's headerAction — ink-only hover (info → infoShimmer, no slab)
  // + ONE click to `open`, the lane's owning surface (the SAME command the
  // lane's own rows dispatch — honest affordance, telemetry-rail grammar).
  // The flat tier's SectionHeader stays display-only chrome.
  const section = (
    key: string,
    glyph: string,
    label: string,
    count: string | undefined,
    body: React.ReactNode,
    opts?: { first?: boolean; open?: string },
  ): React.ReactNode => {
    const open = opts?.open
    return boxed ? (
      <RailPanel
        key={key}
        glyph={glyph}
        label={label}
        count={count}
        width={width}
        headerAction={open ? { id: `helm:lane:${key}`, run: () => requestCommandDispatch(open) } : undefined}
      >
        {body}
      </RailPanel>
    ) : (
      // ATOMIC under height pressure: the flat
      // tier's bare boxes default-shrink inside the rail's overflow-hidden
      // wrapper, so at ~26-30 term rows Yoga compressed INTERIOR rows — a
      // section header could vanish while its body line stayed (orphaned
      // grammar; grid-verified at 120x27 focused). flexShrink=0 makes each
      // section all-or-nothing (RailPanel already pins this on the boxed
      // tier). Above this, the measured-ceiling WHOLE-SECTION shed with
      // published-model parity landed in (the shedSet plan near
      // the row model) — a shed section's builder never runs, so nothing
      // clips and the cursor can never walk a hidden row.
      <Box key={key} flexDirection="column" flexShrink={0}>
        <Box marginTop={opts?.first ? 0 : 1}>
          <SectionHeader label={count ? `${label} · ${count}` : label} width={rowW} />
        </Box>
        {body}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      {/* Focus banner — the visible focus ring for the rail (accent ❯ + keys).
          While the TABULA ask line composes it advertises THAT grammar instead
          (keydead honesty — every shown key is armed in minervaRepl/PromptInput).
          The ROW IS RESERVED permanently (the stable-
          geometry law): focusing must never INSERT it — an inserted row shifts
          every lane row, and a pointer's second click lands one row off.
          Content-only transition. */}
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {/* LUSTRE L6 — the focus-LANDING beat: the ❯ slot rides ValueGlow
              (the one change-flash primitive) on the SAME snappy beat as the
              list-cursor nudge. Gain: the glyph lands IVORY-bold for one
              beat. Loss: the slot is BLANK, so the symmetric flash paints
              nothing (the CursorCell invisible-when-blank idiom — gain-only
              emphasis without a hand-rolled latch). Geometry fixed. */}
          <ValueGlow value={focused} color={focused ? accent : tok.textMuted} ms={CURSOR_NUDGE_MS}>
            {focused ? <Text bold>{`${GLYPH.prompt} `}</Text> : '  '}
          </ValueGlow>
          {!focused ? (
            <Text color={tok.textMuted}>{'lanes'}</Text>
          ) : isMinervaComposing() ? (
            <>
              <Text color={accent} bold>{'minerva'}</Text>
              <Text color={tok.textMuted}>{getMinervaPending() ? ' · esc abort' : ' · ↵ send · esc · ^u'}</Text>
            </>
          ) : (
            <>
              <Text color={accent} bold>{'lanes'}</Text>
              <Text color={tok.textMuted}>{' · ↑↓ ↵ tab esc'}</Text>
            </>
          )}
        </Text>
      </Box>

      {/* SEAT */}
      {section('seat', GLYPH.ownHybrid, 'SEAT', `${totalPeers} ${peerWord}`, seatNodes, {
        first: true,
      })}

      {solo ? (
        <>
          {/* CHAT — scribe-bus traffic (a scribe session is crew-less ⇒ solo
              layout); appears only when envelopes exist, gone when the mode
              disengages. Party traffic renders in the busy branch instead. */}
          {chatNodes.length > 0
            ? section('chat', GLYPH.handoff, 'CHAT', String(chatRows.length), chatNodes, { open: chatCommand })
            : null}

          {/* WORK — the current-work digest: outcome ·
              phase + real progress · active · blocker/next · changed+check ·
              queued/blocked. One route in: the header opens /workbench. */}
          {work
            ? section(
                'work',
                work.terminal ? GLYPH.done : GLYPH.busy,
                'WORK',
                work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
                workNodes,
                { open: '/workbench' },
              )
            : null}

          {/* TASKS — the mission board in the SOLO branch too (the operator's
              word: the session task list was invisible outside the
              busy layout). Restraint: present only when the ledger has
              rows — a clean slate leaves the room to NEXT. Yields to the
              WORK digest (M3) — the two never render together. Placed
              directly after CHAT so the cursor-walk matches missionNodes'
              build order (built between CHAT and the bg TASKS rows). */}
          {!work && ledger.length > 0
            ? section('tasks', GLYPH.mission, 'TASKS', `${ledgerDone}/${ledger.length}`, missionNodes, { open: '/tasks' })
            : null}

          {/* RECENT — resumable sessions (the tab-strip data), ↵ → /sessions */}
          {soloNodes.length > 0 ? section('recent', GLYPH.read, 'RECENT', undefined, soloNodes, { open: '/sessions' }) : null}

          {/* MISSION — only when one is set (↵ → /mission reports it) */}
          {missionNode ? section('mission', GLYPH.mission, 'MISSION', undefined, missionNode, { open: '/mission' }) : null}

          {/* TABULA — the project notepad's top open notes (↵ → /tabula);
              present whenever the pad is enabled — a clean slate shows the
              /note invitation row (operator), fired notes show a
              TEAL ◐ until their turn settles them done. */}
          {tabulaNodes.length > 0
            ? section('tabula', GLYPH.leaseHeld, 'MINERVA', String(tabulaOpen.length), tabulaNodes, { open: '/tabula' })
            : null}

          {/* WORKBENCH — the ruled card UNDER the Minerva card: the last
              sent prompt (an honest placeholder before any); ↵ → /workbench. */}
          {workbenchNodes.length > 0
            ? section('workbench', GLYPH.prompt, 'WORKBENCH', undefined, workbenchNodes, { open: '/workbench' })
            : null}

          {/* NEXT — contextual next-action hints; gone the moment real rows exist */}
          {hintNodes.length > 0 ? section('next', GLYPH.cursor, 'NEXT', undefined, hintNodes, { open: '/help' }) : null}
        </>
      ) : (
        <>
          {/* CREW — present only when a crew actually exists (P6:
              a session that never engaged crew gets no standing empty-crew
              stub — the empty-state law says disappear). */}
          {shedSet.has('crew') || crewEntries.length === 0 ? null : section(
            'crew',
            GLYPH.fisheye,
            'CREW',
            `${crewEntries.length} ${crewWord}`,
            crewNodes,
            { open: '/teammates' },
          )}

          {/* CHAT — the router crew's bus traffic, newest first (#71). Only
              when envelopes exist; the scribe inbox tails feed it live. */}
          {chatNodes.length > 0
            ? section('chat', GLYPH.handoff, 'CHAT', String(chatRows.length), chatNodes, { open: chatCommand })
            : null}

          {/* WORK — the current-work digest; TASKS yields
              while it renders (the digest and the list never duplicate). */}
          {work
            ? section(
                'work',
                work.terminal ? GLYPH.done : GLYPH.busy,
                'WORK',
                work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
                workNodes,
                { open: '/workbench' },
              )
            : null}

          {/* TASKS — the mission board: the session task LEDGER (the cockpit
              owner of the transcript's ctrl+t tree — Spinner.tsx defers
              here). Live processes moved to their own RUNS lane below. */}
          {work ? null : section(
            'tasks',
            GLYPH.mission,
            'TASKS',
            ledger.length > 0 ? `${ledgerDone}/${ledger.length}` : undefined,
            missionNodes.length === 0 ? (
              <Box width={rowW}>
                <Text color={tok.textMuted} wrap="truncate-end">
                  {'  no open tasks'}
                </Text>
              </Box>
            ) : (
              missionNodes
            ),
            { open: '/tasks' },
          )}

          {/* RUNS — the live background processes (shells · monitors ·
              workflows · cloud runs): the "what is my machine doing" lane.
              Present only when processes exist (restraint — like SATURN);
              each ↵ → /tasks, the process board. */}
          {runsShown.length > 0
            ? section('runs', GLYPH.turns, 'RUNS', `${runsLive} live`, runNodes, { open: '/tasks' })
            : null}

          {/* TABULA — persists across the router UI:
              the notepad card + MINERVA ask line render in the busy branch
              too. Build order puts tabulaNodes after RUNS —
              this slot matches it (the cursor-walk rule). */}
          {tabulaNodes.length > 0
            ? section('tabula', GLYPH.leaseHeld, 'MINERVA', String(tabulaOpen.length), tabulaNodes, { open: '/tabula' })
            : null}

          {/* WORKBENCH — the ruled card under Minerva, in the busy branch
              too; build order puts workbenchNodes after tabulaNodes —
              this slot matches it (the cursor-walk rule). */}
          {workbenchNodes.length > 0
            ? section('workbench', GLYPH.prompt, 'WORKBENCH', undefined, workbenchNodes, { open: '/workbench' })
            : null}

        </>
      )}

      {/* SATURN — the schedules glance (the /saturn board's cockpit face;
          renamed from WAKES so the lane names its surface); present
          only when schedules exist. Selectable: ↵/click → /saturn. */}
      {wakeGlance ? section('saturn', GLYPH.inProgress, 'SATURN', undefined, wakeBody, { open: '/saturn' }) : null}

      {/* TELEMETRY (merged) — the center-first railPlan folded the telemetry
          rail; its key glanceables live here so nothing is lost: usage 5h ·
          ctx · health, ↵ routes to the owning surface exactly like the full
          rail. Nodes are built in the PARENT pass above (a child component
          would run its sel() calls during RECONCILIATION — after the rowsSig
          effect captured the model — desyncing cursor from screen). */}
      {mergedTelemetry ? glanceSection : null}

      {/* Everything shed folds into ONE honest pointer line (
          the telemetry-rail idiom): destinations only, display-only (no
          selectable row — the cursor can never land on it). */}
      {shedSet.size > 0 ? (
        <Box width={width} height={1} flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>
              {'  more: ' +
                [...shedSet]
                  .map(k => (k === 'next' ? '/help' : k === 'recent' ? '/sessions' : k === 'chat' ? '/daemon' : `/${k}`))
                  .join(' · ')}
            </Text>
          </Text>
        </Box>
      ) : null}

      {/* (The wide tier's ✶ Mercury brand block lived here until
          the single-brand law — the wordmark now appears exactly
          once, as the transcript's banner-header.) */}
    </Box>
  )
}



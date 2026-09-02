import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useHoverOwner } from './useHoverOwned.js'
import { InteractiveRow } from './InteractiveRow.js'
import { keyHintLabel } from './keyHintLabel.js'
import { chatOnlyBoot, concourseWayBack, routeSurfaceRegistered } from '../../context/surfaceRoute.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { filterResumableSessions } from '../../commands/resume/resume.js'
import { Box, Text } from '../../ink.js'
import type { LogOption } from '../../types/logs.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { isCrewSession } from '../../utils/sessionClass.js'
import { boardHomedSessionIds } from '../../daemon/concourseSupervisor.js'
import { isProjectSession, isSubstantiveSession } from '../../utils/sessionFilter.js'
import { isSessionCleared } from '../../utils/sessionStorage/clearedSessions.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  getSessionIdFromLog,
  loadAllProjectsMessageLogs,
} from '../../utils/sessionStorage.js'
import {
  isPromptEmpty,
  requestCommandDispatch,
  setSessionRailRows,
  subscribePromptEmpty,
} from '../../utils/cockpit/helmFocus.js'
import { FAINT, IVORY, SECOND } from '../mercuryPalette.js'
import { useSessionAccent } from './sessionAccent.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { truncateToWidth } from './glyphs.js'

// ============================================================================
//  SessionTabs — the session BERTH RAIL, rendered as the top row of
//  MercuryFrame (above the statusbar). A persistent, at-a-glance companion to
//  the /sessions list switcher: the ACTIVE session is the accent-underlined
//  ▣ berth; recent resumable sessions are the hollow ▢ berths you can switch
//  to. One `│` divider after the active berth echoes the statusbar's own
//  segment grammar so the two chrome rows read as one instrument.
//
// the active berth's ACCENT UNDERLINE — the
//  one place this row spends boldness; everything else stays quiet. A hovered
//  berth raises (tokens.surface2, the house affordance) and previews its FULL
//  title + age in the hint slot (the row is its own tooltip — zero extra
//  height); the overflow `+N` is a live target opening /sessions; and the
//  ⌥←→ chord is advertised ONLY while the prompt is actually empty (the
//  chord's real arming condition, stamped by PromptInput via the helm store)
// honesty by state, not by parenthetical.
//
//  HONEST DATA ONLY. The tabs are real resumable sessions from the same source
//  the /sessions list uses (loadAllProjectsMessageLogs → filterResumableSessions,
//  newest-first). There is no faked concurrency: only ONE session is live at a
//  time (single-process Ink), so the other tabs are paused/resumable — switching
//  to one pauses the current. Reloads when the active session id changes (i.e.
//  after an in-place switch) so the strip always reflects reality.
//
//  The strip self-omits when there is nothing to tab between (no other resumable
//  sessions) or the terminal is too narrow — never a dangling empty rail.
//  (Unconditional.)
// ============================================================================

// One-line tab label: user title > first prompt > agent name > fallback.
// Sanitize ASCII control chars (a literal \t / \n surfaces when an un-unescaped
// lite-metadata firstPrompt carries them) to spaces + collapse runs, so the
// always-visible strip never shows a raw escape or a torn/wrapped row. Done via
// a codepoint filter (charCodeAt < 0x20) — NOT a control-char regex literal, so
// no raw control bytes ever enter this source file. Width is display-aware via
// truncateToWidth at the call site.
export function tabLabel(log: LogOption): string {
  const t =
    log.customTitle?.trim() || log.firstPrompt?.trim() || log.agentName?.trim()
  if (!t) return 'untitled'
  const cleaned = Array.from(t, ch => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'untitled'
}

const LABEL_W = 18 // per-tab label truncation (display-width aware)
const PREVIEW_W = 46 // hovered-berth title preview cap (the hint slot's guest)

// Last-known rows per (project, active-session) SCOPE (continuity
// pass, audit #10): a remount paints the previous answer SYNCHRONOUSLY — no
// skeleton flash, no panel growing a row when the async scan lands — then
// refreshes in the background. Keyed by scope so a project/session switch
// swaps to THAT scope's snapshot (or null) in the same render: one project's
// ring can never flash inside another. Process-lifetime, bounded by the
// scopes actually visited.
const lastKnownTabs = new Map<string, LogOption[]>()

export function SessionTabs({
  cols,
  framed = false,
}: {
  cols: number
  /** Cockpit-panel variant: the row renders INSIDE the frame's
   *  bordered SESSIONS panel — it leads with the `⊞ SESSIONS` panel label and
   *  drops its own horizontal padding (the panel provides it). */
  framed?: boolean
}): React.ReactNode {
  
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const sessionId = getSessionId()
  const scopeKey = `${getProjectRoot() || ''}::${sessionId}`
  const [tabs, setTabs] = useState<{ key: string; rows: LogOption[] | null }>(
    () => ({ key: scopeKey, rows: lastKnownTabs.get(scopeKey) ?? null }),
  )
  // Scope changed mid-life (in-place session switch, /branch cross-project):
  // swap to the new scope's last-known rows in the SAME render — the sanctioned
  // derived-state-from-props pattern — so stale rows never paint under a new
  // identity while the refresh runs.
  if (tabs.key !== scopeKey) {
    setTabs({ key: scopeKey, rows: lastKnownTabs.get(scopeKey) ?? null })
  }
  const others = tabs.key === scopeKey ? tabs.rows : lastKnownTabs.get(scopeKey) ?? null
  // Hovered berth index (into `shown`), or null — drives the raise + the
  // hint-slot preview. Derived from the single-owner hover store (a missed
  // leave self-heals on the next claim; nothing lights mid-drag — the
  // chain-highlight hardening), never a local enter/leave pair.
  // The tabs ride InteractiveRow — its row ids ARE the claims,
  // so the hint slot parses the shared owner instead of a private base.
  const hoverOwner = useHoverOwner()
  const hovered: number | null =
    hoverOwner != null && hoverOwner.startsWith('sessiontabs:row:')
      ? hoverOwner.slice('sessiontabs:row:'.length) === 'more'
        ? -1
        : Number(hoverOwner.slice('sessiontabs:row:'.length))
      : null
  // The chord's real arming condition, live from the input owner.
  const promptEmpty = useSyncExternalStore(
    subscribePromptEmpty,
    isPromptEmpty,
    isPromptEmpty,
  )

  // Load recent resumable sessions (all projects, newest-first) — the same
  // honest source /sessions uses. Re-run when the active session id changes so
  // the strip tracks in-place switches.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const all = await loadAllProjectsMessageLogs()
        // Drop sidechains + the current session, then throwaway / "(no content)"
        // render-junk so the strip only shows real tab-able sessions (matches the
        // /sessions list + the flip target). Safe over LITE logs (size-gated).
        // board-homed sessions stay off the strip — the
        // concourse board is their home while their record stands.
        const boardHomed = boardHomedSessionIds()
        const resumable = filterResumableSessions(all, sessionId)
          .filter(isSubstantiveSession)
          .filter(l => !boardHomed.has(getSessionIdFromLog(l) ?? ''))
          // Router-crew transcripts (party seats / scribe Implementer) are not
          // the operator's sessions — they were flooding the strip ring + the
          // +N count after every party run (task #73/#75). /sessions shows
          // them in their own section; the strip is operator work only.
          .filter(l => !isCrewSession(l))
          // PROJECT SCOPE: the berth ring tabs
          // between THIS project's sessions only — /resume is the
          // cross-project reach.
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
          // /clear'ed sessions are deliberately-closed work — out of the
          // ring (the cleared cache); /resume still retrieves them.
          .filter(l => !isSessionCleared(getSessionIdFromLog(l)))
        resumable.sort(
          (a, b) =>
            new Date(b.modified).getTime() - new Date(a.modified).getTime(),
        )
        if (alive) {
          lastKnownTabs.set(scopeKey, resumable)
          setTabs({ key: scopeKey, rows: resumable })
        }
      } catch {
        // Errors render as empty but are NOT cached — the next mount retries
        // instead of pinning a transient failure as the known state.
        if (alive) setTabs({ key: scopeKey, rows: [] })
      }
    })()
    return () => {
      alive = false
    }
  }, [scopeKey])

  //  R1c: the Session Concourse action is a
  // PERSISTENT element of this top-level session-navigation grammar whenever
  // the surface is genuinely available (registered + fullscreen — never an
  // advertised dead capability). The rail therefore renders even with zero
  // other sessions when it carries the concourse entry; thin terminals still
  // shed the strip entirely (the statusbar row keeps priority).
  const concourseLive = routeSurfaceRegistered('concourse') && isFullscreenEnvEnabled()
  // THE PLAIN WORLD (a `--chat` boot, the concourse switched off): the chip
  // stays — it is the explicit door to the plain live view of the sessions
  // (rule 5's reduced stage; /concourse is the same door) — but it says what
  // it opens and how the concourse comes back, never "one board".
  const plainWorld = chatOnlyBoot()
  const tabList = others ?? []
  // The rail's ONE visibility truth, published as live chrome-row truth
  // (helmFocus store) so height budgets subtract what this rail actually
  // paints instead of guessing with a constant — the zero-session persistent
  // rail otherwise overflows the ask-card height law by exactly this row.
  const railVisible = !(tabList.length === 0 && !concourseLive) && cols >= 70
  // THE ⌥←→ FLIP (the advert made real: the
  // hint below named the chord, the action graph called ⌥←/→ "the session
  // tab-flip", and neither a binding nor a handler existed anywhere; a
  // driven ⌥← did nothing). Armed exactly as advertised: an empty prompt
  // (a draft keeps the arrows for the composer) and a tab to flip to; the
  // flip rides the SAME `/sessiontab <id>` dispatch the clicks use. ⌥→ =
  // the most recent other session (the common two-session hop); ⌥← walks
  // the recency ring from its far end — a strike-able ordering, one line
  // each. Registered before the visibility return (hook order).
  const flipTo = (log: LogOption | undefined): void => {
    const id = log !== undefined ? getSessionIdFromLog(log) : undefined
    if (id !== undefined && id !== null) requestCommandDispatch(`/sessiontab ${id}`)
  }
  const flipArmed = railVisible && promptEmpty && tabList.length > 0
  useKeybinding('chat:flipSessionForward', () => flipTo(tabList[0]), { context: 'Chat', isActive: flipArmed })
  useKeybinding('chat:flipSessionBack', () => flipTo(tabList[tabList.length - 1]), { context: 'Chat', isActive: flipArmed })
  useEffect(() => {
    setSessionRailRows(railVisible ? 1 : 0)
    return () => setSessionRailRows(0)
  }, [railVisible])
  if (!railVisible) return null

  // Ordered shed: more tabs as the row widens. truncate-end on the row is the
  // final backstop, but budgeting the tab COUNT keeps labels readable.
  const room = cols < 100 ? 1 : cols < 130 ? 2 : 3
  const shown = tabList.slice(0, room)
  const overflow = tabList.length - shown.length

  // The hint slot: hovered berth ⇒ its full title + honest age (the row as its
  // own tooltip); otherwise the standing affordances — with the ⌥←→ chord
  // named ONLY while it is actually armed (empty prompt).
  const hoveredConcourse = hoverOwner === 'sessiontabs:row:concourse'
  const hoveredLog = hovered != null ? shown[hovered] : undefined
  const hint = hoveredConcourse
    ? plainWorld
      ? `   \u21b3 live view of your sessions \u2014 the concourse is off in this boot; ${concourseWayBack()} \u00b7 click to open`
      : '   \u21b3 Session Concourse \u2014 every session, one board \u00b7 click to open'
    : hoveredLog
    ? `   ↳ ${truncateToWidth(tabLabel(hoveredLog), PREVIEW_W)} · ${formatRelativeTimeAgo(hoveredLog.modified, { style: 'short' })} · click to flip`
    : promptEmpty && tabList.length > 0
      ? // The chord named ONLY while it can fire (a printed key that does
        // not fire is a lie): an empty prompt AND a tab to flip to —
        // board-homed sessions live on the concourse, so a strip with no
        // tabs advertises /sessions alone.
        `   ${keyHintLabel('⌥←→')} flip · /sessions`
      : '   /sessions'

  // Box-per-tab (trust-cockpit W4): each ▢ is a REAL mouse target dispatching
  // the targeted `/sessiontab <id>` flip through the ONE submit dispatcher
  // (helmFocus.requestCommandDispatch → PromptInput) — and the overflow `+N`
  // opens the /sessions switcher (a count you can act on, not dead text).
  // Width discipline: every tab is flexShrink={0} with its label already
  // truncated to LABEL_W and the tab COUNT budgeted by cols above; the
  // trailing hint is the one shrinkable segment (truncate-end), so tabs never
  // tear mid-glyph at boundary widths.
  return (
    // No width="100%": the layout
    // engine resolves percent widths against the parent's BORDER BOX, so
    // inside MercuryFrame's bordered+padded SESSIONS card a percent row laid
    // out 4 cols wider than the content area — the hint's truncate-end budget
    // then crossed the card's right border under pressure. The default
    // cross-axis stretch sizes this row to the parent's CONTENT box exactly.
    <Box paddingX={framed ? 0 : 1} overflow="hidden">
      {framed ? (
        concourseLive ? (
          /* R1c: the panel label IS the persistent Session
             Concourse control — one click or its keyboard route (/concourse,
             the same composer-boundary typed action) opens the board. Hover
             carries the affordance; the trailing chevron says "this leads
             somewhere" even without color. */
          <Box flexShrink={0}>
            <InteractiveRow
              id="sessiontabs:row:concourse"
              directActivate
              onActivate={() => requestCommandDispatch('/concourse')}
              flexShrink={0}
            >
              {hover => (
                <Box>
                  <Text>
                    <Text color={tokens.info}>⊞ </Text>
                    {/* ONE hover language: chrome chips
                        glow in the info family — the nested surface2 fill
                        and the white flip were the second language; the
                        row's own hoverStyle owns any fill. */}
                    <Text color={hover ? 'infoShimmer' : tokens.info} bold>
                      SESSIONS
                    </Text>
                    <Text color={hover ? tokens.info : FAINT}> ›</Text>
                  </Text>
                </Box>
              )}
            </InteractiveRow>
            <Text color={FAINT}>{' │  '}</Text>
          </Box>
        ) : (
          <Box flexShrink={0}>
            <Text>
              {/* An informational panel label: the info channel — the
                  ACTIVE tab below keeps the accent as the genuine focus cue. */}
              <Text color={tokens.info}>⊞ </Text>
              <Text color={tokens.info} bold>
                SESSIONS
              </Text>
              <Text color={FAINT}>{'  │  '}</Text>
            </Text>
          </Box>
        )
      ) : concourseLive ? (
        /* The inline strip leads with the same persistent concourse chip. */
        <Box flexShrink={0}>
          <InteractiveRow
            id="sessiontabs:row:concourse"
            directActivate
            onActivate={() => requestCommandDispatch('/concourse')}
            flexShrink={0}
          >
            {hover => (
              <Box>
                <Text>
                  <Text color={tokens.info}>⊞ </Text>
                  <Text color={hover ? tokens.info : tokens.textSecondary}>{plainWorld ? 'live view' : 'concourse'}</Text>
                  <Text color={hover ? tokens.info : FAINT}> ›</Text>
                </Text>
              </Box>
            )}
          </InteractiveRow>
          <Text color={FAINT}>{'  │  '}</Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text>
          <Text color={accent}>▣ </Text>
          <Text bold color={IVORY} underline>
            this session
          </Text>
          <Text color={FAINT}>{'  │'}</Text>
        </Text>
      </Box>
      {shown.map((log, i) => {
        const id = getSessionIdFromLog(log)
        const isHover = hovered === i
        return (
          <React.Fragment key={id ?? i}>
            {/* The inter-tab gap lives OUTSIDE the hover target — inside it,
                the highlight bled two cells left of the ▢ chip (operator
                screenshot). */}
            <Box flexShrink={0}>
              <Text>{'  '}</Text>
            </Box>
            <InteractiveRow
              id={`sessiontabs:row:${id ?? `pos-${i}`}`}
              directActivate
              unavailable={!id}
              onActivate={id ? () => requestCommandDispatch(`/sessiontab ${id}`) : undefined}
              flexShrink={0}
            >
              {hover => (
                <Box>
                  <Text>
                    <Text color={tokens.textMuted}>{'▢ '}</Text>
                    {/* ONE hover language: the berth glows in the info
                        family; the nested fill + white flip retire. */}
                    <Text color={hover || isHover ? tokens.info : tokens.textSecondary}>
                      {truncateToWidth(tabLabel(log), LABEL_W)}
                    </Text>
                  </Text>
                </Box>
              )}
            </InteractiveRow>
          </React.Fragment>
        )
      })}
      {overflow > 0 ? (
        <>
          <Box flexShrink={0}>
            <Text>{'  '}</Text>
          </Box>
          <InteractiveRow
            id="sessiontabs:row:more"
            directActivate
            onActivate={() => requestCommandDispatch('/sessions')}
            flexShrink={0}
          >
            {hover => <Text color={hover ? IVORY : FAINT}>{`+${overflow}`}</Text>}
          </InteractiveRow>
        </>
      ) : null}
      <Box>
        <Text wrap="truncate-end" color={FAINT}>
          {hovered === -1 ? `   ↳ ${overflow} more · click for /sessions` : hint}
        </Text>
      </Box>
    </Box>
  )
}

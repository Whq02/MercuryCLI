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

const LABEL_W = 18
const PREVIEW_W = 46

const lastKnownTabs = new Map<string, LogOption[]>()

export function SessionTabs({
  cols,
  framed = false,
}: {
  cols: number
  framed?: boolean
}): React.ReactNode {
  
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const sessionId = getSessionId()
  const scopeKey = `${getProjectRoot() || ''}::${sessionId}`
  const [tabs, setTabs] = useState<{ key: string; rows: LogOption[] | null }>(
    () => ({ key: scopeKey, rows: lastKnownTabs.get(scopeKey) ?? null }),
  )
  if (tabs.key !== scopeKey) {
    setTabs({ key: scopeKey, rows: lastKnownTabs.get(scopeKey) ?? null })
  }
  const others = tabs.key === scopeKey ? tabs.rows : lastKnownTabs.get(scopeKey) ?? null
  const hoverOwner = useHoverOwner()
  const hovered: number | null =
    hoverOwner != null && hoverOwner.startsWith('sessiontabs:row:')
      ? hoverOwner.slice('sessiontabs:row:'.length) === 'more'
        ? -1
        : Number(hoverOwner.slice('sessiontabs:row:'.length))
      : null
  const promptEmpty = useSyncExternalStore(
    subscribePromptEmpty,
    isPromptEmpty,
    isPromptEmpty,
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const all = await loadAllProjectsMessageLogs()
        const boardHomed = boardHomedSessionIds()
        const resumable = filterResumableSessions(all, sessionId)
          .filter(isSubstantiveSession)
          .filter(l => !boardHomed.has(getSessionIdFromLog(l) ?? ''))
          .filter(l => !isCrewSession(l))
          .filter(l => isProjectSession(l, getProjectRoot() || ''))
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
        if (alive) setTabs({ key: scopeKey, rows: [] })
      }
    })()
    return () => {
      alive = false
    }
  }, [scopeKey])

  const concourseLive = routeSurfaceRegistered('concourse') && isFullscreenEnvEnabled()
  const plainWorld = chatOnlyBoot()
  const tabList = others ?? []
  const railVisible = !(tabList.length === 0 && !concourseLive) && cols >= 70
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

  const room = cols < 100 ? 1 : cols < 130 ? 2 : 3
  const shown = tabList.slice(0, room)
  const overflow = tabList.length - shown.length

  const hoveredConcourse = hoverOwner === 'sessiontabs:row:concourse'
  const hoveredLog = hovered != null ? shown[hovered] : undefined
  const hint = hoveredConcourse
    ? plainWorld
      ? `   \u21b3 live view of your sessions \u2014 the concourse is off in this boot; ${concourseWayBack()} \u00b7 click to open`
      : '   \u21b3 Session Concourse \u2014 every session, one board \u00b7 click to open'
    : hoveredLog
    ? `   ↳ ${truncateToWidth(tabLabel(hoveredLog), PREVIEW_W)} · ${formatRelativeTimeAgo(hoveredLog.modified, { style: 'short' })} · click to flip`
    : promptEmpty && tabList.length > 0
      ?
        `   ${keyHintLabel('⌥←→')} flip · /sessions`
      : '   /sessions'

  return (
    <Box paddingX={framed ? 0 : 1} overflow="hidden">
      {framed ? (
        concourseLive ? (
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
                    {
}
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
              {
}
              <Text color={tokens.info}>⊞ </Text>
              <Text color={tokens.info} bold>
                SESSIONS
              </Text>
              <Text color={FAINT}>{'  │  '}</Text>
            </Text>
          </Box>
        )
      ) : concourseLive ? (
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
            {
}
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
                    {
}
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

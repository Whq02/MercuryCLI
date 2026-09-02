import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import type { LogOption } from '../types/logs.js'
import { formatFileSize } from '../utils/format.js'


const TITLE_WIDTH = 34
const DATE_WIDTH = 12
const MAX_ROWS = 12

function sessionTitle(s: LogOption): string {
  return (s.customTitle || s.summary || s.firstPrompt || s.sessionId || 'untitled').replace(/\s+/g, ' ').trim()
}

export function MercuryResume({
  sessions,
  loading = false,
  onSelect,
  onClose,
  isActive = true,
}: {
  sessions?: LogOption[]
  loading?: boolean
  onSelect?: (session: LogOption) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const all = Array.isArray(sessions) ? sessions : []
  const shown = useMemo(() => all.slice(0, MAX_ROWS), [all])

  const [sel, setSel] = useState(0)

  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  const overlayToken = useRegisterOverlay('resume', isActive)
  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical' })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action === 'movePrevious') {
        event.stopImmediatePropagation()
        setSel(s => Math.max(0, s - 1))
        return
      }
      if (action === 'moveNext') {
        event.stopImmediatePropagation()
        setSel(s => Math.min(Math.max(0, shown.length - 1), s + 1))
        return
      }
      if (action === 'first') {
        event.stopImmediatePropagation()
        setSel(0)
        return
      }
      if (action === 'last') {
        event.stopImmediatePropagation()
        setSel(Math.max(0, shown.length - 1))
        return
      }
      if (!pastOpenEvent()) return
      if (action === 'activate') {
        event.stopImmediatePropagation()
        const s = shown[Math.min(sel, Math.max(0, shown.length - 1))]
        if (s) onSelect?.(s)
        return
      }
    },
    { isActive },
  )

  if (loading) {
    return (
      <CommandCenter view="resume" onClose={onClose}>
        <Box marginTop={1}>
          <Text color={FAINT}>loading sessions…</Text>
        </Box>
      </CommandCenter>
    )
  }

  if (all.length === 0) {
    return (
      <CommandCenter view="resume" onClose={onClose}>
        <Box marginTop={1}>
          <EmptyState
            title="no resumable sessions"
            hint="past sessions in this project appear here once you've had at least one"
          />
        </Box>
      </CommandCenter>
    )
  }

  return (
    <CommandCenter view="resume" onClose={onClose} captureInput={false} footer="↑↓ move · ↵ resume">
      <Box marginTop={1}>
        <Text>
          <StateBadge state="live" label="sessions" />
          <Text color={FAINT}> · {all.length} in this project</Text>
        </Text>
      </Box>

      <SectionHeader count={all.length}>Resume</SectionHeader>
      {shown.map((s, i) => {
        const here = i === sel
        const teammate = s.isTeammate || s.isSidechain
        return (
          <Text key={`${s.value}-${s.sessionId ?? i}`}>
            <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={FAINT}>{padTo(truncateToWidth(s.date, DATE_WIDTH), DATE_WIDTH)}</Text>
            <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(sessionTitle(s), TITLE_WIDTH), TITLE_WIDTH)}</Text>
            <Text color={FAINT}>{padTo(s.messageCount !== undefined ? `${s.messageCount} msgs` : formatFileSize(s.fileSize ?? 0), 9)}</Text>
            {teammate ? <Text color={TEAL}> {GLYPH.handoff} teammate</Text> : null}
          </Text>
        )
      })}
      {all.length > shown.length ? (
        <Text color={FAINT}>  +{all.length - shown.length} more</Text>
      ) : null}
    </CommandCenter>
  )
}

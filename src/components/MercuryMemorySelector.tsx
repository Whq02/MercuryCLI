import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

// ============================================================================
//  MercuryMemorySelector — the warm-ink memory-target list SHOWCASE specimen
//  (the 'Memory selector' card in MercuryShowcase). NOTE: NOT on the live /memory
//  path — live /memory mounts MemoryFileSelector (Mercury wraps it
//  in MercuryMemoryFilesDialog/CommandCenter, commands/memory/memory.tsx). Edit this file
//  for the showcase card, not the live picker. A real list over
//  the memory files (passed in — this surface never scrapes the filesystem
//  itself): ↑↓ moves the in-row cursor (clamp, never wrap), ↵ opens the
//  highlighted memory target for editing, esc closes. One useInput over a local
//  selectedIndex, isActive-gated, 150ms enter-buffer so the launching Enter
//  can't open row 0. Honest states: an empty EmptyState when no targets, a dot
//  per row showing whether the file exists yet (● exists / ○ would be created).
//  Paths truncate to the column width; the list is bounded with a `+N more`.
// ============================================================================

export type MemoryTarget = {
  label: string
  path: string
  scope: 'User' | 'Project' | 'Local' | string
  exists?: boolean
}

const LABEL_WIDTH = 18
const PATH_WIDTH = 40
const MAX_ROWS = 12

export function MercuryMemorySelector({
  targets,
  onSelect,
  onClose,
  isActive = true,
}: {
  targets?: MemoryTarget[]
  onSelect?: (target: MemoryTarget) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  const accent = useSessionAccent().accent
  // Guard: a missing/empty array is a state, never a crash.
  const all = Array.isArray(targets) ? targets : []
  const shown = useMemo(() => all.slice(0, MAX_ROWS), [all])

  const [sel, setSel] = useState(0)

  // 150ms buffer so the keystroke that launched /memory doesn't immediately
  // open row 0 — as a open-event seq gate (event identity, not wall-clock), not the old
  // setTimeout→setState flag whose parked commit swallowed the first ↵
  // nondeterministically (§STALE-PAINT idle-parked-commits;
  // swept). Only ↵ waits; esc/arrows respond instantly.
  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    setSel(s => Math.min(s, Math.max(0, shown.length - 1)))
  }, [shown.length])

  useInput(
    (_input, key) => {
      if (!isActive) return
      if (key.escape) {
        onClose()
        return
      }
      if (key.upArrow) {
        setSel(s => Math.max(0, s - 1))
        return
      }
      if (key.downArrow) {
        setSel(s => Math.min(Math.max(0, shown.length - 1), s + 1))
        return
      }
      if (!pastOpenEvent()) return
      if (key.return) {
        const t = shown[Math.min(sel, Math.max(0, shown.length - 1))]
        if (t) onSelect?.(t)
        return
      }
    },
    { isActive },
  )

  // Honest empty — nothing to edit.
  if (all.length === 0) {
    return (
      <CommandCenter view="memory" onClose={onClose}>
        <Box marginTop={1}>
          <EmptyState
            title="no memory targets"
            hint="user + project MERCURY.md targets appear here — selecting one creates it if missing"
          />
        </Box>
      </CommandCenter>
    )
  }

  return (
    <CommandCenter view="memory" onClose={onClose} captureInput={false} footer={isActive ? '↑↓ move · ↵ edit' : 'showcase specimen — keys inert'}>
      <Box marginTop={1}>
        <Text>
          <StateBadge state="live" label="memory" />
          <Text color={FAINT}> · where should the memory go?</Text>
        </Text>
      </Box>

      <SectionHeader count={all.length}>Targets</SectionHeader>
      {shown.map((t, i) => {
        const here = i === sel
        const exists = t.exists !== false
        return (
          <Text key={t.path}>
            <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={exists ? TEAL : FAINT}>{exists ? GLYPH.done : GLYPH.pending} </Text>
            <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(t.label, LABEL_WIDTH), LABEL_WIDTH)}</Text>
            <Text color={FAINT}>{padTo(truncateToWidth(t.path, PATH_WIDTH), PATH_WIDTH)}</Text>
            <Text color={SECOND}>{t.scope}</Text>
          </Text>
        )
      })}
      {all.length > shown.length ? (
        <Text color={FAINT}>  +{all.length - shown.length} more</Text>
      ) : null}
    </CommandCenter>
  )
}

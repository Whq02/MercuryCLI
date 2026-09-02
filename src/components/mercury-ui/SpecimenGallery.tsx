import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { FAINT, IVORY } from '../mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from './components.js'
import { useSessionAccent } from './sessionAccent.js'
import { type SnapshotState } from './theme.js'
import { useOpenEventGate } from './useOpenEventGate.js'

// ============================================================================
//  SpecimenGallery — a reusable navigable index for a set of terminal specimen
//  views. ↑↓ select · ↵ opens the specimen (which owns its own esc → back) · esc
//  closes. Shared by /sessions, /settings, and any future surface group so the
//  keyboard navigation lives in one place (ink-component-patterns: one useInput
//  over a local selectedIndex, no useFocus, clamp don't wrap, Enter-buffer).
// ============================================================================

export type GalleryItem = {
  key: string
  label: string
  state: SnapshotState
  Component: React.ComponentType<{ onClose: () => void }>
  /** Optional section label. When set, a SectionHeader is rendered before the first
   *  item of each group (visual only — the cursor still indexes the flat `items`
   *  array, so navigation is unchanged). Omit on every item ⇒ flat list, byte-identical. */
  group?: string
}

export function SpecimenGallery({
  view,
  heading,
  note,
  items,
  onClose,
}: {
  view: string
  heading: string
  note?: string
  items: GalleryItem[]
  onClose: () => void
}): React.ReactNode {
  const { accent } = useSessionAccent() // live identity accent (TERRA / critter / scribe-glow)
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
  // 150ms buffer so the keystroke that launched the gallery doesn't
  // immediately open row 0 — as a open-event seq gate (event identity, not wall-clock), not the old
  // setTimeout→setState flag whose parked commit could swallow the first ↵ for
  // seconds (§STALE-PAINT idle-parked-commits; swept
  // esc/← and ↑↓ respond instantly; only ↵ waits.
  const pastOpenEvent = useOpenEventGate()

  useInput(
    (_i, key) => {
      if (open !== null) return
      if (key.escape || key.leftArrow) return onClose()
      if (key.upArrow) setSel(s => Math.max(0, s - 1))
      if (key.downArrow) setSel(s => Math.min(items.length - 1, s + 1))
      if (!pastOpenEvent()) return
      if (key.return) setOpen(Math.min(sel, items.length - 1))
    },
    { isActive: open === null },
  )

  if (open !== null) {
    const C = items[open]!.Component
    return <C onClose={() => setOpen(null)} />
  }

  return (
    <CommandCenter
      // The blanket DESIGN-SPECIMEN banner is honest only for a gallery of pure
      // specimens; a mixed gallery (/sessions hosts the LIVE session manager)
      // relies on the per-item StateBadge instead (audit U15).
      specimen={!items.some(it => it.state === 'live')}
      view={view} onClose={onClose} captureInput={false} footer="↑↓ select · ↵ open">
      <SectionHeader>{heading}</SectionHeader>
      {items.map((it, i) => {
        // Visual section break when the group changes (cursor logic unaffected — `sel`
        // still indexes the flat items array; headers are not selectable rows).
        const showGroup = it.group != null && it.group !== items[i - 1]?.group
        return (
          <React.Fragment key={it.key}>
            {showGroup ? (
              <Box marginTop={i === 0 ? 0 : 1}>
                <SectionHeader>{it.group!}</SectionHeader>
              </Box>
            ) : null}
            <Text>
              <Text color={i === sel ? accent : FAINT}>{i === sel ? '▸ ' : '  '}</Text>
              <StateBadge state={it.state} label={it.label} mono />
            </Text>
          </React.Fragment>
        )
      })}
      {note ? (
        <Box marginTop={1}>
          <Text color={FAINT}>
            {note} · <Text color={IVORY}>↵</Text> to open
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}

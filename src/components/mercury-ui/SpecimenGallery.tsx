import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { FAINT, IVORY } from '../mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from './components.js'
import { useSessionAccent } from './sessionAccent.js'
import { type SnapshotState } from './theme.js'
import { useOpenEventGate } from './useOpenEventGate.js'


export type GalleryItem = {
  key: string
  label: string
  state: SnapshotState
  Component: React.ComponentType<{ onClose: () => void }>
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
  const { accent } = useSessionAccent()
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState<number | null>(null)
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
      specimen={!items.some(it => it.state === 'live')}
      view={view} onClose={onClose} captureInput={false} footer="↑↓ select · ↵ open">
      <SectionHeader>{heading}</SectionHeader>
      {items.map((it, i) => {
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

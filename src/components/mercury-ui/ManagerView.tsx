import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  groupedNormalSurfaces,
  type EffectiveSurface,
} from '../../commands/effectiveCatalogue.js'
import { FAINT, IVORY, SECOND, TERRA } from '../mercuryPalette.js'
import { Sigil } from './assets.js'
import { CommandCenter, EmptyState, SectionHeader } from './components.js'
import { GLYPH, truncateToWidth } from './glyphs.js'
import {
  managerMetaLine,
  emphasisSegments,
  matchesSurfaceQuery,
  surfaceQueryTokens,
} from './managerFilter.js'
import { paneWindow } from './paneWindow.js'
import { useSessionAccent } from './sessionAccent.js'
import { useInteractiveList } from './useInteractiveList.js'
import { useOpenEventGate } from './useOpenEventGate.js'
import { InteractiveRow } from './InteractiveRow.js'


type FlatRow = { surface: EffectiveSurface; groupLabel: string }

const NAME_W = 15

export function ManagerView({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (name: string) => void
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const { columns, rows: termRows } = useTerminalSize()
  const [flat] = useState<FlatRow[]>(() =>
    groupedNormalSurfaces().flatMap(g =>
      g.surfaces
        .filter(s => s.name !== 'surfaces')
        .map(surface => ({ surface, groupLabel: g.label })),
    ),
  )

  const [query, setQuery] = useState('')
  const liveQueryRef = useRef(query)
  liveQueryRef.current = query
  const selectedRowRef = useRef<FlatRow | null>(null)
  const focusFirstRef = useRef(false)
  const pastOpenEvent = useOpenEventGate()

  const applyQuery = (next: string): void => {
    liveQueryRef.current = next
    setQuery(next)
    const nextTokens = surfaceQueryTokens(next)
    const focused = selectedRowRef.current
    if (
      nextTokens.length > 0 &&
      focused !== null &&
      !matchesSurfaceQuery(focused.surface, nextTokens)
    ) {
      focusFirstRef.current = true
    }
  }

  useInput((input, key, event) => {
    if (key.escape && liveQueryRef.current.length > 0) {
      event.stopImmediatePropagation()
      applyQuery('')
      return
    }
    if (!pastOpenEvent()) return
    if ((key.backspace || key.delete) && liveQueryRef.current.length > 0) {
      event.stopImmediatePropagation()
      applyQuery(liveQueryRef.current.slice(0, -1))
      return
    }
    if (
      input.length > 0 &&
      !key.ctrl &&
      !key.meta &&
      !key.tab &&
      !key.return &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageUp &&
      !key.pageDown
    ) {
      event.stopImmediatePropagation()
      applyQuery(liveQueryRef.current + input)
    }
  })

  const tokens = surfaceQueryTokens(query)
  const filtered =
    tokens.length === 0 ? flat : flat.filter(f => matchesSurfaceQuery(f.surface, tokens))

  const { selectedIndex: sel, selectedRow, note, hints, moveTo, rowProps } = useInteractiveList({
    rows: filtered,
    rowId: f => f.surface.name,
    idNamespace: 'manager',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'open',
        run: f => {
          if (!f)
            return tokens.length > 0
              ? 'no surfaces match — esc clears the filter'
              : 'no surfaces to open'
          onPick(f.surface.name)
          return null
        },
      },
    ],
  })
  selectedRowRef.current = selectedRow

  useEffect(() => {
    if (!focusFirstRef.current) return
    focusFirstRef.current = false
    moveTo(0)
  })

  const showDesc = columns >= 96
  const descW = Math.max(16, columns - NAME_W - 14)

  const availRows = useModalOrTerminalSize({ rows: termRows, columns }).rows
  const rowCap = Math.max(4, availRows - 21)
  const win = paneWindow(filtered.length, sel, rowCap)

  return (
    <CommandCenter
      view="surfaces"
      onClose={onClose}
      captureInput={false}
      footer={query === '' ? hints : `${hints ?? '↵ open'} · esc clears the filter`}
    >
      <Box marginTop={1} flexDirection="row">
        <Sigil size="small" />
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text color={TERRA}>{GLYPH.prompt} </Text>
            <Text color={IVORY}>{truncateToWidth(query, 48)}</Text>
            <Text color={FAINT}>{query === '' ? 'type to filter…' : GLYPH.caretBlock}</Text>
          </Box>
          <Text color={FAINT}>
            {managerMetaLine(filtered.length, flat.length, tokens.length > 0)}
          </Text>
        </Box>
      </Box>

      {tokens.length > 0 && filtered.length === 0 ? (
        <Box marginTop={1}>
          <EmptyState
            title="No surfaces match"
            hint="backspace widens · esc clears the filter"
            tone="gated"
          />
        </Box>
      ) : null}

      {win.above > 0 ? <Text color={FAINT}>{'  '}↑ {win.above} more</Text> : null}
      {filtered.map((f, i) => {
        if (i < win.start || i >= win.end) return null
        const here = i === sel
        const head = i === win.start || filtered[i - 1]!.groupLabel !== f.groupLabel
        return (
          <React.Fragment key={f.surface.name}>
            {head ? <SectionHeader>{f.groupLabel}</SectionHeader> : null}
            <InteractiveRow {...rowProps(f, i)}>
              <Text>
                <Text color={here ? accent : FAINT}>{here ? '▸ ' : '  '}</Text>
                <Text color={here ? IVORY : SECOND}>
                  {emphasisSegments(`/${f.surface.name}`.padEnd(NAME_W), tokens).map((seg, k) => (
                    <Text key={k} bold={seg.hit}>{seg.text}</Text>
                  ))}
                </Text>
                {showDesc ? (
                  <Text color={FAINT}>
                    {' '}
                    {emphasisSegments(truncateToWidth(f.surface.description, descW), tokens).map((seg, k) => (
                      <Text key={k} bold={seg.hit}>{seg.text}</Text>
                    ))}
                  </Text>
                ) : null}
              </Text>
            </InteractiveRow>
          </React.Fragment>
        )
      })}
      {win.below > 0 ? <Text color={FAINT}>{'  '}↓ {win.below} more</Text> : null}

      {note ? (
        <Box marginTop={1}>
          <Text color={FAINT}>{note}</Text>
        </Box>
      ) : query !== '' ? (
        <Box marginTop={1}>
          <Text color={FAINT}>↵ opens the surface · esc clears the filter</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            ↵ opens the surface · esc returns · open from anywhere with{' '}
            <Text color={IVORY}>ctrl+x m</Text>
          </Text>
        </Box>
      )}
    </CommandCenter>
  )
}

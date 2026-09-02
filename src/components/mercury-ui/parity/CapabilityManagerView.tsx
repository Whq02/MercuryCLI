import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { Box, Text, useInput } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import {
  collectReadiness,
  type ReadinessKind,
  type ReadinessRecord,
} from '../../../utils/readiness.js'
import { CommandCenter, EmptyState, StateBadge } from '../components.js'
import { padTo, truncateToWidth } from '../glyphs.js'
import { useSessionAccent } from '../sessionAccent.js'

// ============================================================================
//  CapabilityManagerView — the LOCAL-FIRST capability center (the ONE
//  capability surface — /capabilities and /capabilities-detail mount THIS view).
//
//  One readiness truth (utils/readiness.ts: ready · starting · configured ·
//  degraded · unavailable · disabled · failed · stale) over every local
//  source — tools, MCP connection states from THIS process, LSP/DAP lanes,
//  engines, extensions/skills, and the full FLAG_REGISTRY environment section.
//  Master-detail: the list windows over EVERY row (no caps — cursor-following
//  window), the detail pane shows the full wrapped reason/remedy/source.
//
//  Keys: ↑↓ move · ctrl+u/d half-page · 1-6 section jump · / filter ·
//  ↵ toggle detail · r refresh · esc close (filter first, then the view).
// ============================================================================

interface Section {
  key: string
  title: string
  kinds: ReadinessKind[]
}

const SECTIONS: Section[] = [
  { key: '1', title: 'TOOLS', kinds: ['tool'] },
  { key: '2', title: 'MCP SERVERS', kinds: ['mcp'] },
  { key: '3', title: 'LANGUAGE & DEBUG LANES', kinds: ['lane'] },
  { key: '4', title: 'ENGINES & BACKGROUND', kinds: ['engine'] },
  { key: '5', title: 'EXTENSIONS & SKILLS', kinds: ['extension', 'skill'] },
  { key: '6', title: 'ENVIRONMENT (flag registry)', kinds: ['env'] },
]

interface FlatRow {
  record: ReadinessRecord
  section: number
}

function buildRows(records: ReadinessRecord[]): FlatRow[] {
  const rows: FlatRow[] = []
  SECTIONS.forEach((s, si) => {
    for (const r of records) {
      if (s.kinds.includes(r.kind)) rows.push({ record: r, section: si })
    }
  })
  return rows
}

function ageLabel(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 2) return 'just now'
  if (s < 120) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

function stateTone(state: ReadinessRecord['state']): string {
  switch (state) {
    case 'ready':
      return TEAL
    case 'failed':
      return CRIMSON
    case 'starting':
    case 'degraded':
    case 'stale':
      return AMBER
    case 'configured':
      return SECOND
    default:
      return FAINT
  }
}

function Row({ row, cursor, width, accent }: { row: FlatRow; cursor: boolean; width: number; accent: string }): React.ReactNode {
  const r = row.record
  // Exact column math (StateBadge = glyph + space + label): cursor 2 + badge
  // (2 + labelW) + separating space; the note gets the remainder and is
  // TRUNCATED to it — a long detail must never wrap and shear the rows below.
  const labelW = Math.min(24, Math.max(12, Math.floor(width * 0.3)))
  const noteW = Math.max(8, width - labelW - 6)
  return (
    <Text wrap="truncate">
      <Text color={cursor ? accent : FAINT}>{cursor ? '▸ ' : '  '}</Text>
      <StateBadge state={r.state} label={padTo(truncateToWidth(r.label, labelW), labelW)} mono />
      <Text color={cursor ? IVORY : FAINT}> {truncateToWidth(r.detail, noteW)}</Text>
    </Text>
  )
}

function DetailCard({ r, width }: { r: ReadinessRecord | undefined; width: number }): React.ReactNode {
  if (!r) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={FAINT} paddingX={1} width={width}>
      <Text>
        <StateBadge state={r.state} label={r.label} />
      </Text>
      <Text color={IVORY} wrap="wrap">
        {r.detail}
      </Text>
      {r.remedy ? (
        <Text color={AMBER} wrap="wrap">
          fix: {r.remedy}
        </Text>
      ) : null}
      <Text color={FAINT} wrap="wrap">
        source: {r.source}
      </Text>
      <Text color={FAINT}>
        checked {ageLabel(r.lastCheckedAt)}
        {r.restartRequired ? ' · change needs relaunch' : ''}
      </Text>
    </Box>
  )
}

export function CapabilityManagerView({ onClose }: { onClose: () => void }): React.ReactNode {
  const { accent } = useSessionAccent()
  const { columns, rows: termRows } = useTerminalSize()
  const [report, setReport] = useState(() => collectReadiness())
  const [filter, setFilter] = useState('')
  const [filterMode, setFilterMode] = useState(false)
  const [sel, setSel] = useState(0)
  const [detailOpen, setDetailOpen] = useState(true)

  const allRows = useMemo(() => buildRows(report.records), [report])
  const rows = useMemo(() => {
    if (!filter) return allRows
    const q = filter.toLowerCase()
    return allRows.filter(
      ({ record: r }) =>
        r.label.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q) || r.state.includes(q),
    )
  }, [allRows, filter])

  const clampedSel = Math.min(sel, Math.max(0, rows.length - 1))
  const selected = rows[clampedSel]?.record

  // Geometry: wide terminals get a side detail pane; narrow ones stack it
  // below the list. The list windows to the height budget and the window
  // FOLLOWS the cursor (no unreachable rows, no dead keys at either end).
  const wide = columns >= 100
  const detailW = wide ? Math.min(46, Math.max(34, Math.floor(columns * 0.38))) : Math.max(40, columns - 6)
  const listW = wide ? columns - detailW - 8 : columns - 6
  // Height budget: the view is INLINE in the transcript (bounded live
  // region) — banner + CommandCenter chrome + status band + up to six
  // section headers + footer eat ~24 rows; the narrow stacked detail card
  // eats ~8 more. The list windows to what is left so the footer is never
  // pushed off-screen (no scrollback spill, no lost keys).
  const chrome = 24 + (wide ? 0 : detailOpen ? 8 : 0)
  const visible = Math.max(4, Math.min(rows.length, (termRows || 24) - chrome))
  const winStart = Math.max(0, Math.min(clampedSel - Math.floor(visible / 2), rows.length - visible))
  const windowRows = rows.slice(winStart, winStart + visible)

  // Enter-buffer (mount-timestamp, not a state flag): action keys wait it
  // out so the launching keystroke never acts on row 0; arrows respond
  // immediately.
  const mountedAt = useRef(Date.now())
  const pastBuffer = (): boolean => Date.now() - mountedAt.current > 150

  useInput((input, key) => {
    if (filterMode) {
      if (key.escape) {
        setFilterMode(false)
        setFilter('')
        return
      }
      if (key.return) {
        setFilterMode(false)
        return
      }
      if (key.backspace || key.delete) {
        setFilter(f => f.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setFilter(f => f + input)
      return
    }
    if (key.escape) {
      if (filter) {
        setFilter('')
        return
      }
      onClose()
      return
    }
    if (key.upArrow) {
      setSel(s => Math.max(0, s - 1))
      return
    }
    if (key.downArrow) {
      setSel(s => Math.min(Math.max(0, rows.length - 1), s + 1))
      return
    }
    if (key.ctrl && input === 'u') {
      setSel(s => Math.max(0, s - Math.floor(visible / 2)))
      return
    }
    if (key.ctrl && input === 'd') {
      setSel(s => Math.min(Math.max(0, rows.length - 1), s + Math.floor(visible / 2)))
      return
    }
    if (!pastBuffer()) return
    if (input === '/') {
      setFilterMode(true)
      setFilter('')
      return
    }
    if (input === 'r') {
      setReport(collectReadiness())
      return
    }
    if (key.return) {
      setDetailOpen(o => !o)
      return
    }
    const si = SECTIONS.findIndex(s => s.key === input)
    if (si >= 0) {
      const target = rows.findIndex(r => r.section === si)
      if (target >= 0) setSel(target)
    }
  })

  const counts = useMemo(() => {
    const c = { ready: 0, attention: 0, total: rows.length }
    for (const { record: r } of rows) {
      if (r.state === 'ready') c.ready++
      else if (r.state === 'failed' || r.state === 'degraded' || r.state === 'unavailable') c.attention++
    }
    return c
  }, [rows])

  let lastSection = winStart > 0 ? windowRows[0]?.section ?? -1 : -1

  const list = (
    <Box flexDirection="column" width={listW}>
      {rows.length === 0 ? (
        <EmptyState glyph="—" title={filter ? `nothing matches "${filter}"` : 'no capability rows'} hint={filter ? 'esc clears the filter' : 'r to rescan'} />
      ) : (
        <>
          {winStart > 0 ? <Text color={FAINT}>  ↑ {winStart} more</Text> : null}
          {windowRows.map((row, i) => {
            const globalIndex = winStart + i
            const header = row.section !== lastSection ? SECTIONS[row.section] : null
            lastSection = row.section
            return (
              <React.Fragment key={row.record.id}>
                {header ? (
                  <Text color={IVORY}>
                    {header.key} · {header.title}
                  </Text>
                ) : null}
                <Row row={row} cursor={globalIndex === clampedSel} width={listW} accent={accent} />
              </React.Fragment>
            )
          })}
          {winStart + visible < rows.length ? <Text color={FAINT}>  ↓ {rows.length - winStart - visible} more</Text> : null}
        </>
      )}
    </Box>
  )

  return (
    <CommandCenter
      view="capabilities"
      onClose={onClose}
      captureInput={false}
      footer={`↑↓ move · 1-6 section · / filter · ↵ detail · r refresh`}
    >
      <Box marginTop={1} flexDirection="column">
        <Text>
          <StateBadge state="live" label="capability center" />
          <Text color={FAINT}>
            {' '}· {counts.total} row(s) · <Text color={TEAL}>{counts.ready} ready</Text>
            {counts.attention > 0 ? <Text color={AMBER}> · {counts.attention} need attention</Text> : null}
            {' '}· local runtime truth — configured is never called ready
          </Text>
        </Text>
        {filterMode || filter ? (
          <Text>
            <Text color={accent}>/ </Text>
            <Text color={IVORY}>{filter}</Text>
            <Text color={FAINT}>{filterMode ? '▌ (↵ keep · esc clear)' : ' · esc clears'}</Text>
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection={wide ? 'row' : 'column'} gap={wide ? 2 : 0}>
        {list}
        {detailOpen ? <DetailCard r={selected} width={detailW} /> : null}
      </Box>
    </CommandCenter>
  )
}

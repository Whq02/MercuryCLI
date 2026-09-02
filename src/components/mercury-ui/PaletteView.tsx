import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  formatDescriptionWithSource,
  getCommandName,
  getCommands,
  type Command,
} from '../../commands.js'
import { Box, Text, useInput } from '../../ink.js'
import {
  fetchCommandHierarchy,
  type CommandHierarchy,
} from '../../utils/commandHierarchy.js'
import { createFuzzyIndex } from '../../utils/fuzzyMatch.js'
import { getCwd } from '../../utils/cwd.js'
import { FAINT, IVORY, SECOND, TEAL, TERRA } from '../mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader } from './components.js'
import { GLYPH, truncateToWidth } from './glyphs.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useSessionAccent } from './sessionAccent.js'
import { useOpenEventGate } from './useOpenEventGate.js'


type PaletteRow = {
  command: Command
  name: string
  description: string
}

const MAX_VISIBLE = 12

export function PaletteView({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (commandName: string) => void
}): React.ReactNode {
  const cols = useTerminalSize().columns
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [rows, setRows] = useState<PaletteRow[] | null>(null)
  const [ladder, setLadder] = useState<CommandHierarchy | null>(null)

  const pastOpenEvent = useOpenEventGate()

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const commands = await getCommands(getCwd())
        if (!alive) return
        const built: PaletteRow[] = commands
          .filter(cmd => !cmd.isHidden)
          .map(cmd => ({
            command: cmd,
            name: getCommandName(cmd),
            description: formatDescriptionWithSource(cmd),
          }))
        setRows(built)
      } catch {
        if (alive) setRows([])
      }
    })()
    void (async () => {
      try {
        const h = await fetchCommandHierarchy()
        if (alive) setLadder(h)
      } catch {
        if (alive) setLadder(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const haystackOf = (r: PaletteRow): string => `${r.name} — ${r.description}`
  const index = useMemo(() => {
    if (!rows) return null
    return createFuzzyIndex(rows.map(haystackOf))
  }, [rows])

  const byName = useMemo(() => {
    const m = new Map<string, PaletteRow>()
    if (rows) for (const r of rows) if (!m.has(haystackOf(r))) m.set(haystackOf(r), r)
    return m
  }, [rows])

  const results: PaletteRow[] = useMemo(() => {
    if (!rows) return []
    if (query.trim() === '') {
      return [...rows]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_VISIBLE)
    }
    if (!index) return []
    return index
      .search(query.trim(), MAX_VISIBLE)
      .map(hit => byName.get(hit.path))
      .filter((r): r is PaletteRow => r !== undefined)
  }, [rows, index, byName, query])

  useEffect(() => {
    setSel(s => Math.max(0, Math.min(s, Math.max(0, results.length - 1))))
  }, [results.length])

  useInput((input, key) => {
    if (key.escape || key.leftArrow) return onClose()
    if (key.upArrow) {
      setSel(s => Math.max(0, s - 1))
      return
    }
    if (key.downArrow) {
      setSel(s => Math.min(Math.max(0, results.length - 1), s + 1))
      return
    }
    if (!pastOpenEvent()) return
    if (key.return) {
      const pick = results[sel]
      if (pick) onPick(pick.name)
      return
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery(q => q + input)
    }
  })

  const accent = useSessionAccent().accent

  if (rows === null) {
    return (
      <CommandCenter view="palette" onClose={onClose} captureInput={false} footer="loading">
        <Box marginTop={1}>
          <EmptyState title="Reading the command roster…" glyph={GLYPH.inProgress} />
        </Box>
      </CommandCenter>
    )
  }

  const queryDisplay = truncateToWidth(query, Math.max(24, cols - 12))

  return (
    <CommandCenter
      view="palette"
      onClose={onClose}
      captureInput={false}
      footer={
        results.length > 0 ? '↑↓ select · ↵ run · type to filter' : 'type to filter · backspace to widen'
      }
    >
      {}
      <LadderHeader ladder={ladder} />

      {}
      <Box marginTop={1}>
        <Text color={TERRA}>{GLYPH.prompt} </Text>
        <Text color={IVORY}>{queryDisplay}</Text>
        <Text color={FAINT}>{query === '' ? 'type to fuzzy-match…' : '▌'}</Text>
      </Box>

      <SectionHeader count={results.length}>Commands</SectionHeader>
      {results.length === 0 ? (
        <EmptyState
          title="No command matches"
          hint="esc / ← close · backspace to widen the query"
          tone="gated"
        />
      ) : (
        results.map((r, i) => {
          const selected = i === sel
          const desc = truncateToWidth(r.description, Math.max(16, cols - 9 - stringWidth(r.name)))
          return (
            <Text key={r.name + ':' + r.command.type}>
              <Text color={selected ? accent : FAINT}>{selected ? '▸ ' : '  '}</Text>
              <Text color={selected ? IVORY : SECOND}>/{r.name}</Text>
              <Text color={FAINT}>  {desc}</Text>
            </Text>
          )
        })
      )}
    </CommandCenter>
  )
}

function LadderHeader({ ladder }: { ladder: CommandHierarchy | null }): React.ReactNode {
  if (!ladder || ladder.rows.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={FAINT}>
          {GLYPH.handoff} command ladder · no active team — run any command directly
        </Text>
      </Box>
    )
  }
  const fc = ladder.rows.find(r => r.role === 'field-commander')
  const rc = ladder.rows.filter(r => r.role === 'room-commander')
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={FAINT}>
        {GLYPH.handoff} command ladder · {ladder.fcRoom ?? 'team'}
      </Text>
      {fc ? (
        <Text>
          <Text color={fc.running ? TEAL : FAINT}>  {GLYPH.done} </Text>
          <Text color={SECOND}>{fc.name}</Text>
          <Text color={FAINT}> · field-commander</Text>
        </Text>
      ) : null}
      {rc.slice(0, 4).map(r => (
        <Text key={r.room}>
          <Text color={r.running ? TEAL : FAINT}>  {GLYPH.dot} </Text>
          <Text color={SECOND}>{truncateToWidth(r.name, 24)}</Text>
          <Text color={FAINT}> · reports to {r.reportsTo ?? ladder.fcRoom ?? 'team'}</Text>
        </Text>
      ))}
      {rc.length > 4 ? (
        <Text color={FAINT}>  {GLYPH.dot} +{rc.length - 4} more room-commanders</Text>
      ) : null}
    </Box>
  )
}

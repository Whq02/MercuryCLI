import * as React from 'react'
import { useMemo, useState } from 'react'
import { useLoad } from '../../hooks/effects.js'
import {
  formatDescriptionWithSource,
  getCommandName,
  getCommands,
  type Command,
} from '../../commands.js'
import { Box, Text, useInput } from '../../ink.js'
import { createFuzzyIndex } from '../../utils/fuzzyMatch.js'
import { getCwd } from '../../utils/cwd.js'
import { FAINT, IVORY, SECOND, TERRA } from '../mercuryPalette.js'
import { CommandCenter, EmptyState, SectionHeader } from './components.js'
import { GLYPH, truncateToWidth } from '../../utils/glyphs.js'
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

export async function loadPaletteRows(
  cwd: string,
): Promise<{ ok: true; rows: PaletteRow[] } | { ok: false; error: string }> {
  try {
    const commands = await getCommands(cwd)
    const built: PaletteRow[] = commands
      .filter(cmd => !cmd.isHidden)
      .map(cmd => ({
        command: cmd,
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
      }))
    return { ok: true, rows: built }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function paletteLoadErrorLine(error: string): string {
  return `Could not read the command roster (${error})`
}

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
  const [loadError, setLoadError] = useState<string | null>(null)

  const pastOpenEvent = useOpenEventGate()

  useLoad(signal => {
    void loadPaletteRows(getCwd()).then(result => {
      if (signal.aborted) return
      if (result.ok) {
        setLoadError(null)
        setRows(result.rows)
      } else {
        setLoadError(result.error)
        setRows([])
      }
    })
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

  const clampedSel = Math.max(0, Math.min(sel, Math.max(0, results.length - 1)))
  if (sel !== clampedSel) setSel(clampedSel)

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
      const pick = results[clampedSel]
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

  if (loadError !== null) {
    return (
      <CommandCenter view="palette" onClose={onClose} captureInput={false} footer="esc / ← close">
        <Box marginTop={1}>
          <EmptyState title={paletteLoadErrorLine(loadError)} hint="esc / ← close" tone="gated" />
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
          const selected = i === clampedSel
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

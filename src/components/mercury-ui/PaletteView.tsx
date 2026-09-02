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

// ============================================================================
//  PaletteView — the Mercury fuzzy command palette (the /palette view).
//
//  This is the CONSUMER for the two leaves that the
//  fork carried but never wired:
//    · src/utils/fuzzyMatch.ts      — the nucleo-style scorer (smart-case,
//      a–z bitmap reject, boundary/camelCase bonuses, gap penalties, top-k).
//      Built here over the LIVE command list (getCommands) instead of fuse.js.
//    · src/utils/commandHierarchy.ts — the command-ladder derivation; surfaced
//      as an honest header (the seated field-/room-commanders when in a team,
//      an honest-empty note otherwise — never a faked live ladder).
//
//  Honest state: the command list is the engine's real per-cwd roster; the
//  ladder is derived from the on-disk team file (null => honest empty, never a
//  crash). Keyboard follows ink-component-patterns: ONE useInput over a clamped
//  selectedIndex (no wrap), a 150ms Enter-buffer so the launching ↵ can't leak
//  into a selection, esc / ← closes, and the query is gated so it never fights the
//  REPL. Selecting a row hands the chosen command back to the caller (onPick),
//  which submits it into the prompt.
// ============================================================================

type PaletteRow = {
  command: Command
  /** The `/name` shown + the haystack key the fuzzy index scores against. */
  name: string
  description: string
}

const MAX_VISIBLE = 12

export function PaletteView({
  onClose,
  onPick,
}: {
  onClose: () => void
  /** Submit the chosen command name (without the leading slash). */
  onPick: (commandName: string) => void
}): React.ReactNode {
  // C14: the live inner width every row budget derives from.
  const cols = useTerminalSize().columns
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [rows, setRows] = useState<PaletteRow[] | null>(null)
  const [ladder, setLadder] = useState<CommandHierarchy | null>(null)

  // 150ms Enter-buffer: the keystroke that launched /palette is ↵ and would
  // otherwise instantly pick the first row of the freshly-mounted panel. A
  // open-event seq gate (event identity, not wall-clock), not the old setTimeout→setState flag whose
  // parked commit could swallow the first ↵ for seconds (the recorded class —
  // §STALE-PAINT idle-parked-commits; swept).
  const pastOpenEvent = useOpenEventGate()

  // Load the LIVE command roster + the command ladder once. Both fail OPEN:
  // an unreadable team file => null ladder (honest empty); getCommands always
  // resolves to at least the built-ins.
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

  // Build the nucleo-style fuzzy index once the roster loads; rebuild only
  // when the roster identity changes (not per keystroke). The haystack is
  // name + description: "review", "current
  // work" or "resume a session" find their commands without the operator
  // knowing a name — the name-first composite keeps exact-name hits ranked.
  const haystackOf = (r: PaletteRow): string => `${r.name} — ${r.description}`
  const index = useMemo(() => {
    if (!rows) return null
    return createFuzzyIndex(rows.map(haystackOf))
  }, [rows])

  // A haystack->row map so a fuzzy hit (which returns the matched string)
  // resolves back to its full command row. Composites are unique enough for
  // the palette; a collision just resolves to the first of that string.
  const byName = useMemo(() => {
    const m = new Map<string, PaletteRow>()
    if (rows) for (const r of rows) if (!m.has(haystackOf(r))) m.set(haystackOf(r), r)
    return m
  }, [rows])

  // The scored, visible result set. Empty query => the alphabetical roster head
  // (the fuzzy index's empty-query view is path-segment-oriented and not what a
  // flat command list wants, so we sort by name ourselves for the resting view).
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

  // Clamp the selection into the live result window whenever it shrinks.
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
    // Plain printable input extends the query (ignore control combos).
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery(q => q + input)
    }
  })

  // HOOK BEFORE THE LOADING RETURN: the
  // loading→loaded transition on the mounted palette otherwise CHANGES the
  // hook count (useSessionAccent was below this return) — React #300. The
  // sterile roster resolves synchronously, a real one is async — exactly the
  // operator-state-dependence signature. Ratchet: prove-hooks-order.ts.
  const accent = useSessionAccent().accent

  // --- honest loading / empty states ---------------------------------------
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
        // a filtered-to-zero list has nothing
        // to select or run — the footer matches the EmptyState's honest hint.
        results.length > 0 ? '↑↓ select · ↵ run · type to filter' : 'type to filter · backspace to widen'
      }
    >
      {/* The command ladder header, surfaced honestly. */}
      <LadderHeader ladder={ladder} />

      {/* The fuzzy query line. */}
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
          // The description spends
          // the live inner width after its OWN row's name — the fixed 52
          // soft-wrapped narrow panes (breaking the row budget) and wasted
          // wide ones.
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

// The derived command ladder, rendered honestly: the seated field-commander +
// room-commanders when in a team, an honest-empty note otherwise. `running` is
// the supervisor child-alive signal (NOT a live-chrome claim — the ghost-LIVE
// rule), so it is shown as a quiet TEAL/FAINT dot, never a "live" badge.
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

import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  substrateSnapshot,
  type SubstrateSection,
} from '../utils/cockpit/index.js'
import { FAINT, IVORY, TEAL, TERRA } from './mercuryPalette.js'
import { CommandCenter, GateRow } from './mercury-ui/components.js'

// ============================================================================
//  SubstratePanel — the Mercury substrate control-panel (the /substrate
//  view). READ-ONLY discoverability surface for the Mercury substrate
//  capabilities. The capability catalog comes from the utils/cockpit snapshot
//  (one source of truth, shared with /deck) — this view never mutates a gate.
//  Just the roll-up + the capability groups; the parity coverage and the
//  boundary/excluded inventory live in /parity, not here.
// ============================================================================

export function SubstratePanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const substrate = substrateSnapshot()
  const { sections, active, total, substrateOn } = substrate.data
  const { columns } = useTerminalSize()
  // Wide terminals (the card renders at 120) get two columns with generous
  // widths so FULL names + hints fit untruncated; narrow terminals (≤ 80) drop
  // to a single column with full names and no hint clipping so nothing wraps.
  // Two columns only when there's room for full names + hints + a gap (the card
  // renders at 120); below that, a single full-width column so nothing truncates.
  const twoCol = columns >= 110

  const byTitle: Record<string, SubstrateSection> = {}
  for (const s of sections) byTitle[s.title] = s

  const renderRows = (s: SubstrateSection | undefined, nameWidth: number, hintWidth?: number) =>
    s
      ? s.rows.map((cap, ri) => (
          <GateRow
            key={ri}
            name={cap.name}
            on={cap.on}
            hint={cap.hint}
            nameWidth={nameWidth}
            hintWidth={hintWidth}
          />
        ))
      : null

  const colHead = (title?: string) =>
    title ? (
      <Text bold color={TERRA}>
        {title}
      </Text>
    ) : null

  // Grouped capability gates. Pairs render as two columns at the card width and
  // collapse to stacked full-width groups when the terminal is narrow.
  const pairs: Array<[string, string?]> = [
    ['Security', 'Autonomy'],
    ['Coordination', 'Observability / perf'],
  ]

  return (
    <CommandCenter
      view="substrate"
      onClose={onClose}
      // footer honesty: looks navigable,
      // binds no cursor — say so. "config — read live" is the freshness truth
      // for a sync gate-read surface (no stamp to show, nothing to go stale);
      // it replaced "safe set LIVE for Mercury", whose substance the rollup
      // line above already carries (N of M active · MERCURY_SUBSTRATE=on),
      // because both don't fit 80 cols beside the close hint.
      footer="display only — no cursor · config — read live"
    >
      {/* rollup */}
      <Box marginTop={1}>
        <Text>
          <Text color={TEAL}>{active}</Text>
          <Text color={FAINT}> of </Text>
          <Text color={IVORY}>{total}</Text>
          {/* The registry-routed spelling (flagRegistry: MERCURY_SUBSTRATE). */}
          <Text color={FAINT}> capabilities active · MERCURY_SUBSTRATE=</Text>
          <Text color={substrateOn ? TEAL : FAINT}>{substrateOn ? 'on' : 'off'}</Text>
        </Text>
      </Box>

      {twoCol
        ? pairs.map(([a, b], i) => (
            <Box key={i} marginTop={1} flexDirection="row">
              <Box flexDirection="column" width="50%" paddingRight={2}>
                {colHead(byTitle[a]?.title)}
                {renderRows(byTitle[a], 25, 28)}
              </Box>
              <Box flexDirection="column" width="50%">
                {colHead(b && byTitle[b] ? byTitle[b].title : undefined)}
                {b ? renderRows(byTitle[b], 25, 28) : null}
              </Box>
            </Box>
          ))
        : pairs.flatMap(([a, b]) =>
            [a, b].filter((t): t is string => Boolean(t && byTitle[t])).map(t => (
              // Single-column (narrow) drops the inter-section blank row: the
              // stacked catalog (27 rows + 6 headers) must fit the no-scroll
              // modal at 80×44 — the accent-bold headers alone carry the
              // separation (self-review find: the P6/P7 rows pushed the tail
              // + footer off-screen at 80).
              <Box key={t} flexDirection="column">
                {colHead(byTitle[t].title)}
                {renderRows(byTitle[t], 27)}
              </Box>
            )),
          )}

      {/* UI — a real fork capability group, rendered full-width after the grid */}
      {byTitle['UI'] ? (
        <Box marginTop={twoCol ? 1 : 0} flexDirection="column">
          {colHead(byTitle['UI'].title)}
          {renderRows(byTitle['UI'], 27)}
        </Box>
      ) : null}
    </CommandCenter>
  )
}

import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  substrateSnapshot,
  type SubstrateSection,
} from '../utils/cockpit/index.js'
import { FAINT, IVORY, TEAL, TERRA } from './mercuryPalette.js'
import { CommandCenter, GateRow } from './mercury-ui/components.js'


export function SubstratePanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const substrate = substrateSnapshot()
  const { sections, active, total, substrateOn } = substrate.data
  const { columns } = useTerminalSize()
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

  const pairs: Array<[string, string?]> = [
    ['Security', 'Autonomy'],
    ['Coordination', 'Observability / perf'],
  ]

  return (
    <CommandCenter
      view="substrate"
      onClose={onClose}
      footer="display only — no cursor · config — read live"
    >
      {}
      <Box marginTop={1}>
        <Text>
          <Text color={TEAL}>{active}</Text>
          <Text color={FAINT}> of </Text>
          <Text color={IVORY}>{total}</Text>
          {}
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
              <Box key={t} flexDirection="column">
                {colHead(byTitle[t].title)}
                {renderRows(byTitle[t], 27)}
              </Box>
            )),
          )}

      {}
      {byTitle['UI'] ? (
        <Box marginTop={twoCol ? 1 : 0} flexDirection="column">
          {colHead(byTitle['UI'].title)}
          {renderRows(byTitle['UI'], 27)}
        </Box>
      ) : null}
    </CommandCenter>
  )
}

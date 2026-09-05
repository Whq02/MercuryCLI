import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useCwdState } from '../hooks/useCwdState.js'
import { pathTailLabel } from '../utils/pathLabel.js'
import { AMBER, CRIMSON, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { GLYPH, branchChip } from './mercury-ui/glyphs.js'


type Agent = { glyph: string; color: string; name: string }
type Props = {
  children?: React.ReactNode
  centerLabel?: React.ReactNode
  repo?: string
  branch?: string
  agents?: Agent[]
  tasks?: { glyph: string; color: string; label: string }[]
  usagePct?: number | null
  traceCount?: number
  traceHigh?: number
  traceKilled?: number
  substrateOn?: number
  substrateTotal?: number
}

const DEF_AGENTS: Agent[] = [
  { glyph: '●', color: TEAL, name: 'orchestrator' },
  { glyph: '◐', color: TEAL, name: 'api-worker' },
  { glyph: '◓', color: AMBER, name: 'db-worker' },
  { glyph: '·', color: FAINT, name: 'docs-worker' },
]
const DEF_TASKS = [
  { glyph: '●', color: TEAL, label: 'wire /substrate' },
  { glyph: '◐', color: TEAL, label: 'persist gate' },
  { glyph: '○', color: FAINT, label: 'update docs' },
]

export function MercuryFullscreen({
  children,
  repo,
  branch = 'main',
  agents = DEF_AGENTS,
  tasks = DEF_TASKS,
  usagePct = 58,
  traceCount = 24,
  traceHigh = 2,
  traceKilled = 1,
  substrateOn = 14,
  substrateTotal = 19,
  centerLabel = 'transcript',
}: Props): React.ReactNode {
  const TERRA = useSessionAccent().accent
  const groundRepo = pathTailLabel(useCwdState())
  const shownRepo = repo ?? groundRepo
  const wide = useTerminalSize().columns >= 100
  return (
    <Box flexDirection="row">
      {}
      <Box flexDirection="column" borderStyle="round" borderColor={FAINT} paddingX={1} width={26}>
        <Text bold color={TERRA}>project</Text>
        <Text color={FAINT}>repo   <Text color={IVORY}>{shownRepo}</Text></Text>
        <Text color={FAINT}>branch <Text color={IVORY}>{branchChip(branch)}</Text></Text>
        {agents.length ? (
          <>
            <Box height={1} />
            <Text bold color={TERRA}>fleet</Text>
            {agents.map(a => (
              <Text key={a.name}><Text color={a.color}>{a.glyph} </Text><Text color={IVORY}>{a.name}</Text></Text>
            ))}
          </>
        ) : null}
        {tasks.length ? (
          <>
            <Box height={1} />
            <Text bold color={TERRA}>tasks</Text>
            {tasks.map(t => (
              <Text key={t.label}><Text color={t.color}>{t.glyph} </Text><Text color={SAND}>{t.label}</Text></Text>
            ))}
          </>
        ) : null}
      </Box>

      {}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {centerLabel ? <Text bold color={TERRA}>{centerLabel}</Text> : null}
        {children ?? (
          <Box flexDirection="column">
            <Text color={FAINT}>· thinking — reading the gate helpers</Text>
            <Text><Text color={TEAL}>●</Text> <Text bold color={IVORY}>Edit</Text> <Text color={SAND}>Deck.tsx</Text></Text>
            <Text color={FAINT}>{'  └─ +318 / -77'}</Text>
            <Text><Text color={TEAL}>✓</Text> <Text color={SAND}>2 files · tests green</Text></Text>
          </Box>
        )}
      </Box>

      {}
      {wide ? (
        <Box flexDirection="column" borderStyle="round" borderColor={FAINT} paddingX={1} width={24}>
          <Text bold color={TERRA}>usage</Text>
          <Text color={FAINT}>5h {usagePct === null ? <Text color={FAINT}>—</Text> : <Text color={usagePct < 80 ? TEAL : usagePct < 95 ? AMBER : CRIMSON}>{usagePct}%</Text>}</Text>
          <Box height={1} />
          <Text bold color={TERRA}>trace</Text>
          <Text color={FAINT}>{traceCount} · {traceHigh} high-risk class · <Text color={CRIMSON}>{traceKilled} killed</Text></Text>
          <Box height={1} />
          <Text bold color={TERRA}>substrate</Text>
          <Text><Text color={TEAL}>●</Text> <Text color={FAINT}>{substrateOn}/{substrateTotal} active</Text></Text>
        </Box>
      ) : null}
    </Box>
  )
}

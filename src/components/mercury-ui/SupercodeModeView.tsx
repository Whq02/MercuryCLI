import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL, TERRA } from '../mercuryPalette.js'
import { Chip, CommandCenter, SectionHeader, StateBadge } from './components.js'
import { useSessionAccent } from './sessionAccent.js'
import {
  EFFORT_AXIS,
  describeEffortLevel,
  describeSupercodeMode,
} from '../../utils/cockpit/effortModel.js'
import { useInteractiveList } from './useInteractiveList.js'
import { InteractiveRow } from './InteractiveRow.js'


export function SupercodeModeView({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const mode = describeSupercodeMode()
  const axis = EFFORT_AXIS.map(l => describeEffortLevel(l, false))

  const { selectedIndex: sel, note, hints, rowProps } = useInteractiveList({
    rows: axis,
    rowId: a => a.level,
    idNamespace: 'supercode',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'explain level',
        run: a => {
          if (!a) return null
          const reach =
            a.reach === 'live'
              ? 'live · /effort applies it this session'
              : a.reach === 'gated'
                ? 'gated · not on this runtime'
                : 'spawn-only'
          return `${a.level} — ${reach} · ${a.note}`
        },
      },
    ],
  })

  return (
    <CommandCenter view="supercode" subtitle="mode" onClose={onClose} footer={hints} captureInput={false}>
      {
}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <StateBadge state="live" label="supercode mode" />
          <Text color={FAINT}> · {mode.summary}</Text>
        </Text>
        <Text color={FAINT}>live via /effort supercode (max-capable model: Opus 4.5+, Sonnet 4.6, or Fable)</Text>
      </Box>

      {}
      <SectionHeader>What supercode is</SectionHeader>
      <Text>
        <Text color={FAINT}>effort    </Text>
        <Text color={TEAL}>pins {mode.pinsEffort}</Text>
        <Text color={FAINT}> — a mode, not an effort level</Text>
      </Text>
      <Text>
        <Text color={FAINT}>orchestrate </Text>
        <Text color={IVORY}>standing</Text>
        <Text color={FAINT}> — author/run subagents (Agent) + fleets (LaunchFleet) for substantive work by default</Text>
      </Text>
      <Text>
        <Text color={FAINT}>scope     </Text>
        <Text color={IVORY}>session-only</Text>
        <Text color={FAINT}> — never a persisted settings key</Text>
      </Text>
      <Text>
        <Text color={FAINT}>excludes  </Text>
        <Text color={AMBER}>{mode.excludes.join(' · ')}</Text>
        <Text color={FAINT}> — the mode owns the effort pin</Text>
      </Text>

      {
}
      <SectionHeader count={axis.length}>Effort axis</SectionHeader>
      <Text color={FAINT}>{`↑↓ to move · ↵ explains the selected level · the axis is ${EFFORT_AXIS.join('→')}`}</Text>
      {axis.map((a, i) => {
        const reachColor = a.reach === 'live' ? TEAL : a.reach === 'gated' ? AMBER : SECOND
        const reachGlyph = a.reach === 'live' ? '●' : a.reach === 'gated' ? '⦿' : '◇'
        return (
          <InteractiveRow key={a.level} {...rowProps(a, i)}>
            <Text>
              <Text color={i === sel ? accent : FAINT}>{i === sel ? '▸ ' : '  '}</Text>
              <Text color={a.level === 'xhigh' ? TERRA : IVORY}>{a.level.padEnd(8)}</Text>
              <Text color={reachColor}>{reachGlyph} </Text>
              <Chip tone={a.reach === 'live' ? 'accent' : a.reach === 'gated' ? 'warn' : 'neutral'}>{a.reach}</Chip>
            </Text>
          </InteractiveRow>
        )
      })}

      {}
      <SectionHeader>Run it</SectionHeader>
      <Text color={FAINT}>{`live levels (${EFFORT_AXIS.join('/')}): set with /effort — applies this session`}</Text>
      <Text color={FAINT}>supercode: /effort supercode — flips the session mode (pins max; needs a max-capable model)</Text>
      <Text color={FAINT}>while on, a standing system-reminder keeps you orchestrating + exhaustive until /effort clears it</Text>

      {}
      <Box marginTop={1} flexDirection="column">
        {note ? (
          <Text>
            <StateBadge state="planned" mono label={note} />
          </Text>
        ) : (
          <Text color={FAINT}>supercode is a live session mode — /effort supercode toggles it; /effort &lt;level&gt; clears it</Text>
        )}
      </Box>
    </CommandCenter>
  )
}

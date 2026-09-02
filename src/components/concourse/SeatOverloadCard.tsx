import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { describeSeatReading } from '../../services/switchboard/capacityCheck.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'

// ============================================================================
//  SeatOverloadCard — BOARD CONTROLS item 4 (operator, ruled): dispatching
//  past the machine reading is a permission card EVERY TIME — never silent,
//  never remembered-away. Declining dispatches nothing (no op fires, no
//  reservation is minted; the draft stays). Allowing proceeds through the
//  SAME dispatch door the ungated submit rides — admission stays the
//  machine's own: the consented dispatch queues and starts when a seat
//  frees, and the rail's seats cell wears the over mark (`5/4·`) while the
//  demand stands past the reading.
//
//  REUSE, never a lookalike (the consent card IS
//  PermissionDialog composed): this file composes the estate's real card
//  owners VERBATIM — PermissionDialog (the one consent frame) and
//  PermissionPrompt (the one option grammar: ↑↓ choose · ↵ confirm · esc
//  cancel, clickable rows). The reading sentence is capacityCheck's own
//  describeSeatReading — one sentence owner, never a bare number.
// ============================================================================

/** The pure gate — the ask arms exactly when THIS dispatch would run past
 *  the machine reading (every live seat taken). Pure and memoryless by
 *  construction: the ask has nothing to remember itself away with. */
export function needsSeatOverloadAsk(live: number, ceiling: number): boolean {
  return live >= ceiling
}

type SeatOverloadAnswer = 'yes' | 'no'

export function SeatOverloadCard({
  live,
  ceiling,
  onAnswer,
}: {
  /** The machine's live seats and its reading, captured at the gesture. */
  live: number
  ceiling: number
  /** true proceeds with the dispatch (it queues; admission stays the
   *  machine's); false dispatches nothing — the draft stays. */
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const options = useMemo<PermissionPromptOption<SeatOverloadAnswer>[]>(
    () => [
      { label: 'Yes — queue it; it starts when a seat frees', value: 'yes' },
      { label: 'No, dispatch nothing (esc)', value: 'no' },
    ],
    [],
  )
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="Past the machine's reading">
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              session <Text bold>{live + 1}</Text> over {describeSeatReading(ceiling)}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor wrap="wrap">
              every seat is taken right now — this dispatch would run past the reading. Yes queues it
              (it starts the moment a seat frees; the seats cell reads {live + 1}/{ceiling}· while
              over). No dispatches nothing — your words stay in the composer.
            </Text>
          </Box>
          <PermissionPrompt
            options={options}
            onSelect={value => onAnswer(value === 'yes')}
            onCancel={() => onAnswer(false)}
          />
        </Box>
      </PermissionDialog>
    </Box>
  )
}


import * as React from 'react'
import { Box, Text } from '../ink.js'
import { FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { hasSupercodeKeyword } from '../utils/keywordTrigger/supercode.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { dynamicWorkflowsEnabled } from '../tools/WorkflowTool/workflowEnablement.js'

const ARMED_GLYPH = GLYPH.mission

export type MercurySupercodeKeywordHintProps = {
  value: string
  active?: boolean
}

export function MercurySupercodeKeywordHint({
  value,
  active = true,
}: MercurySupercodeKeywordHintProps): React.ReactNode {
  const accent = useSessionAccent().accent
  const standingSupercode = useAppStateMaybeOutsideOfProvider(s => s.supercode) === true
  const armed = React.useMemo(
    () =>
      active &&
      typeof value === 'string' &&
      hasSupercodeKeyword(value) &&
      !standingSupercode &&
      dynamicWorkflowsEnabled(),
    [active, value, standingSupercode],
  )
  if (!armed) return null

  return (
    <Box flexDirection="row" marginLeft={2} marginTop={0}>
      <Box minWidth={2}>
        <Text color={accent}>{ARMED_GLYPH}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Text color={IVORY} bold>
          supercode
        </Text>
        <Text color={SECOND}>
          {' '}
          keyword detected — this turn opts into dynamic orchestration
        </Text>
        <Text color={FAINT}> (/effort supercode makes it standing: max + workflows)</Text>
      </Text>
    </Box>
  )
}

export default MercurySupercodeKeywordHint

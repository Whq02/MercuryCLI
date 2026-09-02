import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { SessionMark } from './mercury-ui/assets.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'

/**
 * The REAL exit confirm (the /showcase MercuryExit specimen, made functional —
 * first-run identity pass). Mounted ONLY when live background work
 * would die with the session (agents/tasks running) — a plain exit stays
 * instant, zero added friction. y/↵ ride the mount buffer (the /exit Enter
 * that opened this must never confirm it); n/esc are instant per the kit's
 * cancel doctrine.
 *
 * LUSTRE L3: adaptive tokens replace the raw brand hexes, and
 * the frame wears the WARNING attention role — waiting on an operator
 * decision is the fixed needs-attention state,
 * never identity red.
 */
export function MercuryExitConfirm({
  liveCount,
  onQuit,
  onStay,
}: {
  liveCount: number
  onQuit: () => void
  onStay: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  const pastBuffer = useOpenEventGate()
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onStay()
      return
    }
    if (!pastBuffer()) return
    if (key.return || input === 'y' || input === 'Y') {
      onQuit()
    }
  })
  const noun = liveCount === 1 ? 'agent is' : 'agents are'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} marginTop={1}>
      <Text>
        {/* the farewell is the COMPANION'S moment —
            the selected critter's own mark, not a crab silhouette wearing
            its accent. Crab sessions render byte-identically. */}
        <SessionMark />{' '}
        <Text bold color={t.textPrimary}>
          Leave Mercury?
        </Text>{' '}
        <Text color={t.textSecondary}>
          {liveCount} {noun} still running
        </Text>
      </Text>
      <Text color={t.textMuted}>quitting stops them · the session itself stays resumable</Text>
      <Text>
        {/* Every key that FIRES is named: enter quit and esc stayed while the
            legend printed only y/n — and enter is the reflex key the operator
            just used to submit /exit (TASK-017 S2, exit-confirm-enter-quits-
            unadvertised). */}
        <Text color={t.failure}>[y]</Text> <Text color={t.textSecondary}>quit</Text>
        <Text color={t.textMuted}> · ↵ quit</Text>
        {'   '}
        <Text color={t.success}>[n]</Text> <Text color={t.textSecondary}>stay</Text>
        <Text color={t.textMuted}> · esc stay</Text>
      </Text>
    </Box>
  )
}

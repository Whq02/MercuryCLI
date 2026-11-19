import React from 'react';
import { chatPresent, enterBootSettings, enterRootChat } from '../../../context/surfaceRoute.js';
import { Box, Text, useInput, useTheme } from '../../../ink.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { resolveMercuryTokens } from '../../../utils/mercuryTokens.js';
import { useMercuryTokens } from '../../mercury-ui/useMercuryTokens.js';
import { keyHintLabel } from '../../mercury-ui/keyHintLabel.js';
import { rampSegments } from '../../mercury-ui/focalRamp.js';
import { useGreetingShimmer } from '../../mercury-ui/useGreetingShimmer.js';
import { displayWidth } from '../../mercury-ui/glyphs.js';
import { useSessionAccent } from '../../mercury-ui/sessionAccent.js';

function ConcourseLockup(): React.ReactNode {
  const t = useMercuryTokens()
  const [theme] = useTheme()
  const sa = useSessionAccent()
  const ramp = resolveMercuryTokens(theme, sa.accent).focalRamp
  const shimmer = useGreetingShimmer(ramp, displayWidth('MERCURY — SESSION CONCOURSE'))
  if (ramp.length <= 1) {
    return (
      <Text bold color={t.info} wrap="truncate-end">
        MERCURY — SESSION CONCOURSE
      </Text>
    )
  }
  return (
    <Text wrap="truncate-end">
      {rampSegments('MERCURY — SESSION CONCOURSE', ramp, { shimmer }).map((s, i) => (
        <Text key={i} bold color={s.color}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

export function ConcourseAssemblingShell({ failing, onRetry }: { failing: boolean; onRetry: () => void }): React.ReactNode {
  const t = useMercuryTokens()
  const { rows: termRows } = useTerminalSize()
  const escLabel = chatPresent() ? 'esc focused chat' : 'esc boot face'
  useInput((input, key, event) => {
    if (key.escape) {
      event.stopImmediatePropagation()
      if (!enterRootChat().ok) enterBootSettings()
      return
    }
    if (key.ctrl && input === 'r') {
      event.stopImmediatePropagation()
      onRetry()
      return
    }
  })
  return (
    <Box flexDirection="column" width="100%" height={termRows} paddingX={2} alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="round" borderColor={failing ? t.warning : t.info} paddingX={3} paddingY={1} alignItems="center">
        {}
        <ConcourseLockup />
        {failing ? (
          <>
            <Text color={t.warning}>the live view is unavailable — nothing loaded yet</Text>
            <Text color={t.textMuted}>{`${keyHintLabel('⌃r')} retry · ${escLabel}`}</Text>
          </>
        ) : (
          <>
            <Text color={t.textSecondary}>assembling the concourse…</Text>
            <Text color={t.textMuted}>{escLabel}</Text>
          </>
        )}
      </Box>
    </Box>
  )
}

import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { GLYPH } from '../mercury-ui/glyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import type { AwayRecapMetadata } from '../../types/message.js';
import { humanGap } from '../../utils/cockpit/awaySummary.js';

type Props = {
  metadata: AwayRecapMetadata;
  addMargin: boolean;
  bg?: string;
};

function repoHealthTail(m: AwayRecapMetadata): string {
  const parts: string[] = [];
  if (m.branch) parts.push(m.branch);
  if (typeof m.dirtyCount === 'number' && m.dirtyCount > 0) {
    parts.push(`${m.dirtyCount} uncommitted${m.dirtyDelta ? ` (${m.dirtyDelta})` : ''}`);
  }
  if (m.certVerdict === 'none') {
    parts.push('health none — /health');
  } else if (m.certVerdict) {
    const age = typeof m.certAgeMs === 'number' ? humanGap(m.certAgeMs) : '';
    const glyph =
      m.certVerdict === 'certified' ? GLYPH.check : m.certVerdict === 'caution' ? GLYPH.warn : GLYPH.fail;
    parts.push(`health ${glyph} ${m.certVerdict}${age ? ` ${GLYPH.dot} ${age.replace(' ago', '')}` : ''}`);
  }
  return parts.join(` ${GLYPH.dot} `);
}

function shapeCounts(m: AwayRecapMetadata): string {
  const parts: string[] = [];
  if (typeof m.turns === 'number') parts.push(`${m.turns} turn${m.turns === 1 ? '' : 's'}`);
  if (typeof m.filesTouched === 'number' && m.filesTouched > 0) {
    parts.push(`${m.filesTouched} file${m.filesTouched === 1 ? '' : 's'} touched`);
  }
  if (m.endedOnError && typeof m.toolFailures === 'number' && m.toolFailures > 0) {
    parts.push(`${m.toolFailures} tool call${m.toolFailures === 1 ? '' : 's'} failed`);
  }
  if (typeof m.lastActiveGapMs === 'number') {
    const gap = humanGap(m.lastActiveGapMs);
    if (gap) parts.push(`last active ${gap}`);
  }
  if (m.topTools) parts.push(m.topTools);
  return parts.join(` ${GLYPH.dot} `);
}

export function ResumeRecapCard({ metadata, addMargin, bg }: Props): React.ReactNode {
  const tokens = useMercuryTokens();
  const shape = shapeCounts(metadata);
  const tail = repoHealthTail(metadata);
  const toolFailures = metadata.toolFailures ?? 0;
  const verdictTone = metadata.endedOnError
    ? tokens.failure
    : toolFailures > 0
      ? tokens.warning
      : tokens.borderStrong;
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={bg}
      borderStyle="round"
      borderColor={verdictTone}
      paddingX={1}
      alignSelf="flex-start"
    >
      <Box flexDirection="row">
        {metadata.endedOnError ? (
          <>
            <Box minWidth={2}>
              <Text color={tokens.failure}>{GLYPH.fail}</Text>
            </Box>
            <Text color={tokens.failure}>prior run ended on an error</Text>
          </>
        ) : toolFailures > 0 ? (
          <>
            <Box minWidth={2}>
              <Text color={tokens.warning}>{GLYPH.warn}</Text>
            </Box>
            <Text color={tokens.warning}>
              resumed — {toolFailures} tool call{toolFailures === 1 ? '' : 's'} failed
            </Text>
          </>
        ) : (
          <>
            <Box minWidth={2}>
              <Text color={tokens.success}>{GLYPH.check}</Text>
            </Box>
            <Text color={tokens.textPrimary}>resumed clean</Text>
          </>
        )}
      </Box>
      {shape ? (
        <Box flexDirection="row">
          <Box minWidth={2} />
          <Text color={tokens.textSecondary} wrap="truncate">
            {shape}
          </Text>
        </Box>
      ) : null}
      {tail ? (
        <Box flexDirection="row">
          <Box minWidth={2} />
          <Text color={tokens.textMuted} wrap="truncate">
            {tail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

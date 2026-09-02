import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { formatTokens } from '../../utils/format.js';

/** The boundary row speaks the fold's own facts where the record carries
 *  them: WHY it happened (a manual /compact, the automatic threshold, or an
 *  overflowed request the recovery ladder folded and retried) and the
 *  context weight that was folded — never a fabricated number (an absent
 *  count simply does not speak). */
export function CompactBoundaryMessage({
  message,
}: {
  message?: { compactMetadata?: { trigger?: string; preTokens?: number } };
}) {
  const historyShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  const meta = message?.compactMetadata;
  const head =
    meta?.trigger === 'overflow'
      ? 'Context overflowed — folded and retried'
      : meta?.trigger === 'auto'
        ? 'Context compacted automatically'
        : 'Conversation compacted';
  const weight =
    typeof meta?.preTokens === 'number' && meta.preTokens > 0
      ? ` — folded ${formatTokens(meta.preTokens)} tokens of history`
      : '';
  return <Box marginY={1}><Text dimColor={true}>✻ {head}{weight} ({historyShortcut} for history)</Text></Box>;
}

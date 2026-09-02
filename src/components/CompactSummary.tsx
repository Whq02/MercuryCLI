import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { Box, Text } from '../ink.js';
import type { Screen } from '../screens/REPL.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../utils/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MercuryCompactSummary } from './MercuryCompactSummary.js';
import { MessageResponse } from './MessageResponse.js';
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};

// Mercury carries an honest context-reclaim pct on summarizeMetadata, set by
// commands/compact/compact.ts from the real preCompactTokenCount vs the
// resulting context size. Read it through a narrow optional cast (the type-only
// message module doesn't declare it; bun erases types at build, so this is a
// safe runtime read with no faked fallback).
function reclaimPct(message: NormalizedUserMessage): number | undefined {
  const meta = message.summarizeMetadata as
    | { contextReclaimedPct?: number }
    | undefined;
  const v = meta?.contextReclaimedPct;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function CompactSummary({ message, screen }: Props): React.ReactNode {
  const isTranscriptMode = screen === 'transcript';
  const textContent = getUserMessageText(message) || '';
  const metadata = message.summarizeMetadata;

  // Route any metadata-carrying /compact summary through the warm-ink card;
  // auto-compact's metadata-less path falls through to the default rendering.
  if (metadata) {
    return (
      <MercuryCompactSummary
        summary={textContent}
        pct={reclaimPct(message)}
        messagesSummarized={metadata.messagesSummarized}
        userContext={metadata.userContext}
        tokensBefore={metadata.tokensBefore}
        tokensAfter={metadata.tokensAfter}
        keptMessages={metadata.keptMessages}
        transcript={isTranscriptMode}
      />
    );
  }

  // Default compact summary (auto-compact)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            Compact summary
            {!isTranscriptMode && (
              <Text dimColor>
                {' '}
                <ConfigurableShortcutHint
                  action="app:toggleTranscript"
                  context="Global"
                  fallback="ctrl+o"
                  description="expand"
                  parens
                />
              </Text>
            )}
          </Text>
        </Box>
      </Box>
      {isTranscriptMode && (
        <MessageResponse>
          <Text>{textContent}</Text>
        </MessageResponse>
      )}
    </Box>
  );
}

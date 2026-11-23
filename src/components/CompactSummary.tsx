import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { Box, Text } from '../ink.js';
import type { Screen } from '../screens/Chat.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../services/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MercuryCompactSummary } from './MercuryCompactSummary.js';
import { MessageResponse } from './MessageResponse.js';
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};

function reclaimPct(message: NormalizedUserMessage): number | undefined {
  const v = message.summarizeMetadata?.contextReclaimedPct;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function CompactSummary({ message, screen }: Props): React.ReactNode {
  const summary = getUserMessageText(message) ?? '';
  const isTranscript = screen === 'transcript';

  if (message.summarizeMetadata) {
    const meta = message.summarizeMetadata;
    const pct = reclaimPct(message);
    return (
      <MercuryCompactSummary
        summary={summary}
        {...(pct !== undefined ? { pct } : {})}
        messagesSummarized={meta.messagesSummarized}
        {...(meta.userContext !== undefined ? { userContext: meta.userContext } : {})}
        {...(meta.tokensBefore !== undefined ? { tokensBefore: meta.tokensBefore } : {})}
        {...(meta.tokensAfter !== undefined ? { tokensAfter: meta.tokensAfter } : {})}
        {...(meta.keptMessages !== undefined ? { keptMessages: meta.keptMessages } : {})}
        transcript={isTranscript}
      />
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text>{BLACK_CIRCLE}</Text>
        </Box>
        <Text>
          <Text bold>Compact summary</Text>
          {!isTranscript && (
            <Text dimColor>
              {' '}
              <ConfigurableShortcutHint
                action="app:toggleTranscript"
                context="Global"
                fallback="ctrl+o"
                description="expand"
                parens={true}
              />
            </Text>
          )}
        </Text>
      </Box>
      {isTranscript && (
        <MessageResponse>
          <Text>{summary}</Text>
        </MessageResponse>
      )}
    </Box>
  );
}

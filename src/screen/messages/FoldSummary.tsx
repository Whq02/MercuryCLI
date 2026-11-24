import * as React from 'react';
import { BLACK_CIRCLE } from '../theme/rowGlyphs.js';
import { Box, Text } from '../themedRenderer.js';
import type { Screen } from '../chat/Chat.js';
import type { NormalizedUserMessage } from '../../engine/message-shapes/message.js';
import { getUserMessageText } from '../../engine/messages/messages.js';
import { ConfigurableShortcutHint } from '../keys/ConfigurableShortcutHint.js';
import { MercuryFoldSummary } from './MercuryCompactSummary.js';
import { MessageResponse } from '../../tools/kit/MessageResponse.js';
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};

function reclaimPct(message: NormalizedUserMessage): number | undefined {
  const v = message.summarizeMetadata?.contextReclaimedPct;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function FoldSummary({ message, screen }: Props): React.ReactNode {
  const summary = getUserMessageText(message) ?? '';
  const isTranscript = screen === 'transcript';

  if (message.summarizeMetadata) {
    const meta = message.summarizeMetadata;
    return (
      <MercuryFoldSummary
        summary={summary}
        pct={reclaimPct(message)}
        messagesSummarized={meta.messagesSummarized}
        userContext={meta.userContext}
        tokensBefore={meta.tokensBefore}
        tokensAfter={meta.tokensAfter}
        keptMessages={meta.keptMessages}
        transcript={isTranscript}
      />
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            Compact summary
            {!isTranscript && (
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
      {isTranscript && (
        <MessageResponse>
          <Text>{summary}</Text>
        </MessageResponse>
      )}
    </Box>
  );
}

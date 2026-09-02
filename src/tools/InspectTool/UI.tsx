;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './InspectTool.js';

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  return input.ref ?? null;
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// The shared card grammar: Inspect's 'absent'/'expired' read as
// settled/attention states there, matching every other coding-loop card.

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const lines = (output.result ?? '').split('\n');
  const shown = verbose ? lines : lines.slice(0, 10);
  return (
    <WithCardTone state={output.state}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>{output.state === 'ok' ? (output.title ?? output.ref) : output.state}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {'  '}
            {line}
          </Text>
        ))}
        {!verbose && lines.length > shown.length ? (
          <Text color={FAINT}>{`  … +${lines.length - shown.length} lines (ctrl+o expands)`}</Text>
        ) : null}
      </Box>
  
      )}
    </WithCardTone>
  );
}

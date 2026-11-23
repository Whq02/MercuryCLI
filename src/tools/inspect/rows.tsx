;
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../screen/theme/mercuryPalette.js';
import { WithCardTone } from '../../screen/widgets/toolCardGrammar.js';
import { Box, Text } from '../../screen/themedRenderer.js';
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

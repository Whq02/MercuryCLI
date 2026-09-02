;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './TransactionTool.js';

export function userFacingName(): string {
  return 'Transaction';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.op === 'begin' && input.intent) parts.push(input.intent.slice(0, 60));
  if (input.op === 'step' && input.kind) parts.push(`${input.kind}${input.outcome && input.outcome !== 'ok' ? ` [${input.outcome}]` : ''}`);
  if (input.op === 'finish' && input.verdict) parts.push(input.verdict);
  if (input.id) parts.push(input.id);
  return parts.join(' ');
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
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>{output.op}</Text>
          <Text color={tone}> {output.outcome ?? ''}</Text>
        </Text>
        {shown.map((line, i) => (
          // truncate-end is load-bearing: an unbroken long token (a tx id or a
          // mercury:// ref) must clip inside the width, never wrap the card.
          <Text key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
        {!verbose && lines.length > shown.length ? (
          <Text dimColor>… +{lines.length - shown.length} lines (ctrl+o expands)</Text>
        ) : null}
      </Box>
  
      )}
    </WithCardTone>
  );
}

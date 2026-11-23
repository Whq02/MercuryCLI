;
import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../kit/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../screen/theme/mercuryPalette.js';
import { WithCardTone } from '../../screen/widgets/toolCardGrammar.js';
import { Box, Text } from '../../screen/themedRenderer.js';
import type { Output } from './TransactionTool.js';

type RecordedInput = {
  op?: string;
  intent?: string;
  kind?: string;
  outcome?: string;
  verdict?: string;
  id?: string;
};
type RecordedOutput = Omit<Output, 'op'> & { op: string };

export function userFacingName(): string {
  return 'Transaction';
}

export function renderToolUseMessage(
  input: RecordedInput,
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
  output: RecordedOutput,
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

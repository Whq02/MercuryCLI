;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './JourneyTool.js';

export function userFacingName(): string {
  return 'Journey';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.op === 'run' && input.objective) parts.push(input.objective.slice(0, 60));
  if (input.op === 'run' && input.steps) parts.push(`(${input.steps.length} steps)`);
  if (input.op === 'status' && input.id) parts.push(input.id);
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
  const shown = verbose ? lines : lines.slice(0, 14);
  // A cancelled journey is 'cancelled' (attention), a failed one 'failed'
  // (settled-bad) — the journeyState wins over the effect outcome so the
  // card can never read success over a failed step.
  return (
    <WithCardTone state={output.journeyState ?? output.outcome}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>journey {output.op}</Text>
          <Text color={tone}> {output.journeyState ?? output.outcome}</Text>
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

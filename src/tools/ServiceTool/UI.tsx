;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT, TERRA } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './ServiceTool.js';

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.name) parts.push(input.name);
  if (input.op === 'start' && input.command) {
    parts.push(`— ${input.command}${input.args?.length ? ` ${input.args.join(' ')}` : ''}`);
  }
  return parts.join(' ');
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// State tones come from the shared card grammar — running/
// starting read as in-motion there, the settled states as ✓/×.

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const lines = (output.result ?? '').split('\n');
  const shown = verbose ? lines : lines.slice(0, 12);
  return (
    <WithCardTone state={output.state}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>
            {output.op}
            {output.name ? ` ${output.name}` : ''}
            {output.state ? ` — ${output.state}` : ''}
          </Text>
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

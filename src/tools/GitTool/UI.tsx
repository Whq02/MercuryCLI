;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './GitTool.js';

export function userFacingName(): string {
  return 'Git';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.op === 'diff' && input.scope) parts.push(input.scope);
  if (input.op === 'show' && input.sha) parts.push(input.sha.slice(0, 8));
  if (input.op === 'plan' && input.groups) parts.push(`${input.groups.length} group(s)`);
  if ((input.op === 'apply' || input.op === 'verify') && input.planId) parts.push(input.planId);
  if ((input.op === 'stage' || input.op === 'restore') && input.files) parts.push(input.files.join(' '));
  if (input.op === 'resolve' && input.path) parts.push(input.path);
  return parts.join(' ');
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// Plan (proposed) and applied plans must never look identical — the plan
// card reads amber/in-motion, the applied card settled-good.
function stateWord(output: Output): string {
  if (output.op === 'plan' && output.outcome === 'succeeded') return 'proposed';
  if (output.op === 'apply' && output.outcome === 'succeeded') return 'applied';
  return output.outcome;
}

function stateToneKey(output: Output): string {
  if (output.op === 'plan' && output.outcome === 'succeeded') return 'queued';
  if (output.op === 'apply' && output.outcome === 'succeeded') return 'succeeded';
  return output.outcome;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const lines = (output.result ?? '').split('\n');
  const shown = verbose ? lines : lines.slice(0, 12);
  return (
    <WithCardTone state={stateToneKey(output)}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>git {output.op}</Text>
          <Text color={tone}> {stateWord(output)}</Text>
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

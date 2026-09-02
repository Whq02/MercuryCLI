;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { AMBER, FAINT, TERRA } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './WorkshopTool.js';

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  const cells = input.cells ?? [];
  const first = cells[0];
  if (!first) return null;
  return `${cells.length} ${first.language} cell${cells.length === 1 ? '' : 's'}${first.title ? ` · ${first.title}` : ''}`;
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
  return (
    <Box flexDirection="column">
      {output.cells.map(cell => {
        const tail = verbose ? cell.outputTail : cell.outputTail.slice(-4);
        return (
          <WithCardTone key={cell.cellId} state={cell.state}>
            {({ glyph, tone }) => (
          <Box flexDirection="column">
            <Text>
              <Text color={tone}>{glyph} </Text>
              <Text color={FAINT}>
                {cell.cellId} · {cell.durationMs}ms · gen {cell.generation}
                {cell.title ? ` · ${cell.title}` : ''}
              </Text>
            </Text>
            {cell.runtimeKilled ? (
              <Text color={AMBER}>{'  runtime killed — retained state lost'}</Text>
            ) : null}
            {cell.error ? (
              <Text color={TERRA} wrap="truncate-end">{`  ${cell.error.split('\n')[0]}`}</Text>
            ) : null}
            {cell.valuePreview ? (
              <Text wrap="truncate-end">{`  = ${cell.valuePreview.split('\n')[0]}`}</Text>
            ) : null}
            {tail.map((line, i) => (
              <Text key={i} color={FAINT} wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
            {!verbose && cell.outputTail.length > tail.length ? (
              <Text color={FAINT}>{`  … +${cell.outputTail.length - tail.length} output lines (ctrl+o expands)`}</Text>
            ) : null}
          </Box>
            )}
          </WithCardTone>
        );
      })}
    </Box>
  );
}

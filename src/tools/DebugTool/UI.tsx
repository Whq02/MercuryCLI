;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT, IVORY } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './DebugTool.js';

export function userFacingName(): string {
  return 'Debug';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.op === 'launch' && input.program) {
    parts.push(input.program);
    if (verbose && input.args?.length) parts.push(input.args.join(' '));
  }
  if (input.op === 'attach') {
    parts.push(input.program ?? (input.pid !== undefined ? `pid ${input.pid}` : ''));
  }
  if (input.op === 'breakpoints' && input.file) {
    const lines = input.lines ?? (input.breakpoints ?? []).map(b => b.line);
    parts.push(`${input.file}:${lines.join(',')}`);
  }
  if (input.op === 'functionBreakpoints' && input.functions) {
    parts.push(input.functions.join(','));
  }
  if ((input.op === 'disassemble' || input.op === 'readMemory') && input.memoryReference) {
    parts.push(input.memoryReference);
  }
  if (input.op === 'evaluate' && input.expression) parts.push(input.expression);
  if (input.session && input.session !== 'main') parts.push(`[${input.session}]`);
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
  const shown = verbose ? lines : lines.slice(0, 12);
  // Outcome chrome: the SHARED card grammar (token-aware door) — one glance
  // says applied/failed/indeterminate across every coding-loop card.
  return (
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
    <Box flexDirection="column">
      <Text>
        <Text color={tone}>{glyph} </Text>
        <Text color={FAINT}>{output.op}</Text>
        <Text color={tone}> {output.outcome ?? ''}</Text>
        {output.debuggee ? <Text color={IVORY}> · debuggee {output.debuggee}</Text> : null}
      </Text>
      {shown.map((line, i) => (
        // truncate-end is load-bearing: an unbroken long token (a deep path
        // in a stack frame) must clip inside the width, never wrap the card
        // (the render proof pins this).
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

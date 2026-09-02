;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT, IVORY } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './TestTool.js';

export function userFacingName(): string {
  return 'Test';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.node) parts.push(input.node);
  else if (input.path) parts.push(input.path);
  if (input.changed) parts.push('changed');
  if (input.profile) parts.push(input.profile);
  if (input.framework) parts.push(`[${input.framework}]`);
  return parts.join(' ');
}

/** Family 3: the live runner status line (one bounded row). */
export function renderToolUseProgressMessage(
  progress: Array<{ data?: { type?: string; line?: string } }>,
): React.ReactNode {
  const latest = [...progress].reverse().find(p => p.data?.type === 'test_progress');
  if (!latest?.data?.line) return null;
  return (
    <Box>
      <Text color={FAINT}>{latest.data.line}</Text>
    </Box>
  );
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
  const counts = output.record?.counts;
  return (
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>{output.op}</Text>
          <Text color={tone}> {output.outcome ?? ''}</Text>
          {counts ? (
            <Text color={IVORY}>
              {' '}· {counts.passed} passed
              {counts.failed ? ` · ${counts.failed} failed` : ''}
              {counts.errored ? ` · ${counts.errored} errored` : ''}
              {counts.skipped ? ` · ${counts.skipped} skipped` : ''}
            </Text>
          ) : null}
        </Text>
        {shown.map((line, i) => (
          // truncate-end is load-bearing: an unbroken long token (a node id or
          // deep path) must clip inside the width, never wrap the card.
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

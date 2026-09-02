;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './BlenderTool.js';

export function userFacingName(): string {
  return 'Blender';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.args && Object.keys(input.args).length > 0) {
    const summary = Object.entries(input.args)
      .slice(0, verbose ? 12 : 4)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(', ');
    parts.push(summary.length > 120 && !verbose ? summary.slice(0, 117) + '…' : summary);
  }
  return parts.join(' — ');
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
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Text key={i}>{line || ' '}</Text>
      ))}
      {!verbose && lines.length > shown.length ? (
        <Text dimColor>… +{lines.length - shown.length} lines (ctrl+o expands)</Text>
      ) : null}
    </Box>
  );
}

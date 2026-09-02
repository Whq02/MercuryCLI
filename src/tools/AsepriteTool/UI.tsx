;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './AsepriteTool.js';

export function userFacingName(): string {
  return 'Aseprite';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  const fields: string[] = [];
  if (input.file) fields.push(`file: ${input.file}`);
  if (input.output) fields.push(`output: ${input.output}`);
  if (input.op === 'create' && input.width && input.height) {
    fields.push(`${input.width}x${input.height}${input.colorMode ? ` ${input.colorMode}` : ''}`);
  }
  if (input.op === 'export') {
    if (input.sheetType) fields.push(`sheet: ${input.sheetType}`);
    if (input.dataOutput) fields.push(`data: ${input.dataOutput}`);
    if (input.scale !== undefined) fields.push(`scale: ${input.scale}`);
    if (input.tag) fields.push(`tag: ${input.tag}`);
  }
  if (input.op === 'run-script' && typeof input.source === 'string') {
    const first = input.source.split('\n', 1)[0] ?? '';
    fields.push(`lua: ${first.length > 60 && !verbose ? first.slice(0, 57) + '…' : first}`);
  }
  if (fields.length > 0) {
    const summary = fields.join(', ');
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

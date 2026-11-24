import type { ToolResultBlockParam } from '../../engine/message-shapes/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from './FallbackToolUseErrorMessage.js';
import { Box, Text } from '../../screen/themedRenderer.js';

export function renderBridgeToolUseMessage(
  input: { op?: string; args?: Record<string, unknown> },
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

export function renderBridgeToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

export function renderBridgeToolResultMessage(
  output: { result?: string },
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

export function summarizeBridgeArgs(args: Record<string, unknown> | undefined, cap = 160): string {
  if (!args || Object.keys(args).length === 0) return ''
  const s = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s
}

export function formatBridgeResult(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2) ?? String(result)
}

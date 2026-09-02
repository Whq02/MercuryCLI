;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './BrowserTool.js';

export function userFacingName(): string {
  return 'Browser';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const parts: string[] = [input.op];
  if (input.op === 'open' && input.url) parts.push(clip(input.url, 70));
  if (input.op === 'click')
    parts.push(input.selector ?? (typeof input.x === 'number' ? `(${input.x}, ${input.y})` : ''));
  if (input.op === 'type') {
    if (input.text !== undefined) parts.push(`"${clip(input.text, 30)}"`);
    parts.push(`into ${input.selector ?? '(focused)'}`);
    if (input.enter) parts.push('+ Enter');
  }
  if (input.op === 'scroll') parts.push(input.selector ?? (typeof input.dy === 'number' ? `by ${input.dy}` : ''));
  if (input.op === 'select') parts.push(`${input.selector ?? ''} ← [${(input.values ?? []).join(', ')}]`);
  if (input.op === 'press') parts.push([...(input.modifiers ?? []), input.key ?? ''].filter(Boolean).join('+'));
  if (input.op === 'hover') parts.push(input.selector ?? '');
  if (input.op === 'waitFor')
    parts.push(input.selector ?? (input.text !== undefined ? `text "${clip(input.text, 30)}"` : 'navigation'));
  if (input.op === 'extract') {
    parts.push(input.mode ?? 'text');
    if (input.selector) parts.push(input.selector);
  }
  if (input.op === 'viewport') parts.push(`${input.width}x${input.height}`);
  if (input.op === 'provision') parts.push(input.buildId ?? '(current stable)');
  if (input.op === 'console' && typeof input.limit === 'number') parts.push(`last ${input.limit}`);
  if (input.op === 'screenshot' && input.selector) parts.push(input.selector);
  if (input.op === 'screenshot' && input.fullPage) parts.push('(full page)');
  return parts.filter(Boolean).join(' ');
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
  const shown = verbose ? lines : lines.slice(0, 10);
  return (
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>browser {output.op}</Text>
        </Text>
        {shown.map((line, i) => (
          <Text key={i} color={FAINT}>
            {'  '}
            {line}
          </Text>
        ))}
        {!verbose && lines.length > shown.length ? (
          <Text color={FAINT}>{`  … ${lines.length - shown.length} more line(s)`}</Text>
        ) : null}
      </Box>
  
      )}
    </WithCardTone>
  );
}

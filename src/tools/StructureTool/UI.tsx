;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { InlineChangeView } from '../../components/InlineChangeView.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './StructureTool.js';

export function userFacingName(): string {
  return 'Structure';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.op === 'query' && input.select) {
    parts.push(input.select);
    if (input.name) parts.push(input.name);
    if (input.callee) parts.push(input.callee);
    if (input.module) parts.push(input.module);
  }
  if (input.op === 'query' && input.pattern) {
    parts.push(JSON.stringify(input.pattern.slice(0, 48)));
    if (input.lang) parts.push(input.lang);
  }
  if (input.op === 'preview' && input.action) parts.push(input.action);
  if (input.op === 'apply' && input.previewId) parts.push(input.previewId);
  if (input.op === 'explain' && input.matchId) parts.push(input.matchId);
  return parts.join(' ');
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// The one distinction the grammar must never blur (law +
// render proof): a PREVIEW card reads 'proposed' (amber, in-motion family),
// an APPLIED card reads settled-good — they can never look identical.
function stateWord(output: Output): string {
  if (output.op === 'preview' && output.outcome === 'succeeded') return 'proposed';
  if (output.op === 'apply' && output.outcome === 'succeeded') return 'applied';
  return output.outcome;
}

function stateToneKey(output: Output): string {
  if (output.op === 'preview' && output.outcome === 'succeeded') return 'queued'; // amber family: proposed ≠ applied
  if (output.op === 'apply' && output.outcome === 'succeeded') return 'succeeded';
  return output.outcome;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  // preview/apply results carry the structured change payload —
  // render the ONE premium inline change view (syntax-aware hunks · file
  // headers · counts · diagnostics · resolvable refs) instead of raw text.
  if (output.changeView && output.changeView.files.some(f => f.hunks.length > 0)) {
    return <InlineChangeView data={output.changeView} verbose={verbose} />;
  }
  const lines = (output.result ?? '').split('\n');
  const shown = verbose ? lines : lines.slice(0, 12);
  return (
    <WithCardTone state={stateToneKey(output)}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>structure {output.op}</Text>
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

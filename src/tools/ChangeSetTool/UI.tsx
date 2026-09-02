;
import type { ToolResultBlockParam } from '../../types/wire.js'
import React from 'react';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FAINT } from '../../components/mercuryPalette.js';
import { InlineChangeView } from '../../components/InlineChangeView.js';
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js';
import { Box, Text } from '../../ink.js';
import type { Input, Output } from './ChangeSetTool.js';

export function userFacingName(): string {
  return 'ChangeSet';
}

export function renderToolUseMessage(
  input: Partial<Input>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!input.op) return null;
  const parts: string[] = [input.op];
  if (input.changes && input.changes.length > 0) {
    const hunks = input.changes.reduce((n, c) => n + (c.hunks?.length ?? 0), 0);
    parts.push(`${input.changes.length} file${input.changes.length === 1 ? '' : 's'}`);
    parts.push(`${hunks} hunk${hunks === 1 ? '' : 's'}`);
  } else if (typeof input.patch === 'string' && input.patch.length > 0) {
    const files = new Set([...input.patch.matchAll(/^file\s+(\S+)\s/gm)].map(m => m[1])).size;
    const ops = [...input.patch.matchAll(/^(replace|replace-block|insert|insert-after-block|prepend|delete|cut|paste|move-to|delete-file)\b/gm)].length;
    parts.push(files > 0 ? `patch · ${files} file${files === 1 ? '' : 's'}` : 'patch');
    if (ops > 0) parts.push(`${ops} op${ops === 1 ? '' : 's'}`);
  }
  if (input.plan_id) parts.push(input.plan_id);
  return parts.join(' · ');
}

export function renderToolUseRejectedMessage(): React.ReactNode {
  return (
    <Text color={FAINT}>change set not applied — the aggregate decision was declined; nothing was written</Text>
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
  // The ONE aggregate inline change view carries every ChangeSet state
  // (prepared/applied/no-change/stale/failed/indeterminate/recovered/
  // discarded/expired) — including states with zero renderable hunks.
  if (output.changeView) {
    return <InlineChangeView data={output.changeView} verbose={verbose} />;
  }
  const lines = (output.result ?? '').split('\n');
  const shown = verbose ? lines : lines.slice(0, 12);
  return (
    <WithCardTone state={output.outcome}>
      {({ glyph, tone }) => (
      <Box flexDirection="column">
        <Text>
          <Text color={tone}>{glyph} </Text>
          <Text color={FAINT}>changeset {output.op}</Text>
          <Text color={tone}> {output.outcome}</Text>
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

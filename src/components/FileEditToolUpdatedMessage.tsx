import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { ToolCardMarker, toolCardCountColor } from './mercury-ui/toolCardMeta.js';
import { StructuredDiffList } from './StructuredDiffList.js';
import { basename } from 'node:path';
type Props = {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  style?: 'condensed';
  verbose: boolean;
  previewHint?: string;
};
export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
  previewHint,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const numAdditions = structuredPatch.reduce(
    (acc, hunk) => acc + count(hunk.lines, l => l.startsWith('+')),
    0,
  );
  const numRemovals = structuredPatch.reduce(
    (acc, hunk) => acc + count(hunk.lines, l => l.startsWith('-')),
    0,
  );
  const countColor = toolCardCountColor();
  const hasChanges = numAdditions > 0 || numRemovals > 0;

  const text = (
    <Text>
      {numAdditions > 0 ? (
        <>
          Added{' '}
          <Text bold color={countColor}>
            {numAdditions}
          </Text>{' '}
          {numAdditions > 1 ? 'lines' : 'line'}
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? ', ' : null}
      {numRemovals > 0 ? (
        <>
          {numAdditions === 0 ? 'R' : 'r'}emoved{' '}
          <Text bold color={countColor}>
            {numRemovals}
          </Text>{' '}
          {numRemovals > 1 ? 'lines' : 'line'}
        </>
      ) : null}
      {hasChanges ? null : <Text dimColor>No changes</Text>}
    </Text>
  );

  if (previewHint) {
    if (style !== 'condensed' && !verbose) {
      return (
        <MessageResponse>
          <Text dimColor>{previewHint}</Text>
        </MessageResponse>
      );
    }
  } else if (style === 'condensed' && !verbose) {
    return text;
  }

  const railed = columns > 80;
  const innerWidth = railed ? Math.max(1, columns - 14) : columns - 12;
  const diff = (
    <StructuredDiffList
      hunks={structuredPatch}
      dim={false}
      width={innerWidth}
      filePath={filePath}
      firstLine={firstLine}
      fileContent={fileContent}
    />
  );
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          {text}
        </Text>
        {!hasChanges ? null : railed ? (
          <Box
            borderColor="subtle"
            borderStyle="single"
            flexDirection="column"
            borderText={{
              content: ' diff · ' + basename(filePath) + ' ',
              position: 'top',
              align: 'start',
              offset: 0,
            }}
          >
            {diff}
          </Box>
        ) : (
          diff
        )}
      </Box>
    </MessageResponse>
  );
}

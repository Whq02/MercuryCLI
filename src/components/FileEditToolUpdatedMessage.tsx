import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { ToolCardMarker, toolCardCountColor } from './mercury-ui/toolCardMeta.js';
import { StructuredDiffList } from './StructuredDiffList.js';
import { isSqliteRowTarget } from '../tools/FileWriteTool/structuredTargets.js';
import { basename } from 'node:path';

type Props = {
  filePath: string
  structuredPatch: StructuredPatchHunk[]
  firstLine?: string | null
  fileContent?: string
  style?: 'condensed' | 'default'
  verbose: boolean
}

export function FileEditToolUpdatedMessage({
  filePath,
  structuredPatch,
  firstLine,
  fileContent,
  style,
  verbose,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();
  const numAdditions = structuredPatch.reduce(
    (sum, hunk) => sum + count(hunk.lines, line => line.startsWith('+')),
    0,
  );
  const numRemovals = structuredPatch.reduce(
    (sum, hunk) => sum + count(hunk.lines, line => line.startsWith('-')),
    0,
  );
  const hasChanges = numAdditions > 0 || numRemovals > 0;
  const countColor = toolCardCountColor();
  const notCheckpointed = isSqliteRowTarget(filePath) ? (
    <Text dimColor> · not checkpointed</Text>
  ) : null;

  const summary = hasChanges ? (
    <>
      {numAdditions > 0 ? (
        <>
          Added <Text bold color={countColor}>{numAdditions}</Text>{' '}
          {numAdditions === 1 ? 'line' : 'lines'}
        </>
      ) : null}
      {numAdditions > 0 && numRemovals > 0 ? ', ' : null}
      {numRemovals > 0 ? (
        <>
          {numAdditions > 0 ? 'removed ' : 'Removed '}
          <Text bold color={countColor}>{numRemovals}</Text>{' '}
          {numRemovals === 1 ? 'line' : 'lines'}
        </>
      ) : null}
      {notCheckpointed}
    </>
  ) : (
    <>
      <Text dimColor>No changes</Text>
      {notCheckpointed}
    </>
  );

  if (style === 'condensed' && !verbose) {
    return <Text>{summary}</Text>;
  }

  const railed = columns > 80;
  const innerWidth = railed ? Math.max(1, columns - 14) : Math.max(1, columns - 12);

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          {summary}
        </Text>
        {hasChanges ? (
          railed ? (
            <Box
              borderColor="subtle"
              borderStyle="single"
              flexDirection="column"
              alignSelf="flex-start"
              borderText={{
                content: ' diff · ' + basename(filePath) + ' ',
                position: 'top',
                align: 'start',
                offset: 0,
              }}
            >
              <StructuredDiffList
                hunks={structuredPatch}
                dim={false}
                width={innerWidth}
                filePath={filePath}
                firstLine={firstLine ?? null}
                fileContent={fileContent}
              />
            </Box>
          ) : (
            <StructuredDiffList
              hunks={structuredPatch}
              dim={false}
              width={innerWidth}
              filePath={filePath}
              firstLine={firstLine ?? null}
              fileContent={fileContent}
            />
          )
        ) : null}
      </Box>
    </MessageResponse>
  );
}

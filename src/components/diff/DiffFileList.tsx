import figures from 'figures';
import React from 'react';
import type { DiffFile } from '../../hooks/useDiffData.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { truncateStartToWidth } from '../../utils/format.js';
import { plural } from '../../utils/stringUtils.js';
import { paneWindow } from '../mercury-ui/paneWindow.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { notBuilt } from '../../pi/holes.js'

type Props = {
  files: DiffFile[];
  selectedIndex: number;
  visibleRows: number;
  listWidth?: number;
  onSelect?: (filePath: string) => void;
  onActivate?: (filePath: string) => void;
};

export function DiffFileList(arg0: Props): React.ReactNode {
  return notBuilt('src/components/diff/DiffFileList.tsx:22')
}

function FileItem({
  file,
  isSelected,
  maxPathWidth,
  onSelect,
  onActivate,
}: {
  file: DiffFile;
  isSelected: boolean;
  maxPathWidth: number;
  onSelect: () => void;
  onActivate: () => void;
}): React.ReactNode {
  const displayPath = truncateStartToWidth(file.path, maxPathWidth);
  const pointer = isSelected ? figures.pointer + ' ' : '  ';
  return (
    <InteractiveRow
      id={`diff:file:${file.path}`}
      selected={isSelected}
      selectionBand={false}
      onSelect={onSelect}
      onActivate={onActivate}
      height={1}
      flexDirection="row"
    >
      <Text bold={isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
        {pointer}
        {displayPath}
      </Text>
      <Box flexGrow={1} />
      <FileStats file={file} isSelected={isSelected} />
    </InteractiveRow>
  );
}

function FileStats({
  file,
  isSelected,
}: {
  file: DiffFile;
  isSelected: boolean;
}): React.ReactNode {
  if (file.isUntracked) {
    return (
      <Text italic dimColor={!isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
        untracked
      </Text>
    );
  }
  if (file.isBinary) {
    return (
      <Text italic dimColor={!isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
        Binary file
      </Text>
    );
  }
  if (file.isLargeFile) {
    return (
      <Text italic dimColor={!isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
        Large file modified
      </Text>
    );
  }
  const hasAdded = file.linesAdded > 0;
  const hasRemoved = file.linesRemoved > 0;
  return (
    <Box flexDirection="row">
      {hasAdded ? (
        <Text bold={isSelected} color={isSelected ? 'background' : 'success'} inverse={isSelected}>
          {`+${file.linesAdded}`}
        </Text>
      ) : null}
      {hasAdded && hasRemoved ? (
        <Text color={isSelected ? 'background' : undefined} inverse={isSelected}>
          {' '}
        </Text>
      ) : null}
      {hasRemoved ? (
        <Text bold={isSelected} color={isSelected ? 'background' : 'error'} inverse={isSelected}>
          {`-${file.linesRemoved}`}
        </Text>
      ) : null}
      {file.isTruncated ? (
        <Text dimColor={!isSelected} color={isSelected ? 'background' : undefined} inverse={isSelected}>
          {' (truncated)'}
        </Text>
      ) : null}
    </Box>
  );
}

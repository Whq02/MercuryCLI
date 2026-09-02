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


type Props = {
  files: DiffFile[];
  selectedIndex: number;
  visibleRows: number;
  listWidth?: number;
  onSelect: (path: string) => void;
  onActivate: (path: string) => void;
};

export function DiffFileList({
  files,
  selectedIndex,
  visibleRows,
  listWidth,
  onSelect,
  onActivate,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens();
  const { columns } = useTerminalSize();
  if (files.length === 0) {
    return <Text dimColor>No changed files</Text>;
  }
  const win = paneWindow(files.length, selectedIndex, visibleRows);
  const maxPathWidth = Math.max(20, (listWidth ?? columns) - 16 - 3 - 4);
  return (
    <Box flexDirection="column">
      {win.above > 0 ? (
        <Text color={tokens.textMuted}>{` ↑ ${win.above} more ${plural(win.above, 'file')}`}</Text>
      ) : null}
      {files.slice(win.start, win.end).map((file, i) => {
        const gi = win.start + i;
        return (
          <FileItem
            key={file.path}
            file={file}
            isSelected={gi === selectedIndex}
            maxPathWidth={maxPathWidth}
            onSelect={() => onSelect(file.path)}
            onActivate={() => onActivate(file.path)}
          />
        );
      })}
      {win.below > 0 ? (
        <Text color={tokens.textMuted}>{` ↓ ${win.below} more ${plural(win.below, 'file')}`}</Text>
      ) : null}
    </Box>
  );
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

function FileStats({ file, isSelected }: { file: DiffFile; isSelected: boolean }): React.ReactNode {
  if (file.isUntracked) {
    return (
      <Text dimColor={!isSelected} italic>
        untracked
      </Text>
    );
  }
  if (file.isBinary) {
    return (
      <Text dimColor={!isSelected} italic>
        Binary file
      </Text>
    );
  }
  if (file.isLargeFile) {
    return (
      <Text dimColor={!isSelected} italic>
        Large file modified
      </Text>
    );
  }
  return (
    <Text>
      {file.linesAdded > 0 && (
        <Text color="diffAddedWord" bold={isSelected}>
          +{file.linesAdded}
        </Text>
      )}
      {file.linesAdded > 0 && file.linesRemoved > 0 && ' '}
      {file.linesRemoved > 0 && (
        <Text color="diffRemovedWord" bold={isSelected}>
          -{file.linesRemoved}
        </Text>
      )}
      {file.isTruncated && <Text dimColor={!isSelected}> (truncated)</Text>}
    </Text>
  );
}

import type { StructuredPatchHunk } from 'diff';
import { basename, resolve } from 'path';
import React from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { getCwd } from '../../utils/cwd.js';
import { readFileSafe } from '../../utils/file.js';
import { Divider } from '../design-system/Divider.js';
import { StructuredDiff } from '../StructuredDiff.js';
import { displayWidth, truncateToWidth } from '../mercury-ui/glyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';

// ============================================================================
//  DiffDetailView — one file's hunk workspace (interaction-finish;
//  hand-written, converted from the React-Compiler form).
//
//  · the header is a STABLE file label: long paths middle-truncate so the
//    FILENAME always survives (`src/…/NavigablePanes.tsx`), with the real
//    added/removed totals and — when more than one hunk exists — the current
//    `hunk 2/7` position beside it (never consuming hunk width below);
//  · the body renders the CURRENT hunk through StructuredDiff (the canonical
//    hunk renderer — word-level diff + syntax highlight, unchanged); n/p in
//    the parent step `hunkIndex` between real hunks;
//  · binary / large / untracked / truncated postures keep their honest
//    full-frame explanations.
// ============================================================================

type Props = {
  filePath: string;
  hunks: StructuredPatchHunk[];
  /** Which hunk the workspace is ON (parent-owned; n/p step it). */
  hunkIndex?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isLargeFile?: boolean;
  isBinary?: boolean;
  isTruncated?: boolean;
  isUntracked?: boolean;
};

/** Middle-truncate a path so the basename always survives: `a/b/…/name.ts`. */
export function middleTruncatePath(path: string, max: number): string {
  if (displayWidth(path) <= max) return path;
  const name = basename(path);
  if (displayWidth(name) + 2 >= max) return truncateToWidth(name, max);
  const headBudget = max - displayWidth(name) - 2;
  const head = truncateToWidth(path.slice(0, path.length - name.length), headBudget).replace(
    /…?$/,
    '',
  );
  return `${head}…/${name}`;
}

export function DiffDetailView({
  filePath,
  hunks,
  hunkIndex = 0,
  linesAdded,
  linesRemoved,
  isLargeFile,
  isBinary,
  isTruncated,
  isUntracked,
}: Props): React.ReactNode {
  const tokens = useMercuryTokens();
  const { columns } = useTerminalSize();

  const { firstLine, fileContent } = ((): {
    firstLine: string | null;
    fileContent: string | undefined;
  } => {
    if (!filePath) return { firstLine: null, fileContent: undefined };
    const fullPath = resolve(getCwd(), filePath);
    const content = readFileSafe(fullPath);
    return { firstLine: content?.split('\n')[0] ?? null, fileContent: content ?? undefined };
  })();

  // Header: middle-truncated path + real totals + hunk position. The totals
  // ride the HEADER row (never the hunk body's width).
  const positionLabel = hunks.length > 1 ? `hunk ${Math.min(hunkIndex, hunks.length - 1) + 1}/${hunks.length}` : null;
  const totalsLabel =
    typeof linesAdded === 'number' && typeof linesRemoved === 'number' && !isBinary && !isUntracked
      ? `+${linesAdded}/-${linesRemoved}`
      : null;
  const tailWidth =
    (totalsLabel ? displayWidth(totalsLabel) + 2 : 0) +
    (positionLabel ? displayWidth(positionLabel) + 3 : 0);
  const header = (
    <Box>
      <Text bold wrap="truncate-end">
        {middleTruncatePath(filePath, Math.max(16, columns - 6 - tailWidth))}
      </Text>
      {totalsLabel ? <Text color={tokens.textSecondary}>{`  ${totalsLabel}`}</Text> : null}
      {positionLabel ? <Text color={tokens.textMuted}>{` · ${positionLabel}`}</Text> : null}
      {isTruncated ? <Text dimColor> (truncated)</Text> : null}
    </Box>
  );

  if (isUntracked) {
    return (
      <Box flexDirection="column" width="100%">
        <Box>
          <Text bold>{middleTruncatePath(filePath, Math.max(16, columns - 16))}</Text>
          <Text dimColor> (untracked)</Text>
        </Box>
        <Divider padding={4} />
        <Box flexDirection="column">
          <Text dimColor italic>
            New file not yet staged.
          </Text>
          <Text dimColor italic>
            Run `git add {filePath}` to see line counts.
          </Text>
        </Box>
      </Box>
    );
  }
  if (isBinary) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Divider padding={4} />
        <Text dimColor italic>
          Binary file - cannot display diff
        </Text>
      </Box>
    );
  }
  if (isLargeFile) {
    return (
      <Box flexDirection="column" width="100%">
        {header}
        <Divider padding={4} />
        <Text dimColor italic>
          Large file - diff exceeds 1 MB limit
        </Text>
      </Box>
    );
  }

  const hunk = hunks[Math.min(hunkIndex, Math.max(0, hunks.length - 1))];
  return (
    <Box flexDirection="column" width="100%">
      {header}
      <Divider padding={4} />
      {hunk === undefined ? (
        <Text dimColor>No diff content</Text>
      ) : (
        <Box flexDirection="column">
          <StructuredDiff
            patch={hunk}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
            dim={false}
            width={columns - 2 - 2}
          />
        </Box>
      )}
      {isTruncated ? (
        <Text dimColor italic>
          … diff truncated (exceeded 400 line limit)
        </Text>
      ) : null}
    </Box>
  );
}

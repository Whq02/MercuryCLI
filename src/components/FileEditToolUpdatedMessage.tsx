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
// Hand-written (no React-Compiler `_c` memo cache). The +/-
// counts are honest: numAdditions/numRemovals are computed by counting +/- lines
// in the persisted structuredPatch hunks. Mercury accents them (TEAL ● marker +
// IVORY-bold counts) on the compact summary; the diff body is unchanged.
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
  // A 0/0 patch (an empty-file write, or a no-op edit) yields an empty
  // structuredPatch: both the Added/Removed branches below render null and
  // StructuredDiffList renders an empty (in railed mode: bordered) box, so the
  // user sees a dangling "● " marker over an empty diff box. Surface an honest
  // "No changes" summary and skip the empty diff body instead.
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

  // Plan files run the condensed rule INVERTED:
  // - Regular mode: just show the hint (user can type /plan to see full content)
  // - Condensed mode (subagent view): show the diff
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

  // Warm-ink: frame the in-transcript edit diff in a railed ┌ diff · <file> ──┐
  // box so a committed edit reads as a card (full-chat diff box) and not a
  // borderless wall. The frameless body sizes to columns-12 — the conservative
  // established diff-WIDTH convention (it UNDER-sizes the body, never overflows), NOT
  // the message gutter (the real MessageResponse gutter is 5 cells: ' └ ' = 2
  // spaces + the 2-cell OUTPUT_CONNECTOR + 1 space, per figures.ts). The railed box
  // adds 2 rail cols on top, so width = columns-14, or its bg-filled rows would
  // render wider than the box and bleed past the right rail. Bare-stamp / ≤80-col fall
  // through to the plain frameless body, byte-identical.
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

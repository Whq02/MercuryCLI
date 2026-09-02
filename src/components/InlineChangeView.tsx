import type { StructuredPatchHunk } from 'diff';
import { basename } from 'node:path';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { FAINT } from './mercuryPalette.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';
import { cardToneOf } from './mercury-ui/toolCardGrammar.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { ToolCardMarker, toolCardCountColor } from './mercury-ui/toolCardMeta.js';

// ============================================================================
//  InlineChangeView — the ONE premium inline change view for semantic-edit
//  results: Structure preview/apply, LSP rename / code-action /
//  fixDiagnostic. The transcript shows enough to DECIDE without opening a
//  separate screen; large output stays bounded (the producer caps hunks and
//  NAMES the cut).
//
//    · collapsed: one honest summary line — state word (proposed = amber,
//      in-motion family · applied = settled-good), file/replacement counts,
//      +A/−R line totals, the diagnostics delta — the row-level ctrl+o /
//      click machinery expands it (the transcript disclosure grammar).
//    · expanded: per-file railed `diff · <basename>` cards riding the SAME
//      StructuredDiffList the Edit tool uses (syntax-aware hunks, gutter
//      line numbers), the diagnostics line, and the resolvable mercury://
//      refs for complete detail.
// ============================================================================

export interface InlineChangeViewData {
  state:
    | 'proposed'
    | 'applied'
    // the change-set lifecycle joins the ONE view (additive —
    // Structure/LSP keep emitting proposed/applied byte-identically).
    | 'prepared'
    | 'no-change'
    | 'stale'
    | 'failed'
    | 'indeterminate'
    | 'recovered'
    | 'discarded'
    | 'expired';
  action: string;
  files: {
    file: string;
    hunks: StructuredPatchHunk[];
    omittedHunks?: number;
    changedLines: number;
  }[];
  matchCount?: number;
  diagnostics?: { planned: number } | { clean: number; failed: number };
  refs: string[];
  /** already-satisfied member paths (reported, never written). */
  noChangePaths?: string[];
  /** hunk count across the set (files alone under-tell a set). */
  hunkCount?: number;
  /** plan identity + age when a plan backs the view. */
  planMeta?: { id: string; digest12: string; ageMs: number; expiresInMs?: number };
  /** ONE concise next action for stale/unresolved states. */
  nextAction?: string;
}

/** state → the shared card-tone vocabulary (toolCardGrammar keys). */
const STATE_TONE_KEY: Record<InlineChangeViewData['state'], string> = {
  proposed: 'queued',
  prepared: 'queued',
  applied: 'succeeded',
  'no-change': 'ok',
  stale: 'expired',
  failed: 'failed',
  indeterminate: 'indeterminate',
  recovered: 'succeeded',
  discarded: 'cancelled',
  expired: 'expired',
};

function shortAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

function diagnosticsText(d: InlineChangeViewData['diagnostics']): string | null {
  if (!d) return null;
  if ('planned' in d) return d.planned > 0 ? `diagnostics planned: ${d.planned} file${d.planned === 1 ? '' : 's'}` : null;
  return `diagnostics: ${d.clean} clean${d.failed > 0 ? ` · ${d.failed} FAILED` : ''}`;
}

export function InlineChangeView({
  data,
  verbose,
}: {
  data: InlineChangeViewData;
  verbose: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const t = useMercuryTokens();
  const additions = data.files.reduce(
    (acc, f) => acc + f.hunks.reduce((a, h) => a + count(h.lines, l => l.startsWith('+')), 0),
    0,
  );
  const removals = data.files.reduce(
    (acc, f) => acc + f.hunks.reduce((a, h) => a + count(h.lines, l => l.startsWith('-')), 0),
    0,
  );
  const countColor = toolCardCountColor();
  // proposed/prepared ride the amber in-motion family; applied reads
  // settled-good — the Structure card law (they can never look identical).
  // The states map onto the SAME shared tone vocabulary.
  const { glyph, tone } = cardToneOf(t, STATE_TONE_KEY[data.state]);
  const diag = diagnosticsText(data.diagnostics);
  const noChangeCount = data.noChangePaths?.length ?? 0;

  const summary = (
    <Text>
      <Text color={tone}>{glyph} </Text>
      <Text color={FAINT}>{data.action} </Text>
      <Text color={tone}>{data.state}</Text>
      <Text>
        {' '}· <Text bold color={countColor}>{data.files.length}</Text> file{data.files.length === 1 ? '' : 's'}
        {data.matchCount !== undefined ? (
          <>
            {' '}· <Text bold color={countColor}>{data.matchCount}</Text> match{data.matchCount === 1 ? '' : 'es'}
          </>
        ) : null}
        {data.hunkCount !== undefined ? (
          <>
            {' '}· <Text bold color={countColor}>{data.hunkCount}</Text> hunk{data.hunkCount === 1 ? '' : 's'}
          </>
        ) : null}
        {' '}· <Text bold color={countColor}>+{additions}</Text>/<Text bold color={countColor}>−{removals}</Text>
        {noChangeCount > 0 ? (
          <Text color={FAINT}> · {noChangeCount} already satisfied</Text>
        ) : null}
      </Text>
      {diag && 'failed' in (data.diagnostics ?? {}) && (data.diagnostics as { failed: number }).failed > 0 ? (
        <Text color="error"> · {diag}</Text>
      ) : null}
    </Text>
  );

  if (!verbose) {
    return (
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          {summary}
          <Text dimColor> (ctrl+o expands)</Text>
        </Text>
        {data.nextAction ? (
          <Text>
            {'  '}
            <Text color={tone}>→ {data.nextAction}</Text>
          </Text>
        ) : null}
      </Box>
    );
  }

  const railed = columns > 80;
  const innerWidth = railed ? Math.max(1, columns - 14) : columns - 12;
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          {summary}
        </Text>
        {data.files.filter(f => f.hunks.length > 0).map(f => (
          <Box key={f.file} flexDirection="column">
            {railed ? (
              <Box
                borderColor="subtle"
                borderStyle="single"
                flexDirection="column"
                borderText={{
                  content: ' diff · ' + basename(f.file) + ' ',
                  position: 'top',
                  align: 'start',
                  offset: 0,
                }}
              >
                <StructuredDiffList hunks={f.hunks} dim={false} width={innerWidth} filePath={f.file} firstLine={null} />
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text color={FAINT}>{f.file}</Text>
                <StructuredDiffList hunks={f.hunks} dim={false} width={innerWidth} filePath={f.file} firstLine={null} />
              </Box>
            )}
            {f.omittedHunks ? (
              <Text dimColor>
                … +{f.omittedHunks} hunk{f.omittedHunks === 1 ? '' : 's'} not shown — full detail at the record below
              </Text>
            ) : null}
          </Box>
        ))}
        {diag ? <Text color={FAINT}>{diag}</Text> : null}
        {noChangeCount > 0 ? (
          <Text color={FAINT}>
            already satisfied (not written): {data.noChangePaths!.map(p => basename(p)).join(', ')}
          </Text>
        ) : null}
        {data.planMeta ? (
          <Text dimColor>
            plan {data.planMeta.id} · digest {data.planMeta.digest12} · age {shortAge(data.planMeta.ageMs)}
            {data.planMeta.expiresInMs !== undefined
              ? data.planMeta.expiresInMs > 0
                ? ` · expires in ${shortAge(data.planMeta.expiresInMs)}`
                : ' · EXPIRED'
              : ''}
          </Text>
        ) : null}
        {data.nextAction ? <Text color={tone}>→ {data.nextAction}</Text> : null}
        {data.refs.map(r => (
          <Text key={r} dimColor>
            {r}
          </Text>
        ))}
      </Box>
    </MessageResponse>
  );
}

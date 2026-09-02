// ============================================================================
//  ResumeRecapCard — Mercury's re-entry card (trust-cockpit W2c).
//
//  Renders the away/resume recap as a 3-line transcript card instead of the old
//  30s toast: end-state verdict first (did the prior run finish or crash?), then
//  the run's shape (turns · files · gap · top tools), then the repo/health tail
//  (branch · uncommitted · /doctor cert). Mounted ONLY from SystemTextMessage's
//  away_summary branch when the Mercury build stamped recapMetadata — a message
//  without it (upstream blur-summary path, older sessions) keeps the plain ※
//  line. Props-pure per mercury-ui rules:
//  every value arrives via recapMetadata (the REPL mount effect reads git +
//  healthCertSnapshot; this component reads nothing).
// ============================================================================
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { GLYPH } from '../mercury-ui/glyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import type { AwayRecapMetadata } from '../../types/message.js';
import { humanGap } from '../../utils/cockpit/awaySummary.js';

type Props = {
  metadata: AwayRecapMetadata;
  addMargin: boolean;
  /** The selected-message background from useSelectedMessageBg (parity with the plain branch). */
  bg?: string;
};

/** 'main · 3 uncommitted (+340/-85) · health ✓ certified · 14m' — '' when nothing known. */
function repoHealthTail(m: AwayRecapMetadata): string {
  const parts: string[] = [];
  if (m.branch) parts.push(m.branch);
  if (typeof m.dirtyCount === 'number' && m.dirtyCount > 0) {
    parts.push(`${m.dirtyCount} uncommitted${m.dirtyDelta ? ` (${m.dirtyDelta})` : ''}`);
  }
  // certVerdict undefined ⇒ the cert surface was gated off at build time — say
  // nothing rather than a misleading 'none'; 'none' ⇒ enabled but never issued.
  // The ONE health-chip grammar (frame strip / Helm rail / splash strip):
  // `health <glyph> <verdict> · <age>`.
  if (m.certVerdict === 'none') {
    parts.push('health none — /health');
  } else if (m.certVerdict) {
    const age = typeof m.certAgeMs === 'number' ? humanGap(m.certAgeMs) : '';
    const glyph =
      m.certVerdict === 'certified' ? GLYPH.check : m.certVerdict === 'caution' ? GLYPH.warn : GLYPH.fail;
    parts.push(`health ${glyph} ${m.certVerdict}${age ? ` ${GLYPH.dot} ${age.replace(' ago', '')}` : ''}`);
  }
  return parts.join(` ${GLYPH.dot} `);
}

/** '2 turns · 5 files touched · last active 2h ago · Edit×4 Bash×2' — '' when empty. */
function shapeCounts(m: AwayRecapMetadata): string {
  const parts: string[] = [];
  if (typeof m.turns === 'number') parts.push(`${m.turns} turn${m.turns === 1 ? '' : 's'}`);
  if (typeof m.filesTouched === 'number' && m.filesTouched > 0) {
    parts.push(`${m.filesTouched} file${m.filesTouched === 1 ? '' : 's'} touched`);
  }
  // Failed tool calls ride the verdict line unless the API-error verdict owns
  // it — then they surface here so neither truth displaces the other.
  if (m.endedOnError && typeof m.toolFailures === 'number' && m.toolFailures > 0) {
    parts.push(`${m.toolFailures} tool call${m.toolFailures === 1 ? '' : 's'} failed`);
  }
  if (typeof m.lastActiveGapMs === 'number') {
    const gap = humanGap(m.lastActiveGapMs);
    if (gap) parts.push(`last active ${gap}`);
  }
  if (m.topTools) parts.push(m.topTools);
  return parts.join(` ${GLYPH.dot} `);
}

export function ResumeRecapCard({ metadata, addMargin, bg }: Props): React.ReactNode {
  const tokens = useMercuryTokens();
  const shape = shapeCounts(metadata);
  const tail = repoHealthTail(metadata);
  // "resumed clean" is a claim, not a greeting: a prior run whose tool calls
  // errored or were denied did not finish clean even when its final assistant
  // turn is intact — the verdict downgrades to the amber failed-calls line.
  const toolFailures = metadata.toolFailures ?? 0;
  const verdictTone = metadata.endedOnError
    ? tokens.failure
    : toolFailures > 0
      ? tokens.warning
      : tokens.borderStrong;
  // A real CARD (flare pass): the re-entry briefing is the densest
  // honest datum on a resume — frame it. Round border, neutral structural tone
  // by default; the border itself goes failure-crimson when the prior run died
  // so the verdict is preattentive before a word is read. Content unchanged
  // (props-pure, invents nothing). A Mercury-original component — no parity branch.
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={bg}
      borderStyle="round"
      borderColor={verdictTone}
      paddingX={1}
      alignSelf="flex-start"
    >
      <Box flexDirection="row">
        {metadata.endedOnError ? (
          <>
            <Box minWidth={2}>
              <Text color={tokens.failure}>{GLYPH.fail}</Text>
            </Box>
            <Text color={tokens.failure}>prior run ended on an error</Text>
          </>
        ) : toolFailures > 0 ? (
          <>
            <Box minWidth={2}>
              <Text color={tokens.warning}>{GLYPH.warn}</Text>
            </Box>
            <Text color={tokens.warning}>
              resumed — {toolFailures} tool call{toolFailures === 1 ? '' : 's'} failed
            </Text>
          </>
        ) : (
          <>
            <Box minWidth={2}>
              <Text color={tokens.success}>{GLYPH.check}</Text>
            </Box>
            <Text color={tokens.textPrimary}>resumed clean</Text>
          </>
        )}
      </Box>
      {shape ? (
        <Box flexDirection="row">
          <Box minWidth={2} />
          <Text color={tokens.textSecondary} wrap="truncate">
            {shape}
          </Text>
        </Box>
      ) : null}
      {tail ? (
        <Box flexDirection="row">
          <Box minWidth={2} />
          <Text color={tokens.textMuted} wrap="truncate">
            {tail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

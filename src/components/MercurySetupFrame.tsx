import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Crab, Wordmark } from './mercury-ui/assets.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { InteractiveDisclosure } from './mercury-ui/InteractiveDisclosure.js'
import type { BootNote } from '../substrate/bootNotes.js'

// ============================================================================
//  MercurySetupFrame — the ONE persistent card hosting the whole first-run
//  sequence. Between steps
//  only the body, the step rail, and the footer mutate — border, header,
//  and geometry are pixel-stable so the flow reads as one surface changing
//  state, never screens replacing each other. Supersedes HermesSetupShell
//  for the setup flows (trust keeps the warning boundary tone — AMBER on
//  the dark family). Ink rides the adaptive token layer so the frame
//  repaints under the onboarding theme preview.
// ============================================================================

export interface SetupRailStep {
  key: string
  label: string
  state: 'done' | 'current' | 'pending'
}

export function MercurySetupFrame({
  title,
  stepTag,
  steps,
  tone = 'brand',
  footer,
  bootNotes = [],
  children,
}: {
  /** ' — first run' family tail: 'first run' | 'add account' | … */
  title: string
  /** Right-aligned '<stepname> · n/total' (dropped below 60 cols). */
  stepTag?: string
  steps: SetupRailStep[]
  tone?: 'brand' | 'trust'
  footer: string
  bootNotes?: readonly BootNote[]
  children: React.ReactNode
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  // The accent border is a justified first-run identity moment; trust keeps
  // the fixed attention boundary (warning resolves per family).
  const border = tone === 'trust' ? tokens.warning : tokens.accent
  const width = Math.max(Math.min(columns - 2, 100), 40)
  const inner = width - 4
  const [notesOpen, setNotesOpen] = useState(false)
  // The frame owns its viewport (the CockpitView height-cap idiom): capped
  // one short of the terminal's rows (the renderer's trailing newline costs
  // the last row on the primary screen), identity chrome (border · header ·
  // rail · footer) pinned flexShrink 0, so a body taller than the remainder
  // clips at its own bottom instead of pushing the top border and the
  // identity header off the terminal (they scrolled away on every ≤25-row
  // trust gate). Below 28 rows the breathing gaps go first — content
  // before air.
  const frameCap = Math.max(8, rows - 1)
  const gap = rows >= 28 ? 1 : 0

  const railGlyph = (s: SetupRailStep): React.ReactNode => {
    if (s.state === 'done') return <Text color={tokens.success}>{GLYPH.done}</Text>
    if (s.state === 'current') return <Text color={tokens.success}>◐</Text>
    return <Text color={tokens.textMuted}>○</Text>
  }
  // < 74 usable cols: glyphs only (labels are authored-short but honest).
  const railLabels = inner >= 74 - 4

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={border}
      paddingX={1}
      width={width}
      maxHeight={frameCap}
      overflow="hidden"
    >
      <Box flexShrink={0}>
        <Text>
          <Crab />
          <Text> </Text>
          <Wordmark />
          <Text color={tokens.textMuted}>{` — ${title}`}</Text>
        </Text>
        <Box flexGrow={1} />
        {stepTag && columns >= 60 ? (
          <Text>
            <Text color={tokens.textSecondary}>{stepTag.split(' · ')[0]}</Text>
            <Text color={tokens.textMuted}>{` · ${stepTag.split(' · ')[1] ?? ''}`}</Text>
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          {steps.map((s, i) => (
            <Text key={s.key}>
              {i > 0 ? <Text>{'   '}</Text> : null}
              {railGlyph(s)}
              {railLabels ? (
                <Text
                  bold={s.state === 'current'}
                  color={
                    s.state === 'current'
                      ? tokens.textPrimary
                      : s.state === 'done'
                        ? tokens.textSecondary
                        : tokens.textMuted
                  }
                >
                  {` ${s.label}`}
                </Text>
              ) : null}
            </Text>
          ))}
        </Text>
      </Box>
      {/* Viewport + natural-height inner pair: the outer box yields under
          the frame cap and clips, while the inner box (flexShrink 0) keeps
          the body's natural height — without it the shrink pressure lands
          on individual body rows and crushes arbitrary MIDDLE lines (the
          trust select's own label collapsed) instead of clipping the
          bottom. */}
      <Box flexDirection="column" paddingTop={gap} overflowY="hidden">
        <Box flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {bootNotes.length > 0 ? (
        <Box flexDirection="column" flexShrink={0} paddingTop={gap}>
          <InteractiveDisclosure
            expanded={notesOpen}
            clickable
            onToggle={() => setNotesOpen(o => !o)}
          >
            <Text color={tokens.textMuted}>
              {/* The chevron disclosure pair (› folded / ⌄ open) — the ⌄ expand
                  dialect; ▸ stays reserved for the selection cursor. */}
              {`${notesOpen ? GLYPH.chevronDown : GLYPH.chevronRight} ${bootNotes.length} boot note${bootNotes.length === 1 ? '' : 's'}`}
            </Text>
            {notesOpen ? (
              <Box flexDirection="column">
                {bootNotes.map((n, i) => (
                  <Text key={i} wrap="truncate-end">
                    {n.kind === 'warn' ? (
                      <Text color={tokens.warning}>{`${GLYPH.warn} `}</Text>
                    ) : (
                      <Text color={tokens.textMuted}>{'· '}</Text>
                    )}
                    <Text color={tokens.textSecondary}>{n.text}</Text>
                  </Text>
                ))}
              </Box>
            ) : null}
          </InteractiveDisclosure>
        </Box>
      ) : null}
      <Box flexShrink={0} paddingTop={gap}>
        <Text color={tokens.textMuted} wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>
  )
}

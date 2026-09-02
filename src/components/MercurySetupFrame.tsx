import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Crab, Wordmark } from './mercury-ui/assets.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { InteractiveDisclosure } from './mercury-ui/InteractiveDisclosure.js'
import type { BootNote } from '../substrate/bootNotes.js'


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
  title: string
  stepTag?: string
  steps: SetupRailStep[]
  tone?: 'brand' | 'trust'
  footer: string
  bootNotes?: readonly BootNote[]
  children: React.ReactNode
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const tokens = useMercuryTokens()
  const border = tone === 'trust' ? tokens.warning : tokens.accent
  const width = Math.max(Math.min(columns - 2, 100), 40)
  const inner = width - 4
  const [notesOpen, setNotesOpen] = useState(false)
  const frameCap = Math.max(8, rows - 1)
  const gap = rows >= 28 ? 1 : 0

  const railGlyph = (s: SetupRailStep): React.ReactNode => {
    if (s.state === 'done') return <Text color={tokens.success}>{GLYPH.done}</Text>
    if (s.state === 'current') return <Text color={tokens.success}>◐</Text>
    return <Text color={tokens.textMuted}>○</Text>
  }
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
      {
}
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
              {
}
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

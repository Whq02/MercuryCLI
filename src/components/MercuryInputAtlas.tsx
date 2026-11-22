import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useClaim } from '../hooks/effects.js'
import { Box, Text, useInput } from '../ink.js'
import {
  atlasMatches,
  buildAtlas,
  explainResolution,
  suggestFreeChords,
  type AtlasRow,
  type LookupReport,
} from '../keybindings/atlas.js'
import {
  useKeybindingContext,
  useRegisterKeybindingContext,
} from '../keybindings/KeybindingContext.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { claimKeyCapture } from '../keybindings/keyCapture.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { parseBindings } from '../keybindings/parser.js'
import { resolveKeyWithChordState, unboundConsumes } from '../keybindings/resolver.js'
import { KEYBINDING_CONTEXTS } from '../keybindings/schema.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from '../keybindings/types.js'
import { writeUserBinding } from '../keybindings/writeBindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { toTildePath } from '../utils/path.js'
import { cockpitBottomSlotReserve, paneWindow, viewportRows } from './mercury-ui/geometry.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { GLYPH, padTo } from '../utils/glyphs.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { atlasViewOf } from './inputAtlas/atlasView.js'
import { notBuilt } from '../pi/holes.js'


const CHORD_WIDTH = 16
const ACTION_WIDTH = 26
const QUERY_WIDTH = 44
const MAX_ROWS = 14
const MIN_ROWS = 4
const HEIGHT_RESERVE = 20

type Mode = 'browse' | 'lookup' | 'rebind'

const ALL_CONTEXTS: KeybindingContextName[] = Array.from(
  new Set<KeybindingContextName>([
    ...KEYBINDING_CONTEXTS,
    ...DEFAULT_BINDINGS.map(b => b.context),
  ]),
).sort()

function stateTone(
  row: AtlasRow,
  t: ReturnType<typeof useMercuryTokens>,
): string {
  if (row.state === 'disabled') return t.warning
  if (row.state === 'unbound') return t.textMuted
  return t.info
}

export function MercuryInputAtlas(arg0: {
  onClose: () => void
}): React.ReactNode {
  return notBuilt('src/components/MercuryInputAtlas.tsx:66')
}

function RowDetail({
  row,
  bindings,
}: {
  row: AtlasRow
  bindings: readonly ParsedBinding[]
}): React.ReactNode {
  const t = useMercuryTokens()
  const lines: { text: string; tone: string }[] = []
  if (row.state === 'bound') {
    lines.push({
      text: `${row.chord} is ${row.origin === 'user' ? 'yours' : "Mercury's default"} in ${row.context}`,
      tone: t.textSecondary,
    })
  } else if (row.state === 'disabled') {
    lines.push({
      text: `${row.chord} is disabled in ${row.context} — a printable key types instead of acting`,
      tone: t.warning,
    })
  } else {
    lines.push({
      text: `no chord reaches this action — ${row.reason ?? 'no default binding'}`,
      tone: t.textMuted,
    })
  }
  for (const shadow of row.shadowed) {
    lines.push({
      text: `shadows ${shadow.action ?? 'an unbind'} (${shadow.origin} · ${shadow.context})`,
      tone: t.textMuted,
    })
  }
  if (row.reserved) {
    lines.push({
      text: `${GLYPH.warn} ${row.reserved.reason}`,
      tone: row.reserved.severity === 'error' ? t.failure : t.warning,
    })
  }
  if (row.delivery?.status === 'aliases-to') {
    lines.push({
      text: row.collidesWith
        ? `${GLYPH.warn} on this terminal these bytes arrive as ${row.collidesWith.chord} — pressing it fires ${row.collidesWith.action ?? 'that chord'}; use the portable chord instead`
        : `${GLYPH.warn} this terminal cannot send this chord distinctly — ${row.delivery.reason}`,
      tone: t.warning,
    })
  }
  if (row.state !== 'bound') {
    const free = suggestFreeChords(bindings, row.context, { limit: 3 })
    if (free.length > 0) {
      lines.push({ text: `free here: ${free.join(' · ')}`, tone: t.textMuted })
    }
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Text key={i} color={line.tone}>{`  ${line.text}`}</Text>
      ))}
    </Box>
  )
}

function LookupView({
  report,
  pending,
  live,
}: {
  report: LookupReport | null
  pending: ParsedKeystroke[] | null
  live: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Box flexDirection="column" marginTop={1}>
      {live && pending !== null ? (
        <Text color={t.accent}>{`  ${GLYPH.inProgress} chord pending — press the next key`}</Text>
      ) : live ? (
        <Text color={t.accent}>{`  ${GLYPH.cursor} listening — press a chord`}</Text>
      ) : null}
      {report ? (
        <>
          <Text>
            <Text color={t.textMuted}>{'  '}</Text>
            <Text color={t.info}>{padTo(report.chord, CHORD_WIDTH)}</Text>
            <Text color={t.textPrimary}>{report.verdict}</Text>
          </Text>
          {report.context ? (
            <Text color={t.textMuted}>{`  owned by the ${report.context} context`}</Text>
          ) : null}
          {report.candidates.length > 1 ? (
            <Text color={t.textMuted}>
              {`  beat ${report.candidates
                .slice(0, -1)
                .map(c => `${c.action ?? 'an unbind'} (${c.context})`)
                .join(', ')}`}
            </Text>
          ) : null}
          {report.reserved ? (
            <Text color={report.reserved.severity === 'error' ? t.failure : t.warning}>
              {`  ${GLYPH.warn} ${report.reserved.reason}`}
            </Text>
          ) : null}
        </>
      ) : null}
    </Box>
  )
}


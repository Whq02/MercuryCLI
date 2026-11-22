import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js';
import * as React from 'react'
import { useMemo, useState } from 'react'
import type { Command } from '../commands.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { Box, Text, useInput } from '../ink.js'
import { PopupListViewport } from './CustomSelect/popup-list.js'
import { ACTION_GRAPH } from '../keybindings/actionGraph.js'
import { actionAffordance } from '../keybindings/atlas.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import type { KeybindingContextName } from '../keybindings/types.js'
import { getCommandName } from '../types/command.js'
import { fuzzySearch } from '../utils/fuzzyMatch.js'
import { getSkillUsageScore } from '../utils/suggestions/skillUsageTracking.js'
import TextInput from './TextInput.js'
import { CommandCenter, EmptyState } from './mercury-ui/components.js'
import { displayWidth, GLYPH, truncateToWidth } from '../utils/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { applyNavMotion, decodeNavKey } from './mercury-ui/navSemantics.js'
import { cockpitBottomSlotReserve, paneWindow, viewportRows } from './mercury-ui/geometry.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { notBuilt } from '../pi/holes.js'

function matchPositions(s: string, q: string): Set<number> {
  const out = new Set<number>()
  if (!q) return out
  const sl = s.toLowerCase()
  const ql = q.toLowerCase()
  let qi = 0
  for (let i = 0; i < sl.length && qi < ql.length; i++) {
    if (sl[i] === ql[qi]) {
      out.add(i)
      qi++
    }
  }
  return qi === ql.length ? out : new Set()
}

export function NameHighlight({
  name,
  query,
  here,
  accent,
  textPrimary,
  textSecondary,
}: {
  name: string
  query: string
  here: boolean
  accent: string
  textPrimary: string
  textSecondary: string
}): React.ReactNode {
  const nm = truncateToWidth(name, NAME_WIDTH)
  const hits = matchPositions(nm, query.trim())
  const base = here ? textPrimary : textSecondary
  const hi = here ? accent : textPrimary
  const pad = ' '.repeat(Math.max(0, NAME_WIDTH - displayWidth(nm)))
  return (
    <Text>
      {[...nm].map((ch, k) => (
        <Text key={k} color={hits.has(k) ? hi : base} bold={hits.has(k)}>
          {ch}
        </Text>
      ))}
      {pad}
    </Text>
  )
}


type PaletteItem = { name: string; desc: string; recent: boolean; score: number; run?: () => void; kind?: ActionKind; keychord?: string; unavailable?: string }
type ActionKind = 'open' | 'insert' | 'toggle' | 'switch'
type PaletteAction = {
  label: string
  detail?: string
  run: () => void
  kind?: ActionKind
  action?: string
  context?: KeybindingContextName
}

const NAME_WIDTH = 22
const QUERY_WIDTH = 56
const QUERY_MAX_LENGTH = 200
const MAX_ROWS = 12
const GRAPH_ROWS = 5
const HEIGHT_RESERVE = 26
const MIN_ROWS = 4

export function MercuryCommandPalette(arg0: {
  commands: Command[]
  actions?: PaletteAction[]
  onRun: (insertText: string) => void
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  return notBuilt('src/components/MercuryCommandPalette.tsx:92')
}

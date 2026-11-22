import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { AtlasRow, LookupReport } from '../../keybindings/atlas.js'
import type { useKeybindingContext } from '../../keybindings/KeybindingContext.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from '../../keybindings/types.js'
import TextInput from '../TextInput.js'
import { CommandCenter, EmptyState } from '../mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from '../../utils/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import type { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { notBuilt } from '../../pi/holes.js'

type Tokens = ReturnType<typeof useMercuryTokens>

export function atlasViewOf(arg0: {
  t: Tokens
  kb: ReturnType<typeof useKeybindingContext>
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  cursorOffset: number
  setCursorOffset: React.Dispatch<React.SetStateAction<number>>
  sel: number
  setSel: React.Dispatch<React.SetStateAction<number>>
  mode: 'browse' | 'lookup' | 'rebind'
  report: LookupReport | null
  pending: ParsedKeystroke[] | null
  notice: string | null
  inspected: KeybindingContextName
  filtered: AtlasRow[]
  winStart: number
  shown: AtlasRow[]
  current: AtlasRow | undefined
  liveContexts: KeybindingContextName[]
  footer: string
  onClose: () => void
  stateTone: (row: AtlasRow, t: Tokens) => string
  LookupView: (props: { report: LookupReport | null; pending: ParsedKeystroke[] | null; live: boolean }) => React.ReactNode
  RowDetail: (props: { row: AtlasRow; bindings: readonly ParsedBinding[] }) => React.ReactNode
  CHORD_WIDTH: number
  ACTION_WIDTH: number
  QUERY_WIDTH: number
}): React.ReactNode {
  return notBuilt('src/components/inputAtlas/atlasView.tsx:14')
}

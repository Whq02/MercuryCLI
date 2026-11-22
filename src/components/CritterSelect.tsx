import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { claimHover, releaseHover, useHoverOwner } from './mercury-ui/useHoverOwned.js'
import { SQUARE_DOCK_ART_LINES, critterDefForKey } from '../utils/cockpit/critterData.js'
import { DUNE, FAINT, TEAL } from './mercuryPalette.js'
import { CommandCenter, SectionHeader } from './mercury-ui/components.js'
import { AnimatedCritterArt } from './mercury-ui/AnimatedCritterArt.js'
import { GLYPH } from '../utils/glyphs.js'
import {
  ALL_CRITTERS,
  getSessionAccent,
  setSessionCritter,
  persistSessionCritter,
} from './mercury-ui/sessionAccent.js'
import { useInteractiveList } from './mercury-ui/useInteractiveList.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { notBuilt } from '../pi/holes.js'

function CritterCard({ on, ...box }: { on: boolean } & React.ComponentProps<typeof Box>): React.ReactNode {
  const cursorRef = useDeclaredCursor({ line: 0, column: 0, active: on })
  return <Box ref={cursorRef} {...box} />
}


export function CritterSelect(arg0: { onClose: () => void }): React.ReactNode {
  return notBuilt('src/components/CritterSelect.tsx:25')
}

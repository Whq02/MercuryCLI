import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad, useMount } from '../../hooks/effects.js'
import { basename } from 'node:path'
import { Text, useInput } from '../../ink.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { rosterSummary, trustStateOf } from '../../extensions/roster.js'
import {
  listSources,
  type SourceRow,
} from '../../extensions/sources.js'
import type { Health, RosterEntry } from '../../extensions/types.js'
import { getCwd } from '../../utils/cwd.js'
import {
  NavigablePanes,
  type SectionDef,
} from '../mercury-ui/NavigablePanes.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { ApprovalCardView } from './ApprovalCardView.js'
import { charWord, resolveExtensionsBindings } from './bindings.js'
import { ExtensionView } from './ExtensionView.js'
import { SourceView } from './SourceView.js'
import {
  installedRollup,
  noteWords,
  sourcesRollup,
} from './rowWords.js'
import { boardActions, installCardActions, rowSourceActions } from './board/actions.js'
import { boardColumns } from './board/columns.js'
import { boardRowActions } from './board/rowActions.js'
import { ExtensionSidePane, SourceSidePane } from './board/SidePanes.js'
import { slotParts } from './board/slot.js'
import { rowKeyOf, type BoardRow, type BoardSeed, type Slot, type View } from './board/shapes.js'
import { notBuilt } from '../../pi/holes.js'

export type { CardSpec } from './board/shapes.js'


export type ExtensionsRoute =
  | { kind: 'board'; section: 'installed' | 'sources' }
  | { kind: 'open'; name: string }
  | { kind: 'add'; raw: string }
  | { kind: 'install'; target: string }

export function ExtensionsBoard(arg0: {
  onClose: () => void
  route: ExtensionsRoute
  appendTranscript: (line: string) => void
}): React.ReactNode {
  return notBuilt('src/components/extensions/ExtensionsBoard.tsx:46')
}

import * as React from 'react'
import { useMemo, useState } from 'react'
import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { Box, NoSelect, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useLoad } from '../../../hooks/effects.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import {
  boundHunks,
  boundLines,
  consentBodyBudget,
  consentContentWidth,
  diffPaintWidth,
  filePaintWidth,
} from '../consentBodyBudget.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import { intersperse } from '../../../utils/array.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { parseCellId } from '../../../utils/notebook.js'
import { safeParseJSON } from '../../../utils/json.js'
import type { StructuredPatchHunk } from 'diff'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type NotebookCell = {
  id?: string
  cell_type?: string
  source?: string | string[]
}

type Props = Unbuilt

const FRAME_COLUMNS = 4

function cellSourceText(cell: NotebookCell | undefined): string {
  if (!cell || cell.source === undefined) return ''
  return typeof cell.source === 'string' ? cell.source : cell.source.join('')
}

export function NotebookEditToolDiff(arg0: Props): React.ReactNode {
  return notBuilt('src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx:48')
}

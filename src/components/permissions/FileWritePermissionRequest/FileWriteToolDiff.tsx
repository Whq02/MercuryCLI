import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { Box, NoSelect, Text } from '../../../ink.js'
import { intersperse } from '../../../utils/array.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import {
  boundHunks,
  boundLines,
  consentBodyBudget,
  consentContentWidth,
  diffPaintWidth,
  filePaintWidth,
} from '../consentBodyBudget.js'
import type { StructuredPatchHunk } from 'diff'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'
type Props = Unbuilt

const FRAME_COLUMNS = 2

export function FileWriteToolDiff(arg0: Props): React.ReactNode {
  return notBuilt('src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx:28')
}

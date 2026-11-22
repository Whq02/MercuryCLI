import { mkdirSync } from 'fs'
import * as React from 'react'
import { use, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getInstructionFiles } from '../../services/instructions/engine.js'
import { attachedRows, getInstructionListing, listingRowWords, loadedStateOf, toolPrefixOf } from '../../services/instructions/listing.js'
import type { AttachedInstruction } from '../../services/instructions/attachedText.js'
import type { InstructionSourceEntry } from '../../utils/instructions/contracts.js'
import { openPath } from '../../utils/browser.js'
import { getMemoryPath } from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { toTildePath } from '../../utils/path.js'
import { getMnemeHome, isMnemeEnabled } from '../../mneme/paths.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { getRelativeMemoryPath } from './MemoryUpdateNotification.js'
import { memoryFileListLayout } from './memoryCentreLayout.js'
import { notBuilt } from '../../pi/holes.js'

export function openMemoryFolder(
  dir: string,
  ops: { mkdirSync: typeof mkdirSync; openPath: typeof openPath } = { mkdirSync, openPath },
  onOpenError?: (message: string) => void,
): string | null {
  try {
    ops.mkdirSync(dir, { recursive: true })
  } catch (error) {
    logError(error)
    return `Could not open the memory folder at ${toTildePath(dir)} (${errorMessage(error)}) — check folder permissions.`
  }
  let reported = false
  void ops
    .openPath(dir, error => {
      reported = true
      onOpenError?.(`${toTildePath(dir)} could not be opened (${error}) — open it yourself`)
    })
    .then(ok => {
      if (!ok && !reported) {
        onOpenError?.(`${toTildePath(dir)} could not be opened (could not start file manager) — open it yourself`)
      }
    })
  return null
}
let lastSelectedPath: string | null = null

type Row = {
  label: string
  value: string
  description?: string
}

function importDepthOf(
  entry: InstructionSourceEntry,
  byPath: Map<string, InstructionSourceEntry>,
): number {
  let depth = 0
  let current: InstructionSourceEntry | undefined = entry
  while (current?.parent) {
    depth += 1
    current = byPath.get(current.parent)
    if (depth > 10) break
  }
  return depth
}

export function MemoryFileSelector(arg0: {
  onSelect: (path: string) => void
  onCancel: () => void
  held: (path: string) => boolean
  attached?: readonly AttachedInstruction[]
  width?: number
  rowBudget?: number
}): React.ReactNode {
  return notBuilt('src/components/memory/MemoryFileSelector.tsx:70')
}

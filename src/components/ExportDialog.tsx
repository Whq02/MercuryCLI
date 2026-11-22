import React, { useState } from 'react'
import { join } from 'path'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import TextInput from './TextInput.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { setClipboardWithReceipt } from '../ink/termio/osc.js'
import { getFocusedWorkspaceCwd, useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { writeFileSync } from 'node:fs'
import { notBuilt } from '../pi/holes.js'


type ExportResult = { success: boolean; message: string }

function normalizeTxtFilename(filename: string): string {
  if (filename.endsWith('.txt')) return filename
  if (/\.[^./\\]+$/.test(filename)) {
    return filename.replace(/\.[^./\\]+$/, '.txt')
  }
  return `${filename}.txt`
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

export function ExportDialog(arg0: {
  content: string
  defaultFilename: string
  onDone: (result: ExportResult) => void
}): React.ReactNode {
  return notBuilt('src/components/ExportDialog.tsx:29')
}

export default ExportDialog


import * as React from 'react'
import { useState } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { FileEditToolDiff } from '../FileEditToolDiff.js'
import { consentDiffBudget } from './boundedDiffPreview.js'

type Edit = { old_string?: string; new_string?: string; replace_all?: boolean }

export function ConsentFileEditDiff({
  file_path,
  edits,
}: {
  file_path: string
  edits: Edit[]
}): React.ReactNode {
  const { rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  return (
    <FileEditToolDiff
      file_path={file_path}
      edits={edits}
      consentRowBudget={expanded ? null : consentDiffBudget(rows)}
    />
  )
}

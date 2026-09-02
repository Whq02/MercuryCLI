// The Edit/sed consent cards' bounded diff preview — the FileEditToolDiff
// wrapped in the bounded-preview law (boundedDiffPreview.ts): the preview
// spends viewport-derived rows with an honest "+N more" tail, and
// confirm:toggleFullPreview (ctrl+f) expands to the whole diff on the
// operator's explicit ask — the Write/create card's exact contract, ported.
// The transcript surfaces (the rejected-edit row) keep rendering the bare
// FileEditToolDiff unbounded: a durable row may be tall, a card must fit
// the pane.

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
  // A Confirmation-context chord that Global does NOT bind — per-hook
  // resolution, the Write card's precedent.
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

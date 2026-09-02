import * as React from 'react'
import { exitChordNoticeText } from '../../PromptInput/ExitChordNotice.js'
import { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import TextInput from '../../TextInput.js'
import { Byline } from '../../design-system/Byline.js'
import { ConfigurableShortcutHint } from '../../ConfigurableShortcutHint.js'
import { Dialog } from '../../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js'
import { PromptInputFooterSuggestions } from '../../PromptInput/PromptInputFooterSuggestions.js'
import { Select } from '../../CustomSelect/select.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../../commands/add-dir/validation.js'
import { getDirectoryCompletions } from '../../../utils/suggestions/directoryCompletion.js'
import type { ToolPermissionContext } from '../../../Tool.js'

type PathSuggestion = Awaited<ReturnType<typeof getDirectoryCompletions>>[number]

/**
 * Directory-path entry with debounced completion — or, for a known path, the
 * remember/session choice. The Dialog's own cancel affordance is disabled:
 * escape is handled by the registered `confirm:no` action in the `Settings`
 * context. Also reachable directly from `/add-dir`.
 */
export function AddWorkspaceDirectory({
  onAddDirectory,
  onCancel,
  permissionContext,
  directoryPath,
}: {
  onAddDirectory: (path: string, remember?: boolean) => void
  onCancel: () => void
  permissionContext: ToolPermissionContext
  directoryPath?: string
}): React.ReactNode {
  const [value, setValue] = useState('')
  const [completions, setCompletions] = useState<PathSuggestion[]>([])
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // A REAL caret — the field pinned cursorOffset to
  // value.length with a no-op setter, so ←/→ were inert and any edit
  // landed at the end; and the fixed 80-column wrap ignored the terminal,
  // so a wrapped path broke the completion navigation's geometry.
  const [cursorOffset, setCursorOffset] = useState(0)
  const { columns: termCols } = useTerminalSize()
  const fieldColumns = Math.max(20, Math.min(80, termCols - 6))
  const pendingExit = useExitOnCtrlCDWithKeybindings()
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useKeybinding('confirm:no', () => onCancel(), { context: 'Settings' })

  // Debounced (100 ms) directory completions; an empty value clears the list.
  useEffect(() => {
    if (directoryPath !== undefined) return
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    if (value === '') {
      setCompletions([])
      setHighlightIndex(0)
      return
    }
    debounceTimer.current = setTimeout(() => {
      void getDirectoryCompletions(value)
        .then(items => {
          setCompletions(items)
          setHighlightIndex(0)
        })
        .catch(() => setCompletions([]))
    }, 100)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [value, directoryPath])

  async function submitPath(path: string): Promise<void> {
    const result = await validateDirectoryForWorkspace(path, permissionContext)
    if (result.resultType === 'success') {
      // Text-field submission adds NON-remembered, with the validator's
      // absolute path.
      onAddDirectory(result.absolutePath, false)
    } else {
      setErrorMessage(addDirHelpMessage(result))
    }
  }

  // Completion keys, routed through the text input's own callbacks (this
  // file carries no raw-input site): up/ctrl+p and down/ctrl+n arrive as the
  // history callbacks and wrap; Enter arrives as submit and prefers the
  // highlighted completion; Tab arrives as an inserted tab character that is
  // stripped and applied. All are inert when there are no completions.
  const highlightedCompletion = (): string => {
    const base = completions[highlightIndex]?.id ?? ''
    if (base === '') return ''
    return base.endsWith('/') ? base : `${base}/`
  }
  const moveHighlightUp = (): void => {
    if (directoryPath !== undefined || completions.length === 0) return
    setHighlightIndex(current => (current - 1 + completions.length) % completions.length)
  }
  const moveHighlightDown = (): void => {
    if (directoryPath !== undefined || completions.length === 0) return
    setHighlightIndex(current => (current + 1) % completions.length)
  }
  const handleValueChange = (next: string): void => {
    if (completions.length > 0 && next.endsWith('\t')) {
      const completed = highlightedCompletion()
      setValue(completed)
      // A programmatic value swap parks the caret at the new end (typing
      // keeps its own caret through onChangeCursorOffset).
      setCursorOffset(completed.length)
      setErrorMessage(null)
      return
    }
    setValue(next)
    setErrorMessage(null)
  }

  const explanation = (
    <Text>
      Mercury will be able to read files in this directory, and edit them when implement
      mode is on.
    </Text>
  )

  if (directoryPath !== undefined) {
    return (
      <Dialog title="Add working directory" color="permission" onCancel={onCancel} isCancelActive={false}>
        <Box flexDirection="column">
          <Text color="permission">{directoryPath}</Text>
          {explanation}
          <Select
            options={[
              { label: 'Yes, for this session', value: 'session' },
              { label: 'Yes, and remember this directory', value: 'remember' },
              { label: 'No', value: 'no' },
            ]}
            onChange={choice => {
              if (choice === 'session') onAddDirectory(directoryPath, false)
              else if (choice === 'remember') onAddDirectory(directoryPath, true)
              else onCancel()
            }}
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog title="Add working directory" color="permission" onCancel={onCancel} isCancelActive={false}>
      <Box flexDirection="column">
        {explanation}
        <Text>Directory path:</Text>
        <TextInput
          value={value}
          onChange={handleValueChange}
          onSubmit={submitted => {
            // Enter with completions showing submits the HIGHLIGHTED
            // completion (with its trailing slash), not the raw text.
            void submitPath(completions.length > 0 ? highlightedCompletion() : submitted)
          }}
          onHistoryUp={moveHighlightUp}
          onHistoryDown={moveHighlightDown}
          columns={fieldColumns}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          showCursor
        />
        {completions.length > 0 ? (
          <Box marginBottom={1}>
            <PromptInputFooterSuggestions suggestions={completions} selectedSuggestion={highlightIndex} />
          </Box>
        ) : null}
        {errorMessage !== null ? <Text color="error">{errorMessage}</Text> : null}
        {pendingExit.pending ? (
          <Text color="subtle">{exitChordNoticeText(pendingExit.keyName)}</Text>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Tab" action="complete" />
            <KeyboardShortcutHint shortcut="Enter" action="add" />
            <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
          </Byline>
        )}
      </Box>
    </Dialog>
  )
}

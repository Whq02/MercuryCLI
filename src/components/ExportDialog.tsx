// Conversation export: clipboard (echoing any raw clipboard escape
// the writer returns) or a file in the SESSION'S working directory. The
// filename is normalised to end in .txt; the surface shows the measured line
// count and byte size, and the exact resolved path kept in sync with the field.
// Cancelling completes with an unsuccessful cancelled result — never
// silence. Escape in the filename sub-screen goes back to the method list.

import React, { useState } from 'react'
import { join } from 'path'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import TextInput from './TextInput.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { setClipboardWithReceipt } from '../ink/termio/osc.js'
import { getFocusedWorkspaceCwd, useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { writeFileSync_DEPRECATED } from '../utils/slowOperations.js'

// The export homes by the SESSION's workspace door, never the screen
// process's cwd (Law 9, census A3): a hopped session's transcript lands in
// ITS repo even though the screen still sits in the boot folder; the blank
// chat's door names where the first message grounds the session — one
// source, no carrier fork. The door's feed (hooks/useFocusedWorkspaceCwd)
// hears BOTH beats — the ground beat and the focused-slot signal — so the
// shown path follows an in-place re-ground and a hop alike; the ground beat
// alone fires BEFORE the blank chat re-grounds and never on a hop.

export type ExportResult = { success: boolean; message: string }

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

export function ExportDialog({
  content,
  defaultFilename,
  onDone,
}: {
  content: string
  defaultFilename: string
  onDone: (result: ExportResult) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [screen, setScreen] = useState<'method' | 'filename'>('method')
  const [filename, setFilename] = useState(defaultFilename)
  const [cursorOffset, setCursorOffset] = useState(defaultFilename.length)

  const lineCount = content === '' ? 0 : content.split('\n').length
  const byteSize = Buffer.byteLength(content, 'utf8')
  const sessionCwd = useFocusedWorkspaceCwd()
  const resolvedPath = join(sessionCwd, normalizeTxtFilename(filename))

  const copyToClipboard = async (): Promise<void> => {
    try {
      // C1 clipboard honesty: the receipt's own sentence, never a hardcoded
      // success — an OSC-52-only copy is an offer the terminal may decline.
      const receipt = await setClipboardWithReceipt(content)
      if (receipt.sequence) process.stdout.write(receipt.sequence)
      onDone({ success: true, message: `Conversation ${receipt.confirmation}` })
    } catch (error) {
      onDone({
        success: false,
        message: `Failed to export conversation: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      })
    }
  }

  const writeToFile = (): void => {
    // Call-time read of the same door the shown path renders from — the file
    // lands by the session's ground at the moment of writing.
    const target = join(getFocusedWorkspaceCwd(), normalizeTxtFilename(filename))
    try {
      writeFileSync_DEPRECATED(target, content, {
        encoding: 'utf-8',
        flush: true,
      })
      onDone({ success: true, message: `Conversation exported to: ${target}` })
    } catch (error) {
      onDone({
        success: false,
        message: `Failed to export conversation: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      })
    }
  }

  // Escape while the filename field is focused: back to the method list —
  // registered under the Settings context so typing `n` does not cancel.
  useKeybinding('confirm:no', () => setScreen('method'), {
    context: 'Settings',
    isActive: screen === 'filename',
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      gap={1}
    >
      <Text bold>Export conversation</Text>
      <Text dimColor>
        {lineCount} lines · {formatByteSize(byteSize)}
      </Text>
      {screen === 'method' ? (
        <Select
          options={[
            { label: 'Copy to clipboard', value: 'clipboard' },
            { label: 'Save to file', value: 'file' },
          ]}
          onChange={value => {
            if (value === 'clipboard') void copyToClipboard()
            else setScreen('filename')
          }}
          onCancel={() =>
            onDone({ success: false, message: 'Export cancelled' })
          }
        />
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text>Filename: </Text>
            <TextInput
              value={filename}
              onChange={setFilename}
              onSubmit={writeToFile}
              columns={50}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
          <Text dimColor>Will write to: {resolvedPath}</Text>
          <Text dimColor>enter to save · esc back</Text>
        </Box>
      )}
    </Box>
  )
}

export default ExportDialog

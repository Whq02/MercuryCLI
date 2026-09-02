
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

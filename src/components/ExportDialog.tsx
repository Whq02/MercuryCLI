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

type ExportMethod = 'clipboard' | 'file'

const METHOD_OPTIONS: Array<{ label: string; value: ExportMethod }> = [
  { label: 'Copy to clipboard', value: 'clipboard' },
  { label: 'Save to file', value: 'file' },
]

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
  const cwd = useFocusedWorkspaceCwd()
  const [step, setStep] = useState<'method' | 'filename'>('method')
  const [filename, setFilename] = useState(defaultFilename)
  const [cursorOffset, setCursorOffset] = useState(defaultFilename.length)

  useKeybinding(
    'confirm:no',
    () => {
      setStep('method')
    },
    { context: 'Settings', isActive: step === 'filename' },
  )

  const lineCount = content === '' ? 0 : content.split('\n').length
  const byteSize = formatByteSize(Buffer.byteLength(content, 'utf8'))
  const normalizedName = normalizeTxtFilename(filename.trim() || defaultFilename)
  const resolvedPath = join(cwd, normalizedName)

  const handleMethodSelect = (method: ExportMethod): void => {
    if (method === 'file') {
      setStep('filename')
      return
    }
    void setClipboardWithReceipt(content).then(
      receipt => {
        if (receipt.sequence) {
          process.stdout.write(receipt.sequence)
        }
        onDone({
          success: !receipt.noRoad,
          message: `Conversation ${receipt.confirmation}`,
        })
      },
      error => {
        onDone({
          success: false,
          message: `Failed to export conversation: ${error instanceof Error ? error.message : String(error)}`,
        })
      },
    )
  }

  const handleFilenameSubmit = (submitted: string): void => {
    const targetName = normalizeTxtFilename(submitted.trim() || defaultFilename)
    const targetPath = join(getFocusedWorkspaceCwd(), targetName)
    try {
      writeFileSync(targetPath, content, { encoding: 'utf8', flush: true })
      onDone({
        success: true,
        message: `Conversation exported to: ${targetPath}`,
      })
    } catch (error) {
      onDone({
        success: false,
        message: `Failed to export conversation: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={tokens.accent}>
          Export conversation
        </Text>
        <Text color={tokens.textSecondary}>
          {lineCount} lines · {byteSize}
        </Text>
      </Box>
      {step === 'method' ? (
        <Box flexDirection="column" marginTop={1}>
          <Select
            options={METHOD_OPTIONS}
            onChange={handleMethodSelect}
            onCancel={() => onDone({ success: false, message: 'Export cancelled' })}
          />
          <Box marginTop={1}>
            <Text color={tokens.textMuted}>↑↓ move · ↵ choose · esc cancel</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={tokens.textPrimary}>Enter filename:</Text>
          <Box marginTop={1}>
            <TextInput
              value={filename}
              onChange={setFilename}
              onSubmit={handleFilenameSubmit}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={50}
              focus
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Will write to: {resolvedPath}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>enter to save · esc back</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

export default ExportDialog

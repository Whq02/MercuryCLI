import React, { useState } from 'react'
import { join } from 'path'
import { Box, Text } from '../../screen/themedRenderer.js'
import { Select } from '../../screen/select/index.js'
import TextInput from '../../screen/composer/text-input/TextInput.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { setClipboardWithReceipt } from '../../screen/renderer/termio/osc.js'
import { getFocusedWorkspaceCwd, useFocusedWorkspaceCwd } from '../../screen/focused-session/useFocusedWorkspaceCwd.js'
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
  const normalizedName = normalizeTxtFilename(filename)
  const resolvedPath = join(cwd, normalizedName)

  const handleCopyToClipboard = async (): Promise<void> => {
    try {
      const receipt = await setClipboardWithReceipt(content)
      if (receipt.sequence) {
        process.stdout.write(receipt.sequence)
      }
      onDone({
        success: true,
        message: `Conversation ${receipt.confirmation}`,
      })
    } catch (error) {
      onDone({
        success: false,
        message: `Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      })
    }
  }

  const handleMethodSelect = (method: ExportMethod): void => {
    if (method === 'clipboard') {
      void handleCopyToClipboard()
      return
    }
    setStep('filename')
  }

  const handleFilenameSubmit = (): void => {
    const targetPath = join(getFocusedWorkspaceCwd(), normalizedName)
    try {
      writeFileSync(targetPath, content, { encoding: 'utf-8', flush: true })
      onDone({
        success: true,
        message: `Conversation exported to: ${targetPath}`,
      })
    } catch (error) {
      onDone({
        success: false,
        message: `Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      })
    }
  }

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
        {lineCount} lines · {byteSize}
      </Text>
      {step === 'method' ? (
        <Select
          options={METHOD_OPTIONS}
          onChange={handleMethodSelect}
          onCancel={() => onDone({ success: false, message: 'Export cancelled' })}
        />
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text>Filename: </Text>
            <TextInput
              value={filename}
              onChange={setFilename}
              onSubmit={handleFilenameSubmit}
              columns={50}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
          <Text dimColor>Will write to: {resolvedPath}</Text>
          <Text dimColor>enter to save · esc back</Text>
        </Box>
      )}
      {step === 'method' && (
        <Text dimColor>↑↓ move · ↵ select · esc cancel</Text>
      )}
    </Box>
  )
}

export default ExportDialog

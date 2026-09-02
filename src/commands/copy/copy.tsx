import * as React from 'react'
import { useState } from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { marked } from 'marked'
import { Box, Text } from '../../ink.js'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { InteractiveRow } from '../../components/mercury-ui/InteractiveRow.js'
import { useInteractiveList } from '../../components/mercury-ui/useInteractiveList.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { setClipboardWithReceipt } from '../../ink/termio/osc.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config/globalConfig.js'
import { errorMessage } from '../../utils/errors.js'
import { truncateToWidth } from '../../utils/format.js'
import { stripPromptXMLTags } from '../../utils/messages.js'

/** How many assistant responses the picker looks back over. */
const LOOK_BACK_CAP = 20

/** Label width budget for a code-block row (display columns). */
const BLOCK_LABEL_WIDTH = 60

/** The full response's temp-file name (contract data). */
const FULL_RESPONSE_FILENAME = 'response.md'

/**
 * Newest-first texts of assistant messages that actually said something:
 * API-error messages, non-array contents and tool-use-only turns are
 * skipped; text blocks within one message join with a blank line.
 */
export function collectRecentAssistantTexts(messages: Message[]): string[] {
  const texts: string[] = []
  for (let i = messages.length - 1; i >= 0 && texts.length < LOOK_BACK_CAP; i--) {
    const message = messages[i]
    if (message?.type !== 'assistant') continue
    const assistant = message as AssistantMessage
    if (assistant.isApiErrorMessage) continue
    const content = assistant.message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(block => (block as { type?: string }).type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .filter(part => part !== '')
      .join('\n\n')
    if (!text) continue
    texts.push(text)
  }
  return texts
}

/**
 * The extension for a fenced block's declared language. Sanitisation strips
 * every non-alphanumeric character — a fence can declare an arbitrary
 * "language", so this is a path-traversal defence, not cosmetics.
 */
export function fileExtension(lang: string | undefined): string {
  const sanitized = (lang ?? '').replace(/[^a-zA-Z0-9]/g, '')
  if (sanitized === '' || sanitized === 'plaintext') return '.txt'
  return `.${sanitized}`
}

type CodeBlock = { text: string; lang: string | undefined }

function extractCodeBlocks(text: string): CodeBlock[] {
  const tokens = marked.lexer(stripPromptXMLTags(text))
  const blocks: CodeBlock[] = []
  for (const token of tokens) {
    if (token.type === 'code') {
      blocks.push({ text: token.text, lang: token.lang || undefined })
    }
  }
  return blocks
}

function lineCount(text: string): number {
  return text.split('\n').length
}

type CopyOutcome = { clipboardLine: string; filePath?: string }

/**
 * Copy to the terminal clipboard (best-effort; raw bytes the mechanism
 * returns are written to stdout) and also to a file under a Mercury-named
 * temp directory — terminal clipboard support is best-effort, the file is
 * the recourse.
 */
async function copyContent(content: string, filename: string): Promise<CopyOutcome> {
  const receipt = await setClipboardWithReceipt(content)
  if (receipt.sequence) {
    process.stdout.write(receipt.sequence)
  }
  // C1 clipboard honesty: the receipt owner's own sentence — 'copied
  // (route)' over a settled route, the OSC-52 offer wording otherwise —
  // never an unconditional 'Copied'. The counts are this door's annotation.
  const clipboardLine = `${receipt.confirmation.charAt(0).toUpperCase()}${receipt.confirmation.slice(1)} — ${content.length} characters, ${lineCount(content)} lines`
  try {
    const dir = join(tmpdir(), 'mercury')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, filename)
    writeFileSync(filePath, content, 'utf8')
    return { clipboardLine, filePath }
  } catch {
    // The file write fails silently: only the clipboard line is reported.
    return { clipboardLine }
  }
}

function outcomeMessage(outcome: CopyOutcome): string {
  return outcome.filePath
    ? `${outcome.clipboardLine}\nAlso written to ${outcome.filePath}`
    : outcome.clipboardLine
}

type PickerRow =
  | { kind: 'full'; label: string; description: string }
  | { kind: 'block'; index: number; label: string; description: string }
  | { kind: 'persist'; label: string; description: string }

function CopyPicker({
  fullText,
  blocks,
  turnOffset,
  onDone,
}: {
  fullText: string
  blocks: CodeBlock[]
  turnOffset: number
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [closed, setClosed] = useState(false)

  const rows: PickerRow[] = [
    {
      kind: 'full',
      label: 'Whole response',
      description: `${fullText.length} characters · ${lineCount(fullText)} lines`,
    },
    ...blocks.map((block, index): PickerRow => {
      const firstLine = block.text.split('\n', 1)[0] ?? ''
      const parts: string[] = []
      if (block.lang) parts.push(block.lang)
      const lines = lineCount(block.text)
      if (lines > 1) parts.push(`${lines} lines`)
      return {
        kind: 'block',
        index,
        label: truncateToWidth(firstLine, BLOCK_LABEL_WIDTH),
        description: parts.join(' · '),
      }
    }),
    {
      kind: 'persist',
      label: 'Always copy the full response',
      description: 'Skips this picker from now on; revert any time with /config (copyFullResponse)',
    },
  ]

  const contentFor = (row: PickerRow): { content: string; filename: string } =>
    row.kind === 'block'
      ? {
          content: blocks[row.index]!.text,
          filename: `copy${fileExtension(blocks[row.index]!.lang)}`,
        }
      : { content: fullText, filename: FULL_RESPONSE_FILENAME }

  const finish = (message: string, system = false): void => {
    setClosed(true)
    onDone(message, system ? { display: 'system' } : undefined)
  }

  const activateRow = (row: PickerRow): void => {
    void (async () => {
      if (row.kind === 'persist') {
        const config = getGlobalConfig()
        if (!config.copyFullResponse) {
          saveGlobalConfig(current => ({ ...current, copyFullResponse: true }))
        }
        // The persist entry always copies the FULL text, never a block.
        const outcome = await copyContent(fullText, FULL_RESPONSE_FILENAME)
        finish(
          `${outcomeMessage(outcome)}\nPreference saved — change copyFullResponse via /config to bring the picker back.`,
        )
        return
      }
      const { content, filename } = contentFor(row)
      const outcome = await copyContent(content, filename)
      finish(outcomeMessage(outcome))
    })()
  }

  // `w` writes the CURRENTLY FOCUSED entry to a file instead of the
  // clipboard — the focused row, deliberately never a confirmed one.
  const writeRow = (row: PickerRow): void => {
    if (closed) return
    const { content, filename } = contentFor(row)
    try {
      const dir = join(tmpdir(), 'mercury')
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, filename)
      writeFileSync(filePath, content, 'utf8')
      finish(`Written to ${filePath}`)
    } catch (error) {
      finish(`Failed to write file: ${errorMessage(error)}`)
    }
  }

  const list = useInteractiveList<PickerRow>({
    rows,
    rowId: row => (row.kind === 'block' ? `block-${row.index}` : row.kind),
    onClose: () => finish('Copy cancelled.', true),
    actions: [
      {
        key: 'return',
        run: row => {
          if (row) activateRow(row)
          return null
        },
        hint: 'copy',
      },
      {
        key: 'w',
        run: row => {
          if (row) writeRow(row)
          return null
        },
        hint: 'write to file',
      },
    ],
    idNamespace: 'copy',
  })

  const blockCountLabel =
    blocks.length === 0
      ? 'no code blocks'
      : blocks.length === 1
        ? '1 code block'
        : `${blocks.length} code blocks`
  // The picker names which turn it is copying; an older turn renders with a
  // typographic minus (−, never an ASCII hyphen).
  const turnLabel = turnOffset === 0 ? 'latest response' : `response −${turnOffset}`

  return (
    <CommandCenter
      view="copy"
      subtitle={`${turnLabel} · ${blockCountLabel}`}
      footer="enter copy · w write to file · esc cancel"
      captureInput={false}
      onClose={() => finish('Copy cancelled.', true)}
    >
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <InteractiveRow key={list.rowProps(row, i).id} {...list.rowProps(row, i)}>
            <Box flexDirection="row" gap={1}>
              <Text color={i === list.selectedIndex ? tokens.textPrimary : tokens.textMuted}>
                {i + 1}. {row.label}
              </Text>
              {row.description ? <Text color={tokens.textMuted}>{row.description}</Text> : null}
            </Box>
          </InteractiveRow>
        ))}
      </Box>
    </CommandCenter>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const texts = collectRecentAssistantTexts(context.messages)

  const trimmed = args.trim()
  let offset = 0
  if (trimmed) {
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 1) {
      onDone(`Usage: /copy [N] — N is a whole number, 1 for the latest response. Received: ${trimmed}`)
      return null
    }
    if (parsed > texts.length) {
      onDone(
        texts.length === 1
          ? 'Only 1 assistant message is available to copy.'
          : `Only ${texts.length} assistant messages are available to copy.`,
      )
      return null
    }
    offset = parsed - 1
  }

  if (texts.length === 0) {
    onDone('No assistant message to copy.')
    return null
  }

  const fullText = texts[offset]!
  const blocks = extractCodeBlocks(fullText)

  // Fast path: nothing to pick between, or the user opted out of the picker.
  if (blocks.length === 0 || getGlobalConfig().copyFullResponse) {
    const outcome = await copyContent(fullText, FULL_RESPONSE_FILENAME)
    onDone(outcomeMessage(outcome))
    return null
  }

  return <CopyPicker fullText={fullText} blocks={blocks} turnOffset={offset} onDone={onDone} />
}

import * as React from 'react'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ExportDialog } from '../../components/ExportDialog.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { Message, UserMessage } from '../../types/message.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { errorMessage } from '../../utils/errors.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'

/** First line of the conversation's first user prompt, capped for a filename. */
export function extractFirstPrompt(messages: Message[]): string {
  const first = messages.find(message => message.type === 'user') as UserMessage | undefined
  if (!first) return ''
  const content = first.message.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const block = content.find(b => (b as { type?: string }).type === 'text') as
      | { text?: string }
      | undefined
    text = block?.text ?? ''
  }
  const firstLine = text.trim().split('\n', 1)[0] ?? ''
  return firstLine.length > 50 ? `${firstLine.slice(0, 49)}…` : firstLine
}

/** Lower-cased slug: only letters/digits/whitespace/hyphens survive, runs collapse. */
export function sanitizeFilename(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function localTimestamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function defaultFilename(messages: Message[]): string {
  const timestamp = localTimestamp()
  const slug = sanitizeFilename(extractFirstPrompt(messages))
  return slug ? `${timestamp}-${slug}.txt` : `conversation-${timestamp}.txt`
}

/** A name already ending `.txt` is kept; otherwise any trailing extension is replaced. */
function forceTxtExtension(name: string): string {
  if (name.endsWith('.txt')) return name
  const replaced = name.replace(/\.[^./\\]+$/, '')
  return `${replaced}.txt`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const content = await renderMessagesToPlainText(context.messages, context.options.tools ?? [])

  const trimmed = args.trim()
  if (trimmed) {
    try {
      // The args path homes like the dialog: by the SESSION's workspace door
      // (Law 9, census A3) — never the screen process's cwd.
      const path = resolve(
        getFocusedSessionConnector().workspace().cwd,
        forceTxtExtension(trimmed),
      )
      writeFileSync(path, content, { encoding: 'utf8', flush: true })
      onDone(`Conversation exported to: ${path}`)
    } catch (error) {
      onDone(
        `Failed to export the conversation: ${error instanceof Error ? errorMessage(error) : 'unknown error'}`,
      )
    }
    return null
  }

  return (
    <ExportDialog
      content={content}
      defaultFilename={defaultFilename(context.messages)}
      onDone={result => onDone(result.message)}
    />
  )
}

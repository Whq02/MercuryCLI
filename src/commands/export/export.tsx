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
import { transcriptExport, transcriptExportText, truncateExportResults } from './transcript.js'
import { createSecretRedactor, redactSecretValues, sessionSecretValues } from '../../utils/redactSecrets.js'

export function extractFirstPrompt(messages: Message[], transform: (text: string) => string = text => text): string {
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
  const firstLine = transform(text).trim().split('\n', 1)[0] ?? ''
  return firstLine.length > 50 ? `${firstLine.slice(0, 49)}…` : firstLine
}

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

function defaultFilename(messages: Message[], redact: (text: string) => string): string {
  const timestamp = localTimestamp()
  const slug = sanitizeFilename(extractFirstPrompt(messages, redact))
  return slug ? `${timestamp}-${slug}.txt` : `conversation-${timestamp}.txt`
}

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
  const trimmed = args.trim()
  const json = /\.json$/i.test(trimmed)
  const connector = getFocusedSessionConnector()
  const transcript = transcriptExport(context.messages, {
    id: connector.sessionId(),
    cwd: connector.workspace().cwd,
  })
  let secrets: string[]
  try {
    secrets = await sessionSecretValues()
  } catch {
    onDone('The credential store could not be read; nothing was exported.')
    return null
  }
  const redact = createSecretRedactor(secrets)
  const document = truncateExportResults(redactSecretValues(transcript, redact))
  const content = json ? JSON.stringify(document, null, 2) + '\n' : transcriptExportText(document)
  if (trimmed) {
    try {
      const path = resolve(
        connector.workspace().cwd,
        json ? trimmed : forceTxtExtension(trimmed),
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
      defaultFilename={defaultFilename(context.messages, redact)}
      onDone={result => onDone(result.message)}
    />
  )
}

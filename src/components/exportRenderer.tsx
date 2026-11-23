import * as React from 'react'
import stripAnsi from 'strip-ansi'

import { Messages } from './Messages.tsx'
import { KeybindingProvider, type HandlerRegistry } from '../keybindings/KeybindingContext.tsx'
import type { KeybindingContextName, ParsedKeystroke } from '../keybindings/types.js'
import { loadKeybindingsSync } from '../keybindings/loadUserBindings.js'
import { AppStateProvider } from '../state/AppState.tsx'
import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import { renderToAnsiString } from '../utils/staticRender.tsx'

const DEFAULT_CHUNK_SIZE = 40
const SYNC_MARKER_RE = /\x1b\[\?2026[hl]/g

type ExportOptions = {
  columns?: number
  verbose?: boolean
  chunkSize?: number
}

function MinimalKeybindingProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const handlerRegistryRef = React.useRef<HandlerRegistry>(new Map())
  return (
    <KeybindingProvider
      bindings={loadKeybindingsSync()}
      pendingChordRef={pendingChordRef}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={new Set<KeybindingContextName>()}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  )
}

function normalizedUpperBound(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    const content = (message as { message?: { content?: unknown } }).message?.content
    total += Array.isArray(content) ? Math.max(1, content.length) : 1
  }
  return total
}

async function renderChunk(
  messages: Message[],
  tools: Tools,
  verbose: boolean,
  range: readonly [number, number],
  columns?: number,
): Promise<string> {
  return renderToAnsiString(
    <AppStateProvider>
      <MinimalKeybindingProvider>
        <Messages
          messages={messages}
          tools={tools}
          verbose={verbose}
          toolJSX={null}
          toolUseConfirmQueue={[]}
          inProgressToolUseIDs={new Set()}
          isMessageSelectorVisible={false}
          conversationId="export"
          screen="transcript"
          streamingToolUses={[]}
          isLoading={false}
          showAllInTranscript
          suppressLogo
          disableRenderCap
          renderRange={range}
        />
      </MinimalKeybindingProvider>
    </AppStateProvider>,
    columns,
  )
}

export async function streamRenderedMessages(
  messages: Message[],
  tools: Tools,
  sink: (chunk: string) => Promise<void> | void,
  options?: ExportOptions,
): Promise<void> {
  const chunkSize = Math.max(1, options?.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const verbose = options?.verbose ?? true
  const columns = options?.columns
  const total = normalizedUpperBound(messages)
  if (total === 0) return

  let wroteAny = false
  let prevEndedWithNewline: boolean = true
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total, start + chunkSize)
    const raw = await renderChunk(messages, tools, verbose, [start, end], columns)
    const cleaned = raw.replace(SYNC_MARKER_RE, '')
    if (stripAnsi(cleaned).trim() === '') {
      if (wroteAny) break
      continue
    }
    const piece: string = wroteAny && !prevEndedWithNewline ? `\n${cleaned}` : cleaned
    await sink(piece)
    wroteAny = true
    prevEndedWithNewline = piece.endsWith('\n')
  }
}

export async function renderMessagesToPlainText(
  messages: Message[],
  tools: Tools = [],
  columns?: number,
): Promise<string> {
  const chunks: string[] = []
  await streamRenderedMessages(
    messages,
    tools,
    chunk => {
      chunks.push(stripAnsi(chunk))
    },
    { columns },
  )
  return chunks.join('')
}

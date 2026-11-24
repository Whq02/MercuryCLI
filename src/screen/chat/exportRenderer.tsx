import * as React from 'react'
import stripAnsi from 'strip-ansi'

import { Messages } from '../messages/Messages.tsx'
import { KeybindingProvider, type HandlerRegistry } from '../keys/KeybindingContext.tsx'
import type { KeybindingContextName, ParsedKeystroke } from '../keys/types.js'
import { loadKeybindingsSync } from '../keys/loadUserBindings.js'
import { AppStateProvider } from '../app-state/AppState.tsx'
import type { Tools } from '../../tools/kit/tool.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { renderToAnsiString } from '../renderer/staticRender.tsx'

const DEFAULT_CHUNK_SIZE = 40
const SYNC_MARKER_RE = /\x1b\[\?2026[hl]/g

type ExportOptions = {
  columns?: number
  verbose?: boolean
  chunkSize?: number
  onProgress?: (renderedCount: number) => void
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
          isRewindPickerVisible={false}
          conversationId="export"
          screen="prompt"
          streamingToolUses={[]}
          isLoading={false}
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
  const verbose = options?.verbose ?? false
  const columns = options?.columns
  const upperBound = normalizedUpperBound(messages) + chunkSize

  for (let start = 0; start < upperBound; start += chunkSize) {
    const end = start + chunkSize
    const raw = await renderChunk(messages, tools, verbose, [start, end], columns)
    const cleaned = raw.replace(SYNC_MARKER_RE, '')
    if (stripAnsi(cleaned).trim() === '') break
    await sink(cleaned)
    options?.onProgress?.(end)
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

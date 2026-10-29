import * as React from 'react'
import stripAnsi from 'strip-ansi'

import { Messages } from '../components/Messages.tsx'
import { KeybindingProvider } from '../keybindings/KeybindingContext.tsx'
import { loadKeybindingsSync } from '../keybindings/loadUserBindings.js'
import { AppStateProvider } from '../state/AppState.tsx'
import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import { renderToAnsiString } from './staticRender.tsx'


type ExportOptions = {
  columns?: number
  verbose?: boolean
  chunkSize?: number
  onProgress?: (renderedThrough: number) => void
}

function MinimalKeybindingProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const pendingChordRef = React.useRef(null)
  const handlerRegistryRef = React.useRef(new Map())
  return (
    <KeybindingProvider
      bindings={loadKeybindingsSync()}
      pendingChordRef={pendingChordRef as never}
      pendingChord={null as never}
      setPendingChord={() => {}}
      activeContexts={new Set() as never}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={handlerRegistryRef as never}
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
  columns: number | undefined,
): Promise<string> {
  const tree = (
    <AppStateProvider>
      <MinimalKeybindingProvider>
        <Messages
          messages={messages}
          tools={tools}
          commands={[]}
          verbose={verbose}
          toolJSX={null}
          toolUseConfirmQueue={[]}
          inProgressToolUseIDs={new Set()}
          isMessageSelectorVisible={false}
          conversationId="export"
          screen="prompt"
          streamingToolUses={[]}
          showAllInTranscript={true}
          isLoading={false}
          renderRange={range}
        />
      </MinimalKeybindingProvider>
    </AppStateProvider>
  )
  return renderToAnsiString(tree, columns)
}

export async function streamRenderedMessages(
  messages: Message[],
  tools: Tools,
  sink: (chunk: string) => Promise<void> | void,
  options: ExportOptions = {},
): Promise<void> {
  const { columns, verbose = false, chunkSize = 40, onProgress } = options
  const ceiling = chunkSize + normalizedUpperBound(messages)
  for (let offset = 0; offset < ceiling; offset += chunkSize) {
    const rendered = await renderChunk(messages, tools, verbose, [offset, offset + chunkSize], columns)
    if (stripAnsi(rendered).trim() === '') break
    await sink(rendered)
    onProgress?.(offset + chunkSize)
  }
}

export async function renderMessagesToPlainText(
  messages: Message[],
  tools: Tools = [] as unknown as Tools,
  columns?: number,
): Promise<string> {
  const parts: string[] = []
  await streamRenderedMessages(messages, tools, chunk => {
    parts.push(stripAnsi(chunk))
  }, { columns })
  return parts.join('')
}

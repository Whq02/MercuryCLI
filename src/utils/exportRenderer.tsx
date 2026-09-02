import * as React from 'react'
import stripAnsi from 'strip-ansi'

import { Messages } from '../components/Messages.tsx'
import { KeybindingProvider } from '../keybindings/KeybindingContext.tsx'
import { loadKeybindingsSync } from '../keybindings/loadUserBindings.js'
import { AppStateProvider } from '../state/AppState.tsx'
import type { Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import { renderToAnsiString } from './staticRender.tsx'

/**
 * Render a conversation to ANSI/plain text in bounded chunks for export.
 *
 * Each chunk is a FRESH render restricted to a range: the renderer only
 * ever allocates for the biggest single chunk, so peak memory stops scaling
 * with session length (measured at roughly half the steady-state footprint
 * of one full render on a long session). The range slices AFTER
 * normalisation, grouping and collapsing, so tool-call grouping stays
 * correct across chunk seams, and the message lookups are built over the
 * full normalised array so a tool use and its result resolve even when they
 * land in different chunks.
 */

type ExportOptions = {
  columns?: number
  verbose?: boolean
  chunkSize?: number
  onProgress?: (renderedThrough: number) => void
}

/**
 * A minimal keybinding provider: the loaded bindings and inert context
 * plumbing, deliberately omitting the chord interceptor (it uses the input
 * hook and would hang in a headless render with no stdin).
 */
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

/**
 * An upper bound on the normalised message count: normalisation splits
 * each message into one entry per content block (unbounded per message)
 * and collapsing only shrinks, so the loop ceiling is the chunk size plus
 * this bound. A string content or a message with no body counts as 1.
 */
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

/**
 * Stream the rendered conversation to a sink in chunks, stopping at the
 * first chunk that is empty after ANSI stripping and trimming. The progress
 * value is the chunk's END INDEX (offset plus chunk size), not a count of
 * messages actually rendered.
 */
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

/** Every chunk with ANSI stripped, joined. */
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

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
import { notBuilt, type Unbuilt } from '../pi/holes.js'


type ExportOptions = Unbuilt

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

export async function streamRenderedMessages(
  messages: Message[],
  tools: Tools,
  sink: (chunk: string) => Promise<void> | void,
  options?: ExportOptions,
): Promise<void> {
  return notBuilt('src/components/exportRenderer.tsx:81')
}

export async function renderMessagesToPlainText(
  messages: Message[],
  tools?: Tools,
  columns?: number,
): Promise<string> {
  return notBuilt('src/components/exportRenderer.tsx:97')
}

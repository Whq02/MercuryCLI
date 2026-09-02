// /extensions — the board (spec 05): two sections, installed and sources,
// on the panes chassis. Deep links ride the argument: `sources` opens that
// section, a name opens its extension or source view, `add <url|path>`
// submits the add composer, `install <name>[@label]` selects or fetches,
// and `reload` runs the in-session swap WITHOUT the board, printing the
// one counts line the transcript keeps.
import * as React from 'react'
import { ExtensionsBoard, type ExtensionsRoute } from '../../components/extensions/ExtensionsBoard.js'
import { noteReloaded, reloadExtensions, setExtensionsPending } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { createSystemMessage } from '../../utils/messages/systemMessages.js'

function parseRoute(args: string): ExtensionsRoute | { kind: 'reload' } {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'board', section: 'installed' }
  if (trimmed === 'reload') return { kind: 'reload' }
  if (trimmed === 'sources') return { kind: 'board', section: 'sources' }
  const [word, ...rest] = trimmed.split(/\s+/)
  if (word === 'add' && rest.length > 0) return { kind: 'add', raw: rest.join(' ') }
  if (word === 'install' && rest.length > 0 && rest[0]) return { kind: 'install', target: rest[0] }
  return { kind: 'open', name: trimmed }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const route = parseRoute(args ?? '')
  if (route.kind === 'reload') {
    const pending = reloadExtensions({
      onServersChanged: () =>
        context.setAppState(prev => ({ ...prev, mcp: { ...prev.mcp, extensionReconnectKey: prev.mcp.extensionReconnectKey + 1 } })),
    })
    noteReloaded(pending)
    const result = await pending
    setExtensionsPending(false)
    context.setAppState(prev => ({ ...prev, extensions: extensionsStateFrom(result.set, false, result.line) }))
    onDone(result.line, { display: 'system' })
    return null
  }
  return (
    <ExtensionsBoard
      route={route}
      onClose={() => onDone(undefined, { display: 'skip' })}
      appendTranscript={line => context.setMessages(prev => [...prev, createSystemMessage(line, 'info')])}
    />
  )
}

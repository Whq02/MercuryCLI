import { ExtensionsBoard, type ExtensionsRoute } from '../../components/extensions/ExtensionsBoard.js'
import { noteReloaded, reloadExtensions, setExtensionsPending } from '../../extensions/boot.js'
import { extensionsStateFrom } from '../../hooks/useExtensions.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { createSystemMessage } from '../../utils/messages/systemMessages.js'
import { notBuilt } from '../../pi/holes.js'

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

export const call: LocalJSXCommandCall = async (onDone, context, args) => notBuilt('src/commands/extensions/extensions.tsx:18')

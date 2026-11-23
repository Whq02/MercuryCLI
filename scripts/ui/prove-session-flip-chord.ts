#!/usr/bin/env bun
import { join } from 'node:path'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the registry carries no flip action and no default chord for it')
const { ACTION_GRAPH } = await import('../../src/screen/keys/actionGraph.js')
const graph = ACTION_GRAPH as Record<string, { contexts: string[] }>
check('no chat:flipSession* action stands in the graph', !Object.keys(graph).some(name => name.startsWith('chat:flipSession')), Object.keys(graph).filter(name => name.startsWith('chat:flipSession')).join(', '))
const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
const blocks = DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]
const chat = Object.assign({}, ...blocks.filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('the Chat defaults bind neither meta+left nor meta+right', chat['meta+left'] === undefined && chat['meta+right'] === undefined, `${chat['meta+left'] ?? ''} ${chat['meta+right'] ?? ''}`)


console.log(failures === 0 ? '\nsession flip chord: GREEN' : `\nsession flip chord: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)

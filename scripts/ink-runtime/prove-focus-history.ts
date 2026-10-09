#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { FocusManager } = await import(join(SRC, 'ink/focus.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Node = { nodeName: string; parentNode?: Node; childNodes: Node[]; attributes: Record<string, unknown> }
const root: Node = { nodeName: 'ink-root', childNodes: [], attributes: {} }
const element = (name: string): Node => {
  const node: Node = { nodeName: name, parentNode: root, childNodes: [], attributes: { tabIndex: 0 } }
  root.childNodes.push(node)
  return node
}
const events: string[] = []
const manager = new FocusManager((target: Node, event: { type: string; relatedTarget: Node | null }) => {
  events.push(`${event.type}:${target.nodeName}<-${event.relatedTarget?.nodeName ?? 'none'}`)
})
const a = element('a')
const b = element('b')
const c = element('c')

manager.focus(a)
check('the first focus fires one focus event naming no previous node', events.join(' ') === 'focus:a<-none' && manager.activeElement === a, events.join(' '))
events.length = 0
manager.focus(a)
check('focusing the active node is a no-op', events.length === 0)
manager.focus(b)
check('moving focus blurs the previous node naming the new one, then focuses the new one naming the previous, in that order', events.join(' ') === 'blur:a<-b focus:b<-a', events.join(' '))
events.length = 0
manager.disable()
manager.focus(c)
check('a disabled manager moves nothing', events.length === 0 && manager.activeElement === b)
manager.enable()

manager.focus(c)
manager.focus(a)
manager.focus(b)
events.length = 0
root.childNodes.splice(root.childNodes.indexOf(b), 1)
b.parentNode = undefined
manager.handleNodeRemoved(b, root)
check('removing the active node restores the most recently focused node still mounted', manager.activeElement === a && events.join(' ') === 'blur:b<-none focus:a<-b', events.join(' '))

events.length = 0
root.childNodes.splice(root.childNodes.indexOf(a), 1)
a.parentNode = undefined
manager.handleNodeRemoved(a, root)
check('a node focused twice sits once in the history: the next restore goes to c, not back to a', manager.activeElement === c, manager.activeElement?.nodeName ?? 'none')

const crowd = Array.from({ length: 40 }, (_, i) => element(`n${i}`))
for (const node of crowd) manager.focus(node)
for (const node of [...crowd].reverse()) {
  root.childNodes.splice(root.childNodes.indexOf(node), 1)
  node.parentNode = undefined
  manager.handleNodeRemoved(node, root)
}
check('the history is bounded at 32: after forty focuses the node focused before them has fallen off, so unwinding them all ends with no focus instead of returning to it', manager.activeElement === null && c.parentNode === root, manager.activeElement?.nodeName ?? 'none')

console.log(failures ? `FAIL focus history: ${failures} failures` : 'PASS focus history')
process.exit(failures ? 1 : 0)

#!/usr/bin/env bun
import { getMaxListeners } from 'node:events'
import { createAbortController, createChildAbortController } from '../../src/platform/async/abortController.ts'

const WHERE = 'src/platform/async/abortController.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

section('§1 createAbortController')
{
  const controller = createAbortController()
  check('it is an AbortController that has not aborted', controller instanceof AbortController && controller.signal.aborted === false)
  check('its signal takes fifty listeners before the runtime warns', getMaxListeners(controller.signal) === 50, `${getMaxListeners(controller.signal)}; see createAbortController in ${WHERE}`)
  check('a limit handed in is the limit', getMaxListeners(createAbortController(7).signal) === 7 && getMaxListeners(createAbortController(0).signal) === 0)
  const reason = new Error('stop')
  controller.abort(reason)
  check('aborting it aborts its signal with the reason given', controller.signal.aborted && controller.signal.reason === reason)
  check('two controllers are apart', createAbortController().signal !== createAbortController().signal && !createAbortController().signal.aborted)
}

section('§2 createChildAbortController')
{
  const parent = createAbortController()
  const child = createChildAbortController(parent)
  check('a child of a live parent starts live, with the usual fifty listeners', !child.signal.aborted && getMaxListeners(child.signal) === 50)
  check('a limit handed in is the child\'s limit', getMaxListeners(createChildAbortController(parent, 9).signal) === 9)
  const reason = new Error('parent stopped')
  let heard = 0
  child.signal.addEventListener('abort', () => heard++)
  parent.abort(reason)
  check('aborting the parent aborts the child, with the parent\'s reason', child.signal.aborted && child.signal.reason === reason, `see createChildAbortController in ${WHERE}`)
  check('the child\'s own listeners hear it once', heard === 1, String(heard))
}
{
  const parent = createAbortController()
  const first = createChildAbortController(parent)
  const second = createChildAbortController(parent)
  const grandchild = createChildAbortController(first)
  first.abort(new Error('first only'))
  check('aborting a child leaves its parent and its sibling live', !parent.signal.aborted && !second.signal.aborted)
  check('and aborts its own child', grandchild.signal.aborted && (grandchild.signal.reason as Error).message === 'first only')
  parent.abort(new Error('later'))
  check('a child already aborted keeps its own reason when the parent aborts later', (first.signal.reason as Error).message === 'first only' && (second.signal.reason as Error).message === 'later')
}
{
  const parent = createAbortController()
  const reason = { why: 'already' }
  parent.abort(reason)
  const child = createChildAbortController(parent)
  check('a child of a parent that had already aborted is born aborted, with the parent\'s reason', child.signal.aborted && child.signal.reason === reason)
}
{
  const parent = createAbortController(3)
  const children = Array.from({ length: 20 }, () => createChildAbortController(parent))
  for (const child of children) child.abort()
  let warned = 0
  const onWarning = (): void => {
    warned++
  }
  process.on('warning', onWarning)
  for (let n = 0; n < 20; n++) createChildAbortController(parent).abort()
  await new Promise(resolve => setImmediate(resolve))
  process.off('warning', onWarning)
  check('children that have aborted no longer count against the parent\'s listener limit', warned === 0, `${warned} listener warnings; an aborted child must take its listener off the parent, see createChildAbortController in ${WHERE}`)
  parent.abort()
  check('and the parent still aborts cleanly afterwards', parent.signal.aborted)
}

if (failures > 0) {
  console.error(`\nprove-abort-controller-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-abort-controller-behaviour: all green')

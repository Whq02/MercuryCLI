import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { advanceToolCallChain, readToolCallChain, type ToolCallChain, type ToolUseContext } from '../../src/tools/kit/tool.ts'
import { createChildContext } from '../../src/crew/agents/forkedAgent.ts'
import { FileStateCache } from '../../src/platform/files/fileStateCache.ts'

let checks = 0
const equal = (actual: unknown, expected: unknown): void => {
  const shown = (value: unknown): string => JSON.stringify(value, (_key, item) => (typeof item === 'number' && !Number.isFinite(item) ? String(item) : item))
  assert.deepEqual(actual, expected, `call-chain check ${checks + 1} failed: got ${shown(actual)}, expected ${shown(expected)}; change advanceToolCallChain or readToolCallChain in src/tools/kit/tool.ts, or createSubagentContext in src/crew/agents/forkedAgent.ts`)
  checks++
}

const parents: Array<ToolCallChain | undefined> = [undefined]
for (const key of ['', 'root', 'a:b']) {
  for (const hop of [-1, 0, 1, 12, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    parents.push({ key, hop })
  }
}
for (const parent of parents) {
  const context = parent === undefined ? {} : { callChain: Object.freeze({ ...parent }) }
  for (const mode of ['continue', 'fork'] as const) {
    let minted = 0
    const next = advanceToolCallChain(context, () => `mint-${++minted}`, mode)
    equal(next, {
      key: mode === 'fork' || parent === undefined ? 'mint-1' : parent.key,
      hop: parent === undefined ? 0 : parent.hop + 1,
    })
    equal(minted, mode === 'fork' || parent === undefined ? 1 : 0)
    equal(context, parent === undefined ? {} : { callChain: parent })
    assert.notEqual(next, parent, 'advanceToolCallChain in src/tools/kit/tool.ts returned the parent chain object itself; it must return a new object')
    checks++
  }
  assert.equal(readToolCallChain(context), context.callChain, 'readToolCallChain in src/tools/kit/tool.ts must return the context callChain object unchanged')
  checks++
}
equal(readToolCallChain(undefined), undefined)
equal(advanceToolCallChain(undefined, () => 'first'), { key: 'first', hop: 0 })

const parent = {
  options: {},
  abortController: new AbortController(),
  readFileState: new FileStateCache(10, 1024),
  getAppState: () => ({ toolPermissionContext: {} }),
  setAppState: () => {},
  setResponseLength: () => {},
  updateAttributionState: () => {},
  messages: [],
  callChain: { key: 'parent', hop: 4 },
} as unknown as ToolUseContext
const first = createChildContext(parent)
const second = createChildContext(parent)
const nested = createChildContext(first)
const withoutChain = createChildContext({ ...parent, callChain: undefined })
equal(first.callChain?.hop, 5)
equal(second.callChain?.hop, 5)
equal(nested.callChain?.hop, 6)
equal(withoutChain.callChain?.hop, 0)
equal(new Set([parent, first, second, nested, withoutChain].map(context => readToolCallChain(context)?.key)).size, 5)
equal(parent.callChain, { key: 'parent', hop: 4 })
console.log(`PASS ${checks} tool-call chain checks: roots, continuations, sibling forks, nested forks, allocation counts and unchanged parents`)

import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { advanceToolCallChain, readToolCallChain, type ToolCallChain, type ToolUseContext } from '../../src/Tool.ts'
import { createSubagentContext } from '../../src/utils/forkedAgent.ts'
import { FileStateCache } from '../../src/utils/fileStateCache.ts'

let checks = 0
const equal = (actual: unknown, expected: unknown): void => {
  assert.deepEqual(actual, expected)
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
    assert.notEqual(next, parent)
    checks++
  }
  assert.equal(readToolCallChain(context), context.callChain)
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
const first = createSubagentContext(parent)
const second = createSubagentContext(parent)
const nested = createSubagentContext(first)
const withoutChain = createSubagentContext({ ...parent, callChain: undefined })
equal(first.callChain?.hop, 5)
equal(second.callChain?.hop, 5)
equal(nested.callChain?.hop, 6)
equal(withoutChain.callChain?.hop, 0)
equal(new Set([parent, first, second, nested, withoutChain].map(context => readToolCallChain(context)?.key)).size, 5)
equal(parent.callChain, { key: 'parent', hop: 4 })
console.log(`PASS ${checks} tool-call chain checks: roots, continuations, sibling forks, nested forks, allocation counts and unchanged parents`)

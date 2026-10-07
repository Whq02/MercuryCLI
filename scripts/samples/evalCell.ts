import { makeContext } from '../eval/lib.js'

export async function sampleCellRunner(owner: import('../../src/services/run/ownerKey.js').OwnerKey, cwd: string) {
  const { evalKernelManager } = await import('../../src/services/eval/kernelManager.js')
  const { makeEvalBridgeServer } = await import('../../src/services/eval/evalBridge.js')
  const context = await makeContext()
  const cellAbort = new AbortController()
  const serve = makeEvalBridgeServer({ owner, context, cellAbort, canUseTool: (async (_tool, input) => ({ behavior: 'allow', updatedInput: input })) as never })
  return async (code: string) => {
    let nestedCalls = 0
    const outcome = await evalKernelManager.runCell({ owner, cwd, input: { language: 'js', code }, abortSignal: cellAbort.signal, serveBridge: async (frame, budget) => {
      nestedCalls++
      return serve(frame, budget)
    } })
    return { ...outcome, nestedCalls }
  }
}

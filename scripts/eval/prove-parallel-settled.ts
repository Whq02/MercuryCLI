#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, cleanup, check, finish, loadEval, makeContext } from './lib.ts'
const { work } = setup()
delete process.env.MERCURY_HOME
const { evalKernelManager } = await loadEval()
const serveBridge = async (frame: any) => frame.kind === 'width' ? { ok: true, value: 2 } : { ok: false, error: 'Permission denied by fixture', errorKind: 'permission' }
async function run(language: 'js' | 'py', code: string) {
  return evalKernelManager.runCell({ owner: `settled-${language}`, cwd: work, input: { language, code, timeoutSeconds: 20 }, abortSignal: new AbortController().signal, serveBridge })
}
try {
  const { z } = await import('zod/v4')
  const { buildTool } = await import('../../src/Tool.ts')
  const { makeEvalBridgeServer } = await import('../../src/services/eval/evalBridge.ts')
  let dispatched = 0
  const refusedTool = buildTool({ name: 'DeniedFixture', inputSchema: z.object({}), maxResultSizeChars: 1000, async description() { return 'fixture' }, async prompt() { return 'fixture' }, async call() { dispatched++; return { data: 'unexpected' } }, mapToolResultToToolResultBlockParam(data: string, tool_use_id: string) { return { type: 'tool_result' as const, tool_use_id, content: data } } })
  const context = await makeContext({ tools: [refusedTool] })
  const actualBridge = makeEvalBridgeServer({ context, cellAbort: new AbortController(), canUseTool: (async () => ({ behavior: 'deny', message: 'Permission denied by fixture' })) as any })
  const permissionResult = await actualBridge({ t: 'bridge', token: 'fixture', id: 'fixture', bridgeId: 'deny', kind: 'tool', payload: { name: 'DeniedFixture', input: {} } }, { askBegin() {}, askEnd() {} } as any)
  check('the real permission bridge labels a denial without dispatching it', !permissionResult.ok && permissionResult.errorKind === 'permission' && dispatched === 0, JSON.stringify(permissionResult))
  for (const language of ['js', 'py'] as const) {
    const source = language === 'js'
      ? 'const items = await parallel([() => 11, () => { throw new Error("item failed") }, () => 33], {settled:true, width:2}); items'
      : 'def fail():\n    raise ValueError("item failed")\nitems = parallel([lambda: 11, fail, lambda: 33], width=2, settled=True)\nitems'
    const result = await run(language, source)
    check(`${language}: settled batch returns both successes and error in order`, result.status === 'ok' && /11[\s\S]*item failed[\s\S]*33/.test(result.resultRepr ?? ''), result.resultRepr ?? JSON.stringify(result.error))
    check(`${language}: failed index appears concisely`, /failed indices \(0-based\): 1/.test(result.stdout.text))
    if (process.env.PROOF_RESULT_DIR) writeFileSync(join(process.env.PROOF_RESULT_DIR, `eval-${language}.json`), JSON.stringify({ ...result, language, title: 'Settled batch' }))
    const later = await run(language, language === 'js'
      ? 'await parallel([() => "kept", () => {throw new Error("lost")}], {settled:true}); throw new Error("later cell failure")'
      : 'parallel([lambda: "kept", fail], settled=True)\nraise RuntimeError("later cell failure")')
    check(`${language}: later cell failure stays an error`, later.status === 'error')
    const recovered = await run(language, 'parallel.results')
    check(`${language}: settled outcomes survive a later cell failure`, recovered.status === 'ok' && (recovered.resultRepr ?? '').includes('kept'))
    const throwing = await run(language, language === 'js'
      ? 'await parallel([() => {throw new Error("first")}, () => {throw new Error("second")}])'
      : 'def first():\n    raise ValueError("first")\ndef second():\n    raise ValueError("second")\nparallel([first, second])')
    check(`${language}: default still throws lowest-index failure`, throwing.status === 'error' && throwing.error?.value === 'first', JSON.stringify(throwing.error))
    const kinds = await run(language, language === 'js'
      ? 'const outcomes = await parallel([() => tool.Refused({}), () => {throw new DOMException("cancelled", "AbortError")}, () => {throw new Error("ordinary")}], {settled:true}); outcomes.map(r => r.error.kind).join(",")'
      : 'def cancelled():\n    raise KeyboardInterrupt("cancelled")\nimport json\njson.dumps([r["error"]["kind"] for r in parallel([lambda: tool.Refused(), cancelled, fail], settled=True)])')
    check(`${language}: permission, cancellation and computation failure remain distinct`, kinds.status === 'ok' && /permission[\s\S]*cancelled[\s\S]*error/.test(kinds.resultRepr ?? ''), kinds.resultRepr ?? JSON.stringify(kinds.error))
  }
} finally { await evalKernelManager.disposeAll(); cleanup() }
finish('PARALLEL-SETTLED')

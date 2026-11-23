import { existsSync, readFileSync } from 'node:fs'
import { check, cleanup, finish, loadEval, makeContext, section, setup } from './lib.js'

const checkWithFix = (label: string, cond: boolean, detail: string, fix: string): void => check(label, cond, cond ? detail : detail === '' ? fix : `${detail} — ${fix}`)
const { work } = setup()
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.ts')
const { buildTool } = await import('../../src/tools/kit/tool.ts')
const { z } = await import('zod/v4')
const { setCwd } = await import('../../src/platform/shell/shellExec.ts')
const { PERSISTED_OUTPUT_TAG } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')
setCwd(work)

const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, path: `src/area/file-${i}.ts`, holder: 'seat-a' }))
const large = JSON.stringify({ ok: true, rows, end: 42 })
const small = JSON.stringify({ ok: true, rows: 'small' })
const tagged = `${PERSISTED_OUTPUT_TAG}\nthese are the tool's own words, not a wrapper\n</persisted-output> and a tail`
const fixture = buildTool({
  name: 'FixtureLedger',
  inputSchema: z.object({ size: z.enum(['large', 'small', 'tagged']) }),
  maxResultSizeChars: 50_000,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() { return 'fixture' },
  async prompt() { return 'fixture' },
  async call(input: { size: 'large' | 'small' | 'tagged' }) { return { data: { text: input.size === 'large' ? large : input.size === 'tagged' ? tagged : small } } },
  mapToolResultToToolResultBlockParam(output: { text: string }, tool_use_id: string) { return { type: 'tool_result', tool_use_id, content: output.text } },
} as never)
const context = await makeContext({ tools: [fixture, EvalTool] })
context.toolUseId = 'eval-large-values'
const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
const nested: string[] = []
const progress = (row: { data: { kind?: string; message?: { message?: { content?: unknown } } } }): void => {
  if (row.data.kind !== 'nested') return
  const content = row.data.message?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content as Array<{ type?: string; content?: unknown }>) {
    if (block.type === 'tool_result' && typeof block.content === 'string') nested.push(block.content)
  }
}
const run = (language: 'js' | 'py', code: string) => EvalTool.call({ language, code, timeoutSeconds: 60 }, context, allow, undefined as never, progress as never)
const words = (result: Awaited<ReturnType<typeof run>>): string => result.data.error ? `${result.data.error.name}: ${result.data.error.value}` : String(result.data.resultRepr)

try {
  section(`§1 a tool result above the persist threshold (${large.length} chars over a 50,000 ceiling) is the cell's value whole`)
  const first = await run('js', 'const ledger = await tool.FixtureLedger({ size: "large" })\nconst parsed = JSON.parse(ledger)\nparsed.end')
  checkWithFix('L1 JSON.parse reads the large result and finds its last field', first.data.status === 'ok' && first.data.resultRepr === '42', words(first), 'the cell must get the whole tool result, not the persisted display; see the nested tool call in makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts')
  const next = await run('js', 'JSON.parse(ledger).rows.length')
  checkWithFix('L2 the next cell reads the retained binding whole', next.data.status === 'ok' && next.data.resultRepr === '4000', words(next), 'the kernel must keep the binding between cells; see the kernel manager that loadEval returns in scripts/eval/lib.ts')
  const size = await run('js', 'ledger.length')
  checkWithFix('L3 the value is the whole result, character for character', size.data.resultRepr === String(large.length), words(size), 'the bridge must hand the cell the untruncated text; see makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts')

  section('§2 the transcript keeps the bounded display, which names where the full output lives')
  const display = nested.find(text => text.startsWith(PERSISTED_OUTPUT_TAG))
  checkWithFix('D1 the nested tool result the model sees is the persisted-output display', display !== undefined && display.length < 5_000, `${nested.length} nested results, first ${(nested[0] ?? '').slice(0, 60)}`, 'a result over the ceiling must reach the transcript as the persisted-output display; see PERSISTED_OUTPUT_TAG and buildLargeToolResultMessage in src/engine/tool-dispatch/toolResultStorage.ts')
  const saved = /Full output saved to: (.+)\n/.exec(display ?? '')?.[1]
  checkWithFix('D2 the display names a file that holds exactly the value the cell received', saved !== undefined && existsSync(saved) && readFileSync(saved, 'utf8') === large, saved ?? 'no path in the display', 'the display must carry a Full output saved to: path whose file holds the whole result; see persistToolResult in src/engine/tool-dispatch/toolResultStorage.ts')
  const shown = String(EvalTool.mapToolResultToToolResultBlockParam(first.data, 'eval-large-values').content)
  checkWithFix('D3 the Eval result itself stays small: the cell printed 42, not the ledger', shown.length < 2_000 && shown.includes('42'), shown.slice(0, 200), 'the Eval result must hold only what the cell returned; see mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts')

  section('§3 Python, a small result, and a value that merely contains the tag words')
  const py = await run('py', 'import json\njson.loads(tool.FixtureLedger(size="large"))["end"]')
  checkWithFix('P1 the Python kernel reads the same whole value', py.data.status === 'ok' && py.data.resultRepr === '42', words(py), 'the Python tool bridge must return the whole result too; see makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts')
  const control = await run('js', 'JSON.parse(await tool.FixtureLedger({ size: "small" })).rows')
  checkWithFix('S1 a result under the threshold is unchanged', control.data.status === 'ok' && control.data.resultRepr === "'small'", words(control), 'a result under the ceiling must pass through untouched; see makeEvalBridgeServer in src/tools/engines/eval-kernels/evalBridge.ts')
  const literal = await run('js', 'const own = await tool.FixtureLedger({ size: "tagged" })\nown === ' + JSON.stringify(tagged))
  checkWithFix('S2 a small result that merely contains the tag words is returned as the tool wrote it', literal.data.status === 'ok' && literal.data.resultRepr === 'true', words(literal), 'only a result the bridge itself persisted may be unwrapped, not text that contains PERSISTED_OUTPUT_TAG; see src/tools/engines/eval-kernels/evalBridge.ts')
} finally {
  await evalKernelManager.disposeAll()
  checkWithFix('no kernel left behind', evalKernelManager.kernelCount() === 0, '', 'evalKernelManager.disposeAll must close every kernel; see src/tools/engines/eval-kernels')
  cleanup()
}
finish('BRIDGE LARGE VALUES')

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, makeContext, refusingBridge, setup, within } from './lib.js'

const { home, work } = setup()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.js')
const { contentItemOf } = await import('../../src/engine/rows/content.js')
const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.js')
const { createAssistantMessage } = await import('../../src/engine/messages/messages.js')
const { setCwd } = await import('../../src/platform/shell/shellExec.js')
const { setOriginalCwd, setProjectRoot, setIsInteractive, setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.js')
const { refreshHooksSnapshot } = await import('../../src/integrations/event-hooks/hooksConfigSnapshot.js')
const run = (code: string, timeoutSeconds?: number) => within('budget cell', 60_000, evalKernelManager.runCell({ owner: 'budget-proof', cwd: work, input: { language: 'py', code, timeoutSeconds }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
const block = (out: Awaited<ReturnType<typeof run>>) => EvalTool.mapToolResultToToolResultBlockParam({ ...out, language: 'py' }, 'budget-proof')
const hinted = (label: string, cond: boolean, hint: string, detail = ''): void => check(label, cond, cond ? detail : detail ? `${detail} | ${hint}` : hint)

try {
  setCwd(work)
  setOriginalCwd(work)
  setProjectRoot(work)
  setIsInteractive(false)
  setSessionTrustAccepted(true)
  const mark = join(work, 'after.jsonl')
  const hook = join(work, 'capture.mjs')
  writeFileSync(hook, "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], (await Bun.stdin.text()).trim() + '\\n')")
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: {
    'tool.after': [{ name: 'after capture', match: 'Eval', run: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${JSON.stringify(mark)}` }],
  } } }))
  refreshHooksSnapshot()
  const input = { language: 'py', code: 'import time; time.sleep(3)', timeoutSeconds: 1 }
  const use = { type: 'tool_use' as const, id: 'budget-hook-proof', name: 'Eval', input }
  const parent = createAssistantMessage({ content: [use] })
  const context = await makeContext({ tools: [EvalTool] })
  const results: any[] = []
  for await (const update of runToolUse(use, parent, (async (_tool, values) => ({ behavior: 'allow', updatedInput: values })) as never, context)) {
    if (update.message?.type === 'user' && Array.isArray(update.message.message.content)) {
      results.push(...update.message.message.content.filter(item => item.type === 'tool_result'))
    }
  }
  const cancelled = results.find(result => result.tool_use_id === use.id)
  hinted('budget cancellation is an error result through the tool transaction', cancelled?.is_error === true && String(cancelled?.content).startsWith('[cell cancelled]'), 'a cancelled Eval cell must reach the transcript as an is_error tool_result starting with [cell cancelled]; see composeResultText and mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts', JSON.stringify(cancelled))
  hinted('budget cancellation keeps its exact reason', String(cancelled?.content).includes('the cell hit its 1s runtime budget (bridge time excluded) and was interrupted — raise timeoutSeconds or pass 0 to disable'), 'the wording comes from cancelReasonNote in src/tools/engines/eval-kernels/kernelManager.ts')
  const row = cancelled ? contentItemOf(cancelled) : undefined
  hinted('SDK content projects the cancellation as an error', row?.type === 'tool_result' && row.status === 'error', 'contentItemOf in src/engine/rows/content.ts must map the is_error cancelled tool_result to status error')
  const fires = existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const observed = fires[0]
  hinted('tool.after receives the unchanged cancelled output and input, once', fires.length === 1 && observed?.tool === 'Eval' && observed?.output?.status === 'cancelled' && JSON.stringify(observed?.input) === JSON.stringify(input), 'the tool.after hook must fire exactly once for the cancelled Eval call with its output and input unchanged; the printed list is what the hook captured in after.jsonl', JSON.stringify(fires))
  hinted('a returned cancellation is no cut: ok false, cut false', observed?.ok === false && observed?.cut === false, 'the tool.after payload must report ok false and cut false for a cancellation the tool returned', JSON.stringify(observed))
  const clamped = await run('print("done")', 900)
  hinted('a clamped successful call names the applied limit', !block(clamped).is_error && String(block(clamped).content).includes('[note] timeoutSeconds clamped to 600 s (the maximum)'), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must add the clampClause note (src/tools/kit/waitCeiling.ts) when timeoutSeconds exceeds EVAL_MAX_TIMEOUT_SECONDS', String(block(clamped).content))
  const unlimited = await run('17', 0)
  hinted('zero still disables the runtime budget without a clamp note', !block(unlimited).is_error && !unlimited.annotations.some(note => note.includes('clamped')), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must clamp only values above EVAL_MAX_TIMEOUT_SECONDS, never 0')
  const display = await run('display_markdown("x" * 12000)')
  hinted('display exposes exactly the first 10000 characters and the cut', block(display).content === 'x'.repeat(10000) + '\n… [display cut: 12000 chars, the first 10000 shown]', 'composeResultText in src/tools/eval/EvalTool.ts slices a display to EVAL_MAX_DISPLAY_CHARS and appends the cut mark')
  const represented = await run('display("x" * 12000)')
  hinted('plain display keeps its representation and says its actual length', String(block(represented).content).endsWith('… [display cut: 12002 chars, the first 10000 shown]'), 'composeResultText in src/tools/eval/EvalTool.ts must print the cut mark with the real display length')
  const json = await run('display_json({"x": "y" * 12000})')
  hinted('JSON displays carry the same explicit cut mark', String(block(json).content).startsWith('[json]\n') && String(block(json).content).includes('… [display cut: 12009 chars, the first 10000 shown]'), 'composeResultText in src/tools/eval/EvalTool.ts must prefix [json] and add the same cut mark for application/json displays')
  const short = await run('print("small")')
  hinted('ordinary output is unchanged', block(short).content === 'small\n' && !block(short).is_error, 'composeResultText in src/tools/eval/EvalTool.ts must return plain stdout, with no marks, for a status ok cell')
  for (const images of [[], [{ mime: 'image/png' as const, data: 'AA==', b64: true }]]) {
    const aborted = block({ ...short, status: 'cancelled', displays: images })
    hinted('cancellation is an error with and without image blocks', aborted.is_error === true, 'mapToolResultToToolResultBlockParam in src/tools/eval/EvalTool.ts must set is_error for a non-ok status on both the text-only and the image result shapes')
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL BUDGET OUTCOMES')

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, cleanup, finish, loadEval, makeContext, refusingBridge, setup, within } from './lib.js'

const { home, work } = setup()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const { contentItemOf } = await import('../../src/rows/content.js')
const { runToolUse } = await import('../../src/services/tools/toolExecution.js')
const { createAssistantMessage } = await import('../../src/utils/messages.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { setOriginalCwd, setProjectRoot, setIsInteractive, setSessionTrustAccepted } = await import('../../src/bootstrap/state.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { captureHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
const run = (code: string, timeoutSeconds?: number) => within('budget cell', 60_000, evalKernelManager.runCell({ owner: 'budget-proof', cwd: work, input: { language: 'py', code, timeoutSeconds }, abortSignal: new AbortController().signal, serveBridge: refusingBridge() }))
const block = (out: Awaited<ReturnType<typeof run>>) => EvalTool.mapToolResultToToolResultBlockParam({ ...out, language: 'py' }, 'budget-proof')

try {
  setCwd(work)
  setOriginalCwd(work)
  setProjectRoot(work)
  setIsInteractive(false)
  setSessionTrustAccepted(true)
  const mark = join(work, 'post.json')
  const failed = join(work, 'failure.json')
  const hook = join(work, 'capture.mjs')
  writeFileSync(hook, 'await Bun.write(process.argv[2], await Bun.stdin.text())')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: {
    PostToolUse: [{ matcher: 'Eval', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${JSON.stringify(mark)}` }] }],
    PostToolUseFailure: [{ matcher: 'Eval', hooks: [{ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${JSON.stringify(failed)}` }] }],
  } } }))
  resetSettingsCache()
  captureHooksConfigSnapshot()
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
  check('budget cancellation is an error result through the tool transaction', cancelled?.is_error === true && String(cancelled?.content).startsWith('[cell cancelled]'), JSON.stringify(cancelled))
  check('budget cancellation keeps its exact reason', String(cancelled?.content).includes('the cell hit its 1s runtime budget (bridge time excluded) and was interrupted — raise timeoutSeconds or pass 0 to disable'))
  const row = cancelled ? contentItemOf(cancelled) : undefined
  check('SDK content projects the cancellation as an error', row?.type === 'tool_result' && row.status === 'error')
  const observed = existsSync(mark) ? JSON.parse(readFileSync(mark, 'utf8')) : null
  check('PostToolUse receives the unchanged cancelled outcome and input', observed?.tool_name === 'Eval' && observed?.tool_response?.status === 'cancelled' && JSON.stringify(observed?.tool_input) === JSON.stringify(input), JSON.stringify(observed))
  check('returned cancellation does not fire PostToolUseFailure', !existsSync(failed))
  const clamped = await run('print("done")', 900)
  check('a clamped successful call names the applied limit', !block(clamped).is_error && String(block(clamped).content).includes('[note] timeoutSeconds clamped to 600 s (the maximum)'), String(block(clamped).content))
  const unlimited = await run('17', 0)
  check('zero still disables the runtime budget without a clamp note', !block(unlimited).is_error && !unlimited.annotations.some(note => note.includes('clamped')))
  const display = await run('display_markdown("x" * 12000)')
  check('display exposes exactly the first 10000 characters and the cut', block(display).content === 'x'.repeat(10000) + '\n… [display cut: 12000 chars, the first 10000 shown]')
  const represented = await run('display("x" * 12000)')
  check('plain display keeps its representation and says its actual length', String(block(represented).content).endsWith('… [display cut: 12002 chars, the first 10000 shown]'))
  const json = await run('display_json({"x": "y" * 12000})')
  check('JSON displays carry the same explicit cut mark', String(block(json).content).startsWith('[json]\n') && String(block(json).content).includes('… [display cut: 12009 chars, the first 10000 shown]'))
  const short = await run('print("small")')
  check('ordinary output is unchanged', block(short).content === 'small\n' && !block(short).is_error)
  for (const images of [[], [{ mime: 'image/png' as const, data: 'AA==', b64: true }]]) {
    const aborted = block({ ...short, status: 'cancelled', displays: images })
    check('cancellation is an error with and without image blocks', aborted.is_error === true)
  }
} finally {
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL BUDGET OUTCOMES')

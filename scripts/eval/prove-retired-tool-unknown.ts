import { check, cleanup, finish, makeContext, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'

setup()
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.js')
const { createAssistantMessage } = await import('../../src/engine/messages/messages.js')
const { gateToolCall } = await import('../../src/models/roads/toolCallGate.js')
const tools = getAllBaseTools()
const retired = CODE_TOOL_SPELLINGS[0]
const nonsense = 'NoSuchCellRuntime'
const context = await makeContext({ tools: [...tools] })
async function call(name: string): Promise<string[]> {
  const use = { type: 'tool_use' as const, id: 'unknown-cell-proof', name, input: {} }
  const parent = createAssistantMessage({ content: [use] })
  const answers: string[] = []
  for await (const update of runToolUse(use, parent, (async () => ({ behavior: 'deny', message: 'unexpected execution' })) as never, context)) {
    if (update.message?.type !== 'user' || !Array.isArray(update.message.message.content)) continue
    for (const part of update.message.message.content) {
      if (part.type !== 'tool_result') continue
      check('the unavailable call is an error', part.is_error === true, part.is_error === true ? '' : 'an unknown tool name must come back as an error tool_result: see the unknown-tool branch in runToolUse in src/engine/tool-dispatch/toolExecution.ts')
      answers.push(String(part.content).replaceAll(name, '<name>'))
    }
  }
  return answers
}
const retiredResult = await call(retired)
const unknownResult = await call(nonsense)
const sameOk = retiredResult.length === 1 && JSON.stringify(retiredResult) === JSON.stringify(unknownResult)
check('one generic unknown-tool result, byte-identical after name substitution', sameOk, sameOk ? JSON.stringify(retiredResult) : `${JSON.stringify(retiredResult)} — the retired name must get the same answer as an invented one: remove any special case for it in the unknown-tool branch of runToolUse in src/engine/tool-dispatch/toolExecution.ts`)
const ROSTER_WORDS = 'call one of the tools you were given:'
const beforeRoster = (retiredResult[0] ?? '').split(ROSTER_WORDS)[0] ?? ''
const absenceOk = retiredResult[0]?.includes('No such tool available: <name>') === true && retiredResult[0]?.includes(ROSTER_WORDS) === true && !beforeRoster.includes('Eval') && !/\b(?:use|instead|replaced by|now called)\b[^.]*\bEval\b/.test(retiredResult[0] ?? '')
check('the result names ordinary absence rather than a redirect: Eval is not named before the roster of the tools the session was given, where every tool is listed', absenceOk, absenceOk ? (retiredResult[0] ?? '') : `${retiredResult[0] ?? ''} — the message must read No such tool available, then the roster words, with no redirect to Eval: see the message built near the top of the unknown-tool branch in src/engine/tool-dispatch/toolExecution.ts`)
for (const name of [retired, nonsense]) {
  const verdict = gateToolCall(tools, { id: 'gate', name, argumentsRaw: '{}' })
  const gateOk = !verdict.ok && verdict.refusal.code === 'unknown-tool' && verdict.refusal.reason === `No such tool available: ${name}`
  check('the provider-neutral gate takes its ordinary unknown-tool road', gateOk, gateOk ? '' : `gateToolCall in src/models/roads/toolCallGate.ts must refuse ${name} with code unknown-tool and the plain reason, with no special case`)
}
cleanup()
finish('EVAL GENERIC UNKNOWN TOOL')

import { check, cleanup, finish, makeContext, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS } from '../identity/forbidden-code-tool.js'

setup()
const { getAllBaseTools } = await import('../../src/tools.js')
const { runToolUse } = await import('../../src/services/tools/toolExecution.js')
const { createAssistantMessage } = await import('../../src/utils/messages.js')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.js')
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
      check('the unavailable call is an error', part.is_error === true)
      answers.push(String(part.content).replaceAll(name, '<name>'))
    }
  }
  return answers
}
const retiredResult = await call(retired)
const unknownResult = await call(nonsense)
check('one generic unknown-tool result, byte-identical after name substitution', retiredResult.length === 1 && JSON.stringify(retiredResult) === JSON.stringify(unknownResult), JSON.stringify(retiredResult))
const ROSTER_WORDS = 'call one of the tools you were given:'
const beforeRoster = (retiredResult[0] ?? '').split(ROSTER_WORDS)[0] ?? ''
check('the result names ordinary absence rather than a redirect: Eval is not named before the roster of the tools the session was given, where every tool is listed', retiredResult[0]?.includes('No such tool available: <name>') === true && retiredResult[0]?.includes(ROSTER_WORDS) === true && !beforeRoster.includes('Eval') && !/\b(?:use|instead|replaced by|now called)\b[^.]*\bEval\b/.test(retiredResult[0] ?? ''), retiredResult[0] ?? '')
for (const name of [retired, nonsense]) {
  const verdict = gateToolCall(tools, { id: 'gate', name, argumentsRaw: '{}' })
  check('the provider-neutral gate takes its ordinary unknown-tool road', !verdict.ok && verdict.refusal.code === 'unknown-tool' && verdict.refusal.reason === `No such tool available: ${name}`)
}
cleanup()
finish('EVAL GENERIC UNKNOWN TOOL')

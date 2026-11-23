import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { isToolErrorResultTruncated, FallbackToolUseErrorMessage } = await import('../../src/tools/kit/FallbackToolUseErrorMessage.tsx')
const React = await import('react')
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
const refusalHint = ' | change formatZodValidationError in src/tools/kit/toolErrors.ts or refuseInvalidInput in src/engine/tool-dispatch/toolExecution.ts'
const cardHint = ' | change deriveDisplayedError or isToolErrorResultTruncated in src/tools/kit/FallbackToolUseErrorMessage.tsx'
let calls = 0
const tool = {
  name: 'SchemaSentenceProbe',
  inputSchema: z.object({ count: z.number() }),
  call: async () => { calls++; return { data: 'unexpected' } },
}
const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
const context = {
  abortController: new AbortController(),
  getAppState: () => appState,
  setAppState: () => {},
  messages: [],
  toolDecisions: new Map(),
  options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
}
for (const input of [{ count: 'two' }, {}]) {
  const updates = []
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'schema-sentence', name: tool.name, input },
    { uuid: 'schema-assistant', message: { id: 'schema-message' } } as never,
    (async () => ({ behavior: 'allow' })) as never,
    context as never,
  )) updates.push(update)
  const results = updates.flatMap(u => u.message.type === 'user' && Array.isArray(u.message.message.content)
    ? u.message.message.content.filter(b => b.type === 'tool_result') : [])
  const result = results[0]
  const text = String(result?.content ?? '')
  check('the refusal is one error result', results.length === 1 && result?.is_error === true, text + refusalHint)
  check('the refusal starts with its sentence', text.startsWith(`<tool_use_error>${tool.name} failed (`), text + refusalHint)
  check('the refusal names the count field', text.includes('`count`'), text + refusalHint)
  check('the refusal explains the expected shape', 'count' in input ? text.includes('number') : text.includes('missing'), text + refusalHint)
  const row = updates.find(u => u.message.type === 'user')?.message
  check('the saved result carries the same sentence, not raw schema JSON', row?.type === 'user' && row.toolUseResult === text.replace(/^<tool_use_error>|<\/tool_use_error>$/g, ''), JSON.stringify(row) + ' | make the saved toolUseResult in refuseInvalidInput (src/engine/tool-dispatch/toolExecution.ts) equal the sentence text')
  check('a short schema sentence stays visible in the collapsed card', !isToolErrorResultTruncated(text), text + cardHint)
  for (const verbose of [false, true]) {
    const frame = await renderToString(React.createElement(FallbackToolUseErrorMessage, { result: text, verbose }), 120)
    check(`the ${verbose ? 'expanded' : 'collapsed'} card shows the field and shape`, frame.includes('count') && frame.includes('count' in input ? 'number' : 'missing'), frame + cardHint)
    console.log(frame)
  }
}
check('invalid input never executes the tool', calls === 0)
console.log(`schema-refusal-sentence: ${failures} failures`)
process.exit(failures ? 1 : 0)

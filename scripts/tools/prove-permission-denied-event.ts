import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const parent = process.env.MERCURY_CONFIG_DIR
if (!parent) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const home = mkdtempSync(join(parent, 'permission-denied-'))
process.env.MERCURY_CONFIG_DIR = home
const captured = join(home, 'input.json')
const reply = join(home, 'reply.json')
writeFileSync(reply, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } }))
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { PermissionDenied: [{ matcher: 'DeniedEventProbe', hooks: [{ type: 'command', command: `cat > '${captured}'; cat '${reply}'` }] }] } } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
let calls = 0
const tool = {
  name: 'DeniedEventProbe',
  inputSchema: z.object({ path: z.string() }),
  call: async () => { calls++; return { data: 'ran' } },
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
}
const input = { path: 'fixture.txt' }
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
const context = {
  abortController: new AbortController(),
  getAppState: () => state,
  setAppState: () => {},
  messages: [],
  toolDecisions: new Map(),
  options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
}
try {
  for (const [id, decision, wantsRetry] of [
    ['rule', { behavior: 'deny', message: 'Denied by the fixture rule.' }, true],
    ['card', { behavior: 'deny', message: 'The operator declined this call.' }, true],
    ['headless', { behavior: 'ask', message: 'This call requires approval.' }, true],
    ['no-retry', { behavior: 'deny', message: 'No retry requested.' }, false],
    ['allowed', { behavior: 'allow' }, false],
  ] as const) {
    rmSync(captured, { force: true })
    writeFileSync(reply, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: wantsRetry } }))
    const beforeCalls = calls
    let permissionReads = 0
    const updates = []
    for await (const update of runToolUse(
      { type: 'tool_use', id: `denied-${id}`, name: tool.name, input },
      { uuid: `assistant-${id}`, message: { id: `message-${id}` } } as never,
      (async () => { permissionReads++; return decision }) as never,
      context as never,
    )) updates.push(update)
    const results = updates.flatMap(u => u.message.type === 'user' && Array.isArray(u.message.message.content) ? u.message.message.content.filter(b => b.type === 'tool_result') : [])
    const text = String(results[0]?.content ?? '')
    if (id === 'allowed') {
      check('an allowed call emits no PermissionDenied event', !existsSync(captured))
      check('an allowed call executes once', calls === beforeCalls + 1)
      continue
    }
    check(`${id}: the refusal fires PermissionDenied`, existsSync(captured))
    const event = existsSync(captured) ? JSON.parse(readFileSync(captured, 'utf8')) : {}
    check(`${id}: the event carries the exact tool name, input and id`, event.tool_name === tool.name && JSON.stringify(event.tool_input) === JSON.stringify(input) && event.tool_use_id === `denied-${id}`, JSON.stringify(event))
    check(`${id}: the event carries the refusal reason`, String(event.reason).includes(decision.message!), JSON.stringify(event))
    if (id === 'headless') check('the hook reason names the headless auto-deny', String(event.reason).includes('auto-denied'), JSON.stringify(event))
    check(`${id}: retry is relayed only when the hook requests it`, text.includes('The PermissionDenied hook asks you to try this call again.') === wantsRetry, text)
    check(`${id}: retry never grants permission or executes the refused call`, calls === beforeCalls && permissionReads === 1 && results.length === 1 && results[0]?.is_error === true, text)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`permission-denied-event: ${failures} failures`)
process.exit(failures ? 1 : 0)

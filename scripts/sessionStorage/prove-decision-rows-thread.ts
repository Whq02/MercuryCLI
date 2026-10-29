#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { buildConversationChain } = await import('../../src/utils/sessionStorage/chain.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Row = { uuid: string; parentUuid: string | null; type: string; message: { id: string; role: string; content: unknown[] } }
const row = (uuid: string, parentUuid: string | null, type: string): Row => ({ uuid, parentUuid, type, message: { id: `msg-${uuid}`, role: type === 'assistant' ? 'assistant' : 'user', content: [] } })
const chainTypes = (rows: Row[], leaf: string): string[] => {
  const map = new Map(rows.map(r => [r.uuid, r] as [never, never]))
  return buildConversationChain(map as never, rows.find(r => r.uuid === leaf) as never).map(r => (r as unknown as Row).type)
}

section('§1 the chain walk')
{
  const call = row('a', null, 'assistant')
  const between = row('b', 'a', 'attachment')
  const result = row('c', 'a', 'user')
  check('a row recorded between the call and its result is a side branch the walk never reaches', chainTypes([call, between, result], 'c').join('>') === 'assistant>user')
  const after = row('d', 'c', 'attachment')
  check('a row recorded after the result threads onto the chain', chainTypes([call, result, after], 'd').join('>') === 'assistant>user>attachment')
}

section('§2 the source: both decision rows land after the result')
{
  const src = readFileSync(join(ROOT, 'src/services/tools/toolExecution.ts'), 'utf8')
  const built = src.indexOf('const decidedRows = hookRowsOfResult(decided, { callId: toolUseID })')
  const denyPushed = src.indexOf('for (const row of decidedRows) push(row)')
  const pushed = src.indexOf('if (executed) for (const row of decidedRows) push(row)')
  const allowance = src.indexOf('if (executed && allowanceRow !== null) push({ message: allowanceRow })')
  check('the permission.decided rows are built at the decision and pushed at the terminal step', built !== -1 && pushed !== -1 && built < pushed)
  check('…on the deny road after the refusal result, and beside the allowance row on the allow road', denyPushed !== -1 && denyPushed < pushed && allowance !== -1 && pushed < allowance)
  check('no decided row is pushed in the slot between the call and its result', !/push\(\{\s*message: createAttachmentMessage\(\{\s*type: 'hook'/.test(src))
}

section('§3 the tool execution road: the permission.decided row lands after the result on the DENY road and the ALLOW road')
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'decision-rows-'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  delete process.env.MERCURY_HOME
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { setSessionTrustAccepted, setIsInteractive, getSessionId } = await import('../../src/bootstrap/state.ts')
  setSessionTrustAccepted(true)
  setIsInteractive(false)
  const { refreshHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
  const { addSessionHooks } = await import('../../src/utils/hooks/sessionHooks.ts')
  const { z } = await import('zod/v4')
  const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  writeFileSync(join(home, 'settings.json'), '{}')
  refreshHooksSnapshot()
  const spy = join(home, 'decided.cjs')
  writeFileSync(spy, "const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ notice: `decided ${input.decision} by ${input.by}` }))")
  const tool = {
    name: 'FakeHookTool',
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'allow', updatedInput: undefined }),
    mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', content: typeof data === 'string' ? data : JSON.stringify(data), tool_use_id: id }),
    call: async () => ({ data: 'hooked ok' }),
  }
  const appState = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as never }, sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
  const setAppState = (f: (s: unknown) => unknown): void => { f(appState) }
  addSessionHooks(setAppState as never, { sessionId: String(getSessionId()) }, { 'permission.decided': [{ name: 'decided spy', run: `${JSON.stringify(process.execPath)} ${JSON.stringify(spy)}` }] } as never, { kind: 'agent', type: 'decision-rig' })
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState,
    messages: [],
    agentType: undefined,
    agentId: undefined,
    toolDecisions: new Map(),
    readFileState: new Map(),
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
  }
  const ASSISTANT = { uuid: 'uuid-hook', requestId: 'req_hook', message: { id: 'msg_hook' } } as never
  type Yielded = { message?: { type?: string; attachment?: { type?: string; outcome?: string; words?: string }; message?: { content?: Array<{ type?: string; is_error?: boolean }> } } }
  const drive = async (decision: unknown): Promise<string[]> => {
    const out: Yielded[] = []
    for await (const update of runToolUse({ type: 'tool_use', id: 'toolu_hook', name: tool.name, input: {} } as never, ASSISTANT, (async () => decision) as never, context as never)) out.push(update as never)
    return out.map(u => {
      const m = u.message
      if (m?.type === 'attachment') return m.attachment?.type === 'hook' ? `hook:${m.attachment.outcome}:${m.attachment.words}` : `attachment:${m.attachment?.type}`
      if (m?.type === 'user') return `result${m.message?.content?.[0]?.is_error ? ':error' : ''}`
      return String(m?.type)
    })
  }
  const hook = { type: 'hook', hookName: 'ask gate', reason: 'the hook decided' }
  const denied = (await drive({ behavior: 'deny', message: 'denied by the hook', decisionReason: hook })).filter(x => x.startsWith('result') || x.startsWith('hook:'))
  check('DENY: the refusal result lands, then the decided row — after it, never lost', denied.join(' → ') === 'result:error → hook:notice:decided denied by hook', denied.join(' → '))
  const allowed = (await drive({ behavior: 'allow', updatedInput: {}, decisionReason: hook })).filter(x => x.startsWith('result') || x.startsWith('hook:'))
  check('ALLOW: the tool ran, its result landed, then the decided row', allowed.join(' → ') === 'result → hook:notice:decided allowed by hook', allowed.join(' → '))
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

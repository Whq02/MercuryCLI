#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'run-protocol-wiring-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.MERCURY_BARE

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { getRunProtocolDelta } = await import('../../src/utils/cockpit/runProtocol.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { setOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')
const { getAttachments, createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — run-protocol wiring proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()
const j = (v: unknown): string => JSON.stringify(v)

const scratch = mkdtempSync(join(tmpdir(), 'run-protocol-wiring-'))
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)
const model = 'claude-fable-5-1'
const tools = [{ name: 'Read' }] as never
const withLsp = [{ name: 'Read' }, { name: 'LSP' }] as never
const context = (over: Record<string, unknown> = {}, pool: unknown = withLsp) =>
  ({
    getAppState: () => ({ tasks: {}, toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { agentDefinitions: { activeAgents: [] }, tools: pool, mainLoopModel: model, mcpClients: [] },
    readFileState: new Map<string, unknown>(),
    ...over,
  }) as never
const collect = async (ctx: never, messages: unknown[]): Promise<Array<Record<string, unknown>>> =>
  ((await getAttachments('hello', ctx, null, [], messages as never, undefined, { skipSkillDiscovery: true })) as Array<Record<string, unknown>>).filter(a => a.type === 'run_protocol_delta')

console.log('\nrun-protocol wiring — the capability delta reaches the model through the real collection')
clearSystemPromptSections()
await getSystemPrompt(tools, model)
const expected = getRunProtocolDelta(withLsp, [])
check('the section cached over [Read] makes an LSP mount a pending delta', expected !== null && j(expected).includes('LSP'), j(expected))
const first = await collect(context(), [])
check('the main thread appends exactly one run_protocol_delta carrying that guidance', first.length === 1 && j(first[0]) === j({ type: 'run_protocol_delta', ...expected }), j(first).slice(0, 300))
const row = createAttachmentMessage({ type: 'run_protocol_delta', ...(expected as Record<string, unknown>) } as never)
const again = await collect(context(), [row])
check('a history that already carries the row gets none', again.length === 0, j(again).slice(0, 200))
const sub = await collect(context({ agentId: 'wiring-probe-agent' }), [])
check('a sub-agent collection appends none', sub.length === 0, j(sub).slice(0, 200))
const same = await collect(context({}, tools), [])
check('an unchanged capability set appends none', same.length === 0, j(same).slice(0, 200))

console.log(`\n${failures === 0 ? 'RUN-PROTOCOL WIRING GREEN' : `${failures} RUN-PROTOCOL WIRING FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)

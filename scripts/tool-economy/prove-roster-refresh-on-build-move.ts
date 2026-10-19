#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_MODEL', 'MERCURY_HOME']) delete process.env[k]
const scratch = mkdtempSync(join(tmpdir(), 'roster-refresh-build-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-proof' }

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const economy = await import('../../src/services/providers/toolEconomy.ts')
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const ledger = await import('../../src/services/providers/anthropic/prefixLedger.ts')
const { prefixLedgerPath } = await import('../../src/services/providers/anthropic/prefixRecordStore.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const tool = (name: string): Tool => ({ name, searchHint: `${name.toLowerCase()} fixture`, description: async () => name, prompt: async () => name, inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as never, call: async () => ({ data: null }) } as unknown as Tool)
const livePool: Tool[] = [tool('Bash'), tool('Read'), tool('Crewmate')]
const RETIRED = 'RetiredDispatch'
const owner = String(processMainOwner())
const first = createUserMessage({ content: 'the session that began on the earlier build' }) as unknown as Message
const model = 'claude-opus-4-8'
const definition = JSON.stringify({ name: RETIRED, description: 'the retired dispatch tool', input_schema: { type: 'object' } })

function recordFromEarlierBuild(): Message[] {
  const key = economy.conversationRosterKey(owner, [first], model)
  const saved = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster: [{ name: 'Bash', deferred: false }, { name: 'Read', deferred: false }, { name: RETIRED, deferred: false, definition }], sections: [], systemContext: {} } as never) as unknown as Message
  return [first, saved]
}
function writeLedger(build: string | undefined): void {
  const path = prefixLedgerPath()
  mkdirSync(dirname(path), { recursive: true })
  const key = economy.conversationRosterKey(owner, [first], model)
  writeFileSync(path, JSON.stringify({ version: 1, owner, ...(build !== undefined ? { build } : {}), record: { key, whole: 'x', system: [], tools: [], messages: [], wireMessageIds: [], dropped: [] }, drops: null }))
}
async function planAfterRestore(messages: Message[]): Promise<{ names: string[]; missing: string[] }> {
  economy.clearToolRosterLatches()
  economy.clearToolRosterRestore()
  ledger.resetPrefixLedger()
  restoreBoundPrefixFromMessages(messages, { rosterOnly: true })
  const plan = await economy.planToolPayload({ model, tools: livePool, messages, latchKey: owner, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [] })
  return { names: plan.roster.map(t => t.name), missing: [...plan.restoredMissingTools] }
}

try {
  section('§1 a session resumed on a new build: the recorded roster names a tool this build retired, the new tool must be callable at the first request (the field row M39-09)')
  {
    writeLedger('1.0.0-beta.33')
    const plan = await planAfterRestore(recordFromEarlierBuild())
    check('the roster is decided from the live pool: the new tool rides the first request', plan.names.includes('Crewmate'), j(plan))
    check('the retired name is gone from the roster (it fails as an unknown tool, no alias)', !plan.names.includes(RETIRED), j(plan))
  }
  section('§2 the same build respawned (a daemon respawn, a resume): the recorded roster is replayed as first sent')
  {
    writeLedger('1.0.0-proof')
    const plan = await planAfterRestore(recordFromEarlierBuild())
    check('the roster is the record: the retired name rides as its recorded stub and the joiner waits for the lawful boundary', plan.names.includes(RETIRED) && !plan.names.includes('Crewmate'), j(plan))
  }
  section('§3 a record with no ledger beside it whose bound tool has no saved definition: the roster cannot be replayed, so it is decided afresh')
  {
    rmSync(prefixLedgerPath(), { force: true })
    const key = economy.conversationRosterKey(owner, [first], model)
    const saved = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster: [{ name: 'Bash', deferred: false }, { name: RETIRED, deferred: false }], sections: [], systemContext: {} } as never) as unknown as Message
    const plan = await planAfterRestore([first, saved])
    check('the live pool decides the roster and the missing tool is declared for the lawful-change receipt', plan.names.includes('Crewmate') && !plan.names.includes(RETIRED) && plan.missing.includes(RETIRED), j(plan))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('ROSTER REFRESH ON BUILD MOVE RED')
  process.exit(1)
}
console.log('ROSTER REFRESH ON BUILD MOVE GREEN')

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hook-stdin-order-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
mkdirSync(home)
mkdirSync(cwd)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
process.env.MERCURY_TRUST_DIALOG_ACCEPTED = '0'
const ledger = join(root, 'stdin.jsonl')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const program = `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(Object.keys(input))+'\\n')`
const command = `${quote(process.execPath)} -e ${quote(program)}`

const baseOrder = ['session_id', 'transcript_path', 'cwd', 'permission_mode', 'agent_id', 'agent_type']
const families: Array<{ event: string; fields: Record<string, unknown>; expected: string[] }> = [
  { event: 'PreToolUse', fields: { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu1' }, expected: [...baseOrder, 'hook_event_name', 'tool_name', 'tool_input', 'tool_use_id'] },
  { event: 'PostToolUse', fields: { tool_name: 'Read', tool_input: {}, tool_result: {}, tool_use_id: 'tu2' }, expected: [...baseOrder, 'hook_event_name', 'tool_name', 'tool_input', 'tool_result', 'tool_use_id'] },
  { event: 'Notification', fields: { message: 'm', notification_type: 'permission' }, expected: [...baseOrder, 'hook_event_name', 'message', 'notification_type'] },
  { event: 'UserPromptSubmit', fields: { prompt: 'p' }, expected: [...baseOrder, 'hook_event_name', 'prompt'] },
  { event: 'SessionStart', fields: { source: 'startup' }, expected: [...baseOrder, 'hook_event_name', 'source'] },
  { event: 'SessionEnd', fields: { reason: 'clear' }, expected: [...baseOrder, 'hook_event_name', 'reason'] },
  { event: 'Stop', fields: { stop_hook_active: false }, expected: [...baseOrder, 'hook_event_name', 'stop_hook_active'] },
  { event: 'SubagentStop', fields: { stop_hook_active: false, agent_transcript_path: '/at', last_assistant_message: 'x' }, expected: [...baseOrder, 'hook_event_name', 'stop_hook_active', 'agent_transcript_path', 'last_assistant_message'] },
  { event: 'PreCompact', fields: { trigger: 'manual', custom_instructions: 'ci' }, expected: [...baseOrder, 'hook_event_name', 'trigger', 'custom_instructions'] },
  { event: 'PermissionRequest', fields: { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu3' }, expected: [...baseOrder, 'hook_event_name', 'tool_name', 'tool_input', 'tool_use_id'] },
  { event: 'Setup', fields: { trigger: 'first_run', source: 's' }, expected: [...baseOrder, 'hook_event_name', 'trigger', 'source'] },
  { event: 'Elicitation', fields: { mcp_server_name: 'srv', tool_name: 'Elicitation', elicitation_id: 'e1', requested_schema: {} }, expected: [...baseOrder, 'hook_event_name', 'mcp_server_name', 'tool_name', 'elicitation_id', 'requested_schema'] },
  { event: 'FileChanged', fields: { file_path: '/a/b/c.txt', event: 'change' }, expected: [...baseOrder, 'hook_event_name', 'file_path', 'event'] },
  { event: 'Interrupt', fields: { turn_id: 't1', reason: 'cut' }, expected: [...baseOrder, 'hook_event_name', 'turn_id', 'reason'] },
  { event: 'WorktreeCreate', fields: { name: 'wt' }, expected: [...baseOrder, 'hook_event_name', 'name'] },
  { event: 'CrewmateIdle', fields: {}, expected: [...baseOrder, 'hook_event_name'] },
]

writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: Object.fromEntries(families.map(family => [family.event, [{ hooks: [{ type: 'command', command }] }]])) } }))

const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { runHookEvent } = await import('../../src/utils/hooks/engine.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { registerHookEventHandler } = await import('../../src/utils/hooks/hookEvents.ts')
registerHookEventHandler(() => {})
updateHooksConfigSnapshot()

let failures = 0
const check = (name: string, yes: boolean, detail = ''): void => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  for (const family of families) {
    for await (const _result of runHookEvent({ event: family.event as never, fields: family.fields as never, sessionId: 'stdin-order-session', cwd, transcriptPath: join(root, 'transcript.jsonl'), trustAccepted: true, forceSyncExecution: true })) {
      void _result
    }
  }
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  check('one stdin line per event family', lines.length === families.length, `${lines.length} of ${families.length}`)
  for (let index = 0; index < families.length; index++) {
    const family = families[index]!
    const got = lines[index] ?? []
    const present = family.expected.filter(key => got.includes(key))
    const gotOrder = got.filter(key => present.includes(key)).join(',')
    const wantOrder = present.join(',')
    check(`${family.event} stdin key order is the base's`, gotOrder === wantOrder, `got ${gotOrder} want ${wantOrder}`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'HOOK STDIN ORDER GREEN' : `${failures} HOOK STDIN ORDER FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'lifecycle-contract-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const { setSessionTrustAccepted, registerHookCallbacks } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { executeLifecycleHooks } = await import('../../src/utils/hooks/lifecycleHooks.ts')
const { createBaseHookInput } = await import('../../src/utils/hooks/execution.ts')
const { parseElicitationHookOutput } = await import('../../src/utils/hooks/outputProcessing.ts')
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
const stdout = (s: string): string => `printf '%s' ${quote(s)}`
let failures = 0
const check = (label: string, ok: boolean): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
const answers = {
  FileChanged: JSON.stringify({ systemMessage: 'watch moved', hookSpecificOutput: { hookEventName: 'FileChanged', watchPaths: ['next-file'] } }),
  Elicitation: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { answer: true } } }),
}
const settings = {
  Notification: [{ hooks: [{ type: 'command', command: stdout('first') }, { type: 'command', command: stdout('reason') + ' >&2; exit 2' }, { type: 'prompt', prompt: 'a condition' }, { type: 'agent', prompt: 'an agent condition' }] }],
  FileChanged: [{ hooks: [{ type: 'command', command: stdout(answers.FileChanged) }] }],
  Elicitation: [{ hooks: [{ type: 'command', command: stdout(answers.Elicitation) }] }],
  WorktreeCreate: [{ hooks: [{ type: 'command', command: stdout('/a/workspace\n') }] }],
  ConfigChange: [{ hooks: [{ type: 'command', command: stdout('one shot'), once: true }] }],
}
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: settings } }))
updateHooksConfigSnapshot()
const input = (event: string, fields: Record<string, unknown>) => ({ ...createBaseHookInput(), hook_event_name: event, ...fields })
const run = (event: string, fields: Record<string, unknown>) => executeLifecycleHooks({ hookInput: input(event, fields) as never, timeoutMs: 4000 })
try {
  const rows = await run('Notification', { message: 'a notice', notification_type: 'test' })
  check('lifecycle rows retain matcher order, exact stdout and exact blocking stderr', rows.length === 4 && rows[0]?.output === 'first' && rows[0]?.succeeded === true && rows[1]?.output === 'reason' && rows[1]?.blocked === true && rows[1]?.succeeded === false)
  check('the two unsupported transports retain their exact words', rows[2]?.output === 'Prompt stop hooks are not yet supported outside chat' && rows[3]?.output === 'Agent stop hooks are not yet supported outside chat')
  const changed = await run('FileChanged', { file_path: '/a/file', event: 'change' })
  check('watch paths, system message and raw JSON survive the flat-row projection', changed[0]?.output === answers.FileChanged && changed[0]?.watchPaths?.[0] === 'next-file' && changed[0]?.systemMessage === 'watch moved')
  const elicitation = await run('Elicitation', { mcp_server_name: 'fixture', message: 'a question' })
  const answer = elicitation[0] ? parseElicitationHookOutput(elicitation[0], 'Elicitation') : {}
  check('elicitation retains the structured action and content', answer.response?.action === 'accept' && (answer.response?.content as Record<string, unknown>)?.answer === true)
  const created = await run('WorktreeCreate', { name: 'fixture' })
  check('the command worktree path retains its raw stdout', created[0]?.output === '/a/workspace\n')
  registerHookCallbacks({ WorktreeCreate: [{ hooks: [{ type: 'callback', callback: async () => ({ hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: '/callback/workspace' } }) }] }] } as never)
  const callback = await run('WorktreeCreate', { name: 'callback' })
  check('the callback worktree path survives the same road', callback.some(row => row.command === 'callback' && row.output === '/callback/workspace' && row.succeeded))
  const once = await run('ConfigChange', { source: 'user_settings' })
  const next = await run('ConfigChange', { source: 'user_settings' })
  const stored = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { events?: { hooks?: { ConfigChange?: unknown[] } } }
  check('a lifecycle once-hook retires after its first run, just like a tool hook', once.length === 1 && next.length === 0 && !stored.events?.hooks?.ConfigChange?.length)
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? 'LIFECYCLE HOOK CONTRACT GREEN' : `${failures} LIFECYCLE HOOK CONTRACT FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

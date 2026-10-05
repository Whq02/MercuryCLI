#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-row-road-'))
const home = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(home)
mkdirSync(cwd)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat' }] }] } } }))
updateHooksConfigSnapshot()
let failures = 0
const check = (label: string, ok: boolean): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
let road: typeof import('../../src/utils/hooks/rows.ts') | undefined
try { road = await import('../../src/utils/hooks/rows.ts') } catch {}
check('the hook road reads row facts and projects its lifecycle onto task rows', typeof road?.runHookEventFromRow === 'function' && typeof road?.hookFieldsFromRow === 'function' && typeof road?.hookTaskRow === 'function')
if (road) {
  const { registerHookEventHandler, takeHookEventHandler } = await import('../../src/utils/hooks/hookEvents.ts')
  const { TaskRowSchema } = await import('../../src/rows/vocabulary.ts')
  const { createRowStamper } = await import('../../src/rows/project.ts')
  const globalMarks: string[] = []
  const screen = (event: { hookId: string }): void => { globalMarks.push(event.hookId) }
  registerHookEventHandler(screen)
  const drive = async (sid: string) => {
    const marks: Array<Record<string, unknown>> = []
    const stamper = createRowStamper()
    const scope = { session_id: sid }
    const emit = (mark: Parameters<typeof road.hookTaskRow>[1]): void => { marks.push(stamper.stamp(road!.hookTaskRow(scope, mark))) }
    const session = { type: 'session', session_id: sid, cwd, model: 'fixture-model', mode: 'default' } as never
    for await (const result of road!.runHookEventFromRow({ event: 'SessionStart', row: session, session, fields: { source: 'startup' }, trustAccepted: true, marks: { started: mark => emit({ ...mark, type: 'started' }), progress: emit, response: mark => emit({ ...mark, type: 'response' }) } })) void result
    return marks
  }
  const batches = await Promise.all([drive('row-session-a'), drive('row-session-b')])
  check('concurrent hook runs keep independent mark sinks', batches.every(rows => rows.filter(row => row.state === 'started').length === 1 && rows.filter(row => row.state === 'ended').length === 1 && new Set(rows.map(row => row.task_id)).size === 1))
  check('a screen consumer is neither stolen nor replaced by the row road', takeHookEventHandler() === screen && new Set(globalMarks).size === 2)
  check('every progress and outcome is a valid existing task row', batches.flat().every(row => TaskRowSchema().safeParse(row).success))
  check('the two worker inputs contain only their firing session facts', batches.every((rows, index) => { const ended = rows.find(row => row.state === 'ended'); const input = JSON.parse(String(ended?.summary)); return input.session_id === (index === 0 ? 'row-session-a' : 'row-session-b') && input.cwd === cwd && input.model === 'fixture-model' && input.permission_mode === 'default' }))
  const call = { type: 'tool_call', session_id: 'row-session-a', call_id: 'call-7', tool: 'Read', input: { file_path: '/a/file' }, message_id: 'message-1', block: 0 } as const
  const fields = road.hookFieldsFromRow('PreToolUse', call)
  check('the tool hook input comes from the call row facts', JSON.stringify(fields) === JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/a/file' }, tool_use_id: 'call-7' }))
  let refused = false
  try { for await (const result of road.runHookEventFromRow({ event: 'PreToolUse', row: call, session: { session_id: 'wrong-session', cwd } })) void result } catch { refused = true }
  check('a row cannot fire a sibling session hook', refused)
  registerHookEventHandler(null)
}
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'HOOK ROW ROAD GREEN' : `${failures} HOOK ROW ROAD FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

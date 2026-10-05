#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'lifecycle-off-event-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { executeLifecycleHooks } = await import('../../src/utils/hooks/lifecycleHooks.ts')
const { createBaseHookInput } = await import('../../src/utils/hooks/execution.ts')
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
const offEvent = JSON.stringify({ systemMessage: 'crossed', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', reason: 'wrong lane' } })
const settings = {
  PreCompact: [{ hooks: [{ type: 'command', command: `printf '%s' ${quote(offEvent)}` }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: `printf '%s' ${quote(offEvent)}` }] }],
  WorktreeCreate: [{ hooks: [{ type: 'command', command: `printf '%s' ${quote(offEvent)}` }] }],
}
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: settings } }))
updateHooksConfigSnapshot()
const input = (event: string, fields: Record<string, unknown>) => ({ ...createBaseHookInput(), hook_event_name: event, ...fields })
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`) }
try {
  const preCompact = await executeLifecycleHooks({ hookInput: input('PreCompact', { trigger: 'manual', custom_instructions: 'ci' }) as never, timeoutMs: 4000 })
  check('a PreCompact hook answering PreToolUse-shaped output is refused loudly, never silently merged', preCompact.length === 1 && preCompact[0]?.succeeded === false && /incorrect event name: expected 'PreCompact' but got 'PreToolUse'/.test(preCompact[0]?.output ?? ''), `output: ${preCompact[0]?.output?.slice(0, 90)}`)
  const sessionEnd = await executeLifecycleHooks({ hookInput: input('SessionEnd', { reason: 'clear' }) as never, timeoutMs: 4000 })
  check('a SessionEnd hook answering another event\'s shape is refused loudly', sessionEnd.length === 1 && sessionEnd[0]?.succeeded === false && /incorrect event name/.test(sessionEnd[0]?.output ?? ''), `output: ${sessionEnd[0]?.output?.slice(0, 90)}`)
  const worktree = await executeLifecycleHooks({ hookInput: input('WorktreeCreate', { name: 'wt' }) as never, timeoutMs: 4000 })
  check('a WorktreeCreate hook can no longer leak another event\'s JSON text as the worktree path', worktree.length === 1 && worktree[0]?.succeeded === false && /incorrect event name/.test(worktree[0]?.output ?? ''), `output: ${worktree[0]?.output?.slice(0, 90)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(failures === 0 ? 'LIFECYCLE OFF-EVENT REFUSAL GREEN' : `${failures} LIFECYCLE OFF-EVENT REFUSAL FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

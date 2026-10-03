#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { WorktreeCreateHookInputSchema, WorktreeRemoveHookInputSchema } = await import('../../src/utils/hooks/contract.ts')
const events = readFileSync(join(import.meta.dir, '../../src/utils/hooks/events.ts'), 'utf8')
const base = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', permission_mode: 'default' }

const createInput = events.match(/hook_event_name: 'WorktreeCreate' as const,\n\s*(\w+),/)?.[1]
check('the WorktreeCreate emitter sends the worktree name it asks the hook to provision', createInput === 'name', String(createInput))
const created = WorktreeCreateHookInputSchema().strict().safeParse({ ...base, hook_event_name: 'WorktreeCreate', name: 'review-a' })
check('the contract declares exactly what the emitter sends: name', created.success, created.success ? '' : JSON.stringify(created.error.issues))
const declaredExtra = WorktreeCreateHookInputSchema().strict().safeParse({ ...base, hook_event_name: 'WorktreeCreate', worktree_path: '/w/x', branch: 'b' })
check('a field the emitter never sends is not a declared input', !declaredExtra.success)
const removeInput = events.match(/hook_event_name: 'WorktreeRemove' as const,\n\s*(\w+): /)?.[1]
const removed = WorktreeRemoveHookInputSchema().strict().safeParse({ ...base, hook_event_name: 'WorktreeRemove', worktree_path: '/w/x' })
check('the WorktreeRemove contract matches its emitter: worktree_path', removeInput === 'worktree_path' && removed.success, String(removeInput))

if (failures > 0) {
  console.log(`❌ ${failures} HOOK INPUT CONTRACT CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ the hook input contract declares what the emitters send')

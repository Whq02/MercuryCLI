#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const storage = await import('../../src/sessions/transcripts/sessionStorage.ts')
type AgentIdArg = Parameters<typeof storage.writeAgentMetadata>[0]

section('§1 the launch sidecar carries the directory')
await storage.writeAgentMetadata('cwd-continuation-proof' as AgentIdArg, { agentType: 'mercury-crew', description: 'proof', model: 'claude-fable-5-1', cwd: '/proof/lane' })
const back = await storage.readAgentMetadata('cwd-continuation-proof' as AgentIdArg)
check('cwd round-trips through the sidecar', back?.cwd === '/proof/lane', JSON.stringify(back) + ' · fix writeAgentMetadata and readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')
check('the other launch facts are intact beside it', back?.agentType === 'mercury-crew' && back?.description === 'proof' && back?.model === 'claude-fable-5-1', JSON.stringify(back) + ' · fix writeAgentMetadata and readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')
await storage.writeAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg, { agentType: 'mercury-crew', description: 'plain' })
const plain = await storage.readAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg)
check('a sidecar written without a directory reads none', plain !== null && plain.cwd === undefined, JSON.stringify(plain) + ' · fix readAgentMetadata in src/sessions/transcripts/sessionStorage.ts')


section("§4 the message's receipt names a recorded directory that is gone, once, with the directory the continuation runs in")
const noteLeaf = await import('../../src/tools/crewmate/continuationNote.ts').catch(() => null)
check('the receipt note has one owner beside the tool', noteLeaf !== null, 'src/tools/crewmate/continuationNote.ts is missing or fails to import; it must export continuationDirectoryNote')
if (noteLeaf !== null) {
  const gone = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory', recordedCwd: '/proof/gone-lane' }, '/proof/session')
  check('a gone recorded directory is named with the fallback', gone.includes('/proof/gone-lane') && gone.includes('is gone') && gone.includes('/proof/session'), gone + ' · fix continuationDirectoryNote in src/tools/crewmate/continuationNote.ts')
  check('the note is one line, once', (gone.match(/NOTE:/g) ?? []).length === 1 && !gone.includes('\n'), gone + ' · fix continuationDirectoryNote in src/tools/crewmate/continuationNote.ts')
  check('the note says where edits land now', gone.includes('anything it edits lands there'), gone + ' · fix continuationDirectoryNote in src/tools/crewmate/continuationNote.ts')
  const checkout = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-checkout' }, '/proof/session')
  check('a gone worktree keeps its existing sentence byte for byte', checkout === ' NOTE: its worktree is gone (already folded or cleaned) — the revived crewmate runs in the PARENT checkout; anything it edits lands in the real tree.', checkout + ' · fix the parent-checkout sentence in continuationDirectoryNote, src/tools/crewmate/continuationNote.ts')
  check('a continuation in its recorded directory carries no note', noteLeaf.continuationDirectoryNote({}, '/proof/session') === '', 'continuationDirectoryNote in src/tools/crewmate/continuationNote.ts must return an empty string when no fallback is recorded')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  const { getCwdState } = await import('../../src/boot/process-state/processState.ts')
  const automaticNote = runWithCwdOverride('/proof/gone-child', () => noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory', recordedCwd: '/proof/gone-child' }))
  check('an automatic callback names the session directory, not its departed child override', automaticNote.includes(`session's own directory, ${getCwdState()};`), automaticNote + ' · fix continuationDirectoryNote in src/tools/crewmate/continuationNote.ts to use the session directory when no directory argument is given')
  check('a gone directory the result did not name is still noted', noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory' }, '/proof/session').includes('its recorded directory is gone'), 'fix continuationDirectoryNote in src/tools/crewmate/continuationNote.ts to note a gone directory even when recordedCwd is absent')
}


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

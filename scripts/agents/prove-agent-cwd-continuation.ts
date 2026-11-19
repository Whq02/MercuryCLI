#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { readFileSync, realpathSync } from 'node:fs'
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

const storage = await import('../../src/utils/sessionStorage.ts')
type AgentIdArg = Parameters<typeof storage.writeAgentMetadata>[0]

section('§1 the launch sidecar carries the directory')
await storage.writeAgentMetadata('cwd-continuation-proof' as AgentIdArg, { agentType: 'mercury-crew', description: 'proof', model: 'claude-fable-5-1', cwd: '/proof/lane' })
const back = await storage.readAgentMetadata('cwd-continuation-proof' as AgentIdArg)
check('cwd round-trips through the sidecar', back?.cwd === '/proof/lane', JSON.stringify(back))
check('the other launch facts are intact beside it', back?.agentType === 'mercury-crew' && back?.description === 'proof' && back?.model === 'claude-fable-5-1')
await storage.writeAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg, { agentType: 'mercury-crew', description: 'plain' })
const plain = await storage.readAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg)
check('a sidecar written without a directory reads none', plain !== null && plain.cwd === undefined, JSON.stringify(plain))

const crewsDoc = readFileSync(join(ROOT, 'docs/CREW.md'), 'utf8').replace(/\s+/g, ' ')
check('the crews page says a continued sub-agent wakes in its launch directory', crewsDoc.includes('continued by a later message wakes in the directory it was launched in'))

section("§4 the message's receipt names a recorded directory that is gone, once, with the directory the continuation runs in")
const noteLeaf = await import('../../src/tools/AgentTool/continuationNote.ts').catch(() => null)
check('the receipt note has one owner beside the tool', noteLeaf !== null)
if (noteLeaf !== null) {
  const gone = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory', recordedCwd: '/proof/gone-lane' }, '/proof/session')
  check('a gone recorded directory is named with the fallback', gone.includes('/proof/gone-lane') && gone.includes('is gone') && gone.includes('/proof/session'), gone)
  check('the note is one line, once', (gone.match(/NOTE:/g) ?? []).length === 1 && !gone.includes('\n'), gone)
  check('the note says where edits land now', gone.includes('anything it edits lands there'), gone)
  const checkout = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-checkout' }, '/proof/session')
  check('a gone worktree keeps its existing sentence byte for byte', checkout === ' NOTE: its worktree is gone (already folded or cleaned) — the revived crewmate runs in the PARENT checkout; anything it edits lands in the real tree.', checkout)
  check('a continuation in its recorded directory carries no note', noteLeaf.continuationDirectoryNote({}, '/proof/session') === '')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const { getCwdState } = await import('../../src/bootstrap/state.ts')
  const automaticNote = runWithCwdOverride('/proof/gone-child', () => noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory', recordedCwd: '/proof/gone-child' }))
  check('an automatic callback names the session directory, not its departed child override', automaticNote.includes(`session's own directory, ${getCwdState()};`), automaticNote)
  check('a gone directory the result did not name is still noted', noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory' }, '/proof/session').includes('its recorded directory is gone'))
}
check('the crews page says the receipt names the gone directory', crewsDoc.includes('naming the directory that is gone'))


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

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
const src = (...parts: string[]): string => readFileSync(join(ROOT, 'src', ...parts), 'utf8')

const storage = await import('../../src/utils/sessionStorage.ts')
type AgentIdArg = Parameters<typeof storage.writeAgentMetadata>[0]

section('§1 the launch sidecar carries the directory')
await storage.writeAgentMetadata('cwd-continuation-proof' as AgentIdArg, { agentType: 'mercury-general', description: 'proof', model: 'claude-fable-5-1', cwd: '/proof/lane' })
const back = await storage.readAgentMetadata('cwd-continuation-proof' as AgentIdArg)
check('cwd round-trips through the sidecar', back?.cwd === '/proof/lane', JSON.stringify(back))
check('the other launch facts are intact beside it', back?.agentType === 'mercury-general' && back?.description === 'proof' && back?.model === 'claude-fable-5-1')
await storage.writeAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg, { agentType: 'mercury-general', description: 'plain' })
const plain = await storage.readAgentMetadata('cwd-continuation-proof-plain' as AgentIdArg)
check('a sidecar written without a directory reads none', plain !== null && plain.cwd === undefined, JSON.stringify(plain))

section('§2 the launch records the directory it resolved')
const agentTool = src('tools', 'AgentTool', 'AgentTool.tsx')
check('the run parameters carry the resolved directory when no worktree is cut', agentTool.includes('...(worktreeInfo === undefined && cwdParam !== undefined ? { cwd: cwdParam } : {})'))
const runAgent = src('tools', 'AgentTool', 'runAgent.ts')
check('the run loop accepts it', /worktreePath\?: string\n\s+cwd\?: string/.test(runAgent))
check("the run loop's sidecar write records it", runAgent.includes('...(cwd ? { cwd } : {}),'))

section('§3 the continuation reads it back and wakes there')
const resume = src('tools', 'AgentTool', 'resumeAgent.ts')
check('the continuation stats the recorded directory', resume.includes('if (meta?.cwd) {') && resume.includes('const info = await stat(meta.cwd)'))
check('a recorded directory that is gone is logged and the parent directory stands', resume.includes('resumeAgent: recorded directory ${meta.cwd} is gone — resuming in the parent cwd'))
check('the run is placed in the worktree first, else the recorded directory', resume.includes('const directory = worktreePath ?? cwdPath') && resume.includes('runWithCwdOverride(directory, runLifecycle)'))
check('the continuation re-persists the directory', resume.includes('...(cwdPath ? { cwd: cwdPath } : {}),\n    description,'))
check('the continuation hands the directory to the run loop', resume.includes('...(cwdPath ? { cwd: cwdPath } : {}),\n          description,'))
check('a gone directory is surfaced to the sender as a fallback, never a silent shift', resume.includes("cwdFallback?: 'parent-checkout' | 'parent-directory'") && resume.includes("? { cwdFallback: 'parent-directory' as const, recordedCwd: meta.cwd }"))
const teamsDoc = readFileSync(join(ROOT, 'docs/TEAMS.md'), 'utf8').replace(/\s+/g, ' ')
check('the teams page says a continued sub-agent wakes in its launch directory', teamsDoc.includes('continued by a later message wakes in the directory it was launched in'))

section("§4 the message's receipt names a recorded directory that is gone, once, with the directory the continuation runs in")
const noteLeaf = await import('../../src/tools/AgentTool/continuationNote.ts').catch(() => null)
check('the receipt note has one owner beside the tool', noteLeaf !== null)
if (noteLeaf !== null) {
  const gone = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory', recordedCwd: '/proof/gone-lane' }, '/proof/session')
  check('a gone recorded directory is named with the fallback', gone.includes('/proof/gone-lane') && gone.includes('is gone') && gone.includes('/proof/session'), gone)
  check('the note is one line, once', (gone.match(/NOTE:/g) ?? []).length === 1 && !gone.includes('\n'), gone)
  check('the note says where edits land now', gone.includes('anything it edits lands there'), gone)
  const checkout = noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-checkout' }, '/proof/session')
  check('a gone worktree keeps its existing sentence byte for byte', checkout === ' NOTE: its worktree is gone (already folded or cleaned) — the revived agent runs in the PARENT checkout; anything it edits lands in the real tree.', checkout)
  check('a continuation in its recorded directory carries no note', noteLeaf.continuationDirectoryNote({}, '/proof/session') === '')
  check('a gone directory the result did not name is still noted', noteLeaf.continuationDirectoryNote({ cwdFallback: 'parent-directory' }, '/proof/session').includes('its recorded directory is gone'))
}
const send = src('tools', 'SendMessageTool', 'SendMessageTool.ts')
check('BOTH resume arms of the message tool paint the note from its owner', send.split("(resumed.note ?? '')").length - 1 === 2 && resume.includes("from './continuationNote.js'"))
check('the resume result names the recorded directory beside the parent-directory fallback', resume.includes("{ cwdFallback: 'parent-directory' as const, recordedCwd: meta.cwd }"))
check('the teams page says the receipt names the gone directory', teamsDoc.includes('naming the directory that is gone'))

section('§5 the resume owner carries the note into every continuation')
check('the result carries the note', resume.includes('note?: string'))
check('the resumed helper reads the note in its own prompt', /createUserMessage\(\{ content: prompt \+ note \}\)/.test(resume))
const lifecycle = src('tools', 'AgentTool', 'agentToolUtils.ts')
for (const [start, end] of [['export function armBudgetCutResume(', 'const overloadEpisodes'], ['export function armOverloadProbe(', 'export async function runAsyncAgentLifecycle('], ['if (queued.length > 0)', 'drainPendingMessages(taskId,']]) {
  const at = lifecycle.indexOf(start)
  const body = lifecycle.slice(at, lifecycle.indexOf(end, at))
  check(`${start}: the resume receipt carries the returned note`, at >= 0 && body.includes('enqueueAgentReceiptRow(') && /resumed\??\.note/.test(body))
}
const print = src('cli', 'print.ts')
check('the crew resume answer carries the note and recorded directory', print.includes('recorded_cwd: resumed.recordedCwd') && print.includes('note: resumed.note'))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

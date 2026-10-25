#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkdtempSync(join(tmpdir(), 'failed-crewmate-tail-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { lastToolCallsOf } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { noteCrewWorktreeLeftover, CREW_JANITOR_DAYS } = await import('../../src/utils/crew/crewWorktreeReminder.ts')
const { enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { dequeueAll } = await import('../../src/utils/messageQueueManager.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

type Block = { type: 'text'; text: string }
type Mapped = { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: Block[] }
const map = (data: Record<string, unknown>, id: string): Mapped =>
  (AgentTool as unknown as { mapToolResultToToolResultBlockParam: (d: unknown, id: string) => Mapped }).mapToolResultToToolResultBlockParam(data, id)
const trailerOf = (mapped: Mapped): string => mapped.content[mapped.content.length - 1]?.text ?? ''

const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use' as const, id, name, input })
const result = (id: string, text: string, isError = false) => ({ type: 'tool_result' as const, tool_use_id: id, content: text, is_error: isError })
const assistant = (...blocks: unknown[]): Message => createAssistantMessage({ content: blocks as never }) as Message
const user = (...blocks: unknown[]): Message => createUserMessage({ content: blocks as never }) as Message

section('1. the forensic tail: the last five calls, the tool, the first line of its arguments, and how each ended')
{
  const messages: Message[] = [
    assistant(use('t1', 'Read', { file_path: '/w/src/a.ts' })),
    user(result('t1', 'file text')),
    assistant(use('t2', 'Grep', { pattern: 'foo', path: '/w/src' })),
    user(result('t2', 'no matches', true)),
    assistant(use('t3', 'Bash', { command: 'git -C /w status\n# second line never shows', description: 'Check status' })),
    user(result('t3', 'clean')),
    assistant(use('t4', 'Edit', { file_path: '/w/src/a.ts', old_string: 'x'.repeat(200), new_string: 'y' })),
    user(result('t4', 'edited')),
    assistant(use('t5', 'Write', { file_path: '/w/src/b.ts', content: 'export const b = 1\n' })),
    user(result('t5', 'written')),
    assistant(use('t6', 'Bash', { command: 'bun run typecheck' })),
  ]
  const tail = lastToolCallsOf(messages)
  check('five calls at most, oldest first, the one before them dropped', tail.length === 5 && !tail.some(line => line.startsWith('Read(')), JSON.stringify(tail))
  check('an errored result reads error, a settled one ok', tail[0] === 'Grep(pattern: foo, path: /w/src) → error' && tail[3] === 'Write(file_path: /w/src/b.ts, content: export const b = 1) → ok', JSON.stringify(tail.slice(0, 4)))
  check('the arguments stop at their first line', tail[1] === 'Bash(command: git -C /w status) → ok', tail[1])
  check('a long first line is clipped at 120 characters with an ellipsis', tail[2] === `Edit(file_path: /w/src/a.ts, old_string: ${'x'.repeat(120 - 'file_path: /w/src/a.ts, old_string: '.length)}…) → ok`, tail[2])
  check('the call the run died inside reads no result', tail[4] === 'Bash(command: bun run typecheck) → no result', tail[4])
  check('a run with no tool calls has an empty tail', lastToolCallsOf([assistant({ type: 'text', text: 'hello' })]).length === 0)
  check('the limit is the caller\'s', lastToolCallsOf(messages, 2).length === 2 && lastToolCallsOf(messages, 2)[1] === tail[4])
}

const worktreePath = join(proofHome, '.mercury', 'worktrees', 'agent-a0000001')
const now = Date.now()
noteCrewWorktreeLeftover({ name: 'helper', path: worktreePath, branch: 'agent-a0000001', head: '3f2a1c9', gitRoot: proofHome, state: 'uncommitted', detail: '2 uncommitted changes (src/a.ts, src/b.ts)', changedAt: now, janitorAt: now + CREW_JANITOR_DAYS * 86_400_000 })
const base = {
  agentId: 'a0000001',
  agentType: 'mercury-crew',
  content: [{ type: 'text', text: 'I was reading the file when the provider declined.' }],
  totalTokens: 400,
  totalToolUseCount: 3,
  totalDurationMs: 5000,
}
const calls = ['Read(file_path: /w/src/a.ts) → ok', 'Edit(file_path: /w/src/a.ts, old_string: x) → error', 'Bash(command: bun run typecheck) → no result']

section('2. the failed receipt: the kept worktree with its branch, HEAD and state, then the last tool calls, before the usage')
{
  const failed = map({ ...base, status: 'failed', error: 'API Error: 529', outcome: { status: 'failed', reason: 'provider-declined', error: 'API Error: 529' }, lastCalls: calls, worktreePath, worktreeBranch: 'agent-a0000001' }, 't1')
  const trailer = trailerOf(failed)
  check('the failure trailer still opens with the cause and the partial-work line', failed.is_error === true && trailer.startsWith('Crewmate execution failed: API Error: 529\nOutput above was captured before the failure'), trailer.slice(0, 160))
  check('it names the kept worktree with its path, branch and HEAD', trailer.includes(`Worktree kept: ${worktreePath} (branch agent-a0000001 @ 3f2a1c9) — `), trailer)
  check('…and what the worktree holds: the dirty count the leftover read', trailer.includes('2 uncommitted changes (src/a.ts, src/b.ts)') && trailer.includes('never removed by the machine'), trailer)
  check('the last tool calls follow, one per line, indented', trailer.includes(`Last tool calls:\n  ${calls[0]}\n  ${calls[1]}\n  ${calls[2]}`), trailer)
  const order = [trailer.indexOf('agentId:'), trailer.indexOf('Worktree kept:'), trailer.indexOf('Last tool calls:'), trailer.indexOf('<usage>')]
  check('the order: the way back, the worktree, the calls, the usage', order.every(i => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]! && order[2]! < order[3]!, JSON.stringify(order))
  const bare = map({ ...base, status: 'failed', error: 'API Error: 529', outcome: { status: 'failed', reason: 'provider-declined', error: 'API Error: 529' } }, 't2')
  check('a failed result with no worktree and no calls carries neither line', !trailerOf(bare).includes('Worktree kept:') && !trailerOf(bare).includes('Last tool calls:'), trailerOf(bare))
  const completed = map({ ...base, status: 'completed', outcome: { status: 'completed', promotedNarration: false }, worktreePath, worktreeBranch: 'agent-a0000001' }, 't3')
  check('the completed receipt names the kept worktree the same way, HEAD included', trailerOf(completed).includes(`Worktree kept: ${worktreePath} (branch agent-a0000001 @ 3f2a1c9) — `) && !trailerOf(completed).includes('Last tool calls:'), trailerOf(completed))
}

section('3. the death notice: the last tool calls and the worktree state ride the notification')
{
  dequeueAll()
  let state: { tasks: Record<string, Record<string, unknown>>; speculation: { status: string } } = {
    tasks: {
      a0000001: { id: 'a0000001', type: 'local_agent', status: 'failed', description: 'helper', notified: false, startTime: now, outputFile: '/tmp/out', outputOffset: 0 },
      a0000002: { id: 'a0000002', type: 'local_agent', status: 'completed', description: 'quiet', notified: false, startTime: now, outputFile: '/tmp/out2', outputOffset: 0 },
    },
    speculation: { status: 'idle' },
  }
  const setAppState = (fn: (prev: typeof state) => typeof state): void => {
    state = fn(state)
  }
  const notify = enqueueAgentNotification as unknown as (args: Record<string, unknown>) => void
  notify({ taskId: 'a0000001', description: 'helper', status: 'failed', error: 'API Error: 529', setAppState, finalMessage: 'partial', usage: { totalTokens: 400, toolUses: 3, durationMs: 5000 }, landedWrites: ['/w/src/a.ts'], lastCalls: calls, worktreePath, worktreeBranch: 'agent-a0000001' })
  notify({ taskId: 'a0000002', description: 'quiet', status: 'completed', setAppState, finalMessage: 'done', usage: { totalTokens: 10, toolUses: 0, durationMs: 100 } })
  const queued = dequeueAll().map(entry => String((entry as { value?: string }).value ?? ''))
  const death = queued.find(value => value.includes('<task_id>a0000001</task_id>')) ?? queued[0] ?? ''
  const quiet = queued.find(value => value.includes('a0000002')) ?? ''
  check('two notices queued', queued.length === 2, JSON.stringify(queued.map(value => value.slice(0, 80))))
  check('the death notice carries the worktree path, branch, HEAD and state', death.includes(`<worktree><worktreePath>${worktreePath}</worktreePath><worktreeBranch>agent-a0000001</worktreeBranch><worktreeHead>3f2a1c9</worktreeHead><worktreeState>2 uncommitted changes (src/a.ts, src/b.ts)</worktreeState></worktree>`), death)
  check('…and the last tool calls in their own section, one per line', death.includes(`<last_tool_calls>\n${calls.join('\n')}\n</last_tool_calls>`), death)
  check('the landed-writes census still rides the summary line', /1 file write landed: \/w\/src\/a\.ts/.test(death), death.slice(0, 400))
  check('a completed notice with no calls handed carries no section', !quiet.includes('<last_tool_calls>') && !quiet.includes('<worktree>'), quiet)
}

section('4. the roads hand the tail over: every death and stop in the two lifecycles, the failed foreground arm')
{
  const lifecycle = readFileSync(join(ROOT, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf8')
  const foreground = readFileSync(join(ROOT, 'src/tools/AgentTool/foregroundExecution.tsx'), 'utf8')
  const tool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const count = (source: string, needle: string): number => source.split(needle).length - 1
  check('the background lifecycle passes the tail on its declined, stopped and thrown roads', count(lifecycle, 'lastCalls: lastToolCallsOf(accumulated)') === 3, String(count(lifecycle, 'lastCalls: lastToolCallsOf(accumulated)')))
  check('the foreground run passes it on its three backgrounded exits and on the failed result', count(foreground, 'lastCalls: lastToolCallsOf(agentMessages)') === 4, String(count(foreground, 'lastCalls: lastToolCallsOf(agentMessages)')))
  check('the tail rides beside the landed-writes census wherever a death is noticed', count(lifecycle, 'landedWrites: landedWritesOf(accumulated)') === count(lifecycle, 'lastCalls: lastToolCallsOf(accumulated)') && count(foreground, 'landedWrites: landedWritesOf(agentMessages)') === 3)
  check('the failed arm of the result schema admits the tail', tool.includes('lastCalls: z.array(z.string()).optional()'))
  check('one line builder names the kept worktree on both arms', count(tool, 'worktreeKeptLine(data)') === 2 && tool.includes('crewWorktreeReminderTail('))
}

console.log(failures === 0 ? '\nprove-failed-crewmate-tail: all green' : `\nprove-failed-crewmate-tail: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

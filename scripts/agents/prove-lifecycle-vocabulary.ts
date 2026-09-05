#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const { deriveAgentLifecycle, IDLE_TTL_MS } = await import(
  '../../src/services/agentResults/lifecycle.ts'
)

const NOW = 1_000_000_000

section('§A the derivation truth-table')
{
  const running = deriveAgentLifecycle({ taskStatus: 'running', transcriptExists: true, now: NOW })
  check('running: not revivable, messages queue', running.state === 'running' && !running.revivable && running.basis.includes('queue'))
  const pending = deriveAgentLifecycle({ taskStatus: 'pending', transcriptExists: false, now: NOW })
  check('pending counts as running', pending.state === 'running')
  const idle = deriveAgentLifecycle({ taskStatus: 'completed', finishedAtMs: NOW - IDLE_TTL_MS + 1000, transcriptExists: true, now: NOW })
  check('completed within the TTL: idle, revivable WARM', idle.state === 'idle' && idle.revivable && idle.basis.includes('warm'))
  const parked = deriveAgentLifecycle({ taskStatus: 'completed', finishedAtMs: NOW - IDLE_TTL_MS - 1000, transcriptExists: true, now: NOW })
  check('completed past the TTL: parked, revivable COLD', parked.state === 'parked' && parked.revivable && parked.basis.includes('cold'))
  const diskOnly = deriveAgentLifecycle({ transcriptExists: true, now: NOW })
  check('registry row gone + transcript on disk: parked (a resumed session rediscovers it)', diskOnly.state === 'parked' && diskOnly.revivable)
  const nothing = deriveAgentLifecycle({ transcriptExists: false, now: NOW })
  check('no transcript anywhere: aborted, NOT revivable, honest basis', nothing.state === 'aborted' && !nothing.revivable && nothing.basis.includes('nothing to revive'))
}

section('§B the reconciliation — Mercury keeps aborted revivable')
{
  const killed = deriveAgentLifecycle({ taskStatus: 'killed', transcriptExists: true, now: NOW })
  check('killed + transcript: aborted AND revivable (the documented divergence)', killed.state === 'aborted' && killed.revivable && killed.basis.includes('revives'))
  const failedNoTranscript = deriveAgentLifecycle({ taskStatus: 'failed', transcriptExists: false, now: NOW })
  check('failed without a transcript: aborted, not revivable', failedNoTranscript.state === 'aborted' && !failedNoTranscript.revivable)
  const moduleHead = readFileSync(join(ROOT, 'src/services/agentResults/lifecycle.ts'), 'utf8')
  check('the divergence is documented where the vocabulary lives', moduleHead.includes('MORE capable') && moduleHead.includes('never-reduce'))
}

section('§C the revival honesty (structural pins)')
{
  const resume = readFileSync(join(ROOT, 'src/tools/AgentTool/resumeAgent.ts'), 'utf8')
  check('a gone worktree reports cwdFallback on the result', resume.includes("cwdFallback: 'parent-checkout'"))
  const send = readFileSync(join(ROOT, 'src/tools/SendMessageTool/SendMessageTool.ts'), 'utf8')
  const fallbackClauses = send.split('its worktree is gone').length - 1
  check('BOTH SendMessage resume arms surface the fallback verbatim', fallbackClauses === 2, `clauses=${fallbackClauses}`)
  check('the surfaced words say WHERE edits land now', send.includes('anything it edits lands in the real tree'))
}

section('§D the consumers — the vocabulary is SPOKEN (no orphan module)')
{
  const bridge = readFileSync(join(ROOT, 'src/components/tasks/taskStatusUtils.tsx'), 'utf8')
  check('taskStatusUtils bridges rows to the ONE derivation (agentLifecycleOf)', bridge.includes('deriveAgentLifecycle(') && bridge.includes('export function agentLifecycleOf'))
  check('the bridge feeds owner-held facts (status, endTime, the terminal transcript promise)', bridge.includes('finishedAtMs: row.endTime') && bridge.includes('transcriptExists: isTerminalStatus(row.status)'))
  const dialog = readFileSync(join(ROOT, 'src/components/tasks/AsyncAgentDetailDialog.tsx'), 'utf8')
  check('the agent detail dialog SPEAKS the vocabulary (state + basis verbatim)', dialog.includes('agentLifecycleOf(agent)') && dialog.includes('lifecycle.basis'))
  check('running rows stay on the live status line (no doubled words)', dialog.includes("lifecycle.state !== 'running'"))
}

section('§E the transcript\'s own end — one fact for every verb once the registry row is gone')
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { readAgentTranscript, transcriptEndWords } = await import('../../src/tools/WorkflowTool/agentTranscriptReader.ts')
  const { INTERRUPT_MESSAGE, turnCutLine } = await import('../../src/utils/messages/rejectionText.ts')
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-end-'))
  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  let seq = 0
  const recordWriter = { sessionId: 'lifecycle-proof' as never, nextOrdinal: () => ordinalOf(++seq), observedAt: '2026-06-19T12:00:00.000Z', source: { channel: 'sdk' } as const }
  const row = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify(entryToRecord({ type, uuid: `00000000-0000-4000-8000-${String(seq + 1).padStart(12, '0')}`, timestamp: new Date(1_700_000_000_000 + (seq + 1) * 1000).toISOString(), message: { role: type, content }, ...extra } as never, recordWriter as never))
  const prompt = row('user', 'plant the foliage')
  const call = (id: string): string => row('assistant', [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/notes.md' } }])
  const result = (id: string): string => row('user', [{ type: 'tool_result', tool_use_id: id, content: 'the notes' }])
  const endOf = async (name: string, rows: string[]): Promise<{ kind: string; words: string } | undefined> => {
    const file = join(dir, `${name}.jsonl`)
    writeFileSync(file, rows.join('\n') + '\n')
    return (await readAgentTranscript(file))?.end
  }
  const completed = await endOf('completed', [prompt, call('t1'), result('t1'), row('assistant', [{ type: 'text', text: 'the foliage is planted' }])])
  check('a final reply with nothing open: completed', completed?.kind === 'completed' && completed.words === 'completed', JSON.stringify(completed))
  const failed = await endOf('failed', [prompt, row('assistant', [{ type: 'text', text: 'half done' }]), row('assistant', [{ type: 'text', text: 'API Error: OpenAI stream fault after partial content (read-failed) — terminated' }], { isApiErrorMessage: true })])
  check('a provider-error tail: failed', failed?.kind === 'failed' && failed.words === 'failed', JSON.stringify(failed))
  const stopped = await endOf('stopped', [prompt, call('t2'), result('t2'), row('user', [{ type: 'text', text: INTERRUPT_MESSAGE }])])
  check("the operator's interruption row: stopped", stopped?.kind === 'stopped' && stopped.words === 'stopped', JSON.stringify(stopped))
  const timedOut = await endOf('timed-out', [prompt, row('assistant', [{ type: 'text', text: 'half done' }]), row('user', [{ type: 'text', text: turnCutLine({ kind: 'idle-timeout' }, false) }])])
  check('a typed cut row names its reason: cut off by a no-progress timeout', timedOut?.kind === 'cut' && timedOut.words === 'cut off by a no-progress timeout (the provider went quiet)', JSON.stringify(timedOut))
  const open = await endOf('open', [prompt, call('t3'), result('t3'), call('t4')])
  check('a call never answered: cut off mid-turn', open?.kind === 'cut' && open.words === 'cut off mid-turn', JSON.stringify(open))
  const promptOnly = await endOf('prompt-only', [prompt])
  check('a prompt never replied to: cut off mid-turn', promptOnly?.kind === 'cut' && promptOnly.words === 'cut off mid-turn', JSON.stringify(promptOnly))
  const resumed = await endOf('resumed', [prompt, row('user', [{ type: 'text', text: INTERRUPT_MESSAGE }]), row('user', 'carry on'), row('assistant', [{ type: 'text', text: 'done after the resume' }])])
  check('a resumed transcript ends on its newest row (completed after the stop)', resumed?.kind === 'completed', JSON.stringify(resumed))
  check('the disk words every verb speaks', transcriptEndWords(completed) === 'completed (transcript on disk)' && transcriptEndWords(undefined) === 'transcript on disk (unreadable)')
  rmSync(dir, { recursive: true, force: true })
  const adapter = readFileSync(join(ROOT, 'src/services/resources/adapters/agent.ts'), 'utf8')
  check('the agent verb reads the registry row first and the transcript\'s end second — never a word of its own', !/settled \(record on disk\)|unregistered \(transcript on disk\)/.test(adapter) && (adapter.match(/transcriptEndWords\(/g) ?? []).length >= 2)
  const transcriptVerb = readFileSync(join(ROOT, 'src/services/resources/adapters/transcript.ts'), 'utf8')
  check('the transcript verb reads the same two facts, never "finished agent execution"', !transcriptVerb.includes('finished agent execution') && transcriptVerb.includes('registryStatusOf(ctx') && transcriptVerb.includes('transcriptEndWords('))
  const stop = readFileSync(join(ROOT, 'src/tasks/stopTask.ts'), 'utf8')
  check('a stop of an evicted agent names the transcript\'s end and the resume door', stop.includes('export async function taskNotFoundWords') && stop.includes('its transcript on disk ends') && readFileSync(join(ROOT, 'src/tools/TaskStopTool/TaskStopTool.ts'), 'utf8').includes('await taskNotFoundWords(taskId)'))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
